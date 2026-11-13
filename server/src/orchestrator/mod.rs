//! The live interviewer: session state, prompt building, tools, speech filtering and the Fish custom LLM endpoint.

pub mod markers;
pub mod prompt;
pub mod speech_filter;
pub mod state;
pub mod tools;

use serde::{Deserialize, Serialize};

pub use state::{
    Level, LiveSettings, MeetingState, Mode, NewSession, PanelSeat, Panelist, Registry,
    SessionSettings, SessionState, SessionStatus, Style, Turn, TurnCommit, VoiceKind,
};

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
