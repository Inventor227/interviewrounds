//! HTTP router: health check, API stubs, static web app, compression and security headers.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use serde_json::json;
use sqlx::PgPool;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::api;
use crate::claude::ClaudeClient;
use crate::config::Config;
use crate::content::Catalog;
use crate::db;
use crate::error::AppError;
use crate::fish::FishClient;
use crate::orchestrator::{LlmApi, OrchestratorOptions, Registry, SessionAuth, oai};
use crate::persist::DbSessionAuth;
use crate::usage::MeteredLlm;
use crate::ws::{self, Hubs, SessionTiming};

/// Shared state for every handler.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub llm: Arc<dyn LlmApi>,
    pub fish: FishClient,
    pub registry: Registry,
    pub session_auth: Arc<dyn SessionAuth>,
    pub orchestrator: OrchestratorOptions,
    /// Rounds, personas, prompts (`content/`).
    pub catalog: Arc<Catalog>,
    /// Socket hubs of live sessions.
    pub hubs: Hubs,
    pub timing: SessionTiming,
    /// Serialises reloading a session from the database into the registry.
    pub load_lock: Arc<tokio::sync::Mutex<()>>,
    /// Wakes the scoring worker when a round ends in `scoring`.
    pub scoring_kick: Arc<tokio::sync::Notify>,
}

impl AppState {
    /// State with the real clients. The content folder is loaded leniently here (tests run without one);
    /// `serve` loads it strictly first.
    pub fn new(db: PgPool, config: Config) -> Self {
        let catalog = Catalog::load(&config.content_dir).unwrap_or_else(|err| {
            tracing::warn!(error = %format!("{err:#}"), "content not loaded; no rounds available");
            Catalog::default()
        });
        let llm: Arc<dyn LlmApi> = Arc::new(ClaudeClient::new(&config));
        AppState {
            llm: Arc::new(MeteredLlm::new(llm, db.clone(), config.usage_phase)),
            fish: FishClient::new(&config),
            registry: Registry::new(),
            session_auth: Arc::new(DbSessionAuth::new(db.clone())),
            orchestrator: OrchestratorOptions::default(),
            catalog: Arc::new(catalog),
            hubs: Hubs::default(),
            timing: SessionTiming::default(),
            load_lock: Arc::new(tokio::sync::Mutex::new(())),
            scoring_kick: Arc::new(tokio::sync::Notify::new()),
            config: Arc::new(config),
            db,
        }
    }

    pub fn with_catalog(mut self, catalog: Catalog) -> Self {
        self.catalog = Arc::new(catalog);
        self
    }

    /// Replaces the Fish client (tests point it at a mock server).
    pub fn with_fish(mut self, fish: FishClient) -> Self {
        self.fish = fish;
        self
    }

    pub fn with_timing(mut self, timing: SessionTiming) -> Self {
        self.timing = timing;
        self
    }

    /// Replaces the model client (tests use a scripted one). Calls are still priced into the ledger.
    pub fn with_llm(mut self, llm: Arc<dyn LlmApi>) -> Self {
        self.llm = Arc::new(MeteredLlm::new(
            llm,
            self.db.clone(),
            self.config.usage_phase,
        ));
        self
    }

    pub fn with_session_auth(mut self, auth: Arc<dyn SessionAuth>) -> Self {
        self.session_auth = auth;
        self
    }

    pub fn with_orchestrator_options(mut self, options: OrchestratorOptions) -> Self {
        self.orchestrator = options;
        self
    }
}

/// Builds the full router. API routes come first; anything else is the web app.
pub fn router(state: AppState) -> Router {
    let csp = content_security_policy(&state.config);
    let public_dir = state.config.public_dir.clone();
    let index = public_dir.join("index.html");

    // Hashed build assets: a miss is a plain 404 (never the web app), and only hits are cached for a year.
    let assets: Router<AppState> = Router::new()
        .fallback_service(ServeDir::new(public_dir.join("assets")))
        .layer(middleware::from_fn(immutable_cache_headers));

    // Unknown paths fall back to index.html (status 200) so client routes work on reload.
    let static_files = Router::new()
        .fallback_service(ServeDir::new(&public_dir).fallback(ServeFile::new(index)))
        .layer(middleware::from_fn(static_cache_headers));

    Router::new()
        .merge(api::routes(&state))
        .route("/ws/session/{id}", get(ws::ws_handler))
        .nest("/assets", assets)
        .route("/healthz", get(healthz))
        // Fish custom LLM endpoint (and the fake-voice path from the browser).
        .route(
            "/v1/chat/completions",
            post(oai::chat_completions).layer(middleware::from_fn_with_state(
                state.clone(),
                api::llm_gate::gate,
            )),
        )
        // Developer pages (DEV_KEY; 404 without it).
        .merge(crate::dev::routes())
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

/// Hashed build assets are cached for a year (hits only).
async fn immutable_cache_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED {
        res.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    res
}

/// Everything else (index.html and the web app routes) revalidates.
async fn static_cache_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    res
}
