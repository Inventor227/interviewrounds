//! Fish Audio agent sessions (REST only): mint a single-use browser token, end a session, read its transcript.

mod client;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use client::{DEFAULT_BASE_URL, FishClient};

/// What we ask for when minting a session for one panelist.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateFishSession {
    pub agent_id: String,
    pub end_user_id: String,
    pub voice_id: String,
    pub system_prompt: String,
    pub first_message: Option<String>,
    /// Comes back on every custom LLM call as `fishaudio_extra_body` (`session_id`, `panelist_id`). At most 16 KB.
    pub llm_extra_body: Value,
    pub record_audio: bool,
    /// Speech recognizer for this session (`overrides.asr.model`); None = the agent's.
    pub asr_model: Option<String>,
}

/// Wire body of `POST /v1/agent/sessions`.
#[derive(Serialize)]
pub(crate) struct CreateBody<'a> {
    pub agent_id: &'a str,
    pub end_user_id: &'a str,
    pub overrides: Overrides<'a>,
    pub llm_extra_body: &'a Value,
    pub record_audio: bool,
}

#[derive(Serialize)]
pub(crate) struct Overrides<'a> {
    pub voice_id: &'a str,
    pub system_prompt: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asr: Option<AsrOverride<'a>>,
}

#[derive(Serialize)]
pub(crate) struct AsrOverride<'a> {
    pub model: &'a str,
}

/// What the browser needs to join (`AgentSession.start({sessionToken})`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FishSessionToken {
    pub session_id: String,
    pub token: String,
    pub livekit_url: String,
    /// Join deadline as Fish sent it (string or number, kept as text).
    #[serde(default, deserialize_with = "string_or_number")]
    pub expires_at: Option<String>,
    /// Everything else Fish sent (`transport`, `max_duration_seconds`, ...), passed to the browser unchanged:
    /// the voice SDK checks some of it.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// `GET /v1/agent/sessions/{id}`, the parts we use.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FishSessionDetail {
    pub items: Vec<FishItem>,
    pub duration_seconds: Option<f64>,
    pub raw: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FishItem {
    pub role: Option<String>,
    pub text: Option<String>,
    pub created_at_ms: Option<i64>,
    pub raw: Value,
}

impl FishSessionDetail {
    /// Lenient parse: the transcript format is young, so unknown fields are kept in `raw`.
    pub fn from_value(raw: Value) -> Self {
        let items = raw
            .get("items")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(FishItem::from_value).collect())
            .unwrap_or_default();
        let duration_seconds = raw.get("duration_seconds").and_then(Value::as_f64);
        FishSessionDetail {
            items,
            duration_seconds,
            raw,
        }
    }
}

impl FishItem {
    fn from_value(v: &Value) -> Self {
        let text = ["text", "content"]
            .iter()
            .find_map(|k| v.get(*k).and_then(Value::as_str))
            .map(str::to_string);
        FishItem {
            role: v.get("role").and_then(Value::as_str).map(str::to_string),
            text,
            created_at_ms: v.get("created_at").and_then(timestamp_ms),
            raw: v.clone(),
        }
    }
}

/// Milliseconds since the epoch from an RFC 3339 string, or a number in seconds or milliseconds.
fn timestamp_ms(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|t| t.timestamp_millis()),
        Value::Number(n) => {
            let f = n.as_f64()?;
            // Anything below 1e11 is seconds (1e11 s is the year 5138).
            Some(if f.abs() < 1e11 {
                (f * 1000.0).round() as i64
            } else {
                f.round() as i64
            })
        }
        _ => None,
    }
}

fn string_or_number<'de, D>(de: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Option::<Value>::deserialize(de)? {
        Some(Value::String(s)) => Some(s),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum FishError {
    #[error("Fish API returned {status}: {message}")]
    Http { status: u16, message: String },
    #[error("Fish API unreachable: {0}")]
    Network(String),
    #[error("unexpected Fish API response: {0}")]
    Decode(String),
}
