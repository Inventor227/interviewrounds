//! Scoring and the session report: delivery metrics, the verdict rule, the model call (scripted), the report
//! checks and schema, storage and the report endpoints. Database tests need `DATABASE_URL` (remote.sh --pg);
//! the live run needs the model API key (`--env-file .secrets/llm-anthropic.env`, `-- --ignored`).

mod common;

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use axum::{Extension, Router};
use futures::stream::{self, BoxStream};
use ir_server::claude::{
    ClaudeClient, ClaudeError, ContentBlock, MessagesRequest, MessagesResponse, StreamEvent,
    Thinking, Usage,
};
use ir_server::content::Catalog;
use ir_server::identity::{Identity, IdentityKind};
use ir_server::orchestrator::{LlmApi, Mode};
use ir_server::scoring::metrics::{self, HeadSample, HintRec, MarkRec, MetricsContext, TurnRec};
use ir_server::scoring::report::{self, NOT_ENOUGH_SIGNAL, ReportSchema, ScoreEnv};
use ir_server::scoring::verdict::{self, Confidence, Length, Verdict};
use ir_server::scoring::{self, BoardOpRec, PanelSeat, ReportEvents, ScoringDeps, ScoringInput};
use ir_server::{AppState, Config};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

// ---------- fakes and fixtures ----------

fn content_dir() -> &'static Path {
    Path::new("../content")
}

fn catalog() -> Catalog {
    Catalog::load(content_dir()).expect("content loads")
}

fn schema() -> ReportSchema {
    ReportSchema::load(content_dir()).expect("report schema loads")
}

/// Streams scripted replies. The main scorecard call takes the next reply from `replies`; the headset card
/// (fast model) and the meeting reactions (schema with `attendees`) take theirs from `card` and `meeting`
/// (missing = a failed call). Records every request.
#[derive(Default)]
struct ScriptedLlm {
    replies: Mutex<VecDeque<Result<String, ClaudeError>>>,
    card: Mutex<Option<String>>,
    meeting: Mutex<Option<String>>,
    panic_main: bool,
    /// Side calls that never answer.
    hang_card: bool,
    hang_meeting: bool,
    /// The card's model is overloaded (its fallback answers).
    card_model_down: bool,
    requests: Mutex<Vec<MessagesRequest>>,
}

fn is_card(req: &MessagesRequest) -> bool {
    req.output_config
        .as_ref()
        .and_then(|o| o.format.as_ref())
        .is_some_and(|f| f["schema"]["properties"].get("one_line").is_some())
}

fn is_meeting(req: &MessagesRequest) -> bool {
    req.output_config
        .as_ref()
        .and_then(|o| o.format.as_ref())
        .is_some_and(|f| f["schema"]["properties"].get("attendees").is_some())
}

impl ScriptedLlm {
    fn new(replies: Vec<Result<String, ClaudeError>>) -> Arc<Self> {
        Arc::new(ScriptedLlm {
            replies: Mutex::new(replies.into()),
            ..ScriptedLlm::default()
        })
    }
    fn with_side(
        replies: Vec<Result<String, ClaudeError>>,
        card: Option<Value>,
        meeting: Option<Value>,
    ) -> Arc<Self> {
        Arc::new(ScriptedLlm {
            replies: Mutex::new(replies.into()),
            card: Mutex::new(card.map(|v| v.to_string())),
            meeting: Mutex::new(meeting.map(|v| v.to_string())),
            ..ScriptedLlm::default()
        })
    }
    /// Main scorecard calls only.
    fn calls(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| !is_card(r) && !is_meeting(r))
            .count()
    }
    fn card_calls(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| is_card(r))
            .count()
    }
    /// The models of the main scorecard calls, in order.
    fn main_models(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| !is_card(r) && !is_meeting(r))
            .map(|r| r.model.clone())
            .collect()
    }
    fn card_models(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| is_card(r))
            .map(|r| r.model.clone())
            .collect()
    }
    fn all_calls(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
    fn main_request(&self) -> MessagesRequest {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .find(|r| !is_card(r) && !is_meeting(r))
            .cloned()
            .expect("a main call")
    }
}

fn stream_of(text: String) -> BoxStream<'static, Result<StreamEvent, ClaudeError>> {
    // Split the JSON into a few deltas, as the API streams it.
    let mid = text.len() / 2;
    let mid = (mid..text.len())
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(text.len());
    let events = vec![
        Ok(StreamEvent::Block(ContentBlock::Thinking {
            thinking: String::new(),
            signature: "sig".into(),
        })),
        Ok(StreamEvent::TextDelta(text[..mid].to_string())),
        Ok(StreamEvent::TextDelta(text[mid..].to_string())),
        Ok(StreamEvent::Stop {
            reason: "end_turn".into(),
            usage: Usage {
                input_tokens: 9000,
                output_tokens: 3000,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 2500,
            },
        }),
    ];
    Box::pin(stream::iter(events))
}

#[async_trait]
impl LlmApi for ScriptedLlm {
    async fn create(&self, _req: &MessagesRequest) -> Result<MessagesResponse, ClaudeError> {
        Err(ClaudeError::BadRequest("scoring never calls create".into()))
    }

    async fn stream(
        &self,
        req: &MessagesRequest,
    ) -> Result<BoxStream<'static, Result<StreamEvent, ClaudeError>>, ClaudeError> {
        self.requests.lock().unwrap().push(req.clone());
        let side = if is_card(req) {
            Some(self.card.lock().unwrap().clone())
        } else if is_meeting(req) {
            Some(self.meeting.lock().unwrap().clone())
        } else {
            None
        };
        if (self.hang_card && is_card(req)) || (self.hang_meeting && is_meeting(req)) {
            return Ok(Box::pin(stream::pending()));
        }
        if self.card_model_down && is_card(req) && req.model == "claude-sonnet-5-5" {
            return Err(ClaudeError::Overloaded);
        }
        if let Some(reply) = side {
            return reply
                .map(stream_of)
                .ok_or_else(|| ClaudeError::BadRequest("no scripted side reply".into()));
        }
        if self.panic_main {
            panic!("scripted crash");
        }
        let next = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(ClaudeError::BadRequest("no scripted reply".into())));
        Ok(stream_of(next?))
    }
}

/// Collects `report.progress`, the card, `report.ready` and the failure.
#[derive(Default)]
struct RecordedEvents(Mutex<Vec<String>>, Mutex<Vec<Value>>);

#[async_trait]
impl ReportEvents for RecordedEvents {
    async fn progress(&self, _session_id: &str, stage: &str, pct: u8) {
        self.0.lock().unwrap().push(format!("{stage}:{pct}"));
    }
    async fn card(&self, _session_id: &str, card: &Value) {
        self.0.lock().unwrap().push("card".into());
        self.1.lock().unwrap().push(card.clone());
    }
    async fn ready(&self, _session_id: &str) {
        self.0.lock().unwrap().push("ready".into());
    }
    async fn failed(&self, _session_id: &str) {
        self.0.lock().unwrap().push("failed".into());
    }
}

fn turn(seq: i32, speaker: &str, panelist: Option<&str>, text: &str, at_ms: i64) -> TurnRec {
    TurnRec {
        seq,
        speaker: speaker.into(),
        panelist_id: panelist.map(str::to_string),
        kind: "speech".into(),
        text: text.into(),
        started_ms: Some(at_ms),
        ended_ms: None,
        interrupted: false,
    }
}

fn mark(id: &str, start_ms: i64, end_ms: i64, text: &str) -> MarkRec {
    MarkRec {
        segment_id: id.into(),
        panelist_id: Some("p1".into()),
        start_ms,
        end_ms,
        text: text.into(),
    }
}

const S2: &str = "First I want the numbers. How many fans arrive in the first minute, and is overselling ever acceptable? The hardest requirement is never selling one seat twice, so I will design around that.";
const S4: &str = "I would put a waiting room queue in front of the seat service. The seat service holds a seat for eight minutes with a conditional write in Postgres, and the payment callback confirms the hold.";
const S6: &str = "Um, I would just add more servers I guess, um, maybe a cache somewhere.";
const BOARD: &str = "Components: waiting room queue, seat service, Postgres (seat holds), payment callback handler. Edges: queue -> seat service -> Postgres.";

/// A full system design session on the Fish voice, with transcript marks.
fn design_input() -> ScoringInput {
    ScoringInput {
        session_id: Uuid::new_v4().to_string(),
        mode: "interview".into(),
        round_id: "sde.system_design.full".into(),
        length: "full".into(),
        level: "mid".into(),
        style: "neutral".into(),
        voice: "fish".into(),
        panel: vec![PanelSeat {
            panelist_id: "p1".into(),
            persona_id: "persona.daniel".into(),
        }],
        started_at: Some("2026-11-13T09:00:00Z".parse().unwrap()),
        duration_sec: 1500,
        ended_reason: Some("completed".into()),
        question_id: Some("system_design.ticket_drop".into()),
        phases_completed: ["intro", "requirements", "api", "hld", "deep_dive", "wrap"]
            .map(String::from)
            .to_vec(),
        turns: vec![
            turn(1, "system", None, "[event: start]", 0),
            turn(
                2,
                "agent",
                Some("p1"),
                "Design the ticketing system for a stadium concert: sixty thousand seats and three million fans at ten. Where do you want to start?",
                1_000,
            ),
            turn(3, "user", None, S2, 70_000),
            turn(
                4,
                "agent",
                Some("p1"),
                "About three million fans, most in the first two minutes. Overselling is unacceptable.",
                72_000,
            ),
            turn(5, "user", None, S4, 200_000),
            turn(
                6,
                "agent",
                Some("p1"),
                "What breaks first at ten times the traffic?",
                202_000,
            ),
            turn(7, "user", None, S6, 330_000),
        ],
        marks: vec![
            mark(
                "a",
                10_000,
                40_000,
                "First I want the numbers. How many fans arrive in the first minute, and is overselling ever acceptable?",
            ),
            mark(
                "b",
                45_000,
                69_000,
                "The hardest requirement is never selling one seat twice, so I will design around that.",
            ),
            mark(
                "c",
                80_000,
                140_000,
                "I would put a waiting room queue in front of the seat service.",
            ),
            mark(
                "d",
                150_000,
                199_000,
                "The seat service holds a seat for eight minutes with a conditional write in Postgres, and the payment callback confirms the hold.",
            ),
            mark("e", 300_000, 329_000, S6),
        ],
        board_text: Some(BOARD.into()),
        board_png: Some(tiny_png()),
        ..ScoringInput::default()
    }
}

/// A 1x1 PNG.
fn tiny_png() -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 255, 255, 255]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

fn model_output() -> Value {
    json!({
        "headline": { "summary": "You designed around double selling; the scale probe stayed vague." },
        "competencies": [
            { "id": "requirements", "name": "Requirements and scope", "score": 3, "level_label": "meets_bar",
              "rationale": "You asked for the numbers and named the hardest requirement.", "evidence_ids": ["e1", "e4"] },
            { "id": "architecture", "name": "Architecture", "score": 3, "level_label": "meets_bar",
              "rationale": "A clear path from queue to seat service to store.", "evidence_ids": ["e2"] },
            { "id": "tradeoffs", "name": "Trade-offs", "score": 3, "level_label": "meets_bar",
              "rationale": "The conditional write was chosen for a reason.", "evidence_ids": ["e2"] },
            { "id": "reliability", "name": "Reliability", "score": 2, "level_label": "developing",
              "rationale": "No specific failure named at ten times the load.", "evidence_ids": ["e3"] }
        ],
        "evidence": [
            { "id": "e1", "segment_id": "s2", "t_start_sec": 999, "t_end_sec": 999, "speaker": "user",
              "quote": "The hardest requirement is never selling one seat twice", "polarity": "positive",
              "competency_ids": ["requirements"], "note": "Names the constraint that shapes the design." },
            { "id": "e2", "segment_id": "s4", "t_start_sec": 0, "t_end_sec": 0, "speaker": "user",
              "quote": "holds a seat for eight minutes with a conditional write in Postgres", "polarity": "positive",
              "competency_ids": ["architecture", "tradeoffs"], "note": "" },
            { "id": "e3", "segment_id": "s6", "t_start_sec": 0, "t_end_sec": 0, "speaker": "user",
              "quote": "I would just add more servers I guess", "polarity": "negative",
              "competency_ids": ["reliability"], "note": "No bottleneck named." },
            { "id": "e4", "segment_id": "s4", "t_start_sec": 0, "t_end_sec": 0, "speaker": "user",
              "quote": "How many fans arrive in the first minute", "polarity": "positive",
              "competency_ids": ["requirements"], "note": "" }
        ],
        "strengths": [
            { "title": "Designed around the hardest requirement", "detail": "You named double selling first and built the hold around it.", "evidence_ids": ["e1"] }
        ],
        "weaknesses": [
            { "title": "Scale answer stayed vague", "detail": "More servers is not a bottleneck. Name what saturates first.", "evidence_ids": ["e3"] }
        ],
        "weakest_moment": {
            "question": "What breaks first at ten times the traffic?",
            "segment_id": "s5",
            "what_happened": "You suggested more servers and a cache without naming a bottleneck.",
            "strong_answer_covers": ["The seat hold writes saturate first", "Shard holds by section", "Queue admission rate"],
            "model_answer": "The first thing to break is the seat hold writes, because every fan in the first two minutes hits the same rows. I would shard holds by section and let the waiting room admit only as many fans as the store can take.",
            "retry": { "prompt": "Ten times the traffic arrives at ten. What breaks first, and what do you change?", "max_seconds": 120 }
        },
        "next_drills": [
            { "title": "Retry the scale probe", "why": "Your scale answer named no bottleneck.", "kind": "retry_answer",
              "round_type": "system_design", "round_id": "", "question_id": "", "est_minutes": 2 },
            { "title": "Short design round", "why": "Practice naming the first bottleneck.", "kind": "short_round",
              "round_type": "system_design", "round_id": "no.such.round", "question_id": "", "est_minutes": 8 },
            { "title": "Bad kind", "why": "x", "kind": "podcast", "round_type": "", "round_id": "", "question_id": "", "est_minutes": 3 }
        ],
        "round_details": {
            "kind": "system_design",
            "requirements_captured": ["No overselling", "Three million fans at ten"],
            "tradeoffs_discussed": ["Conditional write over a distributed lock"],
            "missing_components": ["Rate limiter on the seat service"]
        },
        "red_flag": { "present": false, "reason": "", "evidence_ids": [] }
    })
}

struct Env {
    catalog: Catalog,
    schema: ReportSchema,
    events: RecordedEvents,
}

impl Env {
    fn new() -> Self {
        Env {
            catalog: catalog(),
            schema: schema(),
            events: RecordedEvents::default(),
        }
    }

    fn score_env<'a>(&'a self, llm: &'a dyn LlmApi) -> ScoreEnv<'a> {
        ScoreEnv {
            llm,
            catalog: &self.catalog,
            schema: &self.schema,
            model: "claude-opus-5-5",
            effort: "high",
            max_tokens: 16_000,
            card_model: "claude-sonnet-5-5",
            card_fallback_model: "claude-haiku-5-5",
            timeout: Duration::from_secs(10),
            card_timeout: report::CARD_TIMEOUT,
            meeting_timeout: report::MEETING_TIMEOUT,
            side_grace: report::SIDE_GRACE,
            events: &self.events,
        }
    }
}

fn competency<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["competencies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("competency {id} missing"))
}

// ---------- verdict ----------

#[test]
fn verdict_table() {
    let s = |xs: &[i32]| xs.iter().map(|x| Some(*x as f32)).collect::<Vec<_>>();
    let full = |scores: &[Option<f32>], red: bool| {
        verdict::decide(scores, red, 1.0, Length::Full, Mode::Interview, 2).0
    };
    let cases: [(&[i32], bool, Verdict); 8] = [
        (&[4, 4, 4, 3], false, Verdict::StrongHire), // avg 3.75, min 3
        (&[3, 3, 3, 3], false, Verdict::Hire),       // avg 3.0, min 3
        (&[3, 3, 2, 3], false, Verdict::LeaningHire), // avg 2.75, min 2
        (&[3, 2, 2, 2], false, Verdict::LeaningNoHire), // avg 2.25
        (&[2, 2, 1, 2], false, Verdict::NoHire),     // avg 1.75
        (&[1, 1, 2, 1], false, Verdict::StrongNoHire), // avg 1.25
        (&[4, 4, 4, 4], true, Verdict::StrongNoHire), // red flag
        (&[4, 4, 4, 1], false, Verdict::LeaningNoHire), // avg 3.25 but min 1
    ];
    for (scores, red, want) in cases {
        assert_eq!(full(&s(scores), red), Some(want), "{scores:?} red={red}");
    }
    // Boundaries are inclusive: avg exactly 3.6 with min 3.
    assert_eq!(full(&s(&[4, 4, 4, 3, 3]), false), Some(Verdict::StrongHire));
    // Avg 3.5 with min 3 is Hire, not Strong Hire.
    assert_eq!(full(&s(&[4, 3, 4, 3]), false), Some(Verdict::Hire));
    // Not observed is left out of the average.
    assert_eq!(
        full(&[Some(3.0), None, Some(3.0), Some(4.0)], false),
        Some(Verdict::Hire)
    );
    // Nothing scored: no verdict.
    assert_eq!(full(&[None, None, None], false), None);
    assert_eq!(Verdict::LeaningHire.index(), 4);
    assert_eq!(Verdict::StrongNoHire.label(), "strong_no_hire");

    // Confidence.
    let conf = |pct: f32, len: Length, ev: usize| {
        verdict::decide(&s(&[3, 3, 3, 3]), false, pct, len, Mode::Interview, ev).1
    };
    assert_eq!(conf(1.0, Length::Short, 3), Confidence::Low);
    assert_eq!(conf(0.5, Length::Full, 3), Confidence::Low);
    assert_eq!(conf(0.6, Length::Full, 3), Confidence::Medium);
    assert_eq!(conf(1.0, Length::Full, 1), Confidence::Medium);
    assert_eq!(conf(1.0, Length::Full, 2), Confidence::High);

    // Meetings never get a hire verdict.
    let (v, _) = verdict::decide(
        &s(&[4, 4, 4, 4]),
        false,
        1.0,
        Length::Full,
        Mode::Meeting,
        2,
    );
    assert_eq!(v, None);
}

// ---------- metrics ----------

#[test]
fn metrics_pace_and_fillers() {
    // Two minutes of speech: 280 words, six of them "um" -> 140 wpm (good), 3.0 fillers per minute (okay).
    let words = |n: usize| vec!["word"; n].join(" ");
    let first = format!("um {} um {} um", words(70), words(70));
    let second = format!("{} um, {} um um", words(64), words(70));
    assert_eq!(
        metrics::word_count(&first) + metrics::word_count(&second),
        280
    );
    let marks = vec![
        mark("a", 10_000, 70_000, &first),
        mark("b", 90_000, 150_000, &second),
    ];
    let turns = vec![
        turn(1, "agent", Some("p1"), "Tell me about the design.", 0),
        turn(2, "user", None, &format!("{first} {second}"), 151_000),
    ];
    let ctx = MetricsContext {
        timing: true,
        round_type: "system_design".into(),
        hints: vec![HintRec {
            level: 2,
            t_ms: 65_000,
            accepted: true,
        }],
    };
    let m = metrics::compute(&turns, &marks, &[], &ctx);
    assert_eq!(m.wpm, Some(140.0));
    assert_eq!(m.wpm_band.as_deref(), Some("good"));
    assert_eq!(m.filler_per_min, Some(3.0));
    assert_eq!(m.filler_band.as_deref(), Some("okay"));
    assert_eq!(m.filler_top[0].word, "um");
    assert_eq!(m.filler_top[0].count, 6);
    // One answer (no agent turn between the segments) with a 20 s silence inside it.
    assert_eq!(m.answers.len(), 1);
    assert_eq!(m.answers[0].t_start_sec, 10.0);
    assert_eq!(m.answers[0].dur_sec, 140.0);
    assert_eq!(m.long_pauses.len(), 1);
    assert_eq!(m.long_pauses[0].t_sec, 70.0);
    assert_eq!(m.long_pauses[0].dur_sec, 20.0);
    assert_eq!(m.user_interruptions, Some(0));
    assert_eq!(m.hints.len(), 1);
    assert_eq!(m.hints[0].t_sec, 65.0);

    // Bands.
    assert_eq!(metrics::wpm_band(109.0), "slow");
    assert_eq!(metrics::wpm_band(171.0), "fast");
    assert_eq!(metrics::filler_band(1.9), "good");
    assert_eq!(metrics::filler_band(5.1), "work_on_it");

    // "like" counts only set off by commas; "do you know" is a question.
    let f = metrics::count_fillers(
        "I like Redis. It was, like, slow. Do you know the limit? You know, basically uh.",
    );
    let get = |w: &str| f.iter().find(|x| x.word == w).map(|x| x.count).unwrap_or(0);
    assert_eq!(get("like"), 1);
    assert_eq!(get("you know"), 1);
    assert_eq!(get("basically"), 1);
    assert_eq!(get("uh"), 1);

    // Fake voice: no timing, so the timing fields are null and the lists empty; text fields still work.
    let fake = MetricsContext {
        timing: false,
        ..ctx.clone()
    };
    let m = metrics::compute(&turns, &[], &[], &fake);
    assert_eq!(m.wpm, None);
    assert_eq!(m.wpm_band, None);
    assert_eq!(m.filler_per_min, None);
    assert!(m.answers.is_empty() && m.long_pauses.is_empty());
    assert_eq!(m.user_interruptions, None);
    assert_eq!(m.filler_top[0].count, 6);
    assert!(m.talk_ratio_user.unwrap() > 0.9);
}

#[test]
fn looking_at_interviewer_uses_floor_panelist() {
    // Yaw is relative to whoever holds the floor. While p1 has the floor the user looks at p1 six times and at
    // p2 (34° away) twice; after the hand-over to p2 the user looks at p2, which now counts. Samples while the
    // user is silent never count.
    let sample = |yaw: f64, speaking: bool, target: Option<&str>| HeadSample {
        t_ms: 0.0,
        yaw,
        pitch: -20.0,
        speaking,
        target: target.map(str::to_string),
    };
    let mut head = Vec::new();
    head.extend((0..6).map(|_| sample(3.0, true, Some("p1"))));
    head.extend((0..2).map(|_| sample(34.0, true, Some("p2"))));
    head.extend((0..2).map(|_| sample(-2.0, true, Some("p2"))));
    head.push(sample(-40.0, true, None));
    head.extend((0..5).map(|_| sample(80.0, false, None)));
    assert_eq!(metrics::gaze_on_speaker(&head), Some(0.73));

    let live = MetricsContext {
        timing: true,
        ..MetricsContext::default()
    };
    let m = metrics::compute(&[], &[], &head, &live);
    assert_eq!(m.gaze_on_speaker_pct, Some(0.73));
    // Without a live voice (fake transport) the field stays null.
    let m = metrics::compute(&[], &[], &head, &MetricsContext::default());
    assert_eq!(m.gaze_on_speaker_pct, None);
    // Looking down at the desk (pitch) does not count against them.
    assert_eq!(
        metrics::gaze_on_speaker(&[sample(5.0, true, Some("sheet"))]),
        Some(1.0)
    );
    assert_eq!(metrics::gaze_on_speaker(&[sample(5.0, false, None)]), None);
}

// ---------- report ----------

#[tokio::test]
async fn short_round_has_no_verdict() {
    let env = Env::new();
    let llm = ScriptedLlm::new(vec![]);
    // One answer only.
    let mut input = ScoringInput {
        session_id: Uuid::new_v4().to_string(),
        mode: "interview".into(),
        round_id: "sde.system_design.short".into(),
        length: "short".into(),
        level: "mid".into(),
        style: "warm".into(),
        voice: "fake".into(),
        panel: vec![PanelSeat {
            panelist_id: "p1".into(),
            persona_id: "persona.daniel".into(),
        }],
        duration_sec: 40,
        ended_reason: Some("user_ended".into()),
        turns: vec![
            turn(
                1,
                "agent",
                Some("p1"),
                "Design a URL shortener. Where do you start?",
                0,
            ),
            turn(
                2,
                "user",
                None,
                "I would put a load balancer in front of a few app servers and a key value store.",
                30_000,
            ),
        ],
        ..ScoringInput::default()
    };
    let scored = report::score(&env.score_env(llm.as_ref()), &input)
        .await
        .unwrap();
    let r = &scored.report;
    assert!(!scored.model_called);
    assert_eq!(llm.calls(), 0, "no model call without enough signal");
    assert!(
        env.schema.errors(r).is_empty(),
        "{:?}",
        env.schema.errors(r)
    );
    assert_eq!(r["headline"]["summary"], NOT_ENOUGH_SIGNAL);
    assert!(r["headline"]["verdict"].is_null());
    assert!(r["headline"]["overall_score"].is_null());
    for c in r["competencies"].as_array().unwrap() {
        assert!(c["score"].is_null(), "no invented score: {c}");
        assert_eq!(c["level_label"], "not_observed");
        assert_eq!(c["evidence_ids"], json!([]));
    }
    assert_eq!(r["evidence"], json!([]));
    assert!(r["weakest_moment"].is_null());
    assert_eq!(r["next_drills"][0]["kind"], "short_round");
    assert_eq!(r["next_drills"][0]["round_id"], "sde.system_design.short");
    assert_eq!(r["session"]["difficulty"], "easy");
    assert!(r["delivery"]["wpm"].is_null(), "fake voice has no timing");

    // Three answers but under a minute of speech (120 words at 150 wpm is 48 s; a short round needs 60 s): still
    // not enough.
    let answer = vec!["word"; 40].join(" ");
    input.turns = (0..3)
        .flat_map(|i| {
            vec![
                turn(i * 2 + 1, "agent", Some("p1"), "Go on.", i as i64 * 40_000),
                turn(i * 2 + 2, "user", None, &answer, i as i64 * 40_000 + 30_000),
            ]
        })
        .collect();
    let scored = report::score(&env.score_env(llm.as_ref()), &input)
        .await
        .unwrap();
    assert_eq!(scored.report["headline"]["summary"], NOT_ENOUGH_SIGNAL);
    assert!(scored.report["headline"]["verdict"].is_null());
    assert_eq!(llm.calls(), 0);
}

#[tokio::test]
async fn report_validates_against_schema() {
    let env = Env::new();
    let card = json!({
        "one_line": "You designed around double selling; the scale answer stayed vague.",
        "top_strength": { "title": "Named the hardest requirement", "segment_id": "s2",
                          "quote": "the hardest requirement is never selling one seat twice" },
        "top_fix": { "title": "Name the first bottleneck", "segment_id": "s1",
                     "quote": "Where do you want to start" }
    });
    let llm = ScriptedLlm::with_side(vec![Ok(model_output().to_string())], Some(card), None);
    let mut input = design_input();
    input.last_scores = HashMap::from([("requirements".to_string(), 2.0)]);
    let scored = report::score(&env.score_env(llm.as_ref()), &input)
        .await
        .unwrap();
    let r = &scored.report;
    assert!(scored.model_called);
    let errors = env.schema.errors(r);
    assert!(errors.is_empty(), "{errors:?}\n{r:#}");

    // Rust owns the session, delivery, verdict and confidence.
    assert_eq!(r["session"]["id"], input.session_id.as_str());
    assert_eq!(r["session"]["round_type"], "system_design");
    assert_eq!(r["session"]["seniority"], "mid");
    assert_eq!(r["session"]["difficulty"], "standard");
    assert_eq!(r["session"]["coverage"]["pct"], 1.0);
    assert_eq!(r["session"]["personas"], json!(["persona.daniel"]));
    assert_eq!(r["headline"]["verdict"]["label"], "leaning_hire"); // 3, 3, 3, 2
    assert_eq!(r["headline"]["verdict"]["index"], 4);
    assert_eq!(r["headline"]["verdict"]["is_provisional"], false);
    assert_eq!(
        r["headline"]["verdict"]["rationale"], r["headline"]["summary"],
        "every verdict carries a one line rationale"
    );
    // Full coverage, but architecture has a single evidence item: medium.
    assert_eq!(r["headline"]["verdict"]["confidence"], "medium");
    assert_eq!(r["headline"]["overall_score"], 2.75);
    assert_eq!(competency(r, "requirements")["delta_vs_last"], 1.0);
    assert_eq!(competency(r, "requirements")["weight"], 1.0);
    assert_eq!(r["delivery"]["filler_top"][0]["word"], "um");
    assert!(r["delivery"]["wpm"].is_number());
    // Silences over 4 s inside an answer: 40 s (5 s) and 140 s (10 s); the wait before an answer is not one.
    let pauses = r["delivery"]["long_pauses"].as_array().unwrap();
    assert_eq!(pauses.len(), 2, "{pauses:?}");
    assert_eq!(pauses[1]["t_sec"], 140.0);
    assert_eq!(pauses[1]["dur_sec"], 10.0);
    assert_eq!(r["delivery"]["answers"].as_array().unwrap().len(), 3);

    // Evidence times come from the quoted line, not from the model.
    let e1 = &r["evidence"][0];
    assert_eq!(e1["id"], "e1");
    assert_eq!(e1["t_start_sec"], 10.0);
    assert_eq!(e1["t_end_sec"], 69.0);
    assert_eq!(e1["speaker"], "user");
    // e4 cites s4 but its quote is in s2: no fallback to another line, so it is dropped.
    assert!(
        r["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["id"] != "e4")
    );
    assert_eq!(competency(r, "requirements")["evidence_ids"], json!(["e1"]));
    // The stored quote is the line's own text, not the model's spelling.
    assert_eq!(
        e1["quote"],
        "The hardest requirement is never selling one seat twice"
    );

    // The headset card went out on its own: the strength quote checks out (evidence c1); the fix quotes the
    // interviewer, so it is left out.
    let cards = env.events.1.lock().unwrap().clone();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["top_strength"]["evidence_id"], "c1");
    assert_eq!(cards[0]["top_strength"]["t_start_sec"], 10.0);
    assert!(cards[0]["top_fix"].is_null());
    let c1 = r["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "c1")
        .unwrap();
    assert_eq!(
        c1["quote"],
        "The hardest requirement is never selling one seat twice"
    );
    assert_eq!(scored.calls.len(), 2, "main call and card call ledgered");
    assert_eq!(scored.calls[1].model, "claude-sonnet-5-5");

    // Drills: the unknown kind is dropped and the bad round id replaced with the real short round.
    let drills = r["next_drills"].as_array().unwrap();
    assert_eq!(drills.len(), 2);
    assert_eq!(drills[1]["round_id"], "sde.system_design.short");
    assert!(drills[0].get("round_id").is_none());
    assert_eq!(r["weakest_moment"]["retry"]["max_seconds"], 120);
    assert_eq!(
        r["weakest_moment"]["t_start_sec"], 202.0,
        "time of the line where it was asked"
    );
    assert_eq!(r["round_details"]["board_as_text"], BOARD);

    // The request: one streamed call, adaptive thinking, effort high, fallbacks, structured output, cached
    // rules and rubric, the board image first.
    assert_eq!(llm.calls(), 1);
    assert_eq!(
        llm.all_calls(),
        2,
        "main and card, no meeting call for an interview"
    );
    let req = &llm.main_request();
    assert!(req.stream);
    assert_eq!(req.model, "claude-opus-5-5");
    assert_eq!(req.max_tokens, 16_000);
    assert_eq!(req.thinking, Some(Thinking::Adaptive));
    let oc = req.output_config.as_ref().unwrap();
    assert_eq!(oc.effort.as_deref(), Some("high"));
    assert_eq!(oc.format.as_ref().unwrap()["type"], "json_schema");
    assert_eq!(req.fallbacks, Some(json!("default")));
    assert_eq!(req.system.len(), 2);
    assert!(req.system.iter().all(|b| b.cache_control.is_some()));
    assert!(req.system[0].text.contains("How to score"));
    assert!(
        req.system[0].text.contains("sde.system_design.short"),
        "round ids filled in"
    );
    assert!(req.system[1].text.starts_with("Rubric\n"));
    let content = &req.messages[0].content;
    match &content[0] {
        ContentBlock::Other(v) => {
            assert_eq!(v["type"], "image");
            assert_eq!(v["source"]["media_type"], "image/png");
        }
        other => panic!("expected the board image first, got {other:?}"),
    }
    let text = req.messages[0].text();
    assert!(
        text.contains("[s2] 00:10-01:09 user: First I want the numbers."),
        "{text}"
    );
    assert!(text.contains("persona.daniel: What breaks first"), "{text}");
    assert!(
        text.contains("Delivery (measured by the app"),
        "delivery goes to the model"
    );
    assert!(text.contains("Pace: "));
    assert!(
        text.contains("Concert ticket drop"),
        "the question card is included"
    );
    assert!(!text.contains("{transcript}") && !text.contains("{rubric_json}"));
    assert!(
        !text.contains("[event: start]"),
        "event markers are not speech"
    );

    // Progress went out.
    let ev = env.events.0.lock().unwrap();
    assert!(ev.iter().any(|e| e.starts_with("metrics:")));
    assert!(ev.iter().any(|e| e.starts_with("scoring:")));
}

#[tokio::test]
async fn every_score_cites_evidence_or_is_null() {
    let env = Env::new();
    let mut out = model_output();
    // requirements cites only an id that does not exist; architecture cites a quote never said.
    out["competencies"][0]["evidence_ids"] = json!(["e9"]);
    out["competencies"][1]["score"] = json!(4);
    out["competencies"][1]["evidence_ids"] = json!(["e5"]);
    out["evidence"].as_array_mut().unwrap().push(json!({
        "id": "e5", "segment_id": "s4", "t_start_sec": 0, "t_end_sec": 0, "speaker": "user",
        "quote": "I designed a global CDN with edge caching", "polarity": "positive",
        "competency_ids": ["architecture"], "note": ""
    }));
    out["strengths"] = json!([
        { "title": "Invented strength", "detail": "x", "evidence_ids": ["e9"] },
        { "title": "Real strength", "detail": "y", "evidence_ids": ["e1", "e9"] }
    ]);
    out["red_flag"] = json!({ "present": true, "reason": "made up", "evidence_ids": ["e9"] });
    let llm = ScriptedLlm::new(vec![Ok(out.to_string())]);
    let scored = report::score(&env.score_env(llm.as_ref()), &design_input())
        .await
        .unwrap();
    let r = &scored.report;
    assert!(
        env.schema.errors(r).is_empty(),
        "{:?}",
        env.schema.errors(r)
    );

    let evidence_ids: Vec<&str> = r["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert!(
        !evidence_ids.contains(&"e5"),
        "a quote that is not in the transcript is dropped"
    );
    for c in r["competencies"].as_array().unwrap() {
        let ids = c["evidence_ids"].as_array().unwrap();
        if c["score"].is_null() {
            assert_eq!(c["level_label"], "not_observed", "{c}");
            assert_eq!(c["rationale"], "Not observed.");
            assert!(ids.is_empty());
        } else {
            assert!(!ids.is_empty(), "a score without evidence: {c}");
            for id in ids {
                assert!(
                    evidence_ids.contains(&id.as_str().unwrap()),
                    "{id} is not in evidence"
                );
            }
        }
    }
    assert!(competency(r, "requirements")["score"].is_null());
    assert!(competency(r, "architecture")["score"].is_null());
    assert_eq!(competency(r, "reliability")["score"], 2);
    let strengths = r["strengths"].as_array().unwrap();
    assert_eq!(strengths.len(), 1);
    assert_eq!(strengths[0]["evidence_ids"], json!(["e1"]));
    // A red flag needs real evidence: with none it does not count, so the verdict follows the scores (3, 2).
    assert_ne!(r["headline"]["verdict"]["label"], "strong_no_hire");
}

#[test]
fn quotes_must_be_verbatim_and_in_order() {
    let line = "I did not use Kafka. I handle failures with retries, and I know the limits.";
    // Case, punctuation and spacing aside, the line's own text comes back.
    assert_eq!(
        report::find_quote("i handle FAILURES with retries", line).as_deref(),
        Some("I handle failures with retries")
    );
    // Pieces must be in order: this would reverse the meaning.
    assert_eq!(
        report::find_quote("handle failures ... I did not use Kafka", line),
        None
    );
    assert_eq!(
        report::find_quote("I did not ... the limits", line).as_deref(),
        Some("I did not ... the limits")
    );
    // Whole words only: "no" is not inside "know".
    assert_eq!(report::find_quote("I no the limits", line), None);
    assert_eq!(report::find_quote("", line), None);
    // At most three pieces, and no long jumps between them.
    assert_eq!(report::find_quote("I ... did ... not ... use", line), None);
    let long = format!("start {} end", vec!["word"; 50].join(" "));
    assert_eq!(report::find_quote("start ... end", &long), None);
    assert_eq!(
        report::find_quote("don't", "I dont think so"),
        Some("dont".to_string())
    );
}

#[tokio::test]
async fn scores_need_the_candidates_own_words() {
    let env = Env::new();
    let mut out = model_output();
    // architecture rests only on the interviewer's line; reliability's quote sits in the wrong line.
    out["evidence"].as_array_mut().unwrap().push(json!({
        "id": "e7", "segment_id": "s5", "quote": "What breaks first at ten times the traffic?",
        "polarity": "positive", "competency_ids": ["architecture"], "note": ""
    }));
    out["competencies"][1]["evidence_ids"] = json!(["e7"]);
    out["evidence"][2]["segment_id"] = json!("s4");
    let llm = ScriptedLlm::new(vec![Ok(out.to_string())]);
    let r = report::score(&env.score_env(llm.as_ref()), &design_input())
        .await
        .unwrap()
        .report;
    assert!(
        env.schema.errors(&r).is_empty(),
        "{:?}",
        env.schema.errors(&r)
    );
    let e7 = r["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "e7")
        .unwrap();
    assert_eq!(e7["speaker"], "persona.daniel");
    assert!(
        competency(&r, "architecture")["score"].is_null(),
        "interviewer words alone score nothing"
    );
    assert!(
        competency(&r, "reliability")["score"].is_null(),
        "e3 dropped: quote not in its cited line"
    );
    // Two scored (3 and 3) after the drops: a verdict, recomputed on what is left.
    assert_eq!(r["headline"]["verdict"]["label"], "hire");
}

#[tokio::test]
async fn red_flag_needs_negative_candidate_evidence_and_shows_its_reason() {
    let env = Env::new();
    let mut out = model_output();
    out["red_flag"] = json!({ "present": true, "reason": "You kept defending a number you made up.",
                               "evidence_ids": ["e3"] });
    let llm = ScriptedLlm::new(vec![Ok(out.to_string())]);
    let r = report::score(&env.score_env(llm.as_ref()), &design_input())
        .await
        .unwrap()
        .report;
    assert_eq!(r["headline"]["verdict"]["label"], "strong_no_hire");
    assert_eq!(
        r["headline"]["verdict"]["rationale"],
        "You kept defending a number you made up."
    );
    assert!(env.schema.errors(&r).is_empty());

    // Citing positive evidence does not make a red flag.
    out["red_flag"]["evidence_ids"] = json!(["e1"]);
    let llm = ScriptedLlm::new(vec![Ok(out.to_string())]);
    let r = report::score(&env.score_env(llm.as_ref()), &design_input())
        .await
        .unwrap()
        .report;
    assert_eq!(r["headline"]["verdict"]["label"], "leaning_hire");
}

#[tokio::test]
async fn too_few_scored_competencies_are_only_signal_so_far() {
    let env = Env::new();
    // Only requirements keeps evidence: one scored competency, a 4.
    let mut out = model_output();
    out["competencies"][0]["score"] = json!(4);
    for i in 1..4 {
        out["competencies"][i]["evidence_ids"] = json!(["e404"]);
    }
    let llm = ScriptedLlm::new(vec![Ok(out.to_string())]);
    let r = report::score(&env.score_env(llm.as_ref()), &design_input())
        .await
        .unwrap()
        .report;
    let v = &r["headline"]["verdict"];
    assert_eq!(
        v["is_provisional"], true,
        "one competency is signal so far: {v}"
    );
    assert_eq!(v["confidence"], "low");
    assert!(env.schema.errors(&r).is_empty());

    // Nothing left scored: no verdict, not enough signal.
    for i in 0..4 {
        out["competencies"][i]["evidence_ids"] = json!(["e404"]);
    }
    let llm = ScriptedLlm::new(vec![Ok(out.to_string())]);
    let r = report::score(&env.score_env(llm.as_ref()), &design_input())
        .await
        .unwrap()
        .report;
    assert!(r["headline"]["verdict"].is_null());
    assert_eq!(r["headline"]["summary"], NOT_ENOUGH_SIGNAL);
}

#[tokio::test]
async fn meeting_reactions_come_from_a_second_call() {
    let env = Env::new();
    let mut input = design_input();
    input.mode = "meeting".into();
    input.round_id = "meeting.full".into();
    input.meeting_template = Some("exec_update".into());
    let mut out = model_output();
    for (i, id) in ["clarity", "objections", "evidence", "outcome"]
        .iter()
        .enumerate()
    {
        out["competencies"][i]["id"] = json!(id);
    }
    out["round_details"] = json!({ "kind": "meeting", "goal": "Launch approved", "outcome": "need_more_info",
                                   "goal_reached": "partly", "decision_quote_id": "", "ask_made": true });
    let meeting = json!({
        "attendees": [{ "name": "Grace", "stance_start": -1, "stance_end": 5, "one_line": "Solid, but show me numbers.",
            "concerns": [
                { "concern": "Double selling", "status": "resolved", "segment_id": "s4",
                  "quote": "a conditional write in Postgres" },
                { "concern": "Scale", "status": "open", "segment_id": "s6", "quote": "something never said" }
            ] }],
        "objections": [{ "by": "Grace", "segment_id": "s5", "objection": "Ten times the traffic",
                         "handled": "poorly", "better_response": "Name the bottleneck first." }],
        "next_steps": [{ "owner": "you", "action": "Send the load test", "due": "" }]
    });
    let llm = ScriptedLlm::with_side(vec![Ok(out.to_string())], None, Some(meeting));
    let r = report::score(&env.score_env(llm.as_ref()), &input)
        .await
        .unwrap()
        .report;
    assert!(
        env.schema.errors(&r).is_empty(),
        "{:?}",
        env.schema.errors(&r)
    );
    assert_eq!(llm.all_calls(), 3, "main, card and meeting calls");
    let d = &r["round_details"];
    assert_eq!(d["template"], "exec_update");
    let grace = &d["attendees"][0];
    assert_eq!(grace["stance_end"], 2, "clamped to the scale");
    assert_eq!(grace["concerns"][0]["evidence_ids"], json!(["m1"]));
    assert_eq!(
        grace["concerns"][1]["evidence_ids"],
        json!([]),
        "unverified quote gets no evidence"
    );
    let m1 = r["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "m1")
        .unwrap();
    assert_eq!(m1["quote"], "a conditional write in Postgres");
    assert_eq!(d["objections"][0]["t_sec"], 202.0);
    assert_eq!(
        d["next_steps"][0],
        json!({ "owner": "you", "action": "Send the load test" })
    );
}

fn card_reply() -> Value {
    json!({
        "one_line": "You designed around double selling; the scale answer stayed vague.",
        "top_strength": { "title": "Named the hardest requirement", "segment_id": "s2",
                          "quote": "the hardest requirement is never selling one seat twice" },
        "top_fix": { "title": "Name the first bottleneck", "segment_id": "s6",
                     "quote": "I would just add more servers" }
    })
}

#[tokio::test]
async fn card_is_sent_once_per_run_and_kept_across_attempts() {
    let env = Env::new();
    let llm = ScriptedLlm::with_side(
        vec![Ok("{\"headline\": ".into()), Ok(model_output().to_string())],
        Some(card_reply()),
        None,
    );
    let slot = report::CardSlot::default();
    let input = design_input();
    let senv = env.score_env(llm.as_ref());
    let first = report::score_with_card(&senv, &input, &slot).await;
    let err = first.expect_err("bad JSON fails the first attempt");
    let paid = err
        .downcast_ref::<report::UsageOnError>()
        .expect("usage travels with the error");
    // The main call answered (bad JSON, but paid for) and the card call ran: both travel with the error.
    let kinds: Vec<&str> = paid.0.iter().map(|c| c.kind).collect();
    assert_eq!(kinds, ["scoring", "scoring_card"]);

    let second = report::score_with_card(&senv, &input, &slot).await.unwrap();
    assert_eq!(llm.card_calls(), 1, "one card call per run");
    assert!(
        second.calls.iter().all(|c| c.kind != "scoring_card"),
        "ledgered once"
    );
    let cards = env.events.1.lock().unwrap().clone();
    assert_eq!(cards.len(), 1, "one card event");
    // The final report carries the same c1 and c2 the headset showed.
    for (pick, id) in [("top_strength", "c1"), ("top_fix", "c2")] {
        let e = second.report["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == id)
            .unwrap();
        assert_eq!(cards[0][pick]["evidence_id"], id);
        assert_eq!(e["quote"], cards[0][pick]["quote"]);
        assert_eq!(e["t_start_sec"], cards[0][pick]["t_start_sec"]);
    }
}

#[tokio::test]
async fn card_ids_win_over_a_colliding_main_item() {
    let env = Env::new();
    let mut out = model_output();
    // The main call used the id c1 for its architecture quote.
    out["evidence"][1]["id"] = json!("c1");
    out["competencies"][1]["evidence_ids"] = json!(["c1"]);
    out["competencies"][2]["evidence_ids"] = json!(["c1"]);
    let llm = ScriptedLlm::with_side(vec![Ok(out.to_string())], Some(card_reply()), None);
    let r = report::score(&env.score_env(llm.as_ref()), &design_input())
        .await
        .unwrap()
        .report;
    assert!(
        env.schema.errors(&r).is_empty(),
        "{:?}",
        env.schema.errors(&r)
    );
    let ev = r["evidence"].as_array().unwrap();
    let c1 = ev.iter().find(|e| e["id"] == "c1").unwrap();
    assert_eq!(
        c1["quote"], "The hardest requirement is never selling one seat twice",
        "the card's c1"
    );
    let renamed = competency(&r, "architecture")["evidence_ids"][0]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(renamed, "c1");
    let moved = ev.iter().find(|e| e["id"] == renamed.as_str()).unwrap();
    assert_eq!(
        moved["quote"],
        "holds a seat for eight minutes with a conditional write in Postgres"
    );
    assert_eq!(
        competency(&r, "tradeoffs")["evidence_ids"],
        json!([renamed])
    );
}

#[tokio::test]
async fn stalled_side_calls_never_hold_the_report() {
    let env = Env::new();
    let mut input = design_input();
    input.mode = "meeting".into();
    input.round_id = "meeting.full".into();
    input.meeting_template = Some("exec_update".into());
    let mut out = model_output();
    for (i, id) in ["clarity", "objections", "evidence", "outcome"]
        .iter()
        .enumerate()
    {
        out["competencies"][i]["id"] = json!(id);
    }
    out["round_details"] = json!({ "kind": "meeting", "goal": "Launch approved", "outcome": "need_more_info",
                                   "goal_reached": "partly", "decision_quote_id": "", "ask_made": true });
    let llm = Arc::new(ScriptedLlm {
        replies: Mutex::new(VecDeque::from([Ok(out.to_string())])),
        hang_card: true,
        hang_meeting: true,
        ..ScriptedLlm::default()
    });
    let mut senv = env.score_env(llm.as_ref());
    senv.side_grace = Duration::from_millis(300);
    let t = Instant::now();
    let r = report::score(&senv, &input).await.unwrap().report;
    assert!(
        t.elapsed() < Duration::from_secs(3),
        "waited {:?}",
        t.elapsed()
    );
    assert!(env.schema.errors(&r).is_empty());
    assert_eq!(
        r["round_details"]["outcome"], "need_more_info",
        "the main result is kept"
    );
    assert!(r["round_details"].get("attendees").is_none());
    assert!(env.events.1.lock().unwrap().is_empty(), "no card");

    // The card has its own short timeout even while the main call is still running.
    let llm = Arc::new(ScriptedLlm {
        replies: Mutex::new(VecDeque::from([Ok(model_output().to_string())])),
        hang_card: true,
        ..ScriptedLlm::default()
    });
    let mut senv = env.score_env(llm.as_ref());
    senv.side_grace = Duration::from_secs(30);
    senv.card_timeout = Duration::from_millis(200);
    let t = Instant::now();
    report::score(&senv, &design_input()).await.unwrap();
    assert!(
        t.elapsed() < Duration::from_secs(3),
        "waited {:?}",
        t.elapsed()
    );
}

#[tokio::test]
async fn board_quotes_count_only_when_the_candidate_wrote_them() {
    let env = Env::new();
    let mut input = design_input();
    input.board_text = Some("Waiting room queue. Rate limiter. Seat service.".into());
    input.board_ops = vec![
        BoardOpRec {
            src: "user".into(),
            op: "item.create".into(),
            args: json!({"label": "Waiting room queue"}),
            t_ms: Some(150_000),
            accepted: Some(true),
        },
        BoardOpRec {
            src: "interviewer".into(),
            op: "item.create".into(),
            args: json!({"label": "Rate limiter"}),
            t_ms: Some(160_000),
            accepted: Some(true),
        },
        BoardOpRec {
            src: "scribe".into(),
            op: "item.create".into(),
            args: json!({"label": "Seat service"}),
            t_ms: Some(170_000),
            accepted: Some(false),
        },
    ];
    let mut out = model_output();
    for (id, quote) in [
        ("b1", "Waiting room queue"),
        ("b2", "Rate limiter"),
        ("b3", "Seat service"),
    ] {
        out["evidence"].as_array_mut().unwrap().push(json!({
            "id": id, "segment_id": "board", "quote": quote, "polarity": "positive",
            "competency_ids": ["architecture"], "note": ""
        }));
    }
    let llm = ScriptedLlm::new(vec![Ok(out.to_string())]);
    let r = report::score(&env.score_env(llm.as_ref()), &input)
        .await
        .unwrap()
        .report;
    let ids: Vec<&str> = r["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["id"].as_str())
        .collect();
    assert!(ids.contains(&"b1"));
    assert!(
        !ids.contains(&"b2"),
        "the interviewer's box is not the candidate's work"
    );
    assert!(
        !ids.contains(&"b3"),
        "a dismissed Scribe suggestion is not the candidate's work"
    );
    let b1 = r["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "b1")
        .unwrap();
    assert_eq!(b1["t_start_sec"], 150.0);
}

#[test]
fn card_line_is_cut_at_a_clause_with_an_ellipsis() {
    let line = "You framed the problem well and designed a safe seat hold path, but your capacity reasoning needed a push to catch hot rows at scale";
    let cut = report::clip_line(line, 100);
    assert!(cut.chars().count() <= 100, "{cut}");
    assert_eq!(
        cut,
        "You framed the problem well and designed a safe seat hold path\u{2026}"
    );
    assert_eq!(report::clip_line("Short.", 100), "Short.");
}

#[test]
fn round_clock_rebases_marks_and_leaves_out_pauses() {
    use ir_server::scoring::clock::{RoundClock, pause_spans};
    let start = 1_800_000_000_000i64;
    // The headset clock runs 5 s behind the server; a 2 minute pause from 60 s to 180 s.
    let pauses = pause_spans(
        &[(start + 60_000, true), (start + 180_000, false)],
        start + 900_000,
    );
    let offset = RoundClock::offset_from(&[
        (start + 30_100, start + 25_000),
        (start + 200_150, start + 195_000),
        (start + 210_090, start + 205_000),
    ]);
    assert_eq!(offset, 5_100);
    let clock = RoundClock::new(start, pauses, offset);
    assert_eq!(clock.wall_to_round(start + 30_000), 30_000);
    assert_eq!(
        clock.wall_to_round(start + 100_000),
        60_000,
        "inside the pause: when it began"
    );
    assert_eq!(clock.wall_to_round(start + 200_000), 80_000);
    assert_eq!(clock.client_to_round(start + 194_900), 80_000);
    // Already relative values pass through.
    assert_eq!(clock.client_to_round(12_000), 12_000);
    // Ending while paused: the clock ran again for the closing lines, so an open pause does not count.
    assert_eq!(pause_spans(&[(start + 10, true)], start + 50), vec![]);
}

#[tokio::test]
async fn meeting_mode_has_no_verdict() {
    let env = Env::new();
    let mut input = design_input();
    input.mode = "meeting".into();
    input.round_id = "meeting.full".into();
    input.phases_completed = vec!["welcome".into(), "opening".into()];
    input.meeting_template = Some("exec_update".into());
    input.meeting_difficulty = Some("tough".into());
    let mut out = model_output();
    for (i, id) in ["clarity", "objections", "evidence", "outcome"]
        .iter()
        .enumerate()
    {
        out["competencies"][i]["id"] = json!(id);
    }
    out["round_details"] = json!({
        "kind": "meeting", "goal": "Get the launch approved", "outcome": "need_more_info",
        "goal_reached": "partly", "decision_quote_id": "e77", "ask_made": true,
        "stayed_above_walkaway": null, "next_steps": [], "attendees": [], "objections": []
    });
    let llm = ScriptedLlm::new(vec![Ok(out.to_string())]);
    let r = report::score(&env.score_env(llm.as_ref()), &input)
        .await
        .unwrap()
        .report;
    assert!(
        env.schema.errors(&r).is_empty(),
        "{:?}",
        env.schema.errors(&r)
    );
    assert!(r["headline"]["verdict"].is_null());
    assert!(r["headline"]["overall_score"].is_number());
    assert_eq!(r["session"]["seniority"], "n/a");
    assert_eq!(r["session"]["difficulty"], "hard");
    assert_eq!(r["round_details"]["template"], "exec_update");
    assert!(
        r["round_details"].get("decision_quote_id").is_none(),
        "unknown evidence id removed"
    );
}

#[test]
fn llm_schema_uses_only_supported_keywords() {
    fn walk(v: &Value, path: &str) {
        match v {
            Value::Object(m) => {
                for bad in [
                    "minItems",
                    "maxItems",
                    "maxLength",
                    "minimum",
                    "maximum",
                    "oneOf",
                    "default",
                    "format",
                    "$ref",
                ] {
                    assert!(!m.contains_key(bad), "{bad} at {path}");
                }
                if let Some(t) = m.get("type") {
                    assert!(t.is_string(), "type list at {path}");
                }
                if m.get("type").and_then(Value::as_str) == Some("object") {
                    assert_eq!(
                        m.get("additionalProperties"),
                        Some(&json!(false)),
                        "at {path}"
                    );
                    // Optional properties blow up the compiled grammar: every property is required.
                    let required: Vec<&str> = m
                        .get("required")
                        .and_then(Value::as_array)
                        .map(|r| r.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    if let Some(props) = m.get("properties").and_then(Value::as_object) {
                        for p in props.keys() {
                            assert!(required.contains(&p.as_str()), "{p} optional at {path}");
                        }
                    }
                }
                for (k, x) in m {
                    walk(x, &format!("{path}/{k}"));
                }
            }
            Value::Array(a) => a
                .iter()
                .enumerate()
                .for_each(|(i, x)| walk(x, &format!("{path}/{i}"))),
            _ => {}
        }
    }
    let schema = schema();
    for kind in [
        "coding",
        "system_design",
        "object_design",
        "behavioral",
        "pm",
        "meeting",
    ] {
        let s = report::llm_schema(&schema.raw, kind);
        walk(&s, "");
        assert_eq!(
            s["properties"]["round_details"]["properties"]["kind"]["const"],
            kind
        );
        assert!(s["properties"]["evidence"]["items"]["properties"]["segment_id"].is_object());
        assert!(s["properties"]["red_flag"]["properties"]["present"].is_object());
        let comp = &s["properties"]["competencies"]["items"]["properties"];
        // What our code derives is not asked of the model (it keeps the grammar small).
        for derived in ["delta_vs_last", "weight", "name", "level_label"] {
            assert!(comp.get(derived).is_none(), "{derived}");
        }
        let ev = &s["properties"]["evidence"]["items"]["properties"];
        for derived in ["t_start_sec", "t_end_sec", "speaker"] {
            assert!(ev.get(derived).is_none(), "{derived}");
        }
        let wm = &s["properties"]["weakest_moment"]["anyOf"][0]["properties"];
        assert!(wm["segment_id"].is_object() && wm.get("t_start_sec").is_none());
        // "title" is a property name in drills and points; it must survive keyword cleaning.
        assert!(s["properties"]["next_drills"]["items"]["properties"]["title"].is_object());
    }
    walk(&report::sanitize(&report::card_schema()), "card");
    walk(&report::sanitize(&report::meeting_schema()), "meeting");
    // The prompt splits into cached rules and per session data.
    let cat = catalog();
    let p = report::split_scorer_prompt(cat.prompt("scorer").unwrap()).expect("scorer.md splits");
    assert!(p.intro.starts_with("You are a hiring committee member"));
    assert!(p.head.contains("{transcript}") && !p.head.contains("{rubric_json}"));
    assert!(p.rules.contains("How to score") && p.rules.contains("{round_ids}"));
    assert_eq!(
        report::render("{a} and {b} {c}", &[("a", "{b}".into()), ("b", "x".into())]),
        "{b} and x {c}"
    );
}

// ---------- database: storing, retrying, endpoints ----------

async fn pool() -> PgPool {
    ir_server::db::connect_url(&common::database_url())
        .await
        .expect("connect + migrate")
}

fn config(data_dir: &Path) -> Config {
    let env: HashMap<&str, String> = [
        ("DATABASE_URL", common::database_url()),
        ("APP_ORIGIN", "https://rounds.example.test".to_string()),
        (
            "PUBLIC_DIR",
            common::temp_dir("public").display().to_string(),
        ),
        ("DATA_DIR", data_dir.display().to_string()),
        ("CONTENT_DIR", "../content".to_string()),
        ("ANTHROPIC_API_KEY", "test-anthropic-key".to_string()),
        ("ANTHROPIC_WORKSPACE_ID", "test-workspace".to_string()),
        ("FISH_AUDIO_API_KEY", "test-fish-key".to_string()),
        ("FISH_AGENT_ID", "test-agent".to_string()),
        ("FISH_LLM_SECRET", "test-llm-secret".to_string()),
        ("DEV_KEY", "test-dev-key".to_string()),
    ]
    .into_iter()
    .collect();
    Config::from_lookup(|k| env.get(k).cloned()).unwrap()
}

/// A finished fake-voice system design session waiting for its report.
async fn insert_session(db: &PgPool, input: &ScoringInput) -> Uuid {
    let identity: Uuid =
        sqlx::query_scalar("insert into identities (kind) values ('guest') returning id")
            .fetch_one(db)
            .await
            .unwrap();
    let id: Uuid = sqlx::query_scalar(
        "insert into sessions (identity_id, mode, round_id, length, level, style, voice, panel, status, \
             ended_reason, started_at, ended_at) \
         values ($1, 'interview', $2, $3, 'mid', 'neutral', 'fake', $4, 'scoring', 'completed', \
             now() - interval '25 minutes', now()) returning id",
    )
    .bind(identity)
    .bind(&input.round_id)
    .bind(&input.length)
    .bind(json!([{"panelist_id": "p1", "persona_id": "persona.daniel", "display_name": "Daniel",
                  "title": "Staff engineer", "avatar_id": "a", "seat": 0}]))
    .fetch_one(db)
    .await
    .unwrap();
    for t in &input.turns {
        sqlx::query(
            "insert into turns (session_id, seq, speaker, panelist_id, kind, text, started_ms) \
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(id)
        .bind(t.seq)
        .bind(&t.speaker)
        .bind(&t.panelist_id)
        .bind(if t.speaker == "system" {
            "event"
        } else {
            "speech"
        })
        .bind(&t.text)
        .bind(t.started_ms)
        .execute(db)
        .await
        .unwrap();
    }
    sqlx::query(
        "insert into boards (session_id, rev, doc, summary) values ($1, 7, '{}'::jsonb, $2)",
    )
    .bind(id)
    .bind(BOARD)
    .execute(db)
    .await
    .unwrap();
    id
}

/// Long enough answers for the fake voice (no marks): about 110 s estimated from the words.
fn long_design_input() -> ScoringInput {
    let mut input = design_input();
    input.voice = "fake".into();
    input.marks.clear();
    let pad = " I would also measure the queue length, the hold expiry rate and the payment callback latency, and alert when any of them drifts.";
    for t in input.turns.iter_mut().filter(|t| t.speaker == "user") {
        t.text = format!("{}{pad}{pad}{pad}", t.text);
    }
    input
}

fn deps(db: &PgPool, llm: Arc<dyn LlmApi>, data_dir: &Path) -> ScoringDeps {
    let mut d = ScoringDeps::new(
        db.clone(),
        llm,
        Arc::new(catalog()),
        Arc::new(schema()),
        "claude-opus-5-5",
    );
    d.data_dir = data_dir.to_path_buf();
    d.board_wait = Duration::from_millis(300);
    d
}

/// Database tests share one database and the worker sweeps every queued session, so they run one at a time.
fn db_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

async fn owner(db: &PgPool, id: Uuid) -> Identity {
    let who: Uuid = sqlx::query_scalar("select identity_id from sessions where id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap();
    identity(who)
}

fn identity(id: Uuid) -> Identity {
    Identity {
        id,
        kind: IdentityKind::Guest,
        name: None,
        email: None,
        onboarding_done: true,
    }
}

/// The report routes as the identity layer would serve them to `who`.
fn report_app(db: &PgPool, data: &Path, who: Identity) -> Router {
    Router::new()
        .merge(ir_server::api::report::routes())
        .layer(Extension(who))
        .with_state(AppState::new(db.clone(), config(data)))
}

async fn status(db: &PgPool, id: Uuid) -> String {
    sqlx::query_scalar("select status from sessions where id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

fn post(path: String, ct: &'static str, body: Vec<u8>) -> Request<Body> {
    Request::post(path)
        .header(header::CONTENT_TYPE, ct)
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn score_session_stores_report_and_serves_it() {
    let _serial = db_lock().lock().await;
    let db = pool().await;
    let data = common::temp_dir("data");
    let input = long_design_input();
    let id = insert_session(&db, &input).await;
    let who = owner(&db, id).await;
    let app = report_app(&db, &data, who.clone());

    // Not ready yet; and never visible to someone else.
    let res = common::get(app.clone(), &format!("/api/sessions/{id}/report")).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // The board image arrives before scoring reads it.
    let res = app
        .clone()
        .oneshot(post(
            format!("/api/sessions/{id}/board-image"),
            "image/png",
            tiny_png(),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let (rev, path, bytes): (i64, String, i32) =
        sqlx::query_as("select rev, path, bytes from board_images where session_id = $1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(rev, 7);
    assert_eq!(bytes as usize, tiny_png().len());
    assert!(data.join(&path).is_file());

    let llm = ScriptedLlm::new(vec![Ok(model_output().to_string())]);
    let events = Arc::new(RecordedEvents::default());
    let d = deps(&db, llm.clone(), &data).with_events(events.clone());
    let loaded = scoring::load_scoring_input(&db, id, &d.catalog)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.turns.len(), input.turns.len());
    assert_eq!(loaded.board_text.as_deref(), Some(BOARD));
    assert_eq!(loaded.panel[0].persona_id, "persona.daniel");
    assert_eq!(
        loaded.phases_completed.len(),
        d.catalog.rounds["sde.system_design.full"].phases.len(),
        "ended completed: every phase"
    );
    assert!(loaded.duration_sec >= 1490);

    let report = scoring::score_session(&d, id).await.unwrap();
    assert_eq!(llm.calls(), 1);
    let req = llm.main_request();
    assert!(matches!(&req.messages[0].content[0], ContentBlock::Other(v) if v["type"] == "image"));
    assert_eq!(report["headline"]["verdict"]["label"], "leaning_hire");
    assert!(report["delivery"]["wpm"].is_null(), "fake voice");
    let ev = events.0.lock().unwrap().clone();
    assert_eq!(ev.last().map(String::as_str), Some("ready"));
    assert!(ev.contains(&"done:100".to_string()));

    assert_eq!(status(&db, id).await, "scored");
    let model: Option<String> =
        sqlx::query_scalar("select model from reports where session_id = $1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(model.as_deref(), Some("claude-opus-5-5"));
    // The attempt row with the main call's usage, plus the card call's estimate.
    let rows: Vec<(String, Option<i32>)> = sqlx::query_as(
        "select kind, input_tokens from usage_events where session_id = $1 and provider = 'anthropic'",
    )
    .bind(id)
    .fetch_all(&db)
    .await
    .unwrap();
    // The main call's row, and an estimate for the card call that failed before reporting usage.
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[0], ("scoring".to_string(), Some(9000)));
    assert_eq!(rows[1].0, "scoring_card");
    assert!(rows[1].1.unwrap_or(0) > 0, "{rows:?}");

    let res = common::get(app.clone(), &format!("/api/sessions/{id}/report")).await;
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = common::body_json(res).await;
    // As served, the report carries the session's live public link (none here).
    assert!(schema().errors(&body).is_empty());
    assert_eq!(
        body.as_object_mut().unwrap().remove("share"),
        Some(json!({"public_slug": null, "include_quotes": false}))
    );
    assert_eq!(body, report);
    let stranger = report_app(&db, &data, identity(Uuid::new_v4()));
    let res = common::get(stranger, &format!("/api/sessions/{id}/report")).await;
    assert_eq!(
        res.status(),
        StatusCode::NOT_FOUND,
        "someone else's report is not found"
    );

    // A later session of the same round type gets deltas against this one.
    let id2 = insert_session(&db, &input).await;
    sqlx::query("update sessions set identity_id = $1, status = 'live' where id = $2")
        .bind(who.id)
        .bind(id2)
        .execute(&db)
        .await
        .unwrap();
    let again = scoring::load_scoring_input(&db, id2, &d.catalog)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again.last_scores.get("requirements"), Some(&3.0));
}

#[tokio::test]
async fn attempts_are_capped_and_rescore_is_limited() {
    let _serial = db_lock().lock().await;
    let db = pool().await;
    let data = common::temp_dir("data");
    let id = insert_session(&db, &long_design_input()).await;
    let who = owner(&db, id).await;
    // A broken answer, then a network failure: both attempts fail.
    let llm = ScriptedLlm::new(vec![
        Ok("{\"headline\": ".into()),
        Err(ClaudeError::Overloaded),
        Ok(model_output().to_string()),
    ]);
    let events = Arc::new(RecordedEvents::default());
    let d = deps(&db, llm.clone(), &data).with_events(events.clone());
    assert!(scoring::score_session(&d, id).await.is_err());
    assert_eq!(llm.calls(), 2, "two attempts");
    assert_eq!(status(&db, id).await, "failed");
    assert!(events.0.lock().unwrap().contains(&"failed".to_string()));
    assert_eq!(scoring::attempts_used(&db, id).await.unwrap(), 2);

    // Back in the queue without a person asking (a restart, a stale sweep): no third model call.
    sqlx::query("update sessions set status = 'scoring' where id = $1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    assert!(scoring::score_session(&d, id).await.is_err());
    assert_eq!(llm.calls(), 2, "the budget is spent");
    assert_eq!(status(&db, id).await, "failed");

    // Try again: a person asks, two fresh attempts.
    let app = report_app(&db, &data, who.clone());
    let rescore = || {
        app.clone().oneshot(
            Request::post(format!("/api/sessions/{id}/report"))
                .body(Body::empty())
                .unwrap(),
        )
    };
    let res = report_app(&db, &data, identity(Uuid::new_v4()))
        .oneshot(
            Request::post(format!("/api/sessions/{id}/report"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::NOT_FOUND,
        "not someone else's to retry"
    );
    assert_eq!(rescore().await.unwrap().status(), StatusCode::ACCEPTED);
    assert_eq!(status(&db, id).await, "scoring");
    assert_eq!(scoring::attempts_used(&db, id).await.unwrap(), 0);
    scoring::score_session(&d, id).await.unwrap();
    assert_eq!(status(&db, id).await, "scored");
    assert_eq!(
        rescore().await.unwrap().status(),
        StatusCode::CONFLICT,
        "already scored"
    );

    // At most two re-scores a day.
    for expected in [StatusCode::ACCEPTED, StatusCode::TOO_MANY_REQUESTS] {
        sqlx::query("update sessions set status = 'failed' where id = $1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(rescore().await.unwrap().status(), expected);
    }
}

#[tokio::test]
async fn one_card_per_run_and_no_empty_ledger_rows() {
    let _serial = db_lock().lock().await;
    let db = pool().await;
    let data = common::temp_dir("data");
    let kinds = |id: Uuid| {
        let db = db.clone();
        async move {
            let mut k: Vec<String> =
                sqlx::query_scalar("select kind from usage_events where session_id = $1")
                    .bind(id)
                    .fetch_all(&db)
                    .await
                    .unwrap();
            k.sort();
            k
        }
    };

    // The first attempt fails after the card went out; the second reuses that card.
    let id = insert_session(&db, &long_design_input()).await;
    let llm = ScriptedLlm::with_side(
        vec![Ok("{\"headline\": ".into()), Ok(model_output().to_string())],
        Some(card_reply()),
        None,
    );
    let events = Arc::new(RecordedEvents::default());
    let d = deps(&db, llm.clone(), &data).with_events(events.clone());
    let report = scoring::score_session(&d, id).await.unwrap();
    assert_eq!(llm.card_calls(), 1);
    let cards = events.1.lock().unwrap().clone();
    assert_eq!(cards.len(), 1);
    let c1 = report["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "c1")
        .unwrap();
    assert_eq!(c1["quote"], cards[0]["top_strength"]["quote"]);
    assert_eq!(kinds(id).await, vec!["scoring", "scoring", "scoring_card"]);

    // Not enough signal: scored without a model call, and no ledger row is left behind.
    let mut short = long_design_input();
    short.turns.truncate(3);
    short.turns[2].text = "Just a few words here.".into();
    let id = insert_session(&db, &short).await;
    let llm = ScriptedLlm::new(vec![]);
    let events = Arc::new(RecordedEvents::default());
    let d = deps(&db, llm.clone(), &data).with_events(events.clone());
    let report = scoring::score_session(&d, id).await.unwrap();
    assert_eq!(report["headline"]["summary"], NOT_ENOUGH_SIGNAL);
    assert_eq!(llm.all_calls(), 0);
    assert!(kinds(id).await.is_empty());

    // A session already scored is not reported as failed.
    scoring::mark_failed(&d, id).await;
    assert_eq!(status(&db, id).await, "scored");
    assert!(!events.0.lock().unwrap().contains(&"failed".to_string()));
}

#[tokio::test]
async fn worker_marks_a_crashed_scoring_task_failed() {
    let _serial = db_lock().lock().await;
    let db = pool().await;
    let data = common::temp_dir("data");
    let id = insert_session(&db, &long_design_input()).await;
    let llm = Arc::new(ScriptedLlm {
        panic_main: true,
        ..ScriptedLlm::default()
    });
    let events = Arc::new(RecordedEvents::default());
    let d = deps(&db, llm, &data).with_events(events.clone());
    assert!(scoring::run_pending(&d).await.unwrap() >= 1);
    let deadline = Instant::now() + Duration::from_secs(10);
    while status(&db, id).await != "failed" {
        assert!(Instant::now() < deadline, "the session never left scoring");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(events.0.lock().unwrap().contains(&"failed".to_string()));
}

#[tokio::test]
async fn board_image_is_checked_owned_and_replaced() {
    let _serial = db_lock().lock().await;
    let db = pool().await;
    let data = common::temp_dir("data");
    let id = insert_session(&db, &long_design_input()).await;
    sqlx::query("update sessions set status = 'live' where id = $1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    let app = report_app(&db, &data, owner(&db, id).await);
    let url = format!("/api/sessions/{id}/board-image");
    let send = |ct: &'static str, body: Vec<u8>| app.clone().oneshot(post(url.clone(), ct, body));
    assert_eq!(
        send("image/png", b"GIF89a".to_vec())
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        send("image/jpeg", tiny_png()).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let mut corrupt = tiny_png();
    corrupt.truncate(12);
    assert_eq!(
        send("image/png", corrupt).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let mut big = tiny_png();
    big.resize(2 * 1024 * 1024 + 1, 0);
    assert_eq!(
        send("image/png", big).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let huge = {
        let img = image::GrayImage::new(5000, 1);
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    };
    assert_eq!(
        send("image/png", huge).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let stranger = report_app(&db, &data, identity(Uuid::new_v4()));
    let res = stranger
        .oneshot(post(url.clone(), "image/png", tiny_png()))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // One image per session: the second replaces the first.
    let second = {
        let img = image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 0, 0, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    };
    assert_eq!(
        send("image/png", tiny_png()).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        send("image/png", second.clone()).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    let rows: Vec<String> =
        sqlx::query_scalar("select path from board_images where session_id = $1")
            .bind(id)
            .fetch_all(&db)
            .await
            .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(std::fs::read(data.join(&rows[0])).unwrap(), second);

    // Once scored the board is final.
    sqlx::query("update sessions set status = 'scored' where id = $1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        send("image/png", tiny_png()).await.unwrap().status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn loader_puts_marks_on_round_time_and_reads_hints() {
    let _serial = db_lock().lock().await;
    let db = pool().await;
    // The pause/resume and hint log (created by a later migration; made here when missing).
    sqlx::query(
        "create table if not exists session_events (id bigserial primary key, \
           session_id uuid not null references sessions (id) on delete cascade, kind text not null, \
           at_ms bigint, data jsonb not null, created_at timestamptz not null default now())",
    )
    .execute(&db)
    .await
    .unwrap();
    let identity_id: Uuid =
        sqlx::query_scalar("insert into identities (kind) values ('guest') returning id")
            .fetch_one(&db)
            .await
            .unwrap();
    let start = chrono::DateTime::parse_from_rfc3339("2026-11-13T09:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let at = |s: i64| start + chrono::Duration::milliseconds(s);
    let id: Uuid = sqlx::query_scalar(
        "insert into sessions (identity_id, mode, round_id, length, level, style, voice, status, ended_reason, \
             started_at, ended_at) \
         values ($1, 'interview', 'sde.system_design.short', 'short', 'mid', 'neutral', 'fish', 'scoring', \
             'completed', $2, $3) returning id",
    )
    .bind(identity_id)
    .bind(start)
    .bind(at(600_000))
    .fetch_one(&db)
    .await
    .unwrap();
    // Paused from 60 s to 180 s; the headset clock is 5 s behind the server.
    for (kind, at_ms, data, t) in [
        ("ui.event", None, json!({"kind": "pause"}), at(60_000)),
        ("ui.event", None, json!({"kind": "resume"}), at(180_000)),
        (
            "hint",
            Some(95_000i64),
            json!({"level": 2, "accepted": false}),
            at(215_000),
        ),
    ] {
        sqlx::query("insert into session_events (session_id, kind, at_ms, data, created_at) values ($1, $2, $3, $4, $5)")
            .bind(id)
            .bind(kind)
            .bind(at_ms)
            .bind(data)
            .bind(t)
            .execute(&db)
            .await
            .unwrap();
    }
    let skew = 5_000;
    for (seg, first, last) in [("a", 20_000i64, 40_000i64), ("b", 190_000, 200_000)] {
        sqlx::query(
            "insert into marks (session_id, segment_id, panelist_id, first_at_ms, final_at_ms, text, created_at) \
             values ($1, $2, 'p1', $3, $4, 'some words here', $5)",
        )
        .bind(id)
        .bind(seg)
        .bind(start.timestamp_millis() + first - skew)
        .bind(start.timestamp_millis() + last - skew)
        .bind(at(last + 120))
        .execute(&db)
        .await
        .unwrap();
    }
    let input = scoring::load_scoring_input(&db, id, &catalog())
        .await
        .unwrap()
        .unwrap();
    let marks: Vec<(i64, i64)> = input.marks.iter().map(|m| (m.start_ms, m.end_ms)).collect();
    // The 120 ms network delay stays in; the skew and the 2 minute pause are gone.
    assert_eq!(marks, vec![(20_120, 40_120), (70_120, 80_120)]);
    assert_eq!(input.hints.len(), 1);
    assert_eq!(
        (
            input.hints[0].level,
            input.hints[0].t_ms,
            input.hints[0].accepted
        ),
        (2, 95_000, false)
    );
    let m = report::delivery_for(&input, catalog().round("sde.system_design.short").unwrap());
    assert_eq!(m.hints[0].t_sec, 95.0);
}

#[test]
fn board_image_is_scaled_to_1568_px() {
    let dir = common::temp_dir("img");
    let path = dir.join("big.png");
    image::RgbaImage::from_pixel(3000, 1000, image::Rgba([0, 0, 0, 255]))
        .save(&path)
        .unwrap();
    let png = scoring::board_png(&path).unwrap();
    let img = image::load_from_memory(&png).unwrap();
    assert_eq!(img.width(), 1568);
    assert!((522..=523).contains(&img.height()), "{}", img.height());
}

// ---------- live ----------

/// A realistic recorded fake-voice session (full system design, mid level), scored by the real model, with the
/// headset card timed. `remote.sh <wt> rust --env-file .secrets/llm-anthropic.env -- cargo test --test scoring
/// live_ -- --ignored --nocapture`
#[tokio::test]
#[ignore = "calls the real API"]
async fn live_scoring_run() {
    struct Timed(Instant, Mutex<Option<(f64, Value)>>);
    #[async_trait]
    impl ReportEvents for Timed {
        async fn progress(&self, _: &str, _: &str, _: u8) {}
        async fn card(&self, _: &str, card: &Value) {
            *self.1.lock().unwrap() = Some((self.0.elapsed().as_secs_f64(), card.clone()));
        }
        async fn ready(&self, _: &str) {}
        async fn failed(&self, _: &str) {}
    }
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY");
    let ws = std::env::var("ANTHROPIC_WORKSPACE_ID").expect("ANTHROPIC_WORKSPACE_ID");
    let effort = std::env::var("SCORING_EFFORT").unwrap_or_else(|_| "medium".into());
    let client = ClaudeClient::with_base_url(&key, &ws, ir_server::claude::DEFAULT_BASE_URL);
    let env = Env::new();
    let input = recorded_session();
    let timed = Timed(Instant::now(), Mutex::new(None));
    let mut senv = env.score_env(&client);
    senv.effort = &effort;
    senv.timeout = Duration::from_secs(90);
    senv.events = &timed;
    let scored = report::score(&senv, &input).await.expect("scored");
    let secs = timed.0.elapsed().as_secs_f64();
    let r = &scored.report;
    let card = timed.1.lock().unwrap().clone();
    println!("scoring time: {secs:.1} s at effort {effort}");
    println!("card time: {:?}", card.as_ref().map(|c| c.0));
    for c in &scored.calls {
        println!("call {} {}: {:?}", c.kind, c.model, c.usage);
    }
    if let Ok(out) = std::env::var("SCORING_SAMPLE_OUT") {
        std::fs::create_dir_all(Path::new(&out).parent().unwrap()).ok();
        std::fs::write(&out, serde_json::to_string_pretty(r).unwrap()).unwrap();
        let card_out = out.replace(".json", "-card.json");
        std::fs::write(
            card_out,
            serde_json::to_string_pretty(&card.map(|c| c.1)).unwrap(),
        )
        .unwrap();
    }
    assert!(
        env.schema.errors(r).is_empty(),
        "{:?}",
        env.schema.errors(r)
    );
    assert!(r["headline"]["verdict"].is_object());
    assert!(r["evidence"].as_array().unwrap().len() >= 3);
}

/// The API compiles every model schema (one per round details kind, the meeting reactions, the headset card)
/// without "grammar too large".
#[tokio::test]
#[ignore = "calls the real API"]
async fn live_schemas_compile() {
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY");
    let ws = std::env::var("ANTHROPIC_WORKSPACE_ID").expect("ANTHROPIC_WORKSPACE_ID");
    let client = ClaudeClient::with_base_url(&key, &ws, ir_server::claude::DEFAULT_BASE_URL);
    let schema = schema();
    let mut cases: Vec<(String, &str, Value)> = [
        "coding",
        "system_design",
        "object_design",
        "behavioral",
        "pm",
        "meeting",
    ]
    .iter()
    .map(|k| {
        (
            k.to_string(),
            "claude-opus-5-5",
            report::llm_schema(&schema.raw, k),
        )
    })
    .collect();
    cases.push((
        "meeting reactions".into(),
        "claude-opus-5-5",
        report::sanitize(&report::meeting_schema()),
    ));
    cases.push((
        "headset card".into(),
        "claude-sonnet-5-5",
        report::sanitize(&report::card_schema()),
    ));
    for (kind, model, schema) in cases {
        let req = MessagesRequest {
            model: model.into(),
            max_tokens: 32,
            messages: vec![ir_server::claude::Message::user_text(
                "Fill the schema with tiny placeholder values.",
            )],
            thinking: ir_server::claude::thinking_for(model),
            output_config: Some(ir_server::claude::OutputConfig {
                effort: Some("low".into()),
                format: Some(json!({ "type": "json_schema", "schema": schema })),
            }),
            ..MessagesRequest::default()
        };
        let res = client.create(&req).await;
        assert!(res.is_ok(), "{kind}: {:?}", res.err());
    }
}

fn recorded_session() -> ScoringInput {
    let script: &[(&str, &str)] = &[
        (
            "a",
            "Hi, I'm Daniel. Today we'll design something real. A stadium sells sixty thousand assigned seats for a concert, and about three million fans try to buy the moment sales open at ten. Design the ticketing system. Where would you like to start?",
        ),
        (
            "u",
            "Okay. Before I draw anything I want to pin down the requirements. Functionally, a fan opens the event, sees a seat map, picks up to a few seats, holds them, and pays. Can I ask, how many tickets can one account buy, and how long should a hold last while they pay?",
        ),
        (
            "a",
            "Four tickets per account. A hold lasts eight minutes while the fan pays.",
        ),
        (
            "u",
            "Good. Non functionally, the big one is that we can never sell the same seat twice, so seat assignment needs strong consistency. The seat map can be a little stale, that's fine. And the load is extremely spiky, three million people in the first couple of minutes, mostly on phones. So I'd say the read path for the seat map has to scale to maybe a million requests per second at peak, but the write path is bounded by sixty thousand seats, so writes are small in total but very contended.",
        ),
        ("a", "Sounds right. What does the API look like?"),
        (
            "u",
            "Um, I'd keep it small. GET event seats returns the map with availability. POST holds with the seat ids returns a hold id and an expiry. POST purchases with the hold id and a payment token starts payment. And there's a webhook from the payment processor that confirms or fails the payment. I'd make the purchase call idempotent with a client generated key so retries don't double charge.",
        ),
        ("a", "Okay. Sketch the high level design on the sheet."),
        (
            "u",
            "So, clients go through a CDN and a load balancer. In front of everything at ten o'clock there's a waiting room, a virtual queue that admits fans at a rate the backend can take, like a few thousand per second. Admitted fans get a signed token. The seat map is served from a cache, Redis, rebuilt every second or so from the database, so reads never touch Postgres. Holds go to a seat service that writes to Postgres with a conditional update, set held by me where seat id is this and status is available, so two fans can't both win. Holds expire after eight minutes with a sweeper job. Payments go through the third party processor, and the webhook handler marks the seats sold.",
        ),
        ("a", "The payment callback arrives twice. What happens?"),
        (
            "u",
            "The webhook handler is idempotent on the payment id. The first callback moves the order from pending to paid and the seats from held to sold in one transaction. The second one sees the order is already paid and just returns two hundred. I'd store processed payment ids with a unique constraint so even concurrent duplicates are safe.",
        ),
        ("a", "And if the callback comes after the hold expired?"),
        (
            "u",
            "Hmm, that's a good one. I think, basically, if the hold expired and the seat went to someone else, we have to refund. If the seat is still free we could just complete the sale. I'd probably extend holds a little while a payment is in flight, actually, so the sweeper skips holds with a pending payment, maybe for up to two minutes.",
        ),
        ("a", "What breaks first at ten times the traffic?"),
        (
            "u",
            "Ten times, so thirty million fans. Um, I think the waiting room protects the backend, so the first thing is probably the waiting room itself and the seat map cache. I'd just add more cache nodes, I guess. The database should be fine because writes are capped by the number of seats.",
        ),
        ("a", "Are writes really capped? Think about failed holds."),
        (
            "u",
            "Oh, right, failed attempts are writes too, or at least attempts. Every fan clicking the same popular seat hits the same rows. So the hot rows in the front sections would see a lot of contention. You could shard by section, and, like, maybe reject early in Redis if the seat is already held before going to Postgres. I'm not totally sure about the numbers there.",
        ),
        ("a", "Okay. We're near time. Anything you'd add?"),
        (
            "u",
            "I'd add monitoring on queue admission rate, hold success rate and webhook lag, and a kill switch to slow admission if Postgres latency goes up. That's it from me.",
        ),
        ("a", "Thanks, that's time. Good discussion."),
    ];
    let mut turns = vec![turn(1, "system", None, "[event: start]", 0)];
    let mut at = 2_000i64;
    for (i, (who, text)) in script.iter().enumerate() {
        let words = metrics::word_count(text) as i64;
        let dur = words * 400 + 3_000;
        at += dur;
        let (speaker, panelist) = if *who == "a" {
            ("agent", Some("p1"))
        } else {
            ("user", None)
        };
        turns.push(turn(i as i32 + 2, speaker, panelist, text, at));
        at += 2_000;
    }
    ScoringInput {
        session_id: Uuid::new_v4().to_string(),
        mode: "interview".into(),
        round_id: "sde.system_design.full".into(),
        length: "full".into(),
        level: "mid".into(),
        style: "neutral".into(),
        voice: "fake".into(),
        panel: vec![PanelSeat {
            panelist_id: "p1".into(),
            persona_id: "persona.daniel".into(),
        }],
        started_at: Some("2026-11-13T09:00:00Z".parse().unwrap()),
        duration_sec: at / 1000,
        ended_reason: Some("completed".into()),
        question_id: Some("system_design.ticket_drop".into()),
        phases_completed: ["intro", "requirements", "api", "hld", "deep_dive", "wrap"]
            .map(String::from)
            .to_vec(),
        hints_given: 1,
        hint_max_level: 2,
        turns,
        board_text: Some("Components: CDN, load balancer, waiting room (virtual queue), seat map cache (Redis), seat service, Postgres (seats, holds, orders), hold sweeper, payment processor (external), webhook handler. Edges: client -> CDN -> load balancer -> waiting room -> seat service -> Postgres; seat map cache <- Postgres (rebuilt every second); payment processor -> webhook handler -> Postgres.".into()),
        ..ScoringInput::default()
    }
}

#[test]
fn enough_signal_is_sixty_seconds_in_a_short_round_and_ninety_in_a_full_one() {
    let s = |answers, speech_sec| metrics::Signal {
        answers,
        speech_sec,
    };
    assert!(s(2, 75.0).enough("short"));
    assert!(!s(2, 75.0).enough("full"));
    assert!(s(2, 60.0).enough("short"));
    assert!(!s(2, 59.0).enough("short"));
    assert!(s(3, 90.0).enough("full"));
    assert!(
        !s(1, 200.0).enough("short"),
        "one long answer is still one answer"
    );
}

#[tokio::test]
async fn a_scored_session_is_ledgered_once_even_through_the_metered_client() {
    let _serial = db_lock().lock().await;
    let db = pool().await;
    let data = common::temp_dir("data");
    let input = long_design_input();
    let id = insert_session(&db, &input).await;
    let since: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("select now()")
        .fetch_one(&db)
        .await
        .unwrap();
    let llm = ScriptedLlm::new(vec![Ok(model_output().to_string())]);
    // Production scoring goes through the app's metered client.
    let metered: Arc<dyn LlmApi> = Arc::new(ir_server::usage::MeteredLlm::new(
        llm.clone(),
        db.clone(),
        ir_server::config::UsagePhase::Build,
    ));
    let d = deps(&db, metered, &data);
    scoring::score_session(&d, id).await.unwrap();
    assert_eq!(llm.calls(), 1);
    // The metered client records in the background: give it time to (wrongly) do so.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let rows: Vec<(String, Option<i32>)> = sqlx::query_as(
        "select kind, input_tokens from usage_events where provider = 'anthropic' and created_at >= $1",
    )
    .bind(since)
    .fetch_all(&db)
    .await
    .unwrap();
    // One priced row per model call: the main call, and the card call (it failed, so an estimate). The metered
    // client adds only the zero-cost record of the card's failure (its error kind).
    let priced: Vec<_> = rows
        .iter()
        .filter(|r| r.0 != "model_error")
        .cloned()
        .collect();
    assert_eq!(priced.len(), 2, "one row per call: {rows:?}");
    assert_eq!(priced[0], ("scoring".to_string(), Some(9000)));
    assert_eq!(priced[1].0, "scoring_card");
    let failures = rows.iter().filter(|r| r.0 == "model_error").count();
    assert_eq!(failures, 1, "{rows:?}");
}

#[tokio::test]
async fn a_scoring_call_that_fails_still_counts_in_the_ledger() {
    let _serial = db_lock().lock().await;
    let db = pool().await;
    let data = common::temp_dir("data");
    let input = long_design_input();
    let id = insert_session(&db, &input).await;
    // Every call fails before it reports any usage (both attempts, and their card calls).
    let llm = ScriptedLlm::new(vec![
        Err(ClaudeError::BadRequest("overloaded".into())),
        Err(ClaudeError::BadRequest("overloaded".into())),
        Err(ClaudeError::BadRequest("overloaded".into())),
        Err(ClaudeError::BadRequest("overloaded".into())),
    ]);
    let d = deps(&db, llm.clone(), &data);
    assert!(scoring::score_session(&d, id).await.is_err());
    assert_eq!(status(&db, id).await, "failed");
    let rows: Vec<(String, Option<i32>, f64)> = sqlx::query_as(
        "select kind, input_tokens, cost_usd::float8 from usage_events \
         where session_id = $1 and provider = 'anthropic' and kind = 'scoring' order by id",
    )
    .bind(id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2, "two attempts: {rows:?}");
    for (_, tokens, cost) in &rows {
        assert!(
            tokens.unwrap_or(0) > 1000,
            "the request was estimated: {rows:?}"
        );
        assert!(*cost > 0.0, "and priced, so the caps see it: {rows:?}");
    }
}

// ---------- overload fallback (R62) ----------

#[tokio::test]
async fn second_attempt_runs_on_sonnet_after_an_overload() {
    let _serial = db_lock().lock().await;
    let db = pool().await;
    let data = common::temp_dir("data");
    let id = insert_session(&db, &long_design_input()).await;
    let llm = ScriptedLlm::new(vec![
        Err(ClaudeError::Overloaded),
        Ok(model_output().to_string()),
    ]);
    let d = deps(&db, llm.clone(), &data);
    scoring::score_session(&d, id).await.unwrap();
    assert_eq!(llm.main_models(), ["claude-opus-5-5", "claude-sonnet-5-5"]);
    assert_eq!(status(&db, id).await, "scored");
    // A bad answer (not an outage) keeps the scoring model for the second attempt.
    let id = insert_session(&db, &long_design_input()).await;
    let llm = ScriptedLlm::new(vec![
        Ok("{\"headline\": ".into()),
        Ok(model_output().to_string()),
    ]);
    let d = deps(&db, llm.clone(), &data);
    scoring::score_session(&d, id).await.unwrap();
    assert_eq!(llm.main_models(), ["claude-opus-5-5", "claude-opus-5-5"]);
}

#[tokio::test]
async fn headset_card_retries_on_the_fallback_when_its_model_is_down() {
    let env = Env::new();
    let llm = Arc::new(ScriptedLlm {
        replies: Mutex::new(vec![Ok(model_output().to_string())].into()),
        card: Mutex::new(Some(card_reply().to_string())),
        card_model_down: true,
        ..ScriptedLlm::default()
    });
    let slot = report::CardSlot::default();
    let input = design_input();
    let senv = env.score_env(llm.as_ref());
    let scored = report::score_with_card(&senv, &input, &slot).await.unwrap();
    assert_eq!(llm.card_models(), ["claude-sonnet-5-5", "claude-haiku-5-5"]);
    assert!(env.events.0.lock().unwrap().contains(&"card".to_string()));
    let card = scored
        .calls
        .iter()
        .find(|c| c.kind == "scoring_card")
        .expect("card call ledgered");
    assert_eq!(card.model, "claude-haiku-5-5");
}
