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
use tower_http::catch_panic::CatchPanicLayer;
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
use crate::static_files;
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
    /// Wraps background tasks of a session (meeting state updates) in the usage ledger's session scope.
    pub task_scope: Option<crate::meeting::live::TaskScope>,
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
            task_scope: Some(session_ledger_scope()),
            config: Arc::new(config),
            db,
        }
    }

    pub fn with_task_scope(mut self, scope: crate::meeting::live::TaskScope) -> Self {
        self.task_scope = Some(scope);
        self
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
        .layer(middleware::from_fn_with_state(
            Arc::new(public_dir.clone()),
            static_cache_headers,
        ))
        .layer(middleware::from_fn(worker_csp));

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
        .layer(catch_panic())
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

/// Runs a session's background task inside the ledger's session scope (a session id that is not a uuid runs
/// unscoped).
fn session_ledger_scope() -> crate::meeting::live::TaskScope {
    Arc::new(
        |sid: String, fut: futures::future::BoxFuture<'static, ()>| match sid.parse::<uuid::Uuid>()
        {
            Ok(u) => Box::pin(crate::usage::LLM_SESSION.scope(u, fut))
                as futures::future::BoxFuture<'static, ()>,
            Err(_) => fut,
        },
    )
}

/// A panic in one request answers 500 and leaves the server running (the release build unwinds; tasks spawned
/// with tokio are contained the same way).
pub fn catch_panic() -> CatchPanicLayer<fn(Box<dyn std::any::Any + Send + 'static>) -> Response> {
    CatchPanicLayer::custom(panic_response as fn(_) -> _)
}

fn panic_response(err: Box<dyn std::any::Any + Send + 'static>) -> Response {
    let detail = err
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| err.downcast_ref::<&str>().copied())
        .unwrap_or("unknown");
    tracing::error!(panic = detail, "a request handler panicked");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"status": 500, "code": "server_error", "message": "Something went wrong. Please try again."})),
    )
        .into_response()
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

/// The KTX2 (Basis) transcoder worker script. The transcoder's bindings build functions from strings when they start;
/// a worker loaded from a URL runs under that response's own CSP (not the page's), so only this worker may do that.
pub const KTX2_WORKER_PATH: &str = "/vendor/basis/ktx2_worker.js";
pub const KTX2_WORKER_CSP: &str =
    "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'";

/// Gives the transcoder worker its own CSP (the app-wide one is only set when a response has none). Also on a 304:
/// a worker that revalidates its script runs under the policy of that answer, so a 304 without it gets the page's.
async fn worker_csp(req: Request, next: Next) -> Response {
    let worker = req.uri().path() == KTX2_WORKER_PATH;
    let mut res = next.run(req).await;
    let script = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("text/javascript"));
    let answered = (res.status().is_success() && script) || res.status() == StatusCode::NOT_MODIFIED;
    if worker && answered {
        res.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(KTX2_WORKER_CSP),
        );
    }
    res
}

/// A public file asked for with its own content version (`?v=`, see `static_files`) is cached for a year. Everything
/// else (index.html, the web app routes, a file asked for with another build's version) revalidates.
async fn static_cache_headers(
    State(root): State<Arc<std::path::PathBuf>>,
    req: Request,
    next: Next,
) -> Response {
    let wanted = static_files::version_param(req.uri().query())
        .map(|v| (req.uri().path().to_string(), v.to_string()));
    let mut res = next.run(req).await;
    if res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED {
        let current = match &wanted {
            Some((path, v)) => static_files::file_version(&root, path)
                .await
                .is_some_and(|have| have == *v),
            None => false,
        };
        let value = if current {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    res
}
