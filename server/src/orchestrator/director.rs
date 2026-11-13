//! The director: a second, fast model call that turns the line the interviewer just spoke into tool actions
//! (show_question, next_phase, point_at, give_hint, hand_over, end_round). It runs after the spoken reply is
//! complete, off the voice path, so the live call can stream speech with no tools at all (measured: about 400 ms
//! faster to first token on the same model).
//!
//! The director has its own system prompt, which embeds the speaker's full instructions for reference, and reads the
//! same history the speaker read. The spoken line arrives in the last user message, so the director never mistakes
//! itself for the speaker.

use crate::claude::{
    CacheControl, ContentBlock, Message, MessagesRequest, OutputConfig, Role, SystemBlock,
    ToolChoice, thinking_for,
};

use super::prompt::TurnDraft;
use super::state::SessionState;
use super::tools;

/// Appended to the live system prompt when the live call carries no tools.
pub const SPEAK_ONLY_NOTE: &str = "How your tools work in this app: the app performs show_question, next_phase, point_at, give_hint, hand_over and end_round for you, based on the line you say. So never write a tool name, a call, an id or anything in brackets. Write only your spoken line, exactly as the rules above describe (your transition line, your hint, your hand-over line or your closing line).";

const DIRECTOR_RULES: &str = "You are the action director of a live practice interview app. You never speak to anyone. A speaker (an AI interviewer or meeting attendee) talks with a candidate. After each line the speaker says aloud, you perform the app actions that line calls for, with your tools, exactly as the speaker's own instructions below say the speaker should call them.

In the conversation, assistant turns are the speaker's earlier spoken lines, user turns are the candidate's words or app markers such as [event: start], and system notes are the app's notes to the speaker (phase, time, board summary). The last user message holds the line just spoken.

Actions:
- show_question: the line states the problem, or gives the candidate a fact from the question card. Send the question in one short line and the full list of brief card lines from the round script, plus every fact given so far.
- next_phase: the line moves the round on to the next phase, for example a transition such as \"Let's move on to the design.\"
- point_at: the line asks about one specific board item. Use its id from the latest board summary.
- give_hint: the line nudges a stuck candidate toward an idea, even when it is phrased as a question. Pass the hint ladder level.
- hand_over: the line passes the floor to a colleague. Pass their panelist id and the exact first line the colleague will say, written as the speaker's panel rules describe.
- end_round: the line closes the round. Pass that closing line.

Most lines are ordinary questions or acknowledgements and call for no action; then call no tool. Call each tool at most once. Never write any text.

The speaker's own instructions follow, for reference only.

";

/// The director's system prompt for one panelist (stable for the session, so it is cached).
pub fn system_text(speaker_system: &str) -> String {
    format!("{DIRECTOR_RULES}{speaker_system}")
}

/// The last user message: the turn's input and note as the speaker saw them, then the spoken line.
pub fn line_message(draft: &TurnDraft, speaker: &str, spoken: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for m in &draft.messages {
        let text = m.text();
        match m.role {
            Role::User => parts.push(format!("The candidate's turn: {}", text.trim())),
            Role::System => parts.push(format!("The app note the speaker saw:\n{}", text.trim())),
            Role::Assistant => {}
        }
    }
    let said = if spoken.trim().is_empty() {
        "(nothing)"
    } else {
        spoken.trim()
    };
    parts.push(format!(
        "{speaker} just said aloud: \"{said}\"\nPerform the actions this line calls for, or none."
    ));
    parts.join("\n\n")
}

/// The director request for one finished turn. Cache breakpoints: the system prompt and the end of the history
/// before this turn (the next director call reads up to there from cache).
pub fn build_request(
    state: &SessionState,
    panelist_id: &str,
    draft: &TurnDraft,
    spoken: &str,
    model: &str,
) -> MessagesRequest {
    let panelist = state
        .panelist(panelist_id)
        .or_else(|| state.panelist(&state.floor))
        .unwrap_or(&state.panel[0]);
    let speaker_system: String = panelist
        .system
        .iter()
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut messages = state.history.clone();
    // The history always ends on an assistant line (or is empty), so the new user message never follows a user.
    if let Some(block) = messages
        .last_mut()
        .filter(|m| m.role != Role::System)
        .and_then(|m| {
            m.content.iter_mut().rev().find(|b| {
                matches!(
                    b,
                    ContentBlock::Text { .. } | ContentBlock::ToolResult { .. }
                )
            })
        })
    {
        block.set_cache_control(Some(CacheControl::ephemeral()));
    }
    messages.push(Message::user_text(line_message(
        draft,
        &panelist.persona.display_name,
        spoken,
    )));
    MessagesRequest {
        model: model.to_string(),
        max_tokens: 400,
        system: vec![SystemBlock::cached(system_text(&speaker_system))],
        messages,
        tools: tools::definitions(),
        tool_choice: Some(ToolChoice::Auto),
        thinking: thinking_for(model),
        output_config: Some(OutputConfig::effort("low")),
        fallbacks: None,
        stream: false,
    }
}
