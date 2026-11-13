//! Session REST routes: create, resume, swap-mode join, end, status.
//!
//! Create: check caps -> build the live state -> mint a Fish token for the floor panelist (all panelists when
//! `PANEL_MODE=joined`) -> prewarm the prompt cache -> persist -> `CreateSessionRes`.
//!
//! The fake voice (browser speech, no Fish) is a development path: creating such a session needs the
//! `X-Dev-Key` header. Fish bookkeeping (join, resume) runs under the hub's Fish lock and re-reads the stored
//! Fish sessions there, so no minted session is ever lost from the list that gets ended and billed.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::content::round_public;
use crate::app::AppState;
use crate::claude::ContentBlock;
use crate::config::PanelMode;
use crate::content::RoundConfig;
use crate::error::{AppError, AppResult};
use crate::fish::{CreateFishSession, FishSessionToken};
use crate::identity::Identity;
use crate::orchestrator::markers::{EventKind, UserInput};
use crate::orchestrator::prompt::prepare_live_turn;
use crate::orchestrator::speech_filter::SpeechFilter;
use crate::orchestrator::{
    Level, LiveSettings, Mode, NewSession, PanelSeat, SessionSettings, SessionState, SessionStatus,
    Style, TurnCommit, VoiceKind, constant_time_eq,
};
use crate::persist::{self, FishEntry, PanelEntry, SessionRow};
use crate::usage::{self, LLM_SESSION, Length, StartRequest};
use crate::ws::{self, Hub};

/// Advisory lock key that serialises the cap check and the insert of new sessions.
const CREATE_LOCK: i64 = 0x4952_5345_5353;
/// Resumes allowed per session.
pub const MAX_RESUMES: i32 = 3;
/// A prewarm younger than this still holds the prompt cache (5 minutes): no need to write it again.
const PREWARM_FRESH: Duration = Duration::from_secs(240);
pub const DEV_KEY_HEADER: &str = "x-dev-key";

/// The note the next interviewer turn sees after a resume (the browser then sends `[event: resume]`).
pub const RESUME_NOTE: &str = "The candidate is back after a pause or a dropped connection. Say welcome back in a \
     few words, restate where you were in one sentence, then carry on from there.";

#[derive(Debug, Deserialize)]
pub struct CreateSessionReq {
    pub mode: Mode,
    #[serde(default)]
    pub round_id: Option<String>,
    #[serde(default)]
    pub meeting_plan_id: Option<Uuid>,
    pub length: Length,
    pub level: Level,
    pub style: Style,
    pub voice: VoiceKind,
    #[serde(default)]
    pub parent_session_id: Option<Uuid>,
}

#[derive(Debug, Default, Deserialize)]
pub struct JoinReq {
    #[serde(default)]
    pub opening_line: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EndReq {
    pub reason: String,
}

fn refuse(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({"status": status.as_u16(), "code": code, "message": message})),
    )
        .into_response()
}

fn length_str(l: Length) -> &'static str {
    match l {
        Length::Short => "short",
        Length::Full => "full",
    }
}

fn enum_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The request carries the configured dev key (never true for an empty key, on either side).
pub(crate) fn dev_key_ok(app: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get(DEV_KEY_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|k| {
            !k.is_empty()
                && !app.config.dev_key.is_empty()
                && constant_time_eq(k.as_bytes(), app.config.dev_key.as_bytes())
        })
}

/// The round in the requested length (following `short_version` / `full_version`).
fn pick_round(app: &AppState, round_id: &str, length: Length) -> AppResult<RoundConfig> {
    let round = app
        .catalog
        .round(round_id)
        .ok_or_else(|| AppError::BadRequest(format!("There is no round {round_id}.")))?;
    if round.length == length_str(length) {
        return Ok(round.clone());
    }
    let other = match length {
        Length::Short => round.short_version.as_deref(),
        Length::Full => round.full_version.as_deref(),
    };
    other
        .and_then(|id| app.catalog.round(id))
        .filter(|r| r.length == length_str(length))
        .cloned()
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "Round {round_id} has no {} version.",
                length_str(length)
            ))
        })
}

/// Panel seats of a meeting from its plan's attendees (server-only `hidden.persona_id`).
fn meeting_seats(plan: &Value) -> Vec<PanelSeat> {
    plan["attendees"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|att| att["hidden"]["persona_id"].as_str())
                .enumerate()
                .map(|(i, persona)| PanelSeat {
                    panelist_id: format!("p{}", i + 1),
                    persona_id: persona.to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn panel_entries(st: &SessionState) -> Vec<PanelEntry> {
    st.panel
        .iter()
        .map(|p| PanelEntry {
            panelist_id: p.panelist_id.clone(),
            persona_id: p.persona.id.clone(),
            display_name: p.persona.display_name.clone(),
            title: p.persona.title.clone(),
            avatar_id: p.persona.avatar_id.clone(),
            seat: p.seat,
        })
        .collect()
}

/// Timing the browser needs (RoundPublic strips it): silence wait scaled by level, the floor persona's own
/// interrupt time when it has one.
fn timing(st: &SessionState) -> Value {
    let factor = match st.settings.level {
        Level::Junior => 0.75,
        Level::Mid => 1.0,
        Level::Senior | Level::Staff => 1.5,
    };
    let interrupt = st
        .panelist(&st.floor)
        .and_then(|p| p.persona.interrupts_after_seconds)
        .unwrap_or(st.round.interrupt_after_seconds);
    json!({
        "silence_wait_seconds": (st.round.silence_wait_seconds as f64 * factor).round() as u64,
        "interrupt_after_seconds": interrupt,
        "target_minutes": st.round.target_minutes,
        "hard_stop_minutes": st.round.hard_stop_minutes,
    })
}

fn fish_voice(token: &FishSessionToken) -> Value {
    let fish = if token.raw.is_object() {
        token.raw.clone()
    } else {
        json!({
            "session_id": token.session_id,
            "token": token.token,
            "livekit_url": token.livekit_url,
            "expires_at": token.expires_at,
        })
    };
    json!({"transport": "fish", "fish": fish})
}

/// What a Fish session needs from the state (read under a short lock; minting happens outside it).
struct MintSpec {
    session_id: String,
    identity_id: String,
    panelist_id: String,
    display_name: String,
    title: String,
    voice_id: String,
}

fn mint_spec(app: &AppState, st: &SessionState, panelist_id: &str) -> AppResult<MintSpec> {
    let p = st.panelist(panelist_id).ok_or(AppError::NotFound)?;
    let voice_id = app
        .catalog
        .fish_voice_id(&p.persona)
        .ok_or_else(|| anyhow::anyhow!("no Fish voice for {}", p.persona.id))?
        .to_string();
    Ok(MintSpec {
        session_id: st.id.clone(),
        identity_id: st.identity_id.clone(),
        panelist_id: panelist_id.to_string(),
        display_name: p.persona.display_name.clone(),
        title: p.persona.title.clone(),
        voice_id,
    })
}

/// Mints a Fish session for one panelist (custom LLM calls carry our session and panelist ids back).
async fn mint_fish(
    app: &AppState,
    spec: &MintSpec,
    first_message: Option<String>,
) -> AppResult<(FishSessionToken, FishEntry)> {
    let req = CreateFishSession {
        agent_id: app.config.fish_agent_id.clone(),
        end_user_id: spec.identity_id.clone(),
        voice_id: spec.voice_id.clone(),
        system_prompt: format!("You are {}, {}.", spec.display_name, spec.title),
        first_message,
        llm_extra_body: json!({"session_id": spec.session_id, "panelist_id": spec.panelist_id}),
        record_audio: true,
        asr_model: None,
    };
    let token = app.fish.create_session(&req).await.map_err(|err| {
        tracing::warn!(session_id = %spec.session_id, panelist_id = %spec.panelist_id, error = %err, "could not mint a Fish session");
        AppError::Unavailable
    })?;
    let entry = FishEntry {
        panelist_id: spec.panelist_id.clone(),
        fish_session_id: token.session_id.clone(),
        started_at: Utc::now(),
        ended_at: None,
    };
    Ok((token, entry))
}

/// The panelists that get a voice now: the floor only in swap mode, everyone when joined.
fn voiced(st: &SessionState, mode: PanelMode) -> Vec<String> {
    st.panel
        .iter()
        .filter(|p| mode == PanelMode::Joined || p.panelist_id == st.floor)
        .map(|p| p.panelist_id.clone())
        .collect()
}

/// Mints the voices a (re)starting Fish session needs, saving each Fish session to `entries` the moment it
/// exists (so a failure part way leaves nothing untracked). Returns the voice per panelist.
async fn mint_voices(
    app: &AppState,
    session_id: Uuid,
    specs: Vec<MintSpec>,
) -> AppResult<Vec<(String, Value, String)>> {
    let mut out = Vec::new();
    for spec in specs {
        let (token, entry) = mint_fish(app, &spec, None).await?;
        track(app, session_id, &entry).await?;
        out.push((spec.panelist_id, fish_voice(&token), token.session_id));
    }
    Ok(out)
}

/// Adds a just-minted Fish session to the session's list. When the round ended meanwhile (settlement may already
/// have run), the new Fish session is ended at once and the caller gets 409.
async fn track(app: &AppState, session_id: Uuid, entry: &FishEntry) -> AppResult<()> {
    if persist::append_fish_entry(&app.db, session_id, entry).await? {
        return Ok(());
    }
    if let Err(err) = persist::end_fish(app, &entry.fish_session_id).await {
        tracing::error!(fish_session_id = %entry.fish_session_id, error = %err, "could not end a Fish session minted after the end");
    }
    Err(AppError::Conflict("This session has ended.".into()))
}

fn remember_voices(hub: &Hub, voices: &[(String, Value, String)]) {
    let mut cache = hub.voices.lock().unwrap_or_else(|e| e.into_inner());
    for (pid, voice, fish_id) in voices {
        cache.insert(pid.clone(), (fish_id.clone(), voice.clone()));
    }
}

fn panel_json(st: &SessionState, voices: &[(String, Value, String)]) -> Vec<Value> {
    panel_entries(st)
        .into_iter()
        .map(|e| {
            let voice = if st.settings.voice == VoiceKind::Fake {
                json!({"transport": "fake"})
            } else {
                voices
                    .iter()
                    .find(|(id, _, _)| *id == e.panelist_id)
                    .map(|(_, v, _)| v.clone())
                    .unwrap_or_else(|| json!({"transport": "fish_pending"}))
            };
            let mut v = json!(e);
            v["voice"] = voice;
            v
        })
        .collect()
}

fn create_res(
    st: &SessionState,
    token: &str,
    voices: &[(String, Value, String)],
    mode: PanelMode,
    limits: &usage::Limits,
) -> Value {
    json!({
        "session_id": st.id,
        "client_token": token,
        "ws_url": format!("/ws/session/{}", st.id),
        "round": round_public(&st.round),
        "panel": panel_json(st, voices),
        "floor": st.floor,
        "panel_mode": mode.as_str(),
        "limits": limits,
        "timing": timing(st),
    })
}

/// Writes the prompt cache for the floor panelist's next turn (priced into the ledger), unless it was written
/// less than 4 minutes ago.
fn prewarm(app: &AppState, hub: &Hub, st: &SessionState, session_id: Uuid) {
    {
        let mut last = hub.last_prewarm.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| t.elapsed() < PREWARM_FRESH) {
            return;
        }
        *last = Some(Instant::now());
    }
    let (mut req, _) = prepare_live_turn(
        st,
        &st.floor,
        &UserInput::Event(EventKind::Start),
        Instant::now(),
    );
    req.max_tokens = 0;
    req.stream = false;
    let llm = app.llm.clone();
    tokio::spawn(LLM_SESSION.scope(session_id, async move {
        if let Err(err) = llm.create(&req).await {
            tracing::warn!(session_id = %session_id, error = %err, "prewarm failed");
        }
    }));
}

async fn current_limits(app: &AppState, identity: &Identity) -> AppResult<usage::Limits> {
    let mut conn = app.db.acquire().await?;
    Ok(usage::limits(&mut conn, identity, &app.config, Utc::now()).await?)
}

/// `POST /api/sessions`.
pub async fn create(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    headers: HeaderMap,
    Json(req): Json<CreateSessionReq>,
) -> Response {
    if req.voice == VoiceKind::Fake && !dev_key_ok(&app, &headers) {
        return refuse(
            StatusCode::FORBIDDEN,
            "dev_only",
            "The text voice is for development only.",
        );
    }
    match create_inner(&app, &identity, req).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(cap)) => cap.into_response(),
        Err(err) => err.into_response(),
    }
}

async fn create_inner(
    app: &AppState,
    identity: &Identity,
    req: CreateSessionReq,
) -> AppResult<Result<Value, usage::CapError>> {
    // What to build.
    let mut meeting_state = None;
    let (round, seats, plan) = match req.mode {
        Mode::Interview => {
            let id = req
                .round_id
                .as_deref()
                .ok_or_else(|| AppError::BadRequest("round_id is required.".into()))?;
            (pick_round(app, id, req.length)?, Vec::new(), None)
        }
        Mode::Meeting => {
            let plan_id = req
                .meeting_plan_id
                .ok_or_else(|| AppError::BadRequest("meeting_plan_id is required.".into()))?;
            let plan: Value = sqlx::query_scalar(
                "select plan from meeting_plans where id = $1 and identity_id = $2",
            )
            .bind(plan_id)
            .bind(identity.id)
            .fetch_optional(&app.db)
            .await?
            .ok_or(AppError::NotFound)?;
            meeting_state =
                Some(crate::api::meetings::load_meeting(&app.db, plan_id, identity.id).await?);
            let id = req
                .round_id
                .clone()
                .unwrap_or_else(|| format!("meeting.{}", length_str(req.length)));
            (
                pick_round(app, &id, req.length)?,
                meeting_seats(&plan),
                Some((plan_id, plan)),
            )
        }
    };
    if let Some(parent) = req.parent_session_id {
        let owned: bool = sqlx::query_scalar(
            "select exists (select 1 from sessions where id = $1 and identity_id = $2)",
        )
        .bind(parent)
        .bind(identity.id)
        .fetch_one(&app.db)
        .await?;
        if !owned {
            return Err(AppError::BadRequest("Unknown parent session.".into()));
        }
    }

    let session_id = Uuid::new_v4();
    let now = Instant::now();
    let mut st = SessionState::new(
        NewSession {
            id: session_id.to_string(),
            identity_id: identity.id.to_string(),
            mode: req.mode,
            round_id: round.id.clone(),
            settings: SessionSettings {
                level: req.level,
                style: req.style,
                voice: req.voice,
            },
            panel: seats,
            question_id: None,
            meeting: meeting_state,
        },
        &app.catalog,
        LiveSettings::from_config(&app.config),
        now,
    )
    .map_err(|e| AppError::BadRequest(format!("This round cannot start: {e}")))?;
    // Nothing runs until the browser's socket says hello.
    st.status = SessionStatus::Created;
    // The problem is on the brief card from the first frame, before the opener says so. Interviews only: a meeting's
    // card is the user's own meeting, never a question from the bank.
    if st.mode == Mode::Interview && st.brief.is_none() {
        st.brief = crate::orchestrator::initial_brief(&st.question);
    }
    st.paused_since = Some(now);
    launch(
        app,
        identity,
        Launch {
            session_id,
            st,
            now,
            length: length_str(req.length),
            cap_length: req.length,
            parent: req.parent_session_id,
            meeting_plan_id: plan.as_ref().map(|(id, _)| *id),
            retry: None,
        },
    )
    .await
}

/// A built session, ready to be stored and voiced (from `create` or `retry`).
struct Launch {
    session_id: Uuid,
    st: SessionState,
    now: Instant,
    /// `sessions.length`: `short`, `full` or `retry`.
    length: &'static str,
    /// What the caps count it as (a retry counts as a quick round).
    cap_length: Length,
    parent: Option<Uuid>,
    meeting_plan_id: Option<Uuid>,
    /// `sessions.retry`: what a retry re-asks.
    retry: Option<Value>,
}

/// Checks the caps, stores the session, mints its voices and puts it live in memory: `CreateSessionRes`.
async fn launch(
    app: &AppState,
    identity: &Identity,
    l: Launch,
) -> AppResult<Result<Value, usage::CapError>> {
    let Launch {
        session_id,
        st,
        now,
        length,
        cap_length,
        parent,
        meeting_plan_id,
        retry,
    } = l;
    let mode = app.config.panel_mode;
    let fish = st.settings.voice == VoiceKind::Fish;
    let reservation = if fish {
        usage::fish_reservation(&st.round, st.panel.len(), mode, &app.config)
    } else {
        0.0
    };
    let question_id = st.question["id"].as_str().map(str::to_string);

    // Cap check and insert under one lock, so two requests cannot both take the last slot.
    let mut tx = app.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(CREATE_LOCK)
        .execute(&mut *tx)
        .await?;
    let start = StartRequest {
        length: cap_length,
        fish,
        reservation_usd: reservation,
    };
    if let Err(cap) = usage::check_can_start(&mut tx, identity, &start, &app.config).await? {
        tx.rollback().await?;
        return Ok(Err(cap));
    }
    // The browser makes the session on the mic tap, before the user enters the room, and only rounds that went
    // live count toward limits. So a new session replaces the caller's earlier ones that never started (found
    // under the lock, so concurrent creates leave at most one): they end as abandoned right after this commit.
    let replaced: Vec<Uuid> = sqlx::query_scalar(
        "select id from sessions where identity_id = $1 and status = 'created' and started_at is null",
    )
    .bind(identity.id)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query(
        "insert into sessions (id, identity_id, parent_session_id, mode, round_id, meeting_plan_id, length, \
           level, style, voice, panel_mode, settings, panel, status, fish_reserved_usd, question_id, retry) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, \
           coalesce((select data from settings where identity_id = $2), '{}'::jsonb), $12, 'created', $13, $14, $15)",
    )
    .bind(session_id)
    .bind(identity.id)
    .bind(parent)
    .bind(enum_str(&st.mode))
    .bind(&st.round.id)
    .bind(meeting_plan_id)
    .bind(length)
    .bind(st.settings.level.as_str())
    .bind(st.settings.style.as_str())
    .bind(enum_str(&st.settings.voice))
    .bind(mode.as_str())
    .bind(json!(panel_entries(&st)))
    .bind(reservation)
    .bind(&question_id)
    .bind(&retry)
    .execute(&mut *tx)
    .await?;
    let (token, _, _) = persist::issue_token(&mut tx, session_id, false).await?;
    tx.commit().await?;
    for old in replaced {
        if let Err(err) = persist::end_unstarted(app, old).await {
            tracing::warn!(session_id = %old, error = %format!("{err:#}"), "could not end a session that never started");
        }
    }

    let voices = if fish {
        let specs = voiced(&st, mode)
            .iter()
            .map(|pid| mint_spec(app, &st, pid))
            .collect::<AppResult<Vec<_>>>()?;
        match mint_voices(app, session_id, specs).await {
            Ok(v) => v,
            Err(err) => {
                // Failed sessions do not count; whatever was minted is ended and settled.
                let _ = sqlx::query(
                    "update sessions set status = 'failed', ended_at = now() where id = $1",
                )
                .bind(session_id)
                .execute(&app.db)
                .await;
                let app2 = app.clone();
                tokio::spawn(async move {
                    if let Err(e) = persist::settle_fish(&app2, session_id).await {
                        tracing::warn!(session_id = %session_id, error = %format!("{e:#}"), "could not settle a failed start");
                    }
                });
                return Err(err);
            }
        }
    } else {
        Vec::new()
    };
    persist::save_live(&app.db, session_id, &persist::snapshot(&st, now), 0).await?;

    let limits = current_limits(app, identity).await?;
    let res = create_res(&st, &token, &voices, mode, &limits);
    let round_id = st.round.id.clone();
    let voice = enum_str(&st.settings.voice);
    let handle = app.registry.insert(st);
    let hub = ws::attach(app, session_id, handle.clone()).await;
    remember_voices(&hub, &voices);
    prewarm(app, &hub, &*handle.lock().await, session_id);
    tracing::info!(session_id = %session_id, round_id = %round_id, voice = %voice, length, "session created");
    Ok(Ok(res))
}

/// `POST /api/sessions/{id}/retry` -> `CreateSessionRes`: a two minute retry of the weakest moment of the caller's
/// scored round (`crate::retry`). 409 `no_retry` when the report offers none; caps as for a quick round.
pub async fn retry(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    match retry_inner(&app, &identity, &headers, &id).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(refusal)) => refusal,
        Err(err) => err.into_response(),
    }
}

async fn retry_inner(
    app: &AppState,
    identity: &Identity,
    headers: &HeaderMap,
    id: &str,
) -> AppResult<Result<Value, Response>> {
    let parent = owned(app, identity, id).await?;
    let no_retry = || {
        Ok(Err(refuse(
            StatusCode::CONFLICT,
            "no_retry",
            "This report has no answer to retry.",
        )))
    };
    if parent.status != "scored" || parent.length == "retry" || parent.mode != "interview" {
        return no_retry();
    }
    let report: Option<Value> =
        sqlx::query_scalar("select report from reports where session_id = $1")
            .bind(parent.id)
            .fetch_optional(&app.db)
            .await?;
    let (Some(report), Some(base)) = (
        report,
        parent
            .round_id
            .as_deref()
            .and_then(|r| app.catalog.round(r))
            .cloned(),
    ) else {
        return no_retry();
    };
    let lines = crate::retry::lines(&app.db, parent.id).await?;
    let Some(spec) =
        crate::retry::spec_from(&report, &lines, &parent.panel_entries(), &base.panel.lead)
    else {
        return no_retry();
    };
    let voice: VoiceKind = serde_json::from_value(json!(parent.voice))
        .map_err(|_| anyhow::anyhow!("unexpected voice {:?}", parent.voice))?;
    if voice == VoiceKind::Fake && !dev_key_ok(app, headers) {
        return Ok(Err(refuse(
            StatusCode::FORBIDDEN,
            "dev_only",
            "The text voice is for development only.",
        )));
    }
    let settings = SessionSettings {
        level: serde_json::from_value::<Level>(json!(parent.level))
            .map_err(|_| anyhow::anyhow!("unexpected level {:?}", parent.level))?,
        style: serde_json::from_value::<Style>(json!(parent.style))
            .map_err(|_| anyhow::anyhow!("unexpected style {:?}", parent.style))?,
        voice,
    };

    let session_id = Uuid::new_v4();
    let now = Instant::now();
    let mut st = crate::retry::state(
        NewSession {
            id: session_id.to_string(),
            identity_id: identity.id.to_string(),
            mode: Mode::Interview,
            round_id: base.id.clone(),
            settings,
            panel: vec![PanelSeat {
                panelist_id: "p1".into(),
                persona_id: spec.persona_id.clone(),
            }],
            question_id: parent.question_id.clone(),
            meeting: None,
        },
        &spec,
        &base,
        &app.catalog,
        LiveSettings::from_config(&app.config),
        now,
    )
    .map_err(|e| AppError::Internal(e.context("building a retry")))?;
    st.status = SessionStatus::Created;
    crate::retry::prime(&mut st, &spec);
    st.paused_since = Some(now);
    let res = launch(
        app,
        identity,
        Launch {
            session_id,
            st,
            now,
            length: "retry",
            cap_length: Length::Short,
            parent: Some(parent.id),
            meeting_plan_id: None,
            retry: Some(json!(spec)),
        },
    )
    .await?;
    Ok(res.map_err(IntoResponse::into_response))
}

/// The caller's own session (others look like they do not exist).
async fn owned(app: &AppState, identity: &Identity, id: &str) -> AppResult<SessionRow> {
    let id = Uuid::parse_str(id).map_err(|_| AppError::NotFound)?;
    persist::fetch_session(&app.db, id)
        .await?
        .filter(|r| r.identity_id == identity.id)
        .ok_or(AppError::NotFound)
}

async fn live_handle(
    app: &AppState,
    row: &SessionRow,
) -> AppResult<(Arc<Mutex<SessionState>>, Arc<Hub>)> {
    if !row.is_open() {
        return Err(AppError::Conflict("This session has ended.".into()));
    }
    let handle = persist::load_live(app, row.id)
        .await?
        .ok_or_else(|| AppError::Conflict("This session has ended.".into()))?;
    let hub = ws::attach(app, row.id, handle.clone()).await;
    Ok((handle, hub))
}

/// How long a started round has had no socket: from the hub, or from `last_socket_at` when it is not loaded.
/// None while a socket is connected or before the round started.
async fn offline_for(app: &AppState, row: &SessionRow) -> AppResult<Option<Duration>> {
    if row.started_at.is_none() {
        return Ok(None);
    }
    if let Some(hub) = app.hubs.get(&row.id.to_string()) {
        return Ok(hub.offline_for().await);
    }
    let seen: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("select last_socket_at from sessions where id = $1")
            .bind(row.id)
            .fetch_one(&app.db)
            .await?;
    Ok(Some(
        seen.map(|t| (Utc::now() - t).to_std().unwrap_or_default())
            .unwrap_or(Duration::MAX),
    ))
}

/// `POST /api/sessions/{id}/resume`: same session, new client token, new Fish token(s) for the floor. Only
/// within the 3-minute window after a drop, and at most 3 times per session.
pub async fn resume(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Response {
    match resume_inner(&app, &identity, &id).await {
        Ok(r) => r,
        Err(err) => err.into_response(),
    }
}

async fn resume_inner(app: &AppState, identity: &Identity, id: &str) -> AppResult<Response> {
    let row = owned(app, identity, id).await?;
    if !row.is_open() {
        return Ok(refuse(
            StatusCode::CONFLICT,
            "session_ended",
            "This session has ended.",
        ));
    }
    // A paused round resumes with new voices (its old ones may have been released) whether or not its socket
    // dropped; the pause budget, not the offline window, limits it, and it does not use up a resume.
    let from_pause = row.status == "paused";
    if !from_pause
        && offline_for(app, &row)
            .await?
            .is_some_and(|gone| gone >= app.timing.offline_limit)
    {
        return Ok(refuse(
            StatusCode::CONFLICT,
            "resume_expired",
            "This round can no longer be resumed.",
        ));
    }
    let counted: Option<i32> = if from_pause {
        Some(0)
    } else {
        sqlx::query_scalar(
            "update sessions set resume_count = resume_count + 1 \
             where id = $1 and resume_count < $2 returning resume_count",
        )
        .bind(row.id)
        .bind(MAX_RESUMES)
        .fetch_optional(&app.db)
        .await?
    };
    if counted.is_none() {
        return Ok(refuse(
            StatusCode::CONFLICT,
            "resume_limit",
            "This round has been resumed too many times.",
        ));
    }
    let (handle, hub) = live_handle(app, &row).await?;
    let mode = if row.panel_mode == "joined" {
        PanelMode::Joined
    } else {
        PanelMode::Swap
    };

    // New voices first (a failed mint leaves the old token and voices working), then the token rotates. The old
    // Fish sessions went with the page: they are ended once the new ones exist.
    let voices = if row.voice == "fish" {
        let _fish = hub.fish_lock.lock().await;
        let fresh = persist::fetch_session(&app.db, row.id)
            .await?
            .ok_or(AppError::NotFound)?;
        let stale: Vec<String> = fresh
            .fish_entries()
            .into_iter()
            .filter(|e| e.ended_at.is_none())
            .map(|e| e.fish_session_id)
            .collect();
        let specs = {
            let st = handle.lock().await;
            voiced(&st, mode)
                .iter()
                .map(|pid| mint_spec(app, &st, pid))
                .collect::<AppResult<Vec<_>>>()?
        };
        let voices = match mint_voices(app, row.id, specs).await {
            Ok(v) => v,
            Err(err) if from_pause => return Err(err),
            Err(err) => {
                // This try does not count.
                let _ = sqlx::query(
                    "update sessions set resume_count = greatest(resume_count - 1, 0) where id = $1",
                )
                .bind(row.id)
                .execute(&app.db)
                .await;
                return Err(err);
            }
        };
        persist::end_in_background(app, row.id, stale);
        hub.voices.lock().unwrap_or_else(|e| e.into_inner()).clear();
        remember_voices(&hub, &voices);
        voices
    } else {
        Vec::new()
    };

    let mut tx = app.db.begin().await?;
    let (token, _, revoked) = persist::issue_token(&mut tx, row.id, true).await?;
    tx.commit().await?;
    hub.kick(revoked);

    let res = {
        let mut st = handle.lock().await;
        if !st.pending_notes.iter().any(|n| n == RESUME_NOTE) {
            st.pending_notes.push(RESUME_NOTE.to_string());
        }
        if st.status == SessionStatus::Paused {
            st.status = SessionStatus::Live;
        }
        let status = if st.status == SessionStatus::Created {
            "created"
        } else {
            "live"
        };
        sqlx::query(
            "update sessions set status = $2 where id = $1 and status in ('created', 'live', 'paused')",
        )
        .bind(row.id)
        .bind(status)
        .execute(&app.db)
        .await?;
        prewarm(app, &hub, &st, row.id);
        persist::save_live(
            &app.db,
            row.id,
            &persist::snapshot(&st, Instant::now()),
            st.turns.len(),
        )
        .await?;
        let limits = current_limits(app, identity).await?;
        create_res(&st, &token, &voices, mode, &limits)
    };
    tracing::info!(session_id = %row.id, "session resumed");
    Ok(Json(res).into_response())
}

/// `POST /api/sessions/{id}/panelists/{pid}/join {opening_line?}` (swap mode hand-over). The opening line goes
/// into the shared history as the new panelist's turn (Fish speaks it as `first_message`, so our endpoint never
/// sees it), and the floor moves. Joining a panelist that already has a live voice returns that voice.
pub async fn join(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path((id, pid)): Path<(String, String)>,
    body: Option<Json<JoinReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let row = owned(&app, &identity, &id).await?;
    if row.panel_mode != "swap" {
        return Err(AppError::Conflict(
            "The panel is joined; hand-overs need no new voice.".into(),
        ));
    }
    let (handle, hub) = live_handle(&app, &row).await?;
    let _fish = hub.fish_lock.lock().await;
    let (line, spec, fake) = {
        let st = handle.lock().await;
        if st.panelist(&pid).is_none() {
            return Err(AppError::NotFound);
        }
        let line = req
            .opening_line
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .or_else(|| st.pending_handover.get(&pid).cloned());
        let fake = st.settings.voice == VoiceKind::Fake;
        let spec = if fake {
            None
        } else {
            Some(mint_spec(&app, &st, &pid)?)
        };
        (line, spec, fake)
    };

    let fresh = persist::fetch_session(&app.db, row.id)
        .await?
        .ok_or(AppError::NotFound)?;
    let entries = fresh.fish_entries();
    if !fake {
        // Already holding a live voice: the same one again, nothing new is minted or said.
        let cached = hub
            .voices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&pid)
            .cloned();
        if let Some((fish_id, voice)) = cached
            && entries
                .iter()
                .any(|e| e.fish_session_id == fish_id && e.ended_at.is_none())
        {
            return Ok(Json(json!({ "voice": voice })));
        }
    }

    let voice = match spec {
        None => json!({"transport": "fake"}),
        Some(spec) => {
            // One voice at a time: every other open Fish session ends (including a stale one of this
            // panelist), once Fish confirms; settlement ends whatever is left.
            let stale: Vec<String> = entries
                .iter()
                .filter(|e| e.ended_at.is_none())
                .map(|e| e.fish_session_id.clone())
                .collect();
            hub.voices.lock().unwrap_or_else(|e| e.into_inner()).clear();
            let (token, entry) = mint_fish(&app, &spec, line.clone()).await?;
            track(&app, row.id, &entry).await?;
            persist::end_in_background(&app, row.id, stale);
            let voice = fish_voice(&token);
            remember_voices(&hub, &[(pid.clone(), voice.clone(), token.session_id)]);
            voice
        }
    };

    let mut st = handle.lock().await;
    let now = Instant::now();
    match &line {
        Some(line) => {
            let (_, mut draft) =
                prepare_live_turn(&st, &pid, &UserInput::Event(EventKind::Handover), now);
            // Only the marker goes in with the line; notes wait for this panelist's next real turn.
            draft.messages.truncate(1);
            draft.notes_used = 0;
            draft.warned_two_minutes = false;
            let mut filter = SpeechFilter::new();
            let spoken = format!("{}{}", filter.push(line), filter.finish());
            st.commit_turn(
                TurnCommit {
                    draft,
                    reply: vec![ContentBlock::text(line.clone())],
                    spoken,
                    tool_calls: Vec::new(),
                    handover_line_used: true,
                },
                now,
            );
        }
        None => st.floor = pid.clone(),
    }
    persist::save_live(
        &app.db,
        row.id,
        &persist::snapshot(&st, now),
        st.turns.len().saturating_sub(2),
    )
    .await?;
    Ok(Json(json!({ "voice": voice })))
}

/// `POST /api/sessions/{id}/end {reason}` -> 202. Ends the round now with the client's reason (an ending
/// already in progress keeps the reason given here).
pub async fn end(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    Json(req): Json<EndReq>,
) -> AppResult<StatusCode> {
    if !persist::END_REASONS.contains(&req.reason.as_str()) {
        return Err(AppError::BadRequest(format!(
            "reason must be one of {}.",
            persist::END_REASONS.join(", ")
        )));
    }
    let row = owned(&app, &identity, &id).await?;
    persist::end_session(&app, row.id, &req.reason).await?;
    Ok(StatusCode::ACCEPTED)
}

/// `GET /api/sessions/{id}` -> `{status, report_ready}`.
pub async fn status(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let row = owned(&app, &identity, &id).await?;
    // A retry has no report of its own: its report (the parent's, with the retry on it) is ready once scored.
    let report_ready: bool = if row.length == "retry" {
        row.status == "scored"
    } else {
        sqlx::query_scalar("select exists (select 1 from reports where session_id = $1)")
            .bind(row.id)
            .fetch_one(&app.db)
            .await?
    };
    Ok(Json(
        json!({ "status": row.status, "report_ready": report_ready }),
    ))
}
