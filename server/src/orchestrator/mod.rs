//! The live interviewer: session state, prompt building, tools, speech filtering and the Fish custom LLM endpoint.

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
    Level, LiveSettings, MeetingState, Mode, NewSession, PanelSeat, Panelist, Registry,
    SessionSettings, SessionState, SessionStatus, Style, Turn, TurnCommit, VoiceKind,
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
    /// Writes the prompt cache for this request's prefix in the background (no-op by default).
    fn prewarm(&self, _req: &MessagesRequest) {}
}

#[async_trait]
impl LlmApi for ClaudeClient {
    fn prewarm(&self, req: &MessagesRequest) {
        ClaudeClient::prewarm(self, req)
    }

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
    /// Same, for the one retry on the fast model.
    pub retry_first_text_timeout: Duration,
    /// Longest gap between stream events once text is flowing.
    pub idle_timeout: Duration,
    /// How long a turn waits for the previous turn of the same session to finish.
    pub turn_wait: Duration,
    /// Spoken when no model produced anything, so Fish never gets an empty reply.
    pub hold_line: String,
}

impl Default for OrchestratorOptions {
    fn default() -> Self {
        OrchestratorOptions {
            first_text_timeout: Duration::from_millis(5000),
            retry_first_text_timeout: Duration::from_millis(3500),
            idle_timeout: Duration::from_secs(8),
            turn_wait: Duration::from_secs(6),
            hold_line: "Sorry, give me a second.".into(),
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
}
