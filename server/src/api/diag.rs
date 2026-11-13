//! Device check (`/diag` page) routes.
//!
//! - `POST /api/diag`: stores one result blob (a JSON object, at most 64 KB) for the caller's identity. At most
//!   `PER_IDENTITY_PER_HOUR` per identity and `ALL_PER_DAY` in total.
//! - `GET /api/diag/latest?limit=n`: the newest results, newest first. Needs `X-Dev-Key` (404 without it).
//! - `POST /api/diag/echo`: a Fish voice session for the echo test. Needs `X-Dev-Key` and an identity, at most
//!   `ECHO_PER_IDENTITY_PER_HOUR` per identity; each run is charged to the usage ledger (2 minutes, Fish, the current
//!   phase) when it is minted, so the build cap sees it. The agent reads a fixed
//!   passage as its first message (Fish speaks it; no model call), so the page can count what the microphone
//!   picks up while the tester stays silent, then time a barge-in. The session carries no app session id, so
//!   nothing it hears reaches a round. The server ends it after `ECHO_MAX_SECS` whatever the page does.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Extension, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router, middleware};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::app::AppState;
use crate::error::{AppError, AppResult};
use crate::fish::CreateFishSession;
use crate::identity::{self, Identity};
use crate::orchestrator::constant_time_eq;
use crate::usage;

pub const MAX_BYTES: usize = 64 * 1024;
pub const PER_IDENTITY_PER_HOUR: i64 = 20;
pub const ALL_PER_DAY: i64 = 1000;
/// Results are kept this many days.
pub const KEEP_DAYS: i64 = 30;
pub const ECHO_PER_IDENTITY_PER_HOUR: i64 = 3;
/// Serialises limit checks with their inserts (results and echo runs are rare).
const DIAG_LOCK: i64 = 0x4952_4449_4147;
/// Echo sessions per server process (each one bills Fish minutes).
pub const MAX_ECHO_SESSIONS: usize = 6;
/// The server ends an echo session this long after minting it.
pub const ECHO_MAX_SECS: u64 = 120;
/// What one echo test may cost at most (two minutes at the Fish rate), checked against the build cap.
const ECHO_RESERVE_MIN: f64 = 2.0;

/// About 60 seconds of speech: about 45 for the silent part, then a spoken cue to talk over the rest.
pub const ECHO_PASSAGE: &str = "This is a sound check for Interview Rounds. Please stay quiet while I read. \
The old harbour town wakes up slowly. Before sunrise, the bakery on the corner lights its ovens, and the smell of \
bread drifts down to the water. Fishing boats come back one by one, and the crews sort the catch on the stone pier \
while gulls wait on the railings. By eight, the market square fills with stalls selling fruit, cheese, flowers and \
old books. A ferry leaves for the islands every hour, and its horn echoes across the bay. In the afternoon, small \
sailboats race between the buoys, and children fly kites on the hill above the lighthouse. Now please talk over me, \
as if you wanted to cut in. I will keep reading until you do. In the evening, the cafes put out candles, the boats \
are tied up for the night, and the lighthouse begins to turn. The harbour master walks the pier one last time, checks \
the ropes and the lamps, and writes the day's weather in a thick blue book.";

static ECHO_SESSIONS: AtomicUsize = AtomicUsize::new(0);

pub fn routes(state: &AppState) -> Router<AppState> {
    let with_identity = Router::new()
        .route(
            "/api/diag",
            post(post_result).layer(DefaultBodyLimit::max(MAX_BYTES)),
        )
        .route("/api/diag/echo", post(echo_session))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            identity::require,
        ));
    Router::new()
        .route("/api/diag/latest", get(latest))
        .merge(with_identity)
}

fn dev_key_ok(app: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get("x-dev-key")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|k| {
            !k.is_empty() && constant_time_eq(k.as_bytes(), app.config.dev_key.as_bytes())
        })
}

async fn post_result(
    State(app): State<AppState>,
    Extension(me): Extension<Identity>,
    body: Bytes,
) -> AppResult<(StatusCode, Json<Value>)> {
    if body.len() > MAX_BYTES {
        return Err(AppError::BadRequest(
            "The results are larger than 64 KB.".into(),
        ));
    }
    let payload: Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("The results are not valid JSON.".into()))?;
    if !payload.is_object() {
        return Err(AppError::BadRequest(
            "The results must be a JSON object.".into(),
        ));
    }
    // Postgres jsonb cannot store a NUL character.
    if payload.to_string().contains("\\u0000") {
        return Err(AppError::BadRequest(
            "The results contain a NUL character.".into(),
        ));
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(DIAG_LOCK)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "delete from diag_results where created_at < now() - make_interval(days => $1::int)",
    )
    .bind(KEEP_DAYS as i32)
    .execute(&mut *tx)
    .await?;
    let (mine, all): (i64, i64) = sqlx::query_as(
        "select count(*) filter (where identity_id = $1 and created_at > now() - interval '1 hour'), \
                count(*) \
         from diag_results where created_at > now() - interval '1 day'",
    )
    .bind(me.id)
    .fetch_one(&mut *tx)
    .await?;
    if mine >= PER_IDENTITY_PER_HOUR || all >= ALL_PER_DAY {
        return Err(AppError::Limited {
            code: "diag_limit",
            message: "Too many results sent. Try again later.".into(),
        });
    }
    let id: i64 = sqlx::query_scalar(
        "insert into diag_results (identity_id, payload) values ($1, $2) returning id",
    )
    .bind(me.id)
    .bind(&payload)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({"id": id}))))
}

#[derive(Deserialize)]
struct LatestQuery {
    #[serde(default)]
    limit: Option<i64>,
}

async fn latest(
    State(app): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<LatestQuery>,
) -> AppResult<Json<Value>> {
    if !dev_key_ok(&app, &headers) {
        return Err(AppError::NotFound);
    }
    let limit = q.limit.unwrap_or(5).clamp(1, 50);
    let rows: Vec<(i64, uuid::Uuid, chrono::DateTime<chrono::Utc>, Value)> = sqlx::query_as(
        "select id, identity_id, created_at, payload from diag_results \
         order by created_at desc, id desc limit $1",
    )
    .bind(limit)
    .fetch_all(&app.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, identity_id, created_at, payload)| {
            json!({"id": id, "identity_id": identity_id, "created_at": created_at, "payload": payload})
        })
        .collect();
    Ok(Json(json!({"items": items})))
}

/// The Fish voice for the echo test: Maya's, else the first persona that has one.
fn echo_voice(app: &AppState) -> Option<String> {
    let cat = &app.catalog;
    cat.personas
        .get("persona.maya")
        .and_then(|p| cat.fish_voice_id(p))
        .or_else(|| cat.personas.values().find_map(|p| cat.fish_voice_id(p)))
        .map(str::to_string)
}

async fn echo_session(
    State(app): State<AppState>,
    Extension(me): Extension<Identity>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    if !dev_key_ok(&app, &headers) {
        return Err(AppError::NotFound);
    }
    let voice_id = echo_voice(&app).ok_or(AppError::Unavailable)?;
    // Limits and the ledger row in one transaction under the lock, so parallel taps cannot pass the limits.
    let mut tx = app.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(DIAG_LOCK)
        .execute(&mut *tx)
        .await?;
    let mine: i64 = sqlx::query_scalar(
        "select count(*) from usage_events where identity_id = $1 and kind = 'diag_echo' \
         and created_at > now() - interval '1 hour'",
    )
    .bind(me.id)
    .fetch_one(&mut *tx)
    .await?;
    if mine >= ECHO_PER_IDENTITY_PER_HOUR {
        return Err(AppError::Limited {
            code: "echo_limit",
            message: "Three echo tests an hour at most. Try again later.".into(),
        });
    }
    let reserve = ECHO_RESERVE_MIN * app.config.fish_rate_per_min;
    let spent = usage::fish_build_spend(&mut tx, &app.config).await?;
    if spent + reserve > app.config.fish_build_cap_usd {
        return Err(AppError::Limited {
            code: "fish_cap",
            message: "The voice budget is used up.".into(),
        });
    }
    if ECHO_SESSIONS.fetch_add(1, Ordering::SeqCst) >= MAX_ECHO_SESSIONS {
        return Err(AppError::Limited {
            code: "echo_cap",
            message: "Echo test limit reached for this server run.".into(),
        });
    }
    let token = app
        .fish
        .create_session(&CreateFishSession {
            agent_id: app.config.fish_agent_id.clone(),
            end_user_id: "diag-echo".into(),
            voice_id,
            system_prompt: "Sound check. Read the first message only.".into(),
            first_message: Some(ECHO_PASSAGE.into()),
            llm_extra_body: json!({"diag": "echo"}),
            record_audio: false,
            asr_model: None,
        })
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("fish echo session: {e}")))?;
    tracing::info!(fish_session_id = %token.session_id, "diag echo session");
    // Charged at the most it can run (the server ends it after two minutes).
    sqlx::query(
        "insert into usage_events (identity_id, provider, kind, usage_phase, minutes, cost_usd, meta) \
         values ($1, 'fish', 'diag_echo', $2, $3, $4, $5)",
    )
    .bind(me.id)
    .bind(app.config.usage_phase.as_str())
    .bind(ECHO_RESERVE_MIN)
    .bind(reserve)
    .bind(json!({"fish_session_id": token.session_id}))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let fish = app.fish.clone();
    let fish_id = token.session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(ECHO_MAX_SECS)).await;
        if let Err(e) = fish.end_session(&fish_id).await {
            tracing::info!(fish_session_id = %fish_id, error = %e, "diag echo session end");
        }
    });
    let fish_json = if token.raw.is_object() {
        token.raw.clone()
    } else {
        json!({"session_id": token.session_id, "token": token.token, "livekit_url": token.livekit_url})
    };
    Ok(Json(json!({
        "voice": {"transport": "fish", "fish": fish_json},
        "passage": ECHO_PASSAGE,
        "max_seconds": ECHO_MAX_SECS,
    })))
}
