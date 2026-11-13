//! The live interviewer: session state, prompt building, tools, speech filtering and the Fish custom LLM endpoint.

pub mod director;
pub mod markers;
pub mod oai;
pub mod prompt;
pub mod speech_filter;
pub mod state;
pub mod tools;

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};

pub use state::{
    DirectorJob, Level, LiveSettings, MeetingState, Mode, NewSession, PanelSeat, Panelist,
    Provisional, Registry, SessionSettings, SessionState, SessionStatus, Style, Turn, TurnCommit,
    VoiceKind,
};

use crate::claude::{ClaudeClient, ClaudeError, MessagesRequest, MessagesResponse, StreamEvent};

/// The model API as the orchestrator sees it, so tests can script replies.
#[async_trait]
pub trait LlmApi: Send + Sync {
    async fn create(&self, req: &MessagesRequest) -> Result<MessagesResponse, ClaudeError>;
    async fn stream(
        &self,
        req: &MessagesRequest,
    ) -> Result<BoxStream<'static, Result<StreamEvent, ClaudeError>>, ClaudeError>;
}

/// One non-streamed call with a second attempt on `fallback` when the model is unavailable (overloaded, 5xx, 429,
/// connection failed). Fast side calls use it (director, Scribe, meeting state, meeting prepare): an overload of
/// one model never takes all of them down. No fallback, or a fallback equal to the model, means one attempt.
pub async fn create_with_fallback(
    llm: &dyn LlmApi,
    req: &MessagesRequest,
    fallback: Option<&str>,
) -> Result<MessagesResponse, ClaudeError> {
    match llm.create(req).await {
        Err(e) if e.is_unavailable() => match fallback.filter(|m| *m != req.model) {
            Some(model) => {
                tracing::warn!(model = %req.model, fallback = %model, error = %e.kind(), "model unavailable; one try on the fallback");
                llm.create(&retarget(req, model)).await
            }
            None => Err(e),
        },
        other => other,
    }
}

/// The same request on another model: its own thinking setting (adaptive or omitted stays so; a "thinking off"
/// setting becomes the new model's way of turning it off) and server-side fallbacks.
pub fn retarget(req: &MessagesRequest, model: &str) -> MessagesRequest {
    use crate::claude::Thinking;
    let mut out = req.clone();
    out.model = model.to_string();
    out.thinking = match req.thinking {
        None => None,
        Some(Thinking::Adaptive) => Some(Thinking::Adaptive),
        Some(Thinking::Disabled | Thinking::BetweenTools) => crate::claude::thinking_for(model),
    };
    out.fallbacks = crate::claude::fallbacks_for(model);
    cap_effort_for_thinking_off(&mut out);
    out
}

/// Thinking off (`disabled`, `between_tools`) is accepted at effort `high` or below: a higher `LIVE_EFFORT` is
/// lowered to `high` on such a request, so a retarget never makes an invalid request.
pub fn cap_effort_for_thinking_off(req: &mut MessagesRequest) {
    use crate::claude::Thinking;
    if matches!(
        req.thinking,
        Some(Thinking::Disabled | Thinking::BetweenTools)
    ) && let Some(cfg) = req.output_config.as_mut()
        && matches!(cfg.effort.as_deref(), Some("xhigh" | "max"))
    {
        cfg.effort = Some("high".into());
    }
}

#[async_trait]
impl LlmApi for ClaudeClient {
    async fn create(&self, req: &MessagesRequest) -> Result<MessagesResponse, ClaudeError> {
        ClaudeClient::create(self, req).await
    }

    async fn stream(
        &self,
        req: &MessagesRequest,
    ) -> Result<BoxStream<'static, Result<StreamEvent, ClaudeError>>, ClaudeError> {
        ClaudeClient::stream(self, req).await
    }
}

/// Checks a session's `client_token` (the fake-voice path calls the endpoint straight from the browser).
#[async_trait]
pub trait SessionAuth: Send + Sync {
    async fn client_token_ok(&self, session_id: &str, token: &str) -> bool;
}

/// In-memory tokens (tests, and until sessions are stored).
#[derive(Default)]
pub struct MemorySessionAuth {
    tokens: RwLock<HashMap<String, String>>,
}

impl MemorySessionAuth {
    pub fn insert(&self, session_id: &str, token: &str) {
        self.tokens
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.into(), token.into());
    }

    pub fn remove(&self, session_id: &str) {
        self.tokens
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id);
    }
}

#[async_trait]
impl SessionAuth for MemorySessionAuth {
    async fn client_token_ok(&self, session_id: &str, token: &str) -> bool {
        let tokens = self.tokens.read().unwrap_or_else(|e| e.into_inner());
        tokens
            .get(session_id)
            .is_some_and(|t| constant_time_eq(t.as_bytes(), token.as_bytes()))
    }
}

/// The browser's `voice.spoken {panelist_id, text_prefix}` report (the voice started playing this text): commits the
/// matching parked reply and runs its tool actions now. Returns the events (also broadcast on `state.events`).
/// Call `SessionState::flush_provisional` on pause and `Registry::end_session` at the end.
pub fn confirm_spoken(
    state: &mut SessionState,
    panelist_id: &str,
    text_prefix: &str,
) -> Vec<ServerEvent> {
    state.confirm_spoken(panelist_id, text_prefix)
}

/// Compares secrets without an early exit on the first differing byte.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Timing for live turns. Fish allows 10 s per reply (one retry, then a hold line, three failures hang up).
#[derive(Clone, Debug)]
pub struct OrchestratorOptions {
    /// Time to the first text from the live model before giving up on it.
    pub first_text_timeout: Duration,
    /// Longest gap between stream events once text is flowing.
    pub idle_timeout: Duration,
    /// How long a turn waits for the previous turn of the same session to finish.
    pub turn_wait: Duration,
    /// The whole turn, from request start: the call and its one retry share it (Fish allows 10 s).
    pub turn_deadline: Duration,
    /// Spoken when no model produced anything, so Fish never gets an empty reply.
    pub hold_line: String,
    /// Replies to speech wait for the voice platform to confirm them before they enter the history (speculative
    /// drafts are often thrown away). Off only in tests of the commit itself.
    pub confirm_speech_turns: bool,
}

impl Default for OrchestratorOptions {
    fn default() -> Self {
        OrchestratorOptions {
            first_text_timeout: Duration::from_millis(5000),
            idle_timeout: Duration::from_secs(8),
            turn_wait: Duration::from_secs(6),
            turn_deadline: Duration::from_millis(8500),
            hold_line: "Sorry, give me a second.".into(),
            confirm_speech_turns: true,
        }
    }
}

/// Server to browser WebSocket events (`{"t": ..., "d": ...}`; the socket layer adds `seq`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "t", content = "d")]
pub enum ServerEvent {
    #[serde(rename = "round.state")]
    RoundState(RoundStateMsg),
    #[serde(rename = "panel.hand_over")]
    HandOver {
        from: String,
        to: String,
        opening_line: String,
    },
    #[serde(rename = "avatar.point_at")]
    PointAt {
        panelist_id: String,
        item_id: String,
    },
    #[serde(rename = "round.ending")]
    RoundEnding { closing_line: String },
    /// The interviewer gave a hint (`give_hint`). Kept on the server (a `hint` session event for the report);
    /// the browser is not sent this event.
    #[serde(rename = "hint.given")]
    Hint {
        panelist_id: String,
        level: u8,
        /// Round time of the hint.
        at_ms: u64,
    },
}

/// The brief card the round starts with: the question card's title and its brief lines, so the opener can say
/// "it's on your card" before the interviewer's own show_question arrives. `None` without a question card.
pub fn initial_brief(question: &serde_json::Value) -> Option<Brief> {
    let title = question.get("title").and_then(serde_json::Value::as_str)?;
    let lines = question
        .get("brief_lines")
        .and_then(serde_json::Value::as_array)
        .map(|ls| {
            ls.iter()
                .filter_map(serde_json::Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Some(Brief {
        question: title.trim().to_string(),
        lines,
    })
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Brief {
    pub question: String,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PhasePublic {
    pub id: String,
    pub title: Option<String>,
    pub minutes: f64,
}

/// `round.state` (docs/protocol.md).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RoundStateMsg {
    pub status: SessionStatus,
    pub phase_id: String,
    pub phase_index: usize,
    pub phases: Vec<PhasePublic>,
    pub elapsed_s: u64,
    pub remaining_s: u64,
    pub phase_remaining_s: u64,
    /// Empty until the interviewer calls show_question.
    pub brief: Brief,
    pub floor: String,
    /// The interviewer's model has been unavailable for several turns in a row; the round clock is held until a
    /// turn gets through (the browser shows that the interviewer is reconnecting).
    pub degraded: bool,
}
