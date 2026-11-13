//! REST API (docs/protocol.md, REST).

pub mod meetings;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::post;

use crate::app::AppState;

/// API routes.
pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/meetings/prepare",
        post(meetings::prepare_route).layer(DefaultBodyLimit::max(crate::meeting::MAX_SETUP_BYTES)),
    )
}
