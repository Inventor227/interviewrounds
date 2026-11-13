//! Session REST routes: create, resume, swap-mode join, end, status.
//!
//! Create: check caps -> build the live state -> mint a Fish token for the floor panelist (all panelists when
//! `PANEL_MODE=joined`) -> prewarm the prompt cache -> persist -> `CreateSessionRes`.

use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
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
use crate::fish::CreateFishSession;
use crate::identity::Identity;
use crate::orchestrator::markers::{EventKind, UserInput};
use crate::orchestrator::prompt::prepare_live_turn;
use crate::orchestrator::speech_filter::SpeechFilter;
use crate::orchestrator::{
    Level, LiveSettings, Mode, NewSession, PanelSeat, SessionSettings, SessionState, SessionStatus,
    Style, TurnCommit, VoiceKind,
};
use crate::persist::{self, FishEntry, PanelEntry, SessionRow};
use crate::usage::{self, Length, StartRequest};
use crate::ws;

/// Advisory lock key that serialises the cap check and the insert of new sessions.
const CREATE_LOCK: i64 = 0x4952_5345_5353;

/// The note the next interviewer turn sees after a resume (the browser then sends `[event: resume]`).
pub const RESUME_NOTE: &str = "The candidate's connection dropped and they are back now. Welcome them back in one \
     short line, recap where you were in a few words, and carry on from there.";

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

fn fish_voice(token: &crate::fish::FishSessionToken) -> Value {
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

/// Mints a Fish session for one panelist (custom LLM calls carry our session and panelist ids back).
async fn mint_fish(
    app: &AppState,
    st: &SessionState,
    panelist_id: &str,
    first_message: Option<String>,
) -> AppResult<(crate::fish::FishSessionToken, FishEntry)> {
    let p = st.panelist(panelist_id).ok_or(AppError::NotFound)?;
    let voice_id = app
        .catalog
        .fish_voice_id(&p.persona)
        .ok_or_else(|| anyhow::anyhow!("no Fish voice for {}", p.persona.id))?
        .to_string();
    let req = CreateFishSession {
        agent_id: app.config.fish_agent_id.clone(),
        end_user_id: st.identity_id.clone(),
        voice_id,
        system_prompt: format!("You are {}, {}.", p.persona.display_name, p.persona.title),
        first_message,
        llm_extra_body: json!({"session_id": st.id, "panelist_id": panelist_id}),
        record_audio: true,
    };
    let token = app.fish.create_session(&req).await.map_err(|err| {
        tracing::warn!(session_id = %st.id, panelist_id, error = %err, "could not mint a Fish session");
        AppError::Unavailable
    })?;
    let entry = FishEntry {
        panelist_id: panelist_id.to_string(),
        fish_session_id: token.session_id.clone(),
        started_at: Utc::now(),
        ended_at: None,
    };
    Ok((token, entry))
}

/// Mints the voices a (re)starting session needs: the floor only in swap mode, everyone when joined.
async fn mint_voices(
    app: &AppState,
    st: &SessionState,
    mode: PanelMode,
) -> AppResult<(Vec<(String, Value)>, Vec<FishEntry>)> {
    let mut voices = Vec::new();
    let mut entries = Vec::new();
    for p in &st.panel {
        let wanted = st.settings.voice == VoiceKind::Fish
            && (mode == PanelMode::Joined || p.panelist_id == st.floor);
        let voice = if st.settings.voice == VoiceKind::Fake {
            json!({"transport": "fake"})
        } else if wanted {
            let (token, entry) = mint_fish(app, st, &p.panelist_id, None).await?;
            entries.push(entry);
            fish_voice(&token)
        } else {
            json!({"transport": "fish_pending"})
        };
        voices.push((p.panelist_id.clone(), voice));
    }
    Ok((voices, entries))
}

fn create_res(
    app: &AppState,
    st: &SessionState,
    token: &str,
    voices: &[(String, Value)],
    mode: PanelMode,
    limits: &usage::Limits,
) -> Value {
    let panel: Vec<Value> = panel_entries(st)
        .into_iter()
        .map(|e| {
            let voice = voices
                .iter()
                .find(|(id, _)| *id == e.panelist_id)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| json!({"transport": "fish_pending"}));
            let mut v = json!(e);
            v["voice"] = voice;
            v
        })
        .collect();
    let _ = app;
    json!({
        "session_id": st.id,
        "client_token": token,
        "ws_url": format!("/ws/session/{}", st.id),
        "round": round_public(&st.round),
        "panel": panel,
        "floor": st.floor,
        "panel_mode": mode.as_str(),
        "limits": limits,
        "timing": timing(st),
    })
}

fn prewarm(app: &AppState, st: &SessionState) {
    let (req, _) = prepare_live_turn(
        st,
        &st.floor,
        &UserInput::Event(EventKind::Start),
        Instant::now(),
    );
    app.llm.prewarm(&req);
}

async fn current_limits(app: &AppState, identity: &Identity) -> AppResult<usage::Limits> {
    let mut conn = app.db.acquire().await?;
    Ok(usage::limits(&mut conn, identity, &app.config, Utc::now()).await?)
}

/// `POST /api/sessions`.
pub async fn create(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Json(req): Json<CreateSessionReq>,
) -> Response {
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
            meeting: plan
                .as_ref()
                .map(|(_, p)| crate::orchestrator::MeetingState {
                    hidden: p.to_string(),
                }),
        },
        &app.catalog,
        LiveSettings::from_config(&app.config),
        now,
    )
    .map_err(|e| AppError::BadRequest(format!("This round cannot start: {e}")))?;
    // Nothing runs until the browser's socket says hello.
    st.status = SessionStatus::Created;
    st.paused_since = Some(now);

    let mode = app.config.panel_mode;
    let fish = req.voice == VoiceKind::Fish;
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
        length: req.length,
        fish,
        reservation_usd: reservation,
    };
    if let Err(cap) = usage::check_can_start(&mut tx, identity, &start, &app.config).await? {
        tx.rollback().await?;
        return Ok(Err(cap));
    }
    sqlx::query(
        "insert into sessions (id, identity_id, parent_session_id, mode, round_id, meeting_plan_id, length, \
           level, style, voice, panel_mode, settings, panel, status, fish_reserved_usd, question_id) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, \
           coalesce((select data from settings where identity_id = $2), '{}'::jsonb), $12, 'created', $13, $14)",
    )
    .bind(session_id)
    .bind(identity.id)
    .bind(req.parent_session_id)
    .bind(enum_str(&req.mode))
    .bind(&st.round.id)
    .bind(plan.as_ref().map(|(id, _)| *id))
    .bind(length_str(req.length))
    .bind(req.level.as_str())
    .bind(req.style.as_str())
    .bind(enum_str(&req.voice))
    .bind(mode.as_str())
    .bind(json!(panel_entries(&st)))
    .bind(reservation)
    .bind(&question_id)
    .execute(&mut *tx)
    .await?;
    let (token, _, _) = persist::issue_token(&mut tx, session_id, false).await?;
    tx.commit().await?;

    let (voices, entries) = match mint_voices(app, &st, mode).await {
        Ok(v) => v,
        Err(err) => {
            let _ = sqlx::query(
                "update sessions set status = 'failed', ended_at = now() where id = $1",
            )
            .bind(session_id)
            .execute(&app.db)
            .await;
            return Err(err);
        }
    };
    if !entries.is_empty() {
        persist::save_fish_entries(&app.db, session_id, &entries).await?;
    }
    prewarm(app, &st);
    persist::save_live(&app.db, session_id, &persist::snapshot(&st, now), 0).await?;

    let limits = current_limits(app, identity).await?;
    let res = create_res(app, &st, &token, &voices, mode, &limits);
    let handle = app.registry.insert(st);
    ws::attach(app, session_id, handle).await;
    tracing::info!(session_id = %session_id, round_id = %round.id, voice = %enum_str(&req.voice), "session created");
    Ok(Ok(res))
}

/// The caller's own session (others look like they do not exist).
async fn owned(app: &AppState, identity: &Identity, id: &str) -> AppResult<SessionRow> {
    let id = Uuid::parse_str(id).map_err(|_| AppError::NotFound)?;
    persist::fetch_session(&app.db, id)
        .await?
        .filter(|r| r.identity_id == identity.id)
        .ok_or(AppError::NotFound)
}

async fn live_handle(app: &AppState, row: &SessionRow) -> AppResult<Arc<Mutex<SessionState>>> {
    if !row.is_open() {
        return Err(AppError::Conflict("This session has ended.".into()));
    }
    persist::load_live(app, row.id)
        .await?
        .ok_or_else(|| AppError::Conflict("This session has ended.".into()))
}

/// `POST /api/sessions/{id}/resume`: same session, new client token, new Fish token(s) for the floor.
pub async fn resume(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let row = owned(&app, &identity, &id).await?;
    let handle = live_handle(&app, &row).await?;
    let mode = if row.panel_mode == "joined" {
        PanelMode::Joined
    } else {
        PanelMode::Swap
    };

    let mut tx = app.db.begin().await?;
    let (token, _, revoked) = persist::issue_token(&mut tx, row.id, true).await?;
    tx.commit().await?;
    if let Some(hub) = app.hubs.get(&row.id.to_string()) {
        hub.kick(revoked);
    }

    // The old Fish sessions are gone with the page; end them so they stop billing.
    let mut entries = row.fish_entries();
    let now = Utc::now();
    for e in entries.iter_mut().filter(|e| e.ended_at.is_none()) {
        e.ended_at = Some(now);
        let (fish, fid) = (app.fish.clone(), e.fish_session_id.clone());
        tokio::spawn(async move {
            if let Err(err) = fish.end_session(&fid).await {
                tracing::warn!(fish_session_id = %fid, error = %err, "could not end Fish session");
            }
        });
    }

    let mut st = handle.lock().await;
    let (voices, new_entries) = mint_voices(&app, &st, mode).await?;
    entries.extend(new_entries);
    persist::save_fish_entries(&app.db, row.id, &entries).await?;
    st.pending_notes.push(RESUME_NOTE.to_string());
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
    prewarm(&app, &st);
    persist::save_live(
        &app.db,
        row.id,
        &persist::snapshot(&st, Instant::now()),
        st.turns.len(),
    )
    .await?;
    let limits = current_limits(&app, &identity).await?;
    let res = create_res(&app, &st, &token, &voices, mode, &limits);
    tracing::info!(session_id = %row.id, "session resumed");
    Ok(Json(res))
}

/// `POST /api/sessions/{id}/panelists/{pid}/join {opening_line?}` (swap mode hand-over). The opening line goes
/// into the shared history as the new panelist's turn (Fish speaks it as `first_message`, so our endpoint never
/// sees it), and the floor moves.
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
    let handle = live_handle(&app, &row).await?;
    let mut st = handle.lock().await;
    if st.panelist(&pid).is_none() {
        return Err(AppError::NotFound);
    }
    let line = req
        .opening_line
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .or_else(|| st.pending_handover.get(&pid).cloned());
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
                    extra: Vec::new(),
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

    let voice = if st.settings.voice == VoiceKind::Fake {
        json!({"transport": "fake"})
    } else {
        // One voice at a time: the previous one stops billing.
        let mut entries = row.fish_entries();
        let ended = Utc::now();
        for e in entries
            .iter_mut()
            .filter(|e| e.ended_at.is_none() && e.panelist_id != pid)
        {
            e.ended_at = Some(ended);
            let (fish, fid) = (app.fish.clone(), e.fish_session_id.clone());
            tokio::spawn(async move {
                if let Err(err) = fish.end_session(&fid).await {
                    tracing::warn!(fish_session_id = %fid, error = %err, "could not end Fish session");
                }
            });
        }
        let (token, entry) = mint_fish(&app, &st, &pid, line.clone()).await?;
        entries.push(entry);
        persist::save_fish_entries(&app.db, row.id, &entries).await?;
        fish_voice(&token)
    };
    persist::save_live(
        &app.db,
        row.id,
        &persist::snapshot(&st, now),
        st.turns.len().saturating_sub(2),
    )
    .await?;
    Ok(Json(json!({ "voice": voice })))
}

/// `POST /api/sessions/{id}/end {reason}` -> 202.
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
    let report_ready: bool =
        sqlx::query_scalar("select exists (select 1 from reports where session_id = $1)")
            .bind(row.id)
            .fetch_one(&app.db)
            .await?;
    Ok(Json(
        json!({ "status": row.status, "report_ready": report_ready }),
    ))
}
