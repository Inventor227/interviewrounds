//! Meeting rehearsal: prepare, the hidden state update, chair rules and the attendee view, with the model replaced
//! by a scripted fake. Uses the real `content/` folder. Only the stored-plan test needs Postgres.

mod common;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::Extension;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use futures::StreamExt;
use futures::stream::{self, BoxStream};
use ir_server::api::meetings::{Caller, parse_setup};
use ir_server::claude::{
    ClaudeError, ContentBlock, Message, MessagesRequest, MessagesResponse, Role, StreamEvent, Usage,
};
use ir_server::content::Catalog;
use ir_server::meeting::live::{DECISION_LINE, turn_parts};
use ir_server::meeting::prepare::{ModelPlan, build_plan, build_request};
use ir_server::meeting::state::{ModelUpdate, UpdateContext, apply_update, decide, update};
use ir_server::meeting::{
    ConcernStatus, DecisionPower, MeetingPlan, MeetingSetup, MeetingState, Outcome, PREPARE_MODEL,
    prepare,
};
use ir_server::orchestrator::markers::UserInput;
use ir_server::orchestrator::prompt::{build_live_request, turn_note};
use ir_server::orchestrator::{
    Level, LiveSettings, LlmApi, Mode, NewSession, OrchestratorOptions, SessionSettings,
    SessionState, Style, ToolsMode, Turn, VoiceKind,
};
use ir_server::{AppState, router};
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

// ---------- fakes and helpers ----------

#[derive(Default)]
struct FakeLlm {
    creates: Mutex<VecDeque<Result<MessagesResponse, ClaudeError>>>,
    created: Mutex<Vec<MessagesRequest>>,
    streams: Mutex<VecDeque<Vec<StreamEvent>>>,
    streamed: Mutex<Vec<MessagesRequest>>,
}

impl FakeLlm {
    fn new() -> Arc<Self> {
        Arc::new(FakeLlm::default())
    }
    fn create_json(&self, text: String) {
        self.creates.lock().unwrap().push_back(Ok(response(text)));
    }
    fn create_err(&self) {
        self.creates
            .lock()
            .unwrap()
            .push_back(Err(ClaudeError::Overloaded));
    }
    fn reply(&self, text: &str) {
        self.streams.lock().unwrap().push_back(vec![
            StreamEvent::TextDelta(text.into()),
            StreamEvent::Stop {
                reason: "end_turn".into(),
                usage: Usage::default(),
            },
        ]);
    }
    fn created(&self) -> Vec<MessagesRequest> {
        self.created.lock().unwrap().clone()
    }
    fn streamed(&self) -> Vec<MessagesRequest> {
        self.streamed.lock().unwrap().clone()
    }
}

fn response(text: String) -> MessagesResponse {
    MessagesResponse {
        id: "msg_test".into(),
        model: "test-model".into(),
        content: vec![ContentBlock::text(text)],
        stop_reason: Some("end_turn".into()),
        usage: Usage::default(),
    }
}

#[async_trait]
impl LlmApi for FakeLlm {
    async fn create(&self, req: &MessagesRequest) -> Result<MessagesResponse, ClaudeError> {
        self.created.lock().unwrap().push(req.clone());
        self.creates
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(ClaudeError::BadRequest("create is not scripted".into())))
    }

    async fn stream(
        &self,
        req: &MessagesRequest,
    ) -> Result<BoxStream<'static, Result<StreamEvent, ClaudeError>>, ClaudeError> {
        self.streamed.lock().unwrap().push(req.clone());
        match self.streams.lock().unwrap().pop_front() {
            Some(events) => Ok(stream::iter(events.into_iter().map(Ok)).boxed()),
            None => Err(ClaudeError::BadRequest("no stream scripted".into())),
        }
    }
}

fn catalog() -> Catalog {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../content");
    Catalog::load(&dir).expect("real content loads")
}

fn setup(v: Value) -> MeetingSetup {
    serde_json::from_value(v).expect("setup parses")
}

fn exec_setup() -> MeetingSetup {
    setup(json!({
        "template_id": "exec_update",
        "goal": "Get approval to move one engineer from the payments team for six weeks.",
        "user_role": "Engineering lead for the mobile launch",
        "attendees": [
            {"name": "Dana", "role": "VP of Engineering", "cares_about": ["launch date", "bottom line first"],
             "personality": "skeptical", "decision_power": "approver"},
            {"name": "Owen", "role": "Payments lead", "cares_about": ["his team's roadmap"], "personality": "neutral",
             "likely_objections": ["Losing an engineer delays the refunds work"]}
        ],
        "length": "short",
        "key_facts": ["Launch is slipping 3 weeks", "One extra engineer brings it back to 1 week late"],
        "ask": "One payments engineer for six weeks",
        "difficulty": "realistic"
    }))
}

fn pitch_setup() -> MeetingSetup {
    setup(json!({
        "template_id": "investor_pitch",
        "goal": "Get a partner meeting next week to discuss terms for our seed round.",
        "user_role": "Founder and CEO",
        "attendees": [
            {"name": "Rhea", "role": "Partner, seed fund", "cares_about": ["market size", "why now"],
             "personality": "skeptical", "decision_power": "approver",
             "likely_objections": ["Clinic software is a crowded market"], "voice_base": "persona.ana"},
            {"name": "Tom", "role": "Associate", "cares_about": ["churn", "use of funds"], "personality": "neutral",
             "likely_objections": ["What is your monthly churn?"], "voice_base": "persona.leo"}
        ],
        "length": "short",
        "key_facts": ["Monthly churn: 2 percent", "Revenue: 16,000 dollars per month"],
        "difficulty": "realistic"
    }))
}

fn review_setup() -> MeetingSetup {
    setup(json!({
        "template_id": "performance_review",
        "goal": "Ravi understands the impact of missed code review deadlines and agrees a plan to fix it.",
        "user_role": "Engineering manager",
        "attendees": [
            {"name": "Ravi", "role": "Senior Software Engineer", "cares_about": ["fairness"],
             "personality": "skeptical", "decision_power": "approver",
             "likely_objections": ["Nobody told me this was a problem"], "voice_base": "persona.daniel"}
        ],
        "length": "short",
        "difficulty": "realistic"
    }))
}

fn model_attendee(name: &str, objections: &[&str], concerns: &[&str], stance: i64) -> Value {
    json!({
        "name": name,
        "role": "whatever the model wrote",
        "cares_about": ["something the model added"],
        "personality": "neutral",
        "likely_objections": objections,
        "decision_power": "influencer",
        "knows": "Read the summary email.",
        "stance": stance,
        "concerns": concerns.iter().enumerate().map(|(i, c)| json!({"id": format!("x{i}"), "text": c, "status": "open"})).collect::<Vec<_>>(),
        "patience": 9
    })
}

fn model_plan(
    user_chairs: bool,
    chair: Option<&str>,
    attendees: Vec<Value>,
    opening: &str,
) -> Value {
    json!({
        "user_chairs": user_chairs,
        "chair_attendee": chair,
        "attendees": attendees,
        "opening_line": opening,
        "success_criteria": ["Dana approves the move with a start date."],
        "tips": ["Lead with the ask \u{2014} then the date.", "Have the bug numbers ready.", "Ask for a decision."]
    })
}

fn parse_model(v: &Value) -> ModelPlan {
    serde_json::from_value(v.clone()).unwrap()
}

fn pitch_plan(catalog: &Catalog) -> (MeetingSetup, MeetingPlan) {
    let s = pitch_setup();
    let m = parse_model(&model_plan(
        false,
        Some("Rhea"),
        vec![
            model_attendee(
                "Rhea",
                &[],
                &["Market size and how it was calculated", "Why this team"],
                -1,
            ),
            model_attendee("Tom", &[], &["Churn on a young cohort"], 0),
        ],
        "Thanks for coming in. Over to you.",
    ));
    let plan = build_plan(catalog, &s, Some(&m)).unwrap();
    (s, plan)
}

fn live() -> LiveSettings {
    LiveSettings {
        model: "claude-sonnet-5-5".into(),
        fast_model: "claude-sonnet-5-5".into(),
        effort: "low".into(),
        max_tokens: 300,
        tools: ToolsMode::Inline,
    }
}

fn meeting_session(id: &str, catalog: &Catalog, meeting: MeetingState) -> SessionState {
    SessionState::new(
        NewSession {
            id: id.into(),
            identity_id: "guest-1".into(),
            mode: Mode::Meeting,
            round_id: "meeting.short".into(),
            settings: SessionSettings {
                level: Level::Mid,
                style: Style::Neutral,
                voice: VoiceKind::Fake,
            },
            panel: Vec::new(),
            question_id: None,
            meeting: Some(meeting),
        },
        catalog,
        live(),
        Instant::now(),
    )
    .expect("meeting session builds")
}

/// Moves the session clock so that `remaining_s` seconds are left in the round.
fn with_remaining(st: &mut SessionState, remaining_s: u64) {
    let elapsed = (st.round.target_minutes * 60.0) as u64 - remaining_s;
    st.started_at = Instant::now() - Duration::from_secs(elapsed);
}

fn note(st: &SessionState, panelist: &str) -> String {
    turn_note(
        st,
        panelist,
        &UserInput::Speech("We grew fifteen percent a month.".into()),
        Instant::now(),
    )
    .0
}

fn update_json(attendees: Vec<Value>, ask_made: bool) -> Value {
    json!({
        "attendees": attendees,
        "next_speaker": "Tom",
        "next_speaker_instruction": "Ask what the churn number is based on.",
        "user_contradiction": null,
        "ask_made": ask_made,
        "ask_text": if ask_made { "A partner meeting next week" } else { "" },
        "next_steps": [],
        "decision_guidance": {"outcome": "need_more_info", "reason": "I need the market math.", "conditions": [], "missing_info": ["How the market size was worked out"]},
        "below_walk_away": null
    })
}

fn att_update(name: &str, stance: i64, patience: i64, concerns: Vec<(&str, &str)>) -> Value {
    json!({
        "name": name,
        "stance": stance,
        "stance_reason": "Gave a real number.",
        "patience": patience,
        "concerns": concerns.iter().map(|(id, st)| json!({"id": id, "text": "ignored", "status": st, "evidence_quote": "two percent a month"})).collect::<Vec<_>>()
    })
}

fn raw_update(v: Value) -> ModelUpdate {
    serde_json::from_value(v).unwrap()
}

const SECRET: &str = "test-llm-secret";

fn test_app(llm: Arc<FakeLlm>, catalog: Catalog) -> (Router, AppState) {
    let url = "postgres://nobody:nothing@127.0.0.1:1/none";
    let pool = PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(200))
        .connect_lazy(url)
        .unwrap();
    let cfg = common::test_config(url, &common::temp_dir("public"));
    let opts = OrchestratorOptions {
        first_text_timeout: Duration::from_millis(500),
        retry_first_text_timeout: Duration::from_millis(500),
        confirm_speech_turns: false,
        ..OrchestratorOptions::default()
    };
    let state = AppState::new(pool, cfg)
        .with_llm(llm)
        .with_catalog(catalog)
        .with_orchestrator_options(opts);
    (router(state.clone()), state)
}

async fn say(app: &Router, session: &str, panelist: &str, messages: Value) -> String {
    let body = json!({
        "model": "ir-live",
        "stream": true,
        "messages": messages,
        "fishaudio_extra_body": {"session_id": session, "panelist_id": panelist}
    });
    let res = app
        .clone()
        .oneshot(
            Request::post("/v1/chat/completions")
                .header(header::AUTHORIZATION, format!("Bearer {SECRET}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let raw = String::from_utf8(common::body_bytes(res).await).unwrap();
    raw.lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter(|d| *d != "[DONE]")
        .filter_map(|d| serde_json::from_str::<Value>(d).ok())
        .filter_map(|c| {
            c["choices"][0]["delta"]["content"]
                .as_str()
                .map(str::to_string)
        })
        .collect()
}

fn last_note(req: &MessagesRequest) -> String {
    req.messages
        .iter()
        .rev()
        .find(|m| m.role == Role::System)
        .map(Message::text)
        .unwrap_or_default()
}

// ---------- the brief's tests ----------

#[tokio::test]
async fn prepare_fills_missing_objections_only() {
    let catalog = catalog();
    let llm = FakeLlm::new();
    llm.create_json(
        model_plan(
            false,
            Some("Dana"),
            vec![
                model_attendee(
                    "Dana",
                    &[
                        "What exactly do you need from me?",
                        "Why is this only coming up now?",
                        "What slips if I say no?",
                    ],
                    &[
                        "No clear ask in the first minute",
                        "Why the slip was not flagged earlier",
                    ],
                    -1,
                ),
                // The model rewords the user's objection; the user's words must win.
                model_attendee(
                    "Owen",
                    &["Losing an engineer will delay refunds", "Another one"],
                    &["Refunds slip"],
                    0,
                ),
            ],
            "Thanks for coming, everyone. Over to you.",
        )
        .to_string(),
    );
    let plan = prepare(llm.as_ref(), &catalog, &exec_setup())
        .await
        .unwrap();

    let dana = &plan.attendees[0];
    let owen = &plan.attendees[1];
    assert_eq!(
        dana.likely_objections,
        vec![
            "What exactly do you need from me?",
            "Why is this only coming up now?",
            "What slips if I say no?"
        ],
        "missing objections are filled, up to three"
    );
    assert_eq!(
        owen.likely_objections,
        vec!["Losing an engineer delays the refunds work"],
        "the user's objection is kept verbatim and nothing is added"
    );
    // Every other field the user filled stays as written.
    assert_eq!(dana.role, "VP of Engineering");
    assert_eq!(owen.cares_about, vec!["his team's roadmap"]);
    // Hidden state: stance by the rules, concerns open with ids, patience.
    assert_eq!(dana.hidden.stance, -1);
    assert_eq!(dana.hidden.patience, 2);
    assert_eq!(dana.hidden.concerns[0].id, "dana_1");
    assert!(
        dana.hidden
            .concerns
            .iter()
            .all(|c| c.status == ConcernStatus::Open)
    );
    // Tips are plain copy.
    assert!(
        plan.tips.iter().all(|t| !t.contains('\u{2014}')),
        "{:?}",
        plan.tips
    );
    assert_eq!(plan.tips.len(), 3);

    // One call on the prepare model with structured output.
    let reqs = llm.created();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].model, PREPARE_MODEL);
    let oc = reqs[0].output_config.as_ref().unwrap();
    assert_eq!(oc.effort.as_deref(), Some("medium"));
    assert_eq!(oc.format.as_ref().unwrap()["type"], "json_schema");
    assert!(
        reqs[0].system[0]
            .text
            .contains("Get approval to move one engineer")
    );

    // The public plan hides the hidden block but keeps the suggestions.
    let public = plan.public();
    assert!(public["attendees"][0].get("hidden").is_none());
    assert_eq!(
        public["attendees"][0]["likely_objections"][0],
        "What exactly do you need from me?"
    );
}

#[tokio::test]
async fn state_update_moves_stance_within_bounds() {
    let catalog = catalog();
    let (s, plan) = pitch_plan(&catalog);
    let state = MeetingState::from_parts(&s, &plan);
    let rhea = state.attendee("Rhea").unwrap().clone();
    let tom = state.attendee("Tom").unwrap().clone();
    assert_eq!((rhea.stance, tom.stance), (-1, 0));

    let llm = FakeLlm::new();
    // The model tries to jump Rhea from -1 to +2 and Tom from 0 to -5.
    llm.create_json(
        update_json(
            vec![
                att_update("Rhea", 2, 0, vec![(&rhea.concerns[0].id, "resolved")]),
                att_update("Tom", -5, 7, vec![]),
            ],
            false,
        )
        .to_string(),
    );
    let exchange = vec![
        Turn {
            speaker: "p1".into(),
            text: "How big is this market?".into(),
            at_ms: 30_000,
            interrupted: false,
            heard: None,
        },
        Turn {
            speaker: "candidate".into(),
            text: "Forty thousand clinics at four hundred a month.".into(),
            at_ms: 40_000,
            interrupted: false,
            heard: None,
        },
    ];
    let ctx = UpdateContext {
        model: "claude-sonnet-5-5".into(),
        phase_id: "questions".into(),
        minutes_left: 5.0,
        decision_phase_started: false,
    };
    let next = update(llm.as_ref(), &catalog, &state, &exchange, &ctx)
        .await
        .unwrap();
    let rhea2 = next.attendee("Rhea").unwrap();
    let tom2 = next.attendee("Tom").unwrap();
    assert_eq!(rhea2.stance, 0, "one step up at most");
    assert_eq!(tom2.stance, -1, "one step down at most");
    assert_eq!(rhea2.concerns[0].status, ConcernStatus::Resolved);
    assert_eq!(rhea2.concerns[0].evidence_quote, "two percent a month");
    assert_eq!(
        rhea2.patience, rhea2.patience_start,
        "a resolved concern resets patience"
    );
    assert!(
        tom2.patience <= tom2.patience_start,
        "patience never above its start"
    );
    assert_eq!(rhea2.turns_silent, 0, "Rhea spoke");
    assert_eq!(tom2.turns_silent, 1, "Tom did not");
    assert_eq!(next.next_speaker.as_deref(), Some("Tom"));

    // The request: fast model, structured output, the exchange with names.
    let req = &llm.created()[0];
    assert_eq!(req.model, "claude-sonnet-5-5");
    assert!(req.output_config.as_ref().unwrap().format.is_some());
    let prompt = &req.system[0].text;
    assert!(
        prompt.contains("[30s] Rhea: How big is this market?"),
        "{prompt}"
    );
    assert!(
        prompt.contains("[40s] User: Forty thousand clinics"),
        "{prompt}"
    );

    // Repeated pushes never leave -2..2.
    let mut st = next;
    for _ in 0..6 {
        let raw = raw_update(update_json(
            vec![
                att_update("Rhea", 9, 0, vec![]),
                att_update("Tom", -9, 0, vec![]),
            ],
            false,
        ));
        st = apply_update(&st, &raw, &[], false);
    }
    assert_eq!(st.attendee("Rhea").unwrap().stance, 2);
    assert_eq!(st.attendee("Tom").unwrap().stance, -2);
}

#[test]
fn chair_forces_decision_in_last_two_minutes() {
    let catalog = catalog();
    let (s, plan) = pitch_plan(&catalog);
    assert_eq!(plan.chair_attendee.as_deref(), Some("Rhea"));
    let mut st = meeting_session("m-chair", &catalog, MeetingState::from_parts(&s, &plan));
    let rhea = st
        .meeting
        .as_ref()
        .unwrap()
        .attendee("Rhea")
        .unwrap()
        .panelist_id
        .clone();
    let tom = st
        .meeting
        .as_ref()
        .unwrap()
        .attendee("Tom")
        .unwrap()
        .panelist_id
        .clone();

    with_remaining(&mut st, 200);
    assert!(
        !note(&st, &rhea).contains(DECISION_LINE),
        "not yet with more than two minutes left"
    );

    with_remaining(&mut st, 100);
    let chair_note = note(&st, &rhea);
    assert!(chair_note.contains(DECISION_LINE), "{chair_note}");
    assert!(
        chair_note.contains("Force the decision now"),
        "{chair_note}"
    );
    // Another attendee holding the floor passes it to the chair with that line.
    let tom_note = note(&st, &tom);
    assert!(
        tom_note.contains(&format!("Hand over to Rhea (panelist id {rhea})")),
        "{tom_note}"
    );
    assert!(tom_note.contains(DECISION_LINE));
    // Only the attendee's own hidden state is in its note.
    assert!(tom_note.contains("You are Tom"));
    assert!(
        !tom_note.contains("Market size and how it was calculated"),
        "{tom_note}"
    );

    // Once the decision phase has started, the chair is not told again.
    st.phase_idx = 2;
    assert!(!note(&st, &rhea).contains("Force the decision now"));
}

#[test]
fn setup_requires_goal_and_one_attendee() {
    let mut v = serde_json::to_value(exec_setup()).unwrap();
    v["goal"] = json!("   ");
    let err = parse_setup(v.to_string().as_bytes()).unwrap_err();
    assert_eq!(err.to_string(), "Say what you want from this meeting.");

    let mut v = serde_json::to_value(exec_setup()).unwrap();
    v["attendees"] = json!([]);
    let err = parse_setup(v.to_string().as_bytes()).unwrap_err();
    assert_eq!(err.to_string(), "Add at least one attendee.");

    let mut v = serde_json::to_value(exec_setup()).unwrap();
    v.as_object_mut().unwrap().remove("goal");
    assert!(
        parse_setup(v.to_string().as_bytes()).is_err(),
        "goal is required"
    );

    let mut v = serde_json::to_value(exec_setup()).unwrap();
    v["attendees"][1]["name"] = json!("dana");
    assert!(
        parse_setup(v.to_string().as_bytes())
            .unwrap_err()
            .to_string()
            .contains("different name")
    );

    assert!(parse_setup(serde_json::to_string(&exec_setup()).unwrap().as_bytes()).is_ok());
}

// ---------- chair, user chairs, voices ----------

#[test]
fn chair_is_checked_against_the_attendees() {
    let catalog = catalog();
    let s = exec_setup();
    let plan_with = |chair: Option<&str>| {
        let m = parse_model(&model_plan(false, chair, vec![], "Over to you."));
        build_plan(&catalog, &s, Some(&m)).unwrap()
    };
    // The approver may chair.
    let p = plan_with(Some("dana"));
    assert_eq!(p.chair_attendee.as_deref(), Some("Dana"));
    assert_eq!(p.attendees.len(), 2);
    // Someone not in the meeting, or an attendee who is not the approver: Grace joins to chair.
    for bad in [Some("Bob"), Some("Owen"), None] {
        let p = plan_with(bad);
        assert_eq!(p.chair_attendee.as_deref(), Some("Grace"), "{bad:?}");
        assert_eq!(p.attendees.len(), 3);
        let grace = p.attendees.last().unwrap();
        assert_eq!(grace.hidden.persona_id, "persona.grace");
        assert_eq!(grace.decision_power, DecisionPower::Observer);
    }
    // With three attendees already, the approver chairs.
    let mut v = serde_json::to_value(exec_setup()).unwrap();
    v["attendees"].as_array_mut().unwrap().push(json!({
        "name": "Lee", "role": "QA lead", "cares_about": ["bug count"], "personality": "neutral"
    }));
    let s3: MeetingSetup = serde_json::from_value(v).unwrap();
    let m = parse_model(&model_plan(false, Some("Lee"), vec![], "Over to you."));
    let p = build_plan(&catalog, &s3, Some(&m)).unwrap();
    assert_eq!(p.chair_attendee.as_deref(), Some("Dana"));
    assert_eq!(p.attendees.len(), 3);
}

#[tokio::test]
async fn user_chairs_meeting_has_no_ai_chair() {
    let catalog = catalog();
    let llm = FakeLlm::new();
    // The model gets it wrong; the template decides.
    llm.create_json(
        model_plan(
            false,
            Some("Ravi"),
            vec![model_attendee("Ravi", &[], &["Whether this is fair"], -1)],
            "Hey, thanks for setting this up. I figured this was about the migration?",
        )
        .to_string(),
    );
    let plan = prepare(llm.as_ref(), &catalog, &review_setup())
        .await
        .unwrap();
    assert!(plan.user_chairs);
    assert_eq!(plan.chair_attendee, None);
    assert_eq!(plan.attendees.len(), 1, "Grace is never added");
    assert_eq!(
        plan.attendees[0].hidden.persona_id, "persona.daniel",
        "the template's voice is kept"
    );
    let as_json = serde_json::to_value(&plan).unwrap();
    assert_eq!(as_json["chair_attendee"], Value::Null);

    let mut st = meeting_session(
        "m-user",
        &catalog,
        MeetingState::from_parts(&review_setup(), &plan),
    );
    let ravi = st.panel[0].panelist_id.clone();
    assert_eq!(st.floor, ravi, "the decision maker holds the floor first");
    assert_eq!(st.panel[0].persona.display_name, "Ravi");
    let system = &st.panel[0].system[0].text;
    assert!(
        system.contains("The user runs this meeting, not you"),
        "user_chairs section"
    );
    assert!(
        !system.contains("You are also the chair"),
        "no chair section"
    );

    with_remaining(&mut st, 60);
    let n = note(&st, &ravi);
    assert!(!n.contains(DECISION_LINE), "{n}");
    assert!(!n.contains("two minutes"), "{n}");
    assert!(n.contains("The user runs this meeting"), "{n}");
    assert!(n.contains("ask what they want from you"), "{n}");
}

#[test]
fn voices_are_unique_and_balanced() {
    let catalog = catalog();
    let s = setup(json!({
        "template_id": null,
        "goal": "Agree the budget for next year.",
        "user_role": "Finance lead",
        "attendees": [
            {"name": "Ana", "role": "CFO", "cares_about": ["cash"], "personality": "skeptical", "decision_power": "approver"},
            {"name": "Bo", "role": "COO", "cares_about": ["hiring"], "personality": "skeptical"},
            {"name": "Cy", "role": "CTO", "cares_about": ["cloud costs"], "personality": "skeptical", "voice_base": "persona.maya"}
        ],
        "length": "short"
    }));
    let plan = build_plan(&catalog, &s, None).unwrap();
    let personas: Vec<&str> = plan
        .attendees
        .iter()
        .map(|a| a.hidden.persona_id.as_str())
        .collect();
    let avatars: Vec<&str> = plan
        .attendees
        .iter()
        .map(|a| a.hidden.avatar_id.as_str())
        .collect();
    let voices: Vec<&str> = plan
        .attendees
        .iter()
        .map(|a| a.hidden.voice_id.as_str())
        .collect();
    for list in [&personas, &avatars, &voices] {
        let mut d = list.to_vec();
        d.sort();
        d.dedup();
        assert_eq!(d.len(), list.len(), "no duplicates in {list:?}");
    }
    assert_eq!(personas[2], "persona.maya", "the user's voice_base is kept");
    assert!(
        !personas.contains(&"persona.grace"),
        "Grace is kept for the chair"
    );
    assert!(!avatars.contains(&"f01") || personas[2] == "persona.maya");
    // Both voice genders appear (no guess from names).
    assert!(
        avatars.iter().any(|a| a.starts_with('f')) && avatars.iter().any(|a| a.starts_with('m')),
        "{avatars:?}"
    );
    // Three attendees: the approver chairs.
    assert_eq!(plan.chair_attendee.as_deref(), Some("Ana"));
}

#[tokio::test]
async fn prepare_without_the_model_still_builds_a_plan() {
    let catalog = catalog();
    let llm = FakeLlm::new();
    llm.create_err();
    let plan = prepare(llm.as_ref(), &catalog, &pitch_setup())
        .await
        .unwrap();
    assert_eq!(
        plan.attendees[0].likely_objections,
        vec!["Clinic software is a crowded market"]
    );
    assert!(!plan.opening_line.is_empty());
    assert_eq!(plan.tips.len(), 3);
    assert_eq!(plan.chair_attendee.as_deref(), Some("Grace"));
}

#[test]
fn prepare_request_never_leaks_into_attendee_prompts() {
    let catalog = catalog();
    let mut v = serde_json::to_value(pitch_setup()).unwrap();
    v["walk_away"] = json!("No less than 1.2 million");
    let s: MeetingSetup = serde_json::from_value(v).unwrap();
    assert!(build_request(&catalog, &s).is_some());
    let m = parse_model(&model_plan(
        false,
        Some("Rhea"),
        vec![model_attendee(
            "Rhea",
            &[],
            &["Will they take less than 1.2 million?", "Market size"],
            -1,
        )],
        "Over to you.",
    ));
    let plan = build_plan(&catalog, &s, Some(&m)).unwrap();
    let texts: Vec<&str> = plan.attendees[0]
        .hidden
        .concerns
        .iter()
        .map(|c| c.text.as_str())
        .collect();
    assert_eq!(
        texts,
        vec!["Market size"],
        "generated text naming the walk away is dropped"
    );
    let st = meeting_session("m-walk", &catalog, MeetingState::from_parts(&s, &plan));
    for p in &st.panel {
        assert!(!p.system[0].text.contains("1.2 million"));
    }
}

// ---------- outcome ----------

#[test]
fn outcome_follows_the_approver() {
    let catalog = catalog();
    let (s, plan) = pitch_plan(&catalog);
    let mut st = MeetingState::from_parts(&s, &plan);
    // Rhea starts skeptical: not now.
    assert_eq!(decide(&st, false), Outcome::NotNow);
    let rhea = st.attendees.iter_mut().find(|a| a.name == "Rhea").unwrap();
    rhea.stance = 0;
    assert_eq!(decide(&st, false), Outcome::NeedInfo);
    let rhea = st.attendees.iter_mut().find(|a| a.name == "Rhea").unwrap();
    for c in &mut rhea.concerns {
        c.status = ConcernStatus::Partly;
    }
    assert_eq!(decide(&st, false), Outcome::WithConditions);
    let rhea = st.attendees.iter_mut().find(|a| a.name == "Rhea").unwrap();
    rhea.stance = 1;
    for c in &mut rhea.concerns {
        c.status = ConcernStatus::Resolved;
    }
    assert_eq!(decide(&st, false), Outcome::Approved);
    // No ask by the decision phase: not now, however well it went.
    assert_eq!(decide(&st, true), Outcome::NotNow);
    st.ask_made = true;
    assert_eq!(decide(&st, true), Outcome::Approved);
    assert_eq!(
        serde_json::to_value(Outcome::WithConditions).unwrap(),
        "approved_with_conditions"
    );
}

// ---------- the live session ----------

#[test]
fn each_attendee_sees_the_others_as_said_lines() {
    let catalog = catalog();
    let (s, plan) = pitch_plan(&catalog);
    let mut st = meeting_session("m-view", &catalog, MeetingState::from_parts(&s, &plan));
    let rhea = st
        .meeting
        .as_ref()
        .unwrap()
        .attendee("Rhea")
        .unwrap()
        .panelist_id
        .clone();
    let tom = st
        .meeting
        .as_ref()
        .unwrap()
        .attendee("Tom")
        .unwrap()
        .panelist_id
        .clone();
    // Rhea asks, the user answers, Tom asks.
    st.history.push(Message::user_text("[event: start]"));
    st.history.push(Message::system_text("Rhea's private note"));
    st.push_message(&rhea, Message::assistant_text("How big is the market?"));
    st.history
        .push(Message::user_text("Forty thousand clinics."));
    st.history.push(Message::system_text("Tom's private note"));
    st.push_message(&tom, Message::assistant_text("What's your churn?"));

    let req = build_live_request(
        &st,
        &rhea,
        &UserInput::Speech("Two percent.".into()),
        Instant::now(),
    );
    let texts: Vec<(Role, String)> = req.messages.iter().map(|m| (m.role, m.text())).collect();
    assert!(
        texts.contains(&(Role::Assistant, "How big is the market?".into())),
        "own line stays hers"
    );
    assert!(
        texts.contains(&(Role::User, "Tom said: \"What's your churn?\"".into())),
        "{texts:?}"
    );
    assert!(
        !texts
            .iter()
            .any(|(r, t)| *r == Role::Assistant && t.contains("churn"))
    );
    assert!(!texts.iter().any(|(_, t)| t.contains("Tom's private note")));

    let req = build_live_request(
        &st,
        &tom,
        &UserInput::Speech("Two percent.".into()),
        Instant::now(),
    );
    let texts: Vec<(Role, String)> = req.messages.iter().map(|m| (m.role, m.text())).collect();
    assert!(
        texts.contains(&(Role::User, "Rhea said: \"How big is the market?\"".into())),
        "{texts:?}"
    );
    assert!(texts.contains(&(Role::Assistant, "What's your churn?".into())));
    assert!(!texts.iter().any(|(_, t)| t.contains("Rhea's private note")));
    // A system note is always followed by an assistant turn or is last.
    for (i, m) in req.messages.iter().enumerate() {
        if m.role == Role::System {
            let next = req.messages.get(i + 1);
            assert!(
                next.is_none() || next.unwrap().role == Role::Assistant,
                "note at {i} followed by {:?}",
                next.map(|n| n.role)
            );
        }
    }
}

#[tokio::test]
async fn opening_line_then_background_update_feeds_the_next_note() {
    let catalog = catalog();
    let llm = FakeLlm::new();
    let (router, app) = test_app(llm.clone(), catalog.clone());
    let (s, plan) = pitch_plan(&catalog);
    let st = meeting_session("m-live", &catalog, MeetingState::from_parts(&s, &plan));
    let rhea = st.floor.clone();
    let rhea_first_concern = st
        .meeting
        .as_ref()
        .unwrap()
        .attendee("Rhea")
        .unwrap()
        .concerns[0]
        .clone();
    let session = app.registry.insert(st);

    // [event: start]: the chair speaks the plan's opening line, no model call.
    let said = say(
        &router,
        "m-live",
        &rhea,
        json!([{"role": "user", "content": "[event: start]"}]),
    )
    .await;
    assert_eq!(said, "Thanks for coming in. Over to you.");
    assert!(llm.streamed().is_empty());

    // The user answers; the live reply streams while the state update runs in the background.
    llm.reply("Okay. How did you size the market?");
    llm.create_json(
        update_json(
            vec![att_update(
                "Rhea",
                0,
                2,
                vec![(&rhea_first_concern.id, "partly")],
            )],
            true,
        )
        .to_string(),
    );
    let said = say(
        &router,
        "m-live",
        &rhea,
        json!([
            {"role": "user", "content": "[event: start]"},
            {"role": "assistant", "content": "Thanks for coming in. Over to you."},
            {"role": "user", "content": "We want a partner meeting next week. Forty thousand clinics at four hundred a month."}
        ]),
    )
    .await;
    assert_eq!(said, "Okay. How did you size the market?");
    for _ in 0..100 {
        if session.lock().await.meeting.as_ref().unwrap().updates > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    {
        let st = session.lock().await;
        let m = st.meeting.as_ref().unwrap();
        assert_eq!(m.updates, 1, "the update landed");
        assert!(m.ask_made);
        let r = m.attendee("Rhea").unwrap();
        assert_eq!(r.stance, 0);
        assert_eq!(r.concerns[0].status, ConcernStatus::Partly);
    }
    let update_req = llm
        .created()
        .into_iter()
        .find(|r| {
            r.system
                .first()
                .is_some_and(|s| s.text.contains("You track the hidden state"))
        })
        .expect("state update request");
    assert!(
        update_req.system[0]
            .text
            .contains("[0s] Rhea: Thanks for coming in. Over to you."),
        "{}",
        update_req.system[0].text
    );

    // The next turn's note carries the new state.
    llm.reply("What's the basis for forty thousand?");
    llm.create_json(update_json(vec![], true).to_string());
    say(
        &router,
        "m-live",
        &rhea,
        json!([
            {"role": "user", "content": "We want a partner meeting next week. Forty thousand clinics at four hundred a month."},
            {"role": "assistant", "content": "Okay. How did you size the market?"},
            {"role": "user", "content": "Bottom up, from state registries."}
        ]),
    )
    .await;
    let reqs = llm.streamed();
    let n = last_note(reqs.last().unwrap());
    assert!(n.contains("undecided"), "stance moved: {n}");
    assert!(n.contains("(partly answered)"), "{n}");
    assert!(
        n.contains("The user has made the ask: \"A partner meeting next week\""),
        "{n}"
    );
}

// ---------- the endpoint ----------

#[tokio::test]
async fn prepare_route_needs_a_caller_and_a_valid_setup() {
    let llm = FakeLlm::new();
    let (router, _) = test_app(llm.clone(), catalog());
    let post = |body: String, caller: bool| {
        let r = if caller {
            router.clone().layer(Extension(Caller {
                identity_id: uuid::Uuid::new_v4(),
            }))
        } else {
            router.clone()
        };
        async move {
            r.oneshot(
                Request::post("/api/meetings/prepare")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap()
        }
    };
    let res = post(serde_json::to_string(&exec_setup()).unwrap(), false).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let mut v = serde_json::to_value(exec_setup()).unwrap();
    v["goal"] = json!("");
    let res = post(v.to_string(), true).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = common::body_json(res).await;
    assert_eq!(body["message"], "Say what you want from this meeting.");
    assert!(
        llm.created().is_empty(),
        "no model call for an invalid setup"
    );
}

#[tokio::test]
async fn prepare_stores_the_plan_and_returns_it_without_hidden_state() {
    let url = common::database_url();
    let pool = ir_server::db::connect_url(&url).await.expect("database");
    let identity: uuid::Uuid =
        sqlx::query_scalar("insert into identities (kind) values ('guest') returning id")
            .fetch_one(&pool)
            .await
            .unwrap();
    let llm = FakeLlm::new();
    llm.create_json(
        model_plan(
            false,
            Some("Rhea"),
            vec![model_attendee("Rhea", &[], &["Market size"], -1)],
            "Over to you.",
        )
        .to_string(),
    );
    let cfg = common::test_config(&url, &common::temp_dir("public"));
    let state = AppState::new(pool.clone(), cfg)
        .with_llm(llm)
        .with_catalog(catalog());
    let app = router(state).layer(Extension(Caller {
        identity_id: identity,
    }));
    let res = app
        .oneshot(
            Request::post("/api/meetings/prepare")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_string(&pitch_setup()).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = common::body_json(res).await;
    let id: uuid::Uuid = body["meeting_plan_id"].as_str().unwrap().parse().unwrap();
    assert!(!body.to_string().contains("\"hidden\""), "{body}");
    for key in [
        "persona_id",
        "avatar_id",
        "voice_id",
        "stance",
        "concerns",
        "patience",
    ] {
        assert!(
            !body.to_string().contains(key),
            "{key} stays on the server: {body}"
        );
    }
    assert_eq!(
        body["plan"]["attendees"][1]["likely_objections"][0],
        "What is your monthly churn?"
    );
    let stored: Value = sqlx::query_scalar("select plan from meeting_plans where id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        stored["attendees"][0]["hidden"]["persona_id"],
        "persona.ana"
    );

    let loaded = ir_server::api::meetings::load_meeting(&pool, id, identity)
        .await
        .unwrap();
    assert_eq!(loaded.attendees.len(), 2, "Rhea chairs, so no Grace");
    assert_eq!(loaded.chair.as_deref(), Some("Rhea"));
    assert!(
        ir_server::api::meetings::load_meeting(&pool, id, uuid::Uuid::new_v4())
            .await
            .is_err()
    );
}

// ---------- live model (run by hand) ----------

/// `remote.sh ... --env-file .secrets/llm-anthropic.env -- cargo test --test meeting -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn live_prepare_investor_pitch() {
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY");
    let ws = std::env::var("ANTHROPIC_WORKSPACE_ID").expect("ANTHROPIC_WORKSPACE_ID");
    let client = ir_server::claude::ClaudeClient::with_base_url(
        &key,
        &ws,
        ir_server::claude::DEFAULT_BASE_URL,
    );
    let catalog = catalog();
    // The judge path: the investor template as the setup page pre-fills it, with one attendee left for the model.
    let template = catalog.templates.get("investor_pitch").unwrap().clone();
    let mut attendees = template["attendees"].clone();
    attendees[1]["likely_objections"] = json!([]);
    let s = setup(json!({
        "template_id": "investor_pitch",
        "goal": template["goal"],
        "user_role": template["your_role"],
        "attendees": attendees,
        "length": "short",
        "key_facts": ir_server::meeting::template_key_facts(&template),
        "ask": template["ask"],
        "difficulty": "realistic"
    }));
    let started = Instant::now();
    let req = build_request(&catalog, &s).unwrap();
    let resp = client.create(&req).await.expect("live prepare call");
    let secs = started.elapsed().as_secs_f64();
    let model = ir_server::meeting::prepare::parse_model_plan(&resp).expect("model plan parses");
    let plan = build_plan(&catalog, &s, Some(&model)).unwrap();
    println!(
        "PREPARE_SECONDS {secs:.1} model={} in={} out={}",
        resp.model, resp.usage.input_tokens, resp.usage.output_tokens
    );
    println!("MODEL_RAW_BEGIN\n{}\nMODEL_RAW_END", resp.text());
    println!(
        "PLAN_BEGIN\n{}\nPLAN_END",
        serde_json::to_string_pretty(&plan).unwrap()
    );
    assert_eq!(
        plan.attendees[0].likely_objections,
        template["attendees"][0]["likely_objections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    );
    assert!(!plan.attendees[1].likely_objections.is_empty());
    assert!(plan.opening_line.split_whitespace().count() <= 20);
}
