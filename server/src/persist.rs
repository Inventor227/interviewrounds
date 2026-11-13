//! Saving and reloading sessions: client tokens (hashed), the live state snapshot that lets a session come back
//! after a server restart, the turn log, ending a session, and settling its Fish minutes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::app::AppState;
use crate::claude::Message;
use crate::fish::FishError;
use crate::identity::{random_hex, sha256};
use crate::orchestrator::{
    Brief, LiveSettings, MeetingState, Mode, NewSession, PanelSeat, SessionAuth, SessionSettings,
    SessionState, SessionStatus, Turn, constant_time_eq,
};
use crate::usage::{self, FishMinutes};

/// Session client tokens checked against the database (sha-256, constant-time compare).
pub struct DbSessionAuth {
    db: PgPool,
}

impl DbSessionAuth {
    pub fn new(db: PgPool) -> Self {
        DbSessionAuth { db }
    }
}

#[async_trait]
impl SessionAuth for DbSessionAuth {
    async fn client_token_ok(&self, session_id: &str, token: &str) -> bool {
        let Ok(id) = Uuid::parse_str(session_id) else {
            return false;
        };
        matches!(check_token(&self.db, id, token).await, Ok(Some(_)))
    }
}

/// A valid (not revoked) token: its row id and the highest client seq processed under it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenRecord {
    pub token_id: i64,
    pub last_client_seq: u64,
}

pub async fn check_token(
    db: &PgPool,
    session_id: Uuid,
    token: &str,
) -> Result<Option<TokenRecord>, sqlx::Error> {
    let rows: Vec<(i64, Vec<u8>, i64)> = sqlx::query_as(
        "select id, token_hash, last_client_seq from session_tokens \
         where session_id = $1 and revoked_at is null",
    )
    .bind(session_id)
    .fetch_all(db)
    .await?;
    let hash = sha256(token);
    // Compare against every live token so timing does not depend on which one matched.
    let mut found = None;
    for (id, stored, seq) in rows {
        if constant_time_eq(&stored, &hash) {
            found = Some(TokenRecord {
                token_id: id,
                last_client_seq: seq.max(0) as u64,
            });
        }
    }
    Ok(found)
}

/// Issues a new random 32-byte client token. With `revoke_others`, earlier tokens of the session stop working.
/// Returns (token, token row id, revoked token ids).
pub async fn issue_token(
    conn: &mut PgConnection,
    session_id: Uuid,
    revoke_others: bool,
) -> Result<(String, i64, Vec<i64>), sqlx::Error> {
    let revoked: Vec<i64> = if revoke_others {
        sqlx::query_scalar(
            "update session_tokens set revoked_at = now() \
             where session_id = $1 and revoked_at is null returning id",
        )
        .bind(session_id)
        .fetch_all(&mut *conn)
        .await?
    } else {
        Vec::new()
    };
    let token = random_hex(32);
    let hash = sha256(&token);
    let id: i64 = sqlx::query_scalar(
        "insert into session_tokens (session_id, token_hash) values ($1, $2) returning id",
    )
    .bind(session_id)
    .bind(&hash)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query("update sessions set client_token_hash = $2 where id = $1")
        .bind(session_id)
        .bind(&hash)
        .execute(&mut *conn)
        .await?;
    Ok((token, id, revoked))
}

pub async fn save_client_seq(db: &PgPool, token_id: i64, seq: u64) {
    let res = sqlx::query(
        "update session_tokens set last_client_seq = greatest(last_client_seq, $2) where id = $1",
    )
    .bind(token_id)
    .bind(seq as i64)
    .execute(db)
    .await;
    if let Err(err) = res {
        tracing::warn!(error = %err, "could not save the client seq");
    }
}

/// One seat as stored in `sessions.panel` (the public `Panelist` without its voice).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PanelEntry {
    pub panelist_id: String,
    pub persona_id: String,
    pub display_name: String,
    pub title: String,
    pub avatar_id: String,
    pub seat: u8,
}

/// One Fish session in `sessions.fish_sessions`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FishEntry {
    pub panelist_id: String,
    pub fish_session_id: String,
    pub started_at: DateTime<Utc>,
    #[serde(default)]
    pub ended_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct SessionRow {
    pub id: Uuid,
    pub identity_id: Uuid,
    pub mode: String,
    pub round_id: Option<String>,
    pub meeting_plan_id: Option<Uuid>,
    pub length: String,
    pub level: String,
    pub style: String,
    pub voice: String,
    pub panel_mode: String,
    pub panel: Value,
    pub fish_sessions: Value,
    pub status: String,
    pub ended_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub live_state: Option<Value>,
    pub question_id: Option<String>,
}

impl SessionRow {
    pub fn is_open(&self) -> bool {
        matches!(self.status.as_str(), "created" | "live" | "paused")
    }

    pub fn panel_entries(&self) -> Vec<PanelEntry> {
        serde_json::from_value(self.panel.clone()).unwrap_or_default()
    }

    pub fn fish_entries(&self) -> Vec<FishEntry> {
        serde_json::from_value(self.fish_sessions.clone()).unwrap_or_default()
    }
}

pub async fn fetch_session(db: &PgPool, id: Uuid) -> Result<Option<SessionRow>, sqlx::Error> {
    sqlx::query_as(
        "select id, identity_id, mode, round_id, meeting_plan_id, length, level, style, voice, panel_mode, \
                panel, fish_sessions, status, ended_reason, created_at, started_at, live_state, question_id \
         from sessions where id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn save_fish_entries(
    db: &PgPool,
    id: Uuid,
    entries: &[FishEntry],
) -> Result<(), sqlx::Error> {
    sqlx::query("update sessions set fish_sessions = $2 where id = $1")
        .bind(id)
        .bind(json!(entries))
        .execute(db)
        .await?;
    Ok(())
}

/// Everything about a live session that is not rebuilt from content and settings.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LiveSnapshot {
    pub history: Vec<Message>,
    pub turns: Vec<Turn>,
    pub floor: String,
    pub phase_idx: usize,
    pub elapsed_ms: u64,
    pub started: bool,
    pub user_paused: bool,
    #[serde(default)]
    pub brief: Option<Brief>,
    #[serde(default)]
    pub closing_line: Option<String>,
    #[serde(default)]
    pub hints_given: u8,
    #[serde(default)]
    pub hint_max_level: u8,
    #[serde(default)]
    pub last_agent_text: HashMap<String, String>,
    #[serde(default)]
    pub pending_tool_results: Vec<String>,
    #[serde(default)]
    pub pending_handover: HashMap<String, String>,
    #[serde(default)]
    pub pending_notes: Vec<String>,
    #[serde(default)]
    pub two_minute_warned: bool,
    #[serde(default)]
    pub last_speaker: Option<String>,
    #[serde(default)]
    pub board_text: String,
}

pub fn snapshot(st: &SessionState, now: Instant) -> LiveSnapshot {
    LiveSnapshot {
        history: st.history.clone(),
        turns: st.turns.clone(),
        floor: st.floor.clone(),
        phase_idx: st.phase_idx,
        elapsed_ms: st.elapsed_ms(now),
        started: st.status != SessionStatus::Created,
        user_paused: st.status == SessionStatus::Paused,
        brief: st.brief.clone(),
        closing_line: st.closing_line.clone(),
        hints_given: st.hints_given,
        hint_max_level: st.hint_max_level,
        last_agent_text: st.last_agent_text.clone(),
        pending_tool_results: st.pending_tool_results.clone(),
        pending_handover: st.pending_handover.clone(),
        pending_notes: st.pending_notes.clone(),
        two_minute_warned: st.two_minute_warned,
        last_speaker: st.last_speaker.clone(),
        board_text: st.board_text.clone(),
    }
}

/// Puts a snapshot back. The clock is restored stopped: it runs again when a socket says hello.
pub fn restore(st: &mut SessionState, snap: LiveSnapshot, now: Instant) {
    st.history = snap.history;
    st.turns = snap.turns;
    if st.panelist(&snap.floor).is_some() {
        st.floor = snap.floor;
    }
    st.phase_idx = snap.phase_idx.min(st.round.phases.len().saturating_sub(1));
    st.started_at = now
        .checked_sub(Duration::from_millis(snap.elapsed_ms))
        .unwrap_or(now);
    st.paused_total_ms = 0;
    st.paused_since = Some(now);
    st.status = if !snap.started {
        SessionStatus::Created
    } else if snap.user_paused {
        SessionStatus::Paused
    } else {
        SessionStatus::Live
    };
    st.brief = snap.brief;
    st.closing_line = snap.closing_line;
    st.hints_given = snap.hints_given;
    st.hint_max_level = snap.hint_max_level;
    st.last_agent_text = snap.last_agent_text;
    st.pending_tool_results = snap.pending_tool_results;
    st.pending_handover = snap.pending_handover;
    st.pending_notes = snap.pending_notes;
    st.two_minute_warned = snap.two_minute_warned;
    st.last_speaker = snap.last_speaker;
    st.board_text = snap.board_text;
}

fn parse_enum<T: serde::de::DeserializeOwned>(value: &str) -> anyhow::Result<T> {
    serde_json::from_value(json!(value)).with_context(|| format!("unexpected value {value:?}"))
}

/// Hidden meeting state for the attendee prompts, from the stored plan.
pub async fn meeting_state(
    db: &PgPool,
    plan_id: Option<Uuid>,
) -> anyhow::Result<Option<MeetingState>> {
    let Some(plan_id) = plan_id else {
        return Ok(None);
    };
    let plan: Option<Value> = sqlx::query_scalar("select plan from meeting_plans where id = $1")
        .bind(plan_id)
        .fetch_optional(db)
        .await?;
    Ok(plan.map(|p| MeetingState {
        hidden: p.to_string(),
    }))
}

/// Builds the in-memory state of a stored session (and restores its snapshot when there is one).
pub async fn state_from_row(app: &AppState, row: &SessionRow) -> anyhow::Result<SessionState> {
    let round_id = row
        .round_id
        .clone()
        .ok_or_else(|| anyhow!("session {} has no round", row.id))?;
    let panel: Vec<PanelSeat> = row
        .panel_entries()
        .into_iter()
        .map(|p| PanelSeat {
            panelist_id: p.panelist_id,
            persona_id: p.persona_id,
        })
        .collect();
    let mode: Mode = parse_enum(&row.mode)?;
    let spec = NewSession {
        id: row.id.to_string(),
        identity_id: row.identity_id.to_string(),
        mode,
        round_id,
        settings: SessionSettings {
            level: parse_enum(&row.level)?,
            style: parse_enum(&row.style)?,
            voice: parse_enum(&row.voice)?,
        },
        panel,
        question_id: row.question_id.clone(),
        meeting: meeting_state(&app.db, row.meeting_plan_id).await?,
    };
    let now = Instant::now();
    let mut st = SessionState::new(
        spec,
        &app.catalog,
        LiveSettings::from_config(&app.config),
        now,
    )?;
    match &row.live_state {
        Some(v) => {
            let snap: LiveSnapshot =
                serde_json::from_value(v.clone()).context("reading the live state snapshot")?;
            restore(&mut st, snap, now);
        }
        None => {
            st.status = SessionStatus::Created;
            st.paused_since = Some(now);
        }
    }
    Ok(st)
}

/// The live session, from the registry or rebuilt from the database (after a restart). Ended sessions are not
/// loaded.
pub async fn load_live(
    app: &AppState,
    id: Uuid,
) -> anyhow::Result<Option<Arc<Mutex<SessionState>>>> {
    if let Some(handle) = app.registry.get(&id.to_string()) {
        return Ok(Some(handle));
    }
    let Some(row) = fetch_session(&app.db, id).await? else {
        return Ok(None);
    };
    if !row.is_open() {
        return Ok(None);
    }
    let _guard = app.load_lock.lock().await;
    if let Some(handle) = app.registry.get(&id.to_string()) {
        return Ok(Some(handle));
    }
    let st = state_from_row(app, &row).await?;
    tracing::info!(session_id = %id, "live session reloaded from the database");
    let handle = app.registry.insert(st);
    crate::ws::attach(app, id, handle.clone()).await;
    Ok(Some(handle))
}

fn turn_row(t: &Turn) -> (&'static str, Option<&str>, &'static str) {
    match t.speaker.as_str() {
        "candidate" => ("user", None, "speech"),
        "app" => ("system", None, "event"),
        other => ("agent", Some(other), "speech"),
    }
}

/// Writes turns `from..` (upserting, so an interruption marked later updates the row) and the live snapshot.
pub async fn save_live(
    db: &PgPool,
    id: Uuid,
    snap: &LiveSnapshot,
    from: usize,
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    for (i, t) in snap.turns.iter().enumerate().skip(from) {
        let (speaker, panelist, kind) = turn_row(t);
        sqlx::query(
            "insert into turns (session_id, seq, speaker, panelist_id, kind, text, started_ms, interrupted) \
             values ($1, $2, $3, $4, $5, $6, $7, $8) \
             on conflict (session_id, seq) do update set text = excluded.text, interrupted = excluded.interrupted",
        )
        .bind(id)
        .bind(i as i32 + 1)
        .bind(speaker)
        .bind(panelist)
        .bind(kind)
        .bind(&t.text)
        .bind(t.at_ms as i64)
        .bind(t.interrupted)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("update sessions set live_state = $2, live_state_at = now() where id = $1")
        .bind(id)
        .bind(json!(snap))
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

pub const END_REASONS: [&str; 5] = [
    "completed",
    "user_ended",
    "time_limit",
    "disconnected",
    "headset_removed",
];

/// Ends a session once: saves the last turns, sets `scoring` (or `abandoned` when the candidate never spoke),
/// tells the sockets (`round.ended`, then close 4409), drops it from memory and settles its Fish minutes.
/// Returns false when it had already ended.
pub async fn end_session(app: &AppState, id: Uuid, reason: &str) -> anyhow::Result<bool> {
    let reason = if END_REASONS.contains(&reason) {
        reason
    } else {
        "user_ended"
    };
    let key = id.to_string();
    let handle = app.registry.get(&key);
    // Replies still waiting for playback are settled against what Fish actually played.
    let fish_last = match (&handle, fetch_session(&app.db, id).await?) {
        (Some(_), Some(row)) if row.voice == "fish" && row.is_open() => {
            fish_last_line(app, &row).await
        }
        _ => None,
    };
    let mut guard = match &handle {
        Some(h) => Some(h.lock().await),
        None => None,
    };
    let (spoke, paused_ms) = match guard.as_deref_mut() {
        Some(st) => {
            let now = Instant::now();
            crate::ws::Playback::settle_unplayed(st, fish_last.as_deref(), now);
            let snap = snapshot(st, now);
            save_live(&app.db, id, &snap, 0).await?;
            (
                st.turns.iter().any(|t| t.speaker == "candidate"),
                st.paused_total_ms as i64,
            )
        }
        None => {
            let spoke: bool = sqlx::query_scalar(
                "select exists (select 1 from turns where session_id = $1 and speaker = 'user')",
            )
            .bind(id)
            .fetch_one(&app.db)
            .await?;
            (spoke, 0)
        }
    };
    let status = if spoke { "scoring" } else { "abandoned" };
    let ended: Option<Uuid> = sqlx::query_scalar(
        "update sessions set status = $2, ended_reason = $3, ended_at = now(), \
             paused_total_ms = greatest(paused_total_ms, $4) \
         where id = $1 and status in ('created', 'live', 'paused') returning id",
    )
    .bind(id)
    .bind(status)
    .bind(reason)
    .bind(paused_ms)
    .fetch_optional(&app.db)
    .await?;
    if ended.is_none() {
        return Ok(false);
    }
    if let Some(st) = guard.as_deref_mut() {
        st.status = if spoke {
            SessionStatus::Scoring
        } else {
            SessionStatus::Abandoned
        };
    }
    drop(guard);
    tracing::info!(session_id = %id, reason, status, "session ended");
    // The socket stays open through scoring (report.progress / report.ready); the hub closes itself after.
    if let Some(hub) = app.hubs.get(&key) {
        hub.finish(app, reason).await;
    }
    app.registry.remove(&key);
    let app = app.clone();
    tokio::spawn(async move {
        if let Err(err) = settle_fish(&app, id).await {
            tracing::warn!(session_id = %id, error = %format!("{err:#}"), "could not settle Fish minutes; the janitor retries");
        }
    });
    Ok(true)
}

/// Fish's newest assistant line across the session's Fish sessions (what was played last), if Fish answers
/// within 3 seconds.
async fn fish_last_line(app: &AppState, row: &SessionRow) -> Option<String> {
    let mut best: Option<(i64, String)> = None;
    for e in row.fish_entries() {
        let detail = tokio::time::timeout(
            Duration::from_secs(3),
            app.fish.get_session(&e.fish_session_id),
        )
        .await
        .ok()?
        .ok()?;
        for item in detail
            .items
            .iter()
            .filter(|i| i.role.as_deref() == Some("assistant"))
        {
            if let Some(text) = &item.text {
                let at = item.created_at_ms.unwrap_or(0);
                if best.as_ref().is_none_or(|(t, _)| at >= *t) {
                    best = Some((at, text.clone()));
                }
            }
        }
    }
    best.map(|(_, text)| text)
}

async fn fish_minutes(app: &AppState, entry: &FishEntry, now: DateTime<Utc>) -> FishMinutes {
    let clock = || {
        let end = entry.ended_at.unwrap_or(now);
        (end - entry.started_at).num_milliseconds().max(0) as f64 / 60_000.0
    };
    let (minutes, source) = match app.fish.get_session(&entry.fish_session_id).await {
        Ok(detail) => match detail.duration_seconds {
            Some(s) => (s.max(0.0) / 60.0, "fish"),
            None => (clock(), "clock"),
        },
        // Never joined: Fish has nothing to bill.
        Err(FishError::Http { status: 404, .. }) => (0.0, "fish"),
        Err(err) => {
            tracing::warn!(fish_session_id = %entry.fish_session_id, error = %err, "Fish session lookup failed; using the wall clock");
            (clock(), "clock")
        }
    };
    FishMinutes {
        fish_session_id: entry.fish_session_id.clone(),
        panelist_id: entry.panelist_id.clone(),
        minutes,
        source,
    }
}

/// Ends one Fish session, retrying twice. A session Fish no longer knows counts as ended.
pub async fn end_fish(app: &AppState, fish_session_id: &str) -> Result<(), FishError> {
    let mut last = None;
    for attempt in 0..3u64 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(300 * attempt)).await;
        }
        match app.fish.end_session(fish_session_id).await {
            Ok(()) | Err(FishError::Http { status: 404, .. }) => return Ok(()),
            Err(err) => last = Some(err),
        }
    }
    Err(last.expect("at least one attempt"))
}

/// Before an identity is deleted: ends its open sessions and settles their Fish minutes, so the spend stays in
/// the ledger (ledger rows outlive the identity). When Fish cannot be reached, the reservation is recorded as
/// the estimate.
pub async fn settle_identity(app: &AppState, identity: Uuid) -> anyhow::Result<()> {
    let open: Vec<Uuid> = sqlx::query_scalar(
        "select id from sessions where identity_id = $1 and status in ('created', 'live', 'paused')",
    )
    .bind(identity)
    .fetch_all(&app.db)
    .await?;
    for id in open {
        end_session(app, id, "user_ended").await?;
    }
    let unsettled: Vec<(Uuid, f64)> = sqlx::query_as(
        "select id, fish_reserved_usd::float8 from sessions \
         where identity_id = $1 and voice = 'fish' and not fish_usage_recorded",
    )
    .bind(identity)
    .fetch_all(&app.db)
    .await?;
    for (id, reserved) in unsettled {
        if let Err(err) = settle_fish(app, id).await {
            tracing::warn!(session_id = %id, error = %format!("{err:#}"), "Fish not settled; recording the reservation");
            let estimate = FishMinutes {
                fish_session_id: String::new(),
                panelist_id: String::new(),
                minutes: reserved / app.config.fish_rate_per_min.max(1e-9),
                source: "reservation",
            };
            usage::record_fish(&app.db, &app.config, id, &[estimate]).await?;
        }
    }
    Ok(())
}

/// Ends any open Fish sessions of an ended session and records their minutes (once).
pub async fn settle_fish(app: &AppState, id: Uuid) -> anyhow::Result<()> {
    let Some(row) = fetch_session(&app.db, id).await? else {
        return Ok(());
    };
    if row.voice != "fish" {
        return Ok(());
    }
    let mut entries = row.fish_entries();
    let now = Utc::now();
    let mut still_open = 0;
    for e in entries.iter_mut().filter(|e| e.ended_at.is_none()) {
        match end_fish(app, &e.fish_session_id).await {
            Ok(()) => e.ended_at = Some(now),
            Err(err) => {
                still_open += 1;
                tracing::warn!(fish_session_id = %e.fish_session_id, error = %err, "could not end Fish session");
            }
        }
    }
    save_fish_entries(&app.db, id, &entries).await?;
    if still_open > 0 {
        // A Fish session we could not end may still be billing: settle later, with its real minutes.
        anyhow::bail!("{still_open} Fish session(s) still open");
    }
    let mut minutes = Vec::with_capacity(entries.len());
    for e in &entries {
        minutes.push(fish_minutes(app, e, now).await);
    }
    let cost = usage::record_fish(&app.db, &app.config, id, &minutes).await?;
    tracing::info!(session_id = %id, fish_sessions = minutes.len(), cost_usd = cost, "Fish minutes recorded");
    Ok(())
}

/// Background sweep: ends open sessions nobody holds in memory once they have been offline too long (after a
/// restart), and retries Fish settlement for ended sessions.
pub fn spawn_janitor(app: AppState, every: Duration) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        loop {
            tick.tick().await;
            if let Err(err) = sweep(&app).await {
                tracing::warn!(error = %format!("{err:#}"), "session sweep failed");
            }
        }
    });
}

pub async fn sweep(app: &AppState) -> anyhow::Result<()> {
    let offline = app.timing.offline_limit.as_secs_f64();
    let never = app.timing.start_limit.as_secs_f64();
    let stale: Vec<Uuid> = sqlx::query_scalar(
        "select id from sessions where \
           (status = 'created' and created_at < now() - make_interval(secs => $2)) \
           or (status in ('live', 'paused') \
               and coalesce(last_socket_at, started_at, created_at) < now() - make_interval(secs => $1))",
    )
    .bind(offline)
    .bind(never)
    .fetch_all(&app.db)
    .await?;
    for id in stale {
        if app.registry.get(&id.to_string()).is_none() {
            end_session(app, id, "disconnected").await?;
        }
    }
    let unsettled: Vec<Uuid> = sqlx::query_scalar(
        "select id from sessions where voice = 'fish' and not fish_usage_recorded \
           and status in ('scoring', 'scored', 'failed', 'abandoned') \
           and coalesce(ended_at, created_at) < now() - interval '1 minute'",
    )
    .fetch_all(&app.db)
    .await?;
    for id in unsettled {
        settle_fish(app, id).await?;
    }
    Ok(())
}
