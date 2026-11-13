use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use reqwest::{RequestBuilder, Response};
use serde_json::Value;

use super::{
    CreateBody, CreateFishSession, FishError, FishSessionDetail, FishSessionToken, Overrides,
};
use crate::config::Config;

pub const DEFAULT_BASE_URL: &str = "https://api.fish.audio";

#[derive(Clone)]
pub struct FishClient {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
}

impl fmt::Debug for FishClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FishClient")
            .field("base_url", &self.inner.base_url)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

impl FishClient {
    pub fn new(cfg: &Config) -> Self {
        Self::with_base_url(&cfg.fish_api_key, DEFAULT_BASE_URL)
    }

    pub fn with_base_url(api_key: &str, base_url: &str) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("building the HTTP client");
        FishClient {
            inner: Arc::new(Inner {
                http,
                base_url: base_url.trim_end_matches('/').to_string(),
                api_key: api_key.to_string(),
            }),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.inner.base_url)
    }

    fn auth(&self, req: RequestBuilder) -> RequestBuilder {
        req.bearer_auth(&self.inner.api_key)
    }

    /// `POST /v1/agent/sessions`: a single-use token for the browser. Costs nothing until someone joins.
    pub async fn create_session(
        &self,
        req: &CreateFishSession,
    ) -> Result<FishSessionToken, FishError> {
        let body = CreateBody {
            agent_id: &req.agent_id,
            end_user_id: &req.end_user_id,
            overrides: Overrides {
                voice_id: &req.voice_id,
                system_prompt: &req.system_prompt,
                first_message: req.first_message.as_deref(),
            },
            llm_extra_body: &req.llm_extra_body,
            record_audio: req.record_audio,
        };
        let res = self
            .auth(self.inner.http.post(self.url("/v1/agent/sessions")))
            .json(&body)
            .send()
            .await
            .map_err(network)?;
        let res = check(res).await?;
        res.json::<FishSessionToken>()
            .await
            .map_err(|e| FishError::Decode(e.to_string()))
    }

    /// `POST /v1/agent/sessions/{id}/end` (204).
    pub async fn end_session(&self, session_id: &str) -> Result<(), FishError> {
        let res = self
            .auth(
                self.inner
                    .http
                    .post(self.url(&format!("/v1/agent/sessions/{session_id}/end"))),
            )
            .send()
            .await
            .map_err(network)?;
        check(res).await.map(|_| ())
    }

    /// `GET /v1/agent/sessions/{id}`: transcript items and duration (works while the session is live).
    pub async fn get_session(&self, session_id: &str) -> Result<FishSessionDetail, FishError> {
        let res = self
            .auth(
                self.inner
                    .http
                    .get(self.url(&format!("/v1/agent/sessions/{session_id}"))),
            )
            .send()
            .await
            .map_err(network)?;
        let res = check(res).await?;
        let raw: Value = res
            .json()
            .await
            .map_err(|e| FishError::Decode(e.to_string()))?;
        Ok(FishSessionDetail::from_value(raw))
    }
}

fn network(err: reqwest::Error) -> FishError {
    FishError::Network(err.to_string())
}

async fn check(res: Response) -> Result<Response, FishError> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let body = res.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            ["message", "detail", "error"]
                .iter()
                .find_map(|k| v.get(*k).map(|m| m.as_str().map(str::to_string).unwrap_or_else(|| m.to_string())))
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    Err(FishError::Http {
        status: status.as_u16(),
        message,
    })
}
