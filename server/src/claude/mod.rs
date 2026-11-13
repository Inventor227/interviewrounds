//! Anthropic Messages API: request and response types, the HTTP client and the SSE stream decoder.
//!
//! Rules this module enforces by construction: `anthropic-version` and `anthropic-workspace-id` on every call,
//! no sampling parameters (the request type has no field for them), no assistant prefill (callers build turns),
//! the server-side fallback beta header whenever `fallbacks` is set.

mod client;
mod stream;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use client::{API_VERSION, ClaudeClient, DEFAULT_BASE_URL, FALLBACK_BETA};
pub use stream::StreamDecoder;

/// `POST /v1/messages` body. Optional fields are left out of the JSON when empty.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MessagesRequest {
    pub model: String,
    pub max_tokens: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub system: Vec<SystemBlock>,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<ToolChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Thinking>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_config: Option<OutputConfig>,
    /// `"default"` (scalar form) or a list of fallback models. Sends the fallback beta header when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallbacks: Option<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stream: bool,
}

/// A top-level system prompt block.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename = "text")]
pub struct SystemBlock {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
}

impl SystemBlock {
    pub fn text(text: impl Into<String>) -> Self {
        SystemBlock {
            text: text.into(),
            cache_control: None,
        }
    }

    /// A block that ends the cached prefix (`cache_control: ephemeral`).
    pub fn cached(text: impl Into<String>) -> Self {
        SystemBlock {
            text: text.into(),
            cache_control: Some(CacheControl::ephemeral()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheControl {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<String>,
}

impl CacheControl {
    pub fn ephemeral() -> Self {
        CacheControl {
            kind: "ephemeral".into(),
            ttl: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    /// Mid-conversation system message: must follow a user message and be last or followed by an assistant turn.
    System,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

impl Message {
    pub fn user_text(text: impl Into<String>) -> Self {
        Message {
            role: Role::User,
            content: vec![ContentBlock::text(text)],
        }
    }

    pub fn assistant_text(text: impl Into<String>) -> Self {
        Message {
            role: Role::Assistant,
            content: vec![ContentBlock::text(text)],
        }
    }

    pub fn system_text(text: impl Into<String>) -> Self {
        Message {
            role: Role::System,
            content: vec![ContentBlock::text(text)],
        }
    }

    /// All text blocks joined.
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

/// Content blocks we build or read back. Anything else (for example a `fallback` block) is kept verbatim
/// in `Other` so assistant turns can be sent back unchanged.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
    #[serde(untagged)]
    Other(Value),
}

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        ContentBlock::Text {
            text: text.into(),
            cache_control: None,
        }
    }

    /// Sets or clears `cache_control` on blocks that carry one.
    pub fn set_cache_control(&mut self, value: Option<CacheControl>) {
        match self {
            ContentBlock::Text { cache_control, .. }
            | ContentBlock::ToolResult { cache_control, .. } => *cache_control = value,
            _ => {}
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
}

/// Only `auto` and `none`: forced choices are rejected by the 5.5 models.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolChoice {
    Auto,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Thinking {
    Adaptive,
    Disabled,
    /// Sonnet 5.5 only: no extended thinking (its way of turning thinking off), effort `high` or below.
    BetweenTools,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OutputConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Structured output: `{"type": "json_schema", "schema": {...}}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<Value>,
}

impl OutputConfig {
    pub fn effort(level: &str) -> Self {
        OutputConfig {
            effort: Some(level.to_string()),
            format: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessagesResponse {
    #[serde(default)]
    pub id: String,
    /// The model that actually served the request (differs from the request after a fallback).
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub content: Vec<ContentBlock>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub usage: Usage,
}

impl MessagesResponse {
    /// All text blocks joined.
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

/// What a streamed response yields, in order. Text arrives as soon as it is decoded; a tool call only once its
/// input JSON is complete (`content_block_stop`); thinking and other model blocks whole, for verbatim replay.
#[derive(Clone, Debug, PartialEq)]
pub enum StreamEvent {
    TextDelta(String),
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// A thinking, redacted thinking or other non-text block, complete, to send back unchanged.
    Block(ContentBlock),
    Stop {
        reason: String,
        usage: Usage,
    },
}

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum ClaudeError {
    #[error("rate limited (retry after {retry_after:?})")]
    RateLimited { retry_after: Option<Duration> },
    /// HTTP 529, or an `overloaded_error` event in a stream.
    #[error("overloaded")]
    Overloaded,
    /// Any other 5xx (or an `api_error` event in a stream, kept as 500).
    #[error("server error {status}")]
    ServerError { status: u16 },
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("refused")]
    Refusal,
    #[error("network: {0}")]
    Network(String),
}

/// Drops thinking blocks (and messages left empty by that) from a history. A thinking block is only valid under the
/// exact prefix it was made with, so a request with another system prompt, tools or model must never carry one.
pub fn strip_thinking(messages: &mut Vec<Message>) {
    for m in messages.iter_mut() {
        m.content.retain(|b| {
            !matches!(
                b,
                ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. }
            )
        });
    }
    messages.retain(|m| !m.content.is_empty());
}

impl ClaudeError {
    /// The model could not answer right now (overloaded or another 5xx, rate limited, the connection failed): worth
    /// one more try on a different model. Bad requests and refusals are not.
    pub fn is_unavailable(&self) -> bool {
        matches!(
            self,
            ClaudeError::Overloaded
                | ClaudeError::ServerError { .. }
                | ClaudeError::RateLimited { .. }
                | ClaudeError::Network(_)
        )
    }

    /// The HTTP status behind the error, when there was one (529 overloaded, 5xx, 429, 4xx); for the ledger.
    pub fn status(&self) -> Option<u16> {
        match self {
            ClaudeError::Overloaded => Some(529),
            ClaudeError::ServerError { status } => Some(*status),
            ClaudeError::RateLimited { .. } => Some(429),
            // The message starts with the status ("400 invalid_request_error: ...") when it came from HTTP.
            ClaudeError::BadRequest(msg) => {
                msg.split_whitespace().next().and_then(|w| w.parse().ok())
            }
            ClaudeError::Refusal | ClaudeError::Network(_) => None,
        }
    }

    /// The error's class for the ledger (never its text).
    pub fn kind(&self) -> &'static str {
        match self {
            ClaudeError::RateLimited { .. } => "rate_limited",
            ClaudeError::Overloaded => "overloaded",
            ClaudeError::ServerError { .. } => "server_error",
            ClaudeError::BadRequest(_) => "bad_request",
            ClaudeError::Refusal => "refusal",
            ClaudeError::Network(_) => "network",
        }
    }
}

/// Thinking setting for the cheapest fast reply on each model family.
/// Opus 5.5 always thinks (send nothing, control depth with effort); Sonnet 5.5 turns thinking off with
/// `between_tools`; Haiku 5.5 accepts `disabled` at effort `high` or below.
pub fn thinking_for(model: &str) -> Option<Thinking> {
    if model.starts_with("claude-sonnet-5-5") {
        Some(Thinking::BetweenTools)
    } else if model.starts_with("claude-haiku-5-5") {
        Some(Thinking::Disabled)
    } else {
        None
    }
}

/// Server-side refusal fallbacks exist for Opus 5.5 and Sonnet 5.5 only.
pub fn fallbacks_for(model: &str) -> Option<Value> {
    if model.starts_with("claude-opus-5-5") || model.starts_with("claude-sonnet-5-5") {
        Some(Value::String("default".into()))
    } else {
        None
    }
}

/// Removes anything that looks like an API key from text we might log or return.
pub(crate) fn scrub(text: &str) -> String {
    text.split_inclusive(char::is_whitespace)
        .map(|word| {
            if word
                .trim_start_matches(|c: char| !c.is_alphanumeric())
                .starts_with("sk-")
            {
                let trailing: String = word.chars().filter(|c| c.is_whitespace()).collect();
                format!("[redacted]{trailing}")
            } else {
                word.to_string()
            }
        })
        .collect()
}
