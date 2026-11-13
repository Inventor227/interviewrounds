//! The session report: `GET /api/sessions/{id}/report` (404 until ready), `POST /api/sessions/{id}/report`
//! (score again after a failure) and `POST /api/sessions/{id}/board-image` (the final board PNG, at most 2 MB).

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::AppState;
use crate::error::{AppError, AppResult};

/// Largest board image accepted.
pub const BOARD_IMAGE_MAX_BYTES: usize = 2 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/sessions/{id}/report", get(get_report).post(rescore))
        .route(
            "/api/sessions/{id}/board-image",
            post(post_board_image).layer(DefaultBodyLimit::max(BOARD_IMAGE_MAX_BYTES)),
        )
}

fn session_id(raw: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| AppError::NotFound)
}

async fn status_of(app: &AppState, id: Uuid) -> AppResult<String> {
    let status: Option<String> = sqlx::query_scalar("select status from sessions where id = $1")
        .bind(id)
        .fetch_optional(&app.db)
        .await?;
    status.ok_or(AppError::NotFound)
}

/// `GET /api/sessions/{id}/report` → `Report`, or 404 until it is ready.
async fn get_report(State(app): State<AppState>, Path(id): Path<String>) -> AppResult<Response> {
    let id = session_id(&id)?;
    let report: Option<Value> =
        sqlx::query_scalar("select report from reports where session_id = $1")
            .bind(id)
            .fetch_optional(&app.db)
            .await?;
    match report {
        Some(r) => Ok(([(header::CACHE_CONTROL, "no-store")], Json(r)).into_response()),
        None => Err(AppError::NotFound),
    }
}

/// `POST /api/sessions/{id}/report` → 202: a `failed` session goes back in the scoring queue (the "try again"
/// button). Already queued is fine; a session still running is 409.
async fn rescore(State(app): State<AppState>, Path(id): Path<String>) -> AppResult<Response> {
    let id = session_id(&id)?;
    match status_of(&app, id).await?.as_str() {
        "failed" => {
            sqlx::query(
                "update sessions set status = 'scoring' where id = $1 and status = 'failed'",
            )
            .bind(id)
            .execute(&app.db)
            .await?;
        }
        "scoring" | "scored" => {}
        _ => return Err(AppError::Conflict("The session has not ended yet.".into())),
    }
    Ok((StatusCode::ACCEPTED, Json(json!({ "status": "scoring" }))).into_response())
}

/// `POST /api/sessions/{id}/board-image` (body `image/png`) → 204. Saved under `DATA_DIR/board-images/<id>/`.
async fn post_board_image(
    State(app): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<StatusCode> {
    let id = session_id(&id)?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type.starts_with("image/png") {
        return Err(AppError::BadRequest(
            "The board image must be a PNG.".into(),
        ));
    }
    if body.len() > BOARD_IMAGE_MAX_BYTES {
        return Err(AppError::BadRequest(
            "The board image is larger than 2 MB.".into(),
        ));
    }
    if !body.starts_with(PNG_SIGNATURE) {
        return Err(AppError::BadRequest("The board image is not a PNG.".into()));
    }
    status_of(&app, id).await?;
    let rev: i64 = sqlx::query_scalar("select rev from boards where session_id = $1")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .unwrap_or(0);

    let rel = format!(
        "board-images/{id}/{rev}-{}.png",
        chrono::Utc::now().timestamp_millis()
    );
    let full = app.config.data_dir.join(&rel);
    if let Some(dir) = full.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("creating {}: {e}", dir.display())))?;
    }
    tokio::fs::write(&full, &body)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("writing {}: {e}", full.display())))?;
    sqlx::query("insert into board_images (session_id, rev, path, bytes) values ($1, $2, $3, $4)")
        .bind(id)
        .bind(rev)
        .bind(&rel)
        .bind(body.len() as i32)
        .execute(&app.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
