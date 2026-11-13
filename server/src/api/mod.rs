//! REST API (docs/protocol.md, REST).

pub mod content;
pub mod diag;
pub mod llm_gate;
pub mod me;
pub mod meetings;
pub mod report;
pub mod sessions;
pub mod shares;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::routing::{delete, get, post, put};

use crate::app::AppState;
use crate::identity;

/// API routes. Everything except the content catalog needs an identity (a guest is created on first use).
pub fn routes(state: &AppState) -> Router<AppState> {
    let with_identity = Router::new()
        .route("/api/sessions", post(sessions::create))
        .route("/api/sessions/{id}", get(sessions::status))
        .route("/api/sessions/{id}/resume", post(sessions::resume))
        .route("/api/sessions/{id}/end", post(sessions::end))
        .route("/api/sessions/{id}/retry", post(sessions::retry))
        .route(
            "/api/sessions/{id}/panelists/{pid}/join",
            post(sessions::join),
        )
        .route("/api/me", get(me::me).delete(me::delete_me))
        .route("/api/me/history", get(me::history))
        .route("/api/me/skills", get(me::skills_route))
        .route("/api/me/settings", put(me::put_settings))
        .route("/api/me/onboarding-done", post(me::onboarding_done))
        .route("/api/shares", post(shares::create))
        .route("/api/shares/{slug}", delete(shares::delete))
        .merge(report::routes())
        .route(
            "/api/meetings/prepare",
            post(meetings::prepare_route)
                .layer(DefaultBodyLimit::max(crate::meeting::MAX_SETUP_BYTES)),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            identity::require,
        ));
    Router::new()
        .route("/api/content/catalog", get(content::catalog))
        // Public scorecard links: no identity needed.
        .route("/s/{slug}", get(shares::page))
        .merge(with_identity)
        .merge(diag::routes(state))
}
