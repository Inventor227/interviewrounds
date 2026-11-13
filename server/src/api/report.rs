//! The session report: `GET /api/sessions/{id}/report` (404 until ready), `POST /api/sessions/{id}/report`
//! (score again after a failure, at most twice a day per session) and `POST /api/sessions/{id}/board-image`
//! (the final board PNG, at most 2 MB, one per session).
//!
//! Every handler needs the caller's [`Identity`] (the identity layer adds it) and answers 404 for a session that
//! is not theirs. Mount [`routes`] under that layer.

use std::io::Cursor;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::AppState;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::scoring::MAX_RESCORES_PER_DAY;

/// Largest board image accepted.
pub const BOARD_IMAGE_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Largest board image edge accepted (the scorer scales to 1568 px anyway).
pub const BOARD_IMAGE_MAX_EDGE: u32 = 4096;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/sessions/{id}/report", get(get_report).post(rescore))
        .route(
            "/api/sessions/{id}/board-image",
            post(post_board_image).layer(DefaultBodyLimit::max(BOARD_IMAGE_MAX_BYTES)),
        )
}

/// The session's status when it belongs to the caller; 404 otherwise (never says whose it is).
async fn owned_status(app: &AppState, raw_id: &str, who: &Identity) -> AppResult<(Uuid, String)> {
    let id = Uuid::parse_str(raw_id).map_err(|_| AppError::NotFound)?;
    let row: Option<(String, Uuid)> =
        sqlx::query_as("select status, identity_id from sessions where id = $1")
            .bind(id)
            .fetch_optional(&app.db)
            .await?;
    match row {
        Some((status, owner)) if owner == who.id => Ok((id, status)),
        _ => Err(AppError::NotFound),
    }
}

/// `GET /api/sessions/{id}/report` → `Report`, or 404 until it is ready.
async fn get_report(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let (id, _) = owned_status(&app, &id, &who).await?;
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

/// `POST /api/sessions/{id}/report` → 202 `{status: "scoring"}`: a `failed` session goes back in the scoring
/// queue with two fresh attempts (the "try again" button). At most twice a day per session (429
/// `rescore_limit`). Already queued is a no-op; a scored session is 409; a session still running is 409.
async fn rescore(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let (id, status) = owned_status(&app, &id, &who).await?;
    match status.as_str() {
        "failed" => {
            let today: i64 = sqlx::query_scalar(
                "select count(*) from usage_events where session_id = $1 and kind = 'rescore' \
                   and created_at > now() - interval '1 day'",
            )
            .bind(id)
            .fetch_one(&app.db)
            .await?;
            if today >= MAX_RESCORES_PER_DAY {
                return Err(AppError::Limited {
                    code: "rescore_limit",
                    message: "This report was retried twice today. Try again tomorrow.".into(),
                });
            }
            let mut tx = app.db.begin().await?;
            sqlx::query(
                "insert into usage_events (identity_id, session_id, provider, kind, usage_phase, cost_usd) \
                 values ($1, $2, 'anthropic', 'rescore', $3, 0)",
            )
            .bind(who.id)
            .bind(id)
            .bind(app.config.usage_phase.as_str())
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "update sessions set status = 'scoring' where id = $1 and status = 'failed'",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
        }
        "scoring" => {}
        "scored" => {
            return Err(AppError::Conflict(
                "This session already has its report.".into(),
            ));
        }
        _ => return Err(AppError::Conflict("The session has not ended yet.".into())),
    }
    Ok((StatusCode::ACCEPTED, Json(json!({ "status": "scoring" }))).into_response())
}

/// `POST /api/sessions/{id}/board-image` (body `image/png`) → 204. One image per session: a new one replaces
/// the old (`DATA_DIR/board-images/<id>.png`). Only while the session is live, paused or being scored.
async fn post_board_image(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<StatusCode> {
    let (id, status) = owned_status(&app, &id, &who).await?;
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
    let dims = image::ImageReader::with_format(Cursor::new(&body[..]), image::ImageFormat::Png)
        .into_dimensions()
        .map_err(|_| AppError::BadRequest("The board image is not a readable PNG.".into()))?;
    if dims.0 == 0 || dims.1 == 0 || dims.0.max(dims.1) > BOARD_IMAGE_MAX_EDGE {
        return Err(AppError::BadRequest(
            "The board image must be at most 4096 pixels on each side.".into(),
        ));
    }
    if !matches!(status.as_str(), "live" | "paused" | "scoring") {
        return Err(AppError::Conflict(
            "The board can no longer be changed.".into(),
        ));
    }
    let rev: i64 = sqlx::query_scalar("select rev from boards where session_id = $1")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .unwrap_or(0);

    let rel = format!("board-images/{id}.png");
    let full = app.config.data_dir.join(&rel);
    if let Some(dir) = full.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("creating {}: {e}", dir.display())))?;
    }
    // Write next to the target, then rename, so a reader never sees half an image.
    let tmp = full.with_extension("png.part");
    tokio::fs::write(&tmp, &body)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("writing {}: {e}", tmp.display())))?;
    tokio::fs::rename(&tmp, &full)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("renaming {}: {e}", full.display())))?;
    let mut tx = app.db.begin().await?;
    sqlx::query("delete from board_images where session_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("insert into board_images (session_id, rev, path, bytes) values ($1, $2, $3, $4)")
        .bind(id)
        .bind(rev)
        .bind(&rel)
        .bind(body.len() as i32)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
