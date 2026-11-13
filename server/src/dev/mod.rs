//! Developer-only routes, protected by `DEV_KEY` and never linked from the app.
//!
//! `/dev/voice-spike`: a bare page that starts one or two Fish voice sessions against this server's live
//! interviewer and records event and audio-level timings, so a headless browser with a fake microphone can measure
//! end-of-speech to first-agent-audio latency.

use std::time::Instant;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::app::AppState;
use crate::content::Catalog;
use crate::error::AppError;
use crate::fish::CreateFishSession;
use crate::orchestrator::{
    Level, LiveSettings, Mode, NewSession, SessionSettings, SessionState, Style, VoiceKind,
    constant_time_eq,
};

const PAGE: &str = include_str!("voice-spike.html");
const SCRIPT: &str = include_str!("voice-spike.js");
/// The page loads the voice SDK as an ES module from esm.sh; nothing else leaves the origin.
const PAGE_CSP: &str = "default-src 'self'; script-src 'self' https://esm.sh; connect-src 'self' https://esm.sh https://*.fish.audio wss://*.fish.audio https://*.livekit.cloud wss://*.livekit.cloud; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/dev/voice-spike", get(page))
        .route("/dev/voice-spike.js", get(script))
        .route("/dev/voice-spike/session", post(create_session))
        .route("/dev/voice-spike/state", get(session_state))
        .route("/dev/voice-spike/empty-next", post(empty_next))
        .route("/dev/voice-spike/confirm", post(confirm))
}

#[derive(Deserialize)]
struct KeyQuery {
    #[serde(default)]
    key: String,
    #[serde(default)]
    session_id: Option<String>,
}

/// At most this many spike sessions per server process (each one bills Fish minutes).
const MAX_SPIKE_SESSIONS: usize = 12;
static SPIKE_SESSIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// The dev key from the `x-dev-key` header (API calls) or the `key` query (the page itself).
fn dev_key<'a>(headers: &'a HeaderMap, q: &'a KeyQuery) -> &'a str {
    headers
        .get("x-dev-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(&q.key)
}

fn check_key(app: &AppState, key: &str) -> Result<(), AppError> {
    if !key.is_empty() && constant_time_eq(key.as_bytes(), app.config.dev_key.as_bytes()) {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}

fn with_csp(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PAGE_CSP),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-robots-tag", HeaderValue::from_static("noindex"));
    res
}

async fn page(
    State(app): State<AppState>,
    Query(q): Query<KeyQuery>,
) -> Result<Response, AppError> {
    check_key(&app, &q.key)?;
    Ok(with_csp(
        ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], PAGE).into_response(),
    ))
}

/// Static code with no secrets; the page passes its key to the API calls itself.
async fn script() -> Result<Response, AppError> {
    Ok(with_csp(
        (
            [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
            SCRIPT,
        )
            .into_response(),
    ))
}

#[derive(Deserialize)]
struct CreateBody {
    #[serde(default = "default_round")]
    round_id: String,
    /// How many panelists get a Fish session (1 or 2).
    #[serde(default = "one")]
    panel: usize,
    #[serde(default)]
    asr_model: Option<String>,
}

fn default_round() -> String {
    "sde.system_design.short".into()
}

fn one() -> usize {
    1
}

/// The content folder from the config, or `<data dir>/content` when the image ships none (spike deploys).
fn load_catalog(app: &AppState) -> Result<Catalog, AppError> {
    let primary = Catalog::load(&app.config.content_dir).unwrap_or_default();
    if !primary.rounds.is_empty() {
        return Ok(primary);
    }
    Catalog::load(&app.config.data_dir.join("content"))
        .map_err(|e| AppError::BadRequest(format!("no content: {e:#}")))
}

async fn create_session(
    State(app): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<KeyQuery>,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, AppError> {
    check_key(&app, dev_key(&headers, &q))?;
    let made = SPIKE_SESSIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if made >= MAX_SPIKE_SESSIONS {
        return Err(AppError::Limited {
            code: "spike_cap",
            message: "spike session cap reached for this server process".into(),
        });
    }
    let catalog = load_catalog(&app)?;
    let id = format!("spike-{}", uuid::Uuid::new_v4().simple());
    let state = SessionState::new(
        NewSession {
            id: id.clone(),
            identity_id: "dev-spike".into(),
            mode: Mode::Interview,
            round_id: body.round_id.clone(),
            settings: SessionSettings {
                level: Level::Senior,
                style: Style::Neutral,
                voice: VoiceKind::Fish,
            },
            panel: Vec::new(),
            question_id: None,
            meeting: None,
        },
        &catalog,
        LiveSettings::from_config(&app.config),
        Instant::now(),
    )
    .map_err(|e| AppError::BadRequest(format!("{e:#}")))?;
    let seats: Vec<(String, String, String)> = state
        .panel
        .iter()
        .take(body.panel.clamp(1, 2))
        .map(|p| {
            (
                p.panelist_id.clone(),
                p.persona.display_name.clone(),
                catalog.fish_voice_id(&p.persona).unwrap_or("").to_string(),
            )
        })
        .collect();
    app.registry.insert(state);

    let mut panelists = Vec::new();
    for (panelist_id, name, voice_id) in seats {
        let token = app
            .fish
            .create_session(&CreateFishSession {
                agent_id: app.config.fish_agent_id.clone(),
                end_user_id: "dev-spike".into(),
                voice_id,
                system_prompt: format!(
                    "You are {name}, a practice interviewer. Replies come from the app server."
                ),
                first_message: None,
                llm_extra_body: json!({"session_id": id, "panelist_id": panelist_id}),
                record_audio: false,
                asr_model: body.asr_model.clone(),
            })
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("fish session: {e}")))?;
        tracing::info!(session_id = %id, panelist_id = %panelist_id, fish_session_id = %token.session_id, asr = ?body.asr_model, "voice spike session");
        panelists.push(json!({"panelist_id": panelist_id, "display_name": name, "token": token}));
    }
    Ok(Json(json!({"session_id": id, "panelists": panelists})))
}

/// The server's view of a spike session: turn log, parked turns, floor, phase and brief.
async fn session_state(
    State(app): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<KeyQuery>,
) -> Result<Json<Value>, AppError> {
    check_key(&app, dev_key(&headers, &q))?;
    let id = q.session_id.unwrap_or_default();
    if !id.starts_with("spike-") {
        return Err(AppError::NotFound);
    }
    let session = app.registry.get(&id).ok_or(AppError::NotFound)?;
    let st = session.lock().await;
    Ok(Json(json!({
        "turns": st.turns,
        "provisional": st.provisional.len(),
        "floor": st.floor,
        "phase_index": st.phase_idx,
        "brief": st.brief,
        "history_messages": st.history.len(),
        "pending_handover": st.pending_handover,
    })))
}

/// Makes the next live reply of a spike session empty, to see what Fish does with an empty reply.
async fn empty_next(
    State(app): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<KeyQuery>,
) -> Result<Json<Value>, AppError> {
    check_key(&app, dev_key(&headers, &q))?;
    let id = q.session_id.unwrap_or_default();
    if !id.starts_with("spike-") {
        return Err(AppError::NotFound);
    }
    let session = app.registry.get(&id).ok_or(AppError::NotFound)?;
    session.lock().await.dev_empty_replies += 1;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct ConfirmBody {
    panelist_id: String,
    text: String,
}

/// The page saw the voice start playing a reply (what the app's socket will report): commit it now.
async fn confirm(
    State(app): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<KeyQuery>,
    Json(body): Json<ConfirmBody>,
) -> Result<Json<Value>, AppError> {
    check_key(&app, dev_key(&headers, &q))?;
    let id = q.session_id.unwrap_or_default();
    if !id.starts_with("spike-") {
        return Err(AppError::NotFound);
    }
    let session = app.registry.get(&id).ok_or(AppError::NotFound)?;
    let mut st = session.lock().await;
    let before = st.provisional.len();
    let events = crate::orchestrator::confirm_spoken(&mut st, &body.panelist_id, &body.text);
    let confirmed = st.provisional.len() < before;
    Ok(Json(
        json!({"confirmed": confirmed, "events": events.len()}),
    ))
}
