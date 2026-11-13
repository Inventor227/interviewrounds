//! HTTP router: health check, API stubs, static web app, compression and security headers.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use serde_json::json;
use sqlx::PgPool;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::db;
use crate::error::AppError;

/// Shared state for every handler.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> Self {
        AppState {
            db,
            config: Arc::new(config),
        }
    }
}

/// Builds the full router. API routes come first; anything else is the web app.
pub fn router(state: AppState) -> Router {
    let csp = content_security_policy(&state.config);
    let public_dir = state.config.public_dir.clone();
    let index = public_dir.join("index.html");

    // Unknown paths fall back to index.html (status 200) so client routes work on reload.
    let static_files = Router::new()
        .fallback_service(ServeDir::new(&public_dir).fallback(ServeFile::new(index)))
        .layer(middleware::from_fn(static_cache_headers));

    Router::new()
        .route("/healthz", get(healthz))
        // Unknown API paths answer JSON 404 instead of the web app.
        .route("/api", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .route("/v1/{*rest}", any(api_not_found))
        .fallback_service(static_files)
        .with_state(state)
        .layer(CompressionLayer::new())
        .layer(security_header(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(security_header(
            header::REFERRER_POLICY,
            "strict-origin-when-cross-origin",
        ))
        .layer(security_header(
            header::STRICT_TRANSPORT_SECURITY,
            "max-age=31536000",
        ))
        .layer(security_header(header::X_FRAME_OPTIONS, "DENY"))
        .layer(security_header(
            HeaderName::from_static("permissions-policy"),
            "microphone=(self), xr-spatial-tracking=(self), camera=(), geolocation=()",
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            csp,
        ))
        .layer(TraceLayer::new_for_http())
}

fn security_header(name: HeaderName, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value))
}

/// CSP for a same-origin WebXR app that talks to Fish Audio (LiveKit) from the browser.
pub fn content_security_policy(cfg: &Config) -> HeaderValue {
    let ws_origin = if cfg.app_origin.starts_with("https://") {
        format!("wss://{}", cfg.app_host())
    } else {
        format!("ws://{}", cfg.app_host())
    };
    let policy = format!(
        "default-src 'self'; \
         script-src 'self' 'wasm-unsafe-eval'; \
         style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; \
         font-src 'self' data:; \
         media-src 'self' blob: mediastream:; \
         worker-src 'self' blob:; \
         connect-src 'self' {ws_origin} {extra} data: blob:; \
         form-action 'self' https://accounts.google.com; \
         frame-ancestors 'none'; \
         base-uri 'self'; \
         object-src 'none'",
        extra = cfg.csp_connect_extra
    );
    HeaderValue::from_str(&policy)
        .unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'"))
}

/// `GET /healthz`: 200 `{"ok":true,"db":true}` when Postgres answers `select 1`, else 503.
async fn healthz(State(state): State<AppState>) -> Response {
    let db_up = db::ping(&state.db).await;
    let status = if db_up {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "ok": db_up, "db": db_up })),
    )
        .into_response()
}

async fn api_not_found() -> AppError {
    AppError::NotFound
}

/// Hashed build assets are cached for a year; everything else (index.html) revalidates.
async fn static_cache_headers(req: Request, next: Next) -> Response {
    let immutable = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;
    if res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED {
        let value = if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    res
}
