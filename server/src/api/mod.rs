//! REST API (docs/protocol.md, REST).

pub mod content;
pub mod llm_gate;
pub mod me;
pub mod report;
pub mod sessions;

use axum::Router;
use axum::middleware;
use axum::routing::{get, post, put};

use crate::app::AppState;
use crate::identity;

/// API routes. Everything except the content catalog needs an identity (a guest is created on first use).
pub fn routes(state: &AppState) -> Router<AppState> {
    let with_identity = Router::new()
        .route("/api/sessions", post(sessions::create))
        .route("/api/sessions/{id}", get(sessions::status))
        .route("/api/sessions/{id}/resume", post(sessions::resume))
        .route("/api/sessions/{id}/end", post(sessions::end))
        .route(
            "/api/sessions/{id}/panelists/{pid}/join",
            post(sessions::join),
        )
        .route("/api/me", get(me::me).delete(me::delete_me))
        .route("/api/me/history", get(me::history))
        .route("/api/me/skills", get(me::skills_route))
        .route("/api/me/settings", put(me::put_settings))
        .route("/api/me/onboarding-done", post(me::onboarding_done))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            identity::require,
        ));
    Router::new()
        .route("/api/content/catalog", get(content::catalog))
        .merge(with_identity)
}
