//! Scoring a finished session and storing its report.
//!
//! Flow: a session that ended with speech is `scoring`; the worker picks it up, loads everything stored about it
//! (`load_scoring_input`), waits up to 5 s for the final board image, takes Fish item times when the voice was
//! Fish, computes delivery metrics, calls the scoring model once (unless there is not enough signal), validates
//! the report and stores it (`scored`). A failure retries once, then the session is `failed`; `POST
//! /api/sessions/{id}/report` puts it back in the queue.

pub mod metrics;
pub mod report;
pub mod verdict;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::app::AppState;
use crate::claude::Usage;
use crate::config::UsagePhase;
use crate::content::{Catalog, RoundConfig};
use crate::fish::{FishClient, FishSessionDetail};
use crate::orchestrator::{LlmApi, Mode};
use metrics::{HeadSample, HintRec, MarkRec, TurnRec};
pub use report::{ReportSchema, ScoreEnv, Scored};

/// One seat of the panel.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PanelSeat {
    pub panelist_id: String,
    pub persona_id: String,
}

/// One board op from the log.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BoardOpRec {
    pub src: String,
    pub op: String,
    pub args: Value,
    pub t_ms: Option<i64>,
    pub accepted: Option<bool>,
}

/// Everything scoring reads about one session. Times are milliseconds since the session started.
#[derive(Clone, Debug, Default)]
pub struct ScoringInput {
    pub session_id: String,
    pub identity_id: Option<String>,
    /// `interview` or `meeting`.
    pub mode: String,
    pub round_id: String,
    pub length: String,
    pub level: String,
    pub style: String,
    /// `fish` or `fake`.
    pub voice: String,
    pub panel: Vec<PanelSeat>,
    pub fish_sessions: Vec<(String, String)>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_sec: i64,
    pub ended_reason: Option<String>,
    pub question_id: Option<String>,
    pub phases_completed: Vec<String>,
    pub hints_given: u32,
    pub hint_max_level: u32,
    pub hints: Vec<HintRec>,
    pub turns: Vec<TurnRec>,
    pub marks: Vec<MarkRec>,
    pub head: Vec<HeadSample>,
    pub board_text: Option<String>,
    pub board_ops: Vec<BoardOpRec>,
    /// The final board render, at most 1568 px on the long edge.
    pub board_png: Option<Vec<u8>>,
    pub meeting_plan: Option<Value>,
    pub meeting_template: Option<String>,
    /// `MeetingSetup.difficulty`: friendly, realistic or tough.
    pub meeting_difficulty: Option<String>,
    /// Scores of the last report of the same round type, by competency id.
    pub last_scores: HashMap<String, f64>,
}

impl ScoringInput {
    /// Audio timing exists: Fish voice and at least one transcript mark.
    pub fn has_timing(&self) -> bool {
        self.voice == "fish" && !self.marks.is_empty()
    }

    pub fn mode_enum(&self) -> Mode {
        if self.mode == "meeting" {
            Mode::Meeting
        } else {
            Mode::Interview
        }
    }

    /// `junior` to `staff`; `n/a` for meetings.
    pub fn seniority(&self) -> &str {
        match (self.mode.as_str(), self.level.as_str()) {
            ("meeting", _) => "n/a",
            (_, l @ ("junior" | "mid" | "senior" | "staff")) => l,
            _ => "mid",
        }
    }

    /// Report difficulty: style warm/neutral/tough maps to easy/standard/hard; meetings map their own setting.
    pub fn difficulty(&self) -> &'static str {
        let key = if self.mode == "meeting" {
            self.meeting_difficulty.as_deref().unwrap_or("realistic")
        } else {
            self.style.as_str()
        };
        match key {
            "warm" | "friendly" => "easy",
            "tough" => "hard",
            _ => "standard",
        }
    }

    pub fn ended_by(&self) -> &str {
        match self.ended_reason.as_deref() {
            Some(
                r
                @ ("completed" | "user_ended" | "time_limit" | "disconnected" | "headset_removed"),
            ) => r,
            _ => "user_ended",
        }
    }

    /// The persona id of a panelist (the panelist id itself when unknown).
    pub fn persona_of(&self, panelist_id: Option<&str>) -> String {
        match panelist_id {
            Some(pid) => self
                .panel
                .iter()
                .find(|p| p.panelist_id == pid)
                .map(|p| p.persona_id.clone())
                .unwrap_or_else(|| pid.to_string()),
            None => self
                .panel
                .first()
                .map(|p| p.persona_id.clone())
                .unwrap_or_else(|| "interviewer".to_string()),
        }
    }
}

/// Where `report.progress` and `report.ready` go (the session socket once wired; logs otherwise).
#[async_trait]
pub trait ReportEvents: Send + Sync {
    /// `stage` is `metrics`, `scoring` or `done`.
    async fn progress(&self, session_id: &str, stage: &str, pct: u8);
    async fn ready(&self, session_id: &str);
}

/// Logs the events.
pub struct LogEvents;

#[async_trait]
impl ReportEvents for LogEvents {
    async fn progress(&self, session_id: &str, stage: &str, pct: u8) {
        tracing::debug!(session_id, stage, pct, "report.progress");
    }

    async fn ready(&self, session_id: &str) {
        tracing::info!(session_id, "report.ready");
    }
}

/// Everything the scorer needs. Cheap to clone.
#[derive(Clone)]
pub struct ScoringDeps {
    pub db: PgPool,
    pub llm: Arc<dyn LlmApi>,
    /// For item timestamps of Fish sessions; None skips them.
    pub fish: Option<FishClient>,
    pub catalog: Arc<Catalog>,
    pub schema: Arc<ReportSchema>,
    pub model: String,
    pub effort: String,
    pub max_tokens: u32,
    pub data_dir: PathBuf,
    pub usage_phase: UsagePhase,
    pub events: Arc<dyn ReportEvents>,
    /// How long to wait for the final board image (5 s).
    pub board_wait: Duration,
    /// Ceiling for one model call.
    pub model_timeout: Duration,
    in_flight: Arc<Mutex<HashSet<Uuid>>>,
}

/// Default scoring effort; `SCORING_EFFORT` overrides it. Measured on a recorded 15 minute design session:
/// `high` took 51 s, `medium` 37 s, so medium keeps the report well under the 45 s ceiling.
pub const DEFAULT_EFFORT: &str = "medium";
pub const MAX_TOKENS: u32 = 16_000;
/// Longest edge of the board image sent to the model.
pub const BOARD_IMAGE_MAX_EDGE: u32 = 1568;

impl ScoringDeps {
    pub fn new(
        db: PgPool,
        llm: Arc<dyn LlmApi>,
        catalog: Arc<Catalog>,
        schema: Arc<ReportSchema>,
        model: &str,
    ) -> Self {
        ScoringDeps {
            db,
            llm,
            fish: None,
            catalog,
            schema,
            model: model.to_string(),
            effort: DEFAULT_EFFORT.to_string(),
            max_tokens: MAX_TOKENS,
            data_dir: PathBuf::from("data"),
            usage_phase: UsagePhase::Build,
            events: Arc::new(LogEvents),
            board_wait: Duration::from_secs(5),
            model_timeout: Duration::from_secs(150),
            in_flight: Arc::default(),
        }
    }

    /// From the app state: its model client, Fish client and config; content and schema from `CONTENT_DIR`.
    pub fn from_app(app: &AppState) -> anyhow::Result<Self> {
        let catalog = Catalog::load(&app.config.content_dir).context("loading content")?;
        let schema = ReportSchema::load(&app.config.content_dir)?;
        let mut deps = ScoringDeps::new(
            app.db.clone(),
            app.llm.clone(),
            Arc::new(catalog),
            Arc::new(schema),
            &app.config.scoring_model,
        );
        deps.fish = Some(app.fish.clone());
        deps.data_dir = app.config.data_dir.clone();
        deps.usage_phase = app.config.usage_phase;
        if let Ok(effort) = std::env::var("SCORING_EFFORT")
            && ["low", "medium", "high", "xhigh", "max"].contains(&effort.trim())
        {
            deps.effort = effort.trim().to_string();
        }
        Ok(deps)
    }

    pub fn with_events(mut self, events: Arc<dyn ReportEvents>) -> Self {
        self.events = events;
        self
    }
}

// ---------- loading ----------

/// `turns` columns: seq, speaker, panelist_id, kind, text, started_ms, ended_ms, interrupted.
type TurnRow = (
    i32,
    String,
    Option<String>,
    String,
    String,
    Option<i64>,
    Option<i64>,
    bool,
);
/// `board_ops` columns: src, op, args, t_ms, accepted.
type OpRow = (String, String, Value, Option<i64>, Option<bool>);

fn ts(v: &Value, key: &str) -> Option<DateTime<Utc>> {
    v.get(key)
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc))
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Reads one session from the 0001 tables (and the columns later migrations add, when present: `question_id` and
/// the `live_state` snapshot with the phase index, hints and elapsed time). None when the session does not exist.
pub async fn load_scoring_input(
    pool: &PgPool,
    session_id: Uuid,
    catalog: &Catalog,
) -> anyhow::Result<Option<ScoringInput>> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(s) from sessions s where s.id = $1")
            .bind(session_id)
            .fetch_optional(pool)
            .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut input = ScoringInput {
        session_id: session_id.to_string(),
        identity_id: str_of(&row, "identity_id"),
        mode: str_of(&row, "mode").unwrap_or_else(|| "interview".into()),
        round_id: str_of(&row, "round_id").unwrap_or_default(),
        length: str_of(&row, "length").unwrap_or_else(|| "short".into()),
        level: str_of(&row, "level").unwrap_or_else(|| "mid".into()),
        style: str_of(&row, "style").unwrap_or_else(|| "neutral".into()),
        voice: str_of(&row, "voice").unwrap_or_else(|| "fake".into()),
        started_at: ts(&row, "started_at").or_else(|| ts(&row, "created_at")),
        ended_at: ts(&row, "ended_at"),
        ended_reason: str_of(&row, "ended_reason"),
        question_id: str_of(&row, "question_id"),
        ..ScoringInput::default()
    };
    input.panel = row["panel"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|p| PanelSeat {
                    panelist_id: str_of(p, "panelist_id").unwrap_or_default(),
                    persona_id: str_of(p, "persona_id").unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    input.fish_sessions = row["fish_sessions"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|f| Some((str_of(f, "panelist_id")?, str_of(f, "fish_session_id")?)))
                .collect()
        })
        .unwrap_or_default();
    let live = row.get("live_state").cloned().unwrap_or(Value::Null);
    input.hints_given = live["hints_given"].as_u64().unwrap_or(0) as u32;
    input.hint_max_level = live["hint_max_level"].as_u64().unwrap_or(0) as u32;
    let start_epoch_ms = input.started_at.map(|t| t.timestamp_millis()).unwrap_or(0);

    let turns: Vec<TurnRow> = sqlx::query_as(
        "select seq, speaker, panelist_id, kind, text, started_ms, ended_ms, interrupted \
             from turns where session_id = $1 order by seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    input.turns = turns
        .into_iter()
        .map(
            |(seq, speaker, panelist_id, kind, text, started_ms, ended_ms, interrupted)| TurnRec {
                seq,
                speaker,
                panelist_id,
                kind,
                text,
                started_ms,
                ended_ms,
                interrupted,
            },
        )
        .collect();

    // The browser stamps marks with its wall clock (epoch ms); older clients sent session time.
    let rel = |ms: i64| {
        if ms > 100_000_000_000 {
            (ms - start_epoch_ms).max(0)
        } else {
            ms.max(0)
        }
    };
    let marks: Vec<(String, Option<String>, i64, i64, String)> = sqlx::query_as(
        "select segment_id, panelist_id, first_at_ms, final_at_ms, text from marks \
         where session_id = $1 order by first_at_ms, id",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    input.marks = marks
        .into_iter()
        .map(|(segment_id, panelist_id, first, last, text)| MarkRec {
            segment_id,
            panelist_id,
            start_ms: rel(first),
            end_ms: rel(last).max(rel(first)),
            text,
        })
        .collect();

    let batches: Vec<Value> = sqlx::query_scalar(
        "select samples from head_batches where session_id = $1 order by first_t_ms, id",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    input.head = batches
        .iter()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|s| serde_json::from_value::<HeadSample>(s.clone()).ok())
        .collect();

    input.board_text = sqlx::query_scalar("select summary from boards where session_id = $1")
        .bind(session_id)
        .fetch_optional(pool)
        .await?;
    let ops: Vec<OpRow> = sqlx::query_as(
        "select src, op, args, t_ms, accepted from board_ops where session_id = $1 \
         order by coalesce(t_ms, 0), id",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    input.board_ops = ops
        .into_iter()
        .map(|(src, op, args, t_ms, accepted)| BoardOpRec {
            src,
            op,
            args,
            t_ms,
            accepted,
        })
        .collect();

    if let Some(plan_id) = str_of(&row, "meeting_plan_id").and_then(|s| Uuid::parse_str(&s).ok()) {
        let plan: Option<(Option<String>, Value, Value)> =
            sqlx::query_as("select template_id, setup, plan from meeting_plans where id = $1")
                .bind(plan_id)
                .fetch_optional(pool)
                .await?;
        if let Some((template, setup, plan)) = plan {
            input.meeting_template = template;
            input.meeting_difficulty = str_of(&setup, "difficulty");
            input.meeting_plan = Some(plan);
        }
    }

    // Duration: the live clock when stored, else wall time minus pauses, else the last turn.
    let paused = row["paused_total_ms"].as_i64().unwrap_or(0);
    let elapsed_ms = live["elapsed_ms"].as_i64().or_else(|| {
        let (s, e) = (input.started_at?, input.ended_at?);
        Some((e - s).num_milliseconds() - paused)
    });
    let last_turn = input
        .turns
        .iter()
        .filter_map(|t| t.started_ms)
        .max()
        .unwrap_or(0);
    input.duration_sec = elapsed_ms.unwrap_or(last_turn).max(last_turn).max(0) / 1000;

    if let Some(round) = catalog.round(&input.round_id) {
        input.phases_completed = phases_completed(
            round,
            live["phase_idx"].as_u64().map(|i| i as usize),
            input.ended_by() == "completed",
            input.duration_sec,
        );
        let previous: Option<Value> = sqlx::query_scalar(
            "select r.report from reports r join sessions s on s.id = r.session_id \
             where s.identity_id = $1 and s.id <> $2 \
               and r.report -> 'session' ->> 'round_type' = $3 \
             order by r.created_at desc limit 1",
        )
        .bind(
            input
                .identity_id
                .as_deref()
                .and_then(|s| Uuid::parse_str(s).ok()),
        )
        .bind(session_id)
        .bind(&round.round_type)
        .fetch_optional(pool)
        .await?;
        if let Some(prev) = previous {
            input.last_scores = report::scores_of(&prev);
        }
    }
    Ok(Some(input))
}

/// Phases before the current one are done; the current one too when the round ended normally. Without a phase
/// index, the phases whose planned minutes fit in the time spent.
pub fn phases_completed(
    round: &RoundConfig,
    phase_idx: Option<usize>,
    completed: bool,
    duration_sec: i64,
) -> Vec<String> {
    let ids = round.phases.iter().map(|p| p.id.clone());
    if completed {
        return ids.collect();
    }
    match phase_idx {
        Some(i) => ids.take(i).collect(),
        None => {
            let mut total = 0.0;
            round
                .phases
                .iter()
                .take_while(|p| {
                    total += p.minutes * 60.0;
                    total <= duration_sec as f64
                })
                .map(|p| p.id.clone())
                .collect()
        }
    }
}

/// Takes the Fish item times (wall clock) for the turns they match, in order.
pub fn apply_fish_times(input: &mut ScoringInput, panelist_id: &str, detail: &FishSessionDetail) {
    let start = input.started_at.map(|t| t.timestamp_millis()).unwrap_or(0);
    let key = |t: &str| -> String {
        t.to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .take(40)
            .collect()
    };
    let mut cursor = 0usize;
    for item in &detail.items {
        let (Some(text), Some(at)) = (item.text.as_deref(), item.created_at_ms) else {
            continue;
        };
        let k = key(&metrics::speech_text(text));
        if k.is_empty() {
            continue;
        }
        let user = item.role.as_deref() == Some("user");
        let found = input.turns[cursor..].iter().position(|t| {
            let same_side = if user {
                t.speaker == "user"
            } else {
                t.speaker == "agent" && t.panelist_id.as_deref() == Some(panelist_id)
            };
            let tk = key(&t.speech());
            same_side && !tk.is_empty() && (tk.starts_with(&k) || k.starts_with(&tk))
        });
        if let Some(offset) = found {
            let i = cursor + offset;
            input.turns[i].started_ms = Some((at - start).max(0));
            cursor = i + 1;
        }
    }
}

/// Reads the board image, scaled down to at most 1568 px on the long edge.
pub fn board_png(path: &Path) -> anyhow::Result<Vec<u8>> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .context("decoding the board image")?;
    if img.width().max(img.height()) <= BOARD_IMAGE_MAX_EDGE {
        return Ok(bytes);
    }
    let small = img.resize(
        BOARD_IMAGE_MAX_EDGE,
        BOARD_IMAGE_MAX_EDGE,
        image::imageops::FilterType::Triangle,
    );
    let mut out = std::io::Cursor::new(Vec::new());
    small
        .write_to(&mut out, image::ImageFormat::Png)
        .context("encoding the board image")?;
    Ok(out.into_inner())
}

// ---------- scoring and storing ----------

fn round_uses_board(round: &RoundConfig) -> bool {
    round.hands == "whiteboard" || round.phases.iter().any(|p| p.uses_whiteboard)
}

/// Waits (up to `board_wait`) for the board image the browser posts when the round ends, then reads the newest.
async fn final_board(deps: &ScoringDeps, input: &ScoringInput) -> Option<Vec<u8>> {
    let id = Uuid::parse_str(&input.session_id).ok()?;
    let since = input.ended_at.map(|t| t - chrono::Duration::seconds(30));
    let deadline = Instant::now() + deps.board_wait;
    loop {
        let row: Option<(String, DateTime<Utc>)> = sqlx::query_as(
            "select path, created_at from board_images where session_id = $1 \
             order by created_at desc, id desc limit 1",
        )
        .bind(id)
        .fetch_optional(&deps.db)
        .await
        .ok()
        .flatten();
        let fresh = row
            .as_ref()
            .is_some_and(|(_, at)| since.is_none_or(|s| *at >= s));
        if fresh || Instant::now() >= deadline {
            let (path, _) = row?;
            let full = deps.data_dir.join(path);
            return match tokio::task::spawn_blocking(move || board_png(&full)).await {
                Ok(Ok(png)) => Some(png),
                Ok(Err(err)) => {
                    tracing::warn!(session_id = %id, error = %format!("{err:#}"), "board image skipped");
                    None
                }
                Err(_) => None,
            };
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Loads, scores and returns the report (no storing). One attempt.
pub async fn score(deps: &ScoringDeps, session_id: Uuid) -> anyhow::Result<Scored> {
    let mut input = load_scoring_input(&deps.db, session_id, &deps.catalog)
        .await?
        .ok_or_else(|| anyhow!("session {session_id} not found"))?;
    let round = deps
        .catalog
        .round(&input.round_id)
        .ok_or_else(|| {
            anyhow!(
                "session {session_id} has unknown round {:?}",
                input.round_id
            )
        })?
        .clone();
    if round_uses_board(&round) {
        input.board_png = final_board(deps, &input).await;
    }
    if input.voice == "fish"
        && let Some(fish) = &deps.fish
    {
        for (panelist_id, fish_id) in input.fish_sessions.clone() {
            match tokio::time::timeout(Duration::from_secs(5), fish.get_session(&fish_id)).await {
                Ok(Ok(detail)) => apply_fish_times(&mut input, &panelist_id, &detail),
                Ok(Err(err)) => {
                    tracing::warn!(session_id = %session_id, error = %err, "Fish transcript unavailable; using server times")
                }
                Err(_) => {
                    tracing::warn!(session_id = %session_id, "Fish transcript timed out; using server times")
                }
            }
        }
    }
    let env = ScoreEnv {
        llm: deps.llm.as_ref(),
        catalog: &deps.catalog,
        schema: &deps.schema,
        model: &deps.model,
        effort: &deps.effort,
        max_tokens: deps.max_tokens,
        timeout: deps.model_timeout,
        events: deps.events.as_ref(),
    };
    let scored = report::score(&env, &input).await;
    if let Ok(s) = &scored
        && let Some(usage) = &s.usage
    {
        record_usage(deps, &input, usage).await;
    }
    scored
}

/// Scores a session (two attempts) and stores the report; on a second failure the session is `failed`.
pub async fn score_session(deps: &ScoringDeps, session_id: Uuid) -> anyhow::Result<Value> {
    let started = Instant::now();
    let mut last_err = anyhow!("not scored");
    for attempt in 1..=2 {
        match score(deps, session_id).await {
            Ok(scored) => {
                store_report(
                    &deps.db,
                    session_id,
                    &scored.report,
                    scored.model_called.then_some(deps.model.as_str()),
                )
                .await?;
                let id = session_id.to_string();
                deps.events.progress(&id, "done", 100).await;
                deps.events.ready(&id).await;
                tracing::info!(
                    session_id = %session_id,
                    attempt,
                    model_called = scored.model_called,
                    ms = started.elapsed().as_millis() as u64,
                    "report stored"
                );
                return Ok(scored.report);
            }
            Err(err) => {
                tracing::warn!(session_id = %session_id, attempt, error = %format!("{err:#}"), "scoring failed");
                last_err = err;
            }
        }
    }
    sqlx::query("update sessions set status = 'failed' where id = $1 and status = 'scoring'")
        .bind(session_id)
        .execute(&deps.db)
        .await?;
    Err(last_err)
}

pub async fn store_report(
    db: &PgPool,
    session_id: Uuid,
    report: &Value,
    model: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query(
        "insert into reports (session_id, schema_version, report, model) values ($1, '1.0', $2, $3) \
         on conflict (session_id) do update set report = excluded.report, model = excluded.model, \
             updated_at = now()",
    )
    .bind(session_id)
    .bind(report)
    .bind(model)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update sessions set status = 'scored', scored_at = now() \
         where id = $1 and status in ('scoring', 'failed')",
    )
    .bind(session_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// $ per million tokens: (input, output, cache read, cache write).
fn price(model: &str) -> (f64, f64, f64, f64) {
    if model.starts_with("claude-sonnet-5-5") {
        (2.0, 10.0, 0.10, 2.5)
    } else if model.starts_with("claude-haiku-5-5") {
        (0.10, 0.50, 0.01, 0.125)
    } else {
        (4.0, 20.0, 0.20, 5.0)
    }
}

async fn record_usage(deps: &ScoringDeps, input: &ScoringInput, usage: &Usage) {
    let (pi, po, pr, pw) = price(&deps.model);
    let cost = (usage.input_tokens as f64 * pi
        + usage.output_tokens as f64 * po
        + usage.cache_read_input_tokens as f64 * pr
        + usage.cache_creation_input_tokens as f64 * pw)
        / 1_000_000.0;
    let session = Uuid::parse_str(&input.session_id).ok();
    let identity = input
        .identity_id
        .as_deref()
        .and_then(|s| Uuid::parse_str(s).ok());
    let res = sqlx::query(
        "insert into usage_events (identity_id, session_id, provider, kind, model, usage_phase, \
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) \
         values ($1, $2, 'anthropic', 'scoring', $3, $4, $5, $6, $7, $8, ($9::float8)::numeric)",
    )
    .bind(identity)
    .bind(session)
    .bind(&deps.model)
    .bind(deps.usage_phase.as_str())
    .bind(usage.input_tokens as i32)
    .bind(usage.output_tokens as i32)
    .bind(usage.cache_read_input_tokens as i32)
    .bind(usage.cache_creation_input_tokens as i32)
    .bind(cost)
    .execute(&deps.db)
    .await;
    if let Err(err) = res {
        tracing::warn!(error = %err, "could not record scoring usage");
        return;
    }
    let _ = sqlx::query(
        "update sessions set cost_usd = cost_usd + ($2::float8)::numeric where id = $1",
    )
    .bind(session)
    .bind(cost)
    .execute(&deps.db)
    .await;
}

/// Polls for `scoring` sessions without a report and scores each once at a time. Restart safe: a session that
/// was mid-scoring when the server stopped is still `scoring` and is picked up again.
pub fn spawn_worker(deps: ScoringDeps, every: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if let Err(err) = run_pending(&deps).await {
                tracing::warn!(error = %format!("{err:#}"), "scoring sweep failed");
            }
        }
    })
}

/// Starts scoring for every queued session not already being scored. Returns how many it started.
pub async fn run_pending(deps: &ScoringDeps) -> anyhow::Result<usize> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "select s.id from sessions s where s.status = 'scoring' \
           and not exists (select 1 from reports r where r.session_id = s.id) \
         order by s.ended_at nulls last limit 8",
    )
    .fetch_all(&deps.db)
    .await?;
    let mut started = 0;
    for id in ids {
        let claimed = deps
            .in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id);
        if !claimed {
            continue;
        }
        started += 1;
        let deps = deps.clone();
        tokio::spawn(async move {
            let _ = score_session(&deps, id).await;
            deps.in_flight
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
        });
    }
    Ok(started)
}
