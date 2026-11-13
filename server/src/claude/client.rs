//! The HTTP client: one pooled `reqwest::Client` (HTTP/2 when the server offers it, keep-alive).

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use futures::stream::BoxStream;
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{RequestBuilder, Response, StatusCode};

use super::stream::decode;
use super::{ClaudeError, MessagesRequest, MessagesResponse, StreamEvent, scrub};
use crate::config::Config;

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2026-10-21";
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// Time allowed for a whole non-streamed call (scoring can be long).
const CREATE_TIMEOUT: Duration = Duration::from_secs(180);
/// Longest gap between two chunks of a stream; the API sends pings well inside this.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct ClaudeClient {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    workspace_id: String,
}

impl fmt::Debug for ClaudeClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClaudeClient")
            .field("base_url", &self.inner.base_url)
            .field("api_key", &"<redacted>")
            .field("workspace_id", &"<redacted>")
            .finish()
    }
}

impl ClaudeClient {
    pub fn new(cfg: &Config) -> Self {
        Self::with_base_url(
            &cfg.anthropic_api_key,
            &cfg.anthropic_workspace_id,
            DEFAULT_BASE_URL,
        )
    }

    pub fn with_base_url(api_key: &str, workspace_id: &str, base_url: &str) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(READ_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .http2_keep_alive_interval(Duration::from_secs(20))
            .http2_keep_alive_while_idle(true)
            .build()
            .expect("building the HTTP client");
        ClaudeClient {
            inner: Arc::new(Inner {
                http,
                base_url: base_url.trim_end_matches('/').to_string(),
                api_key: api_key.to_string(),
                workspace_id: workspace_id.to_string(),
            }),
        }
    }

    /// Every call goes through here, so the auth, version and workspace headers are never missed.
    fn post(&self, req: &MessagesRequest) -> RequestBuilder {
        let mut headers = HeaderMap::new();
        headers.insert("anthropic-version", HeaderValue::from_static(API_VERSION));
        if let Ok(v) = HeaderValue::from_str(&self.inner.api_key) {
            headers.insert("x-api-key", v);
        }
        if let Ok(v) = HeaderValue::from_str(&self.inner.workspace_id) {
            headers.insert("anthropic-workspace-id", v);
        }
        if req.fallbacks.is_some() {
            headers.insert("anthropic-beta", HeaderValue::from_static(FALLBACK_BETA));
        }
        self.inner
            .http
            .post(format!("{}/v1/messages", self.inner.base_url))
            .headers(headers)
            .json(req)
    }

    /// Non-streamed call. `stop_reason: "refusal"` comes back as `ClaudeError::Refusal`.
    pub async fn create(&self, req: &MessagesRequest) -> Result<MessagesResponse, ClaudeError> {
        let mut req = req.clone();
        req.stream = false;
        let res = self
            .post(&req)
            .timeout(CREATE_TIMEOUT)
            .send()
            .await
            .map_err(network)?;
        let res = check_status(res).await?;
        let body: MessagesResponse = res.json().await.map_err(|e| {
            ClaudeError::Network(format!("reading response: {}", scrub(&e.to_string())))
        })?;
        if body.stop_reason.as_deref() == Some("refusal") {
            return Err(ClaudeError::Refusal);
        }
        Ok(body)
    }

    /// Streamed call. Errors before the first byte (HTTP status, connect) come back here; errors during the
    /// stream (an `error` event, a cut connection) come back as the stream's last item.
    pub async fn stream(
        &self,
        req: &MessagesRequest,
    ) -> Result<BoxStream<'static, Result<StreamEvent, ClaudeError>>, ClaudeError> {
        let mut req = req.clone();
        req.stream = true;
        let res = self.post(&req).send().await.map_err(network)?;
        let res = check_status(res).await?;
        Ok(decode(res.bytes_stream()))
    }

    /// Writes the prompt cache for `req` ahead of the first real turn: the same request with `max_tokens: 0`,
    /// not streamed, fire-and-forget.
    pub fn prewarm(&self, req: &MessagesRequest) {
        let mut req = req.clone();
        req.max_tokens = 0;
        req.stream = false;
        let client = self.clone();
        tokio::spawn(async move {
            match client
                .post(&req)
                .timeout(Duration::from_secs(60))
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => {
                    tracing::debug!(model = %req.model, "prompt cache prewarmed");
                }
                Ok(res) => {
                    tracing::warn!(model = %req.model, status = res.status().as_u16(), "prewarm failed");
                }
                Err(err) => {
                    tracing::warn!(model = %req.model, error = %scrub(&err.to_string()), "prewarm failed");
                }
            }
        });
    }
}

fn network(err: reqwest::Error) -> ClaudeError {
    ClaudeError::Network(scrub(&err.to_string()))
}

async fn check_status(res: Response) -> Result<Response, ClaudeError> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let retry_after = res
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(Duration::from_secs_f64);
    let body = res.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            let err = v.get("error")?;
            let kind = err.get("type").and_then(|t| t.as_str()).unwrap_or("error");
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("");
            Some(format!("{kind}: {msg}"))
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    let message = scrub(&format!("{} {}", status.as_u16(), message));
    Err(match status {
        StatusCode::TOO_MANY_REQUESTS => ClaudeError::RateLimited { retry_after },
        s if s.as_u16() == 529 => ClaudeError::Overloaded,
        s if s.is_server_error() => ClaudeError::ServerError { status: s.as_u16() },
        _ => ClaudeError::BadRequest(message),
    })
}
