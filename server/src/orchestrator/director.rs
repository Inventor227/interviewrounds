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
pub const SPEAK_ONLY_NOTE: &str = "How actions work in this app: the app updates the brief card, moves to the next phase, points at board items, notes hints, passes the floor and ends the round for you, based on the line you say. So write only your spoken line, exactly as the rules above describe (your transition line, your hint, your hand-over line or your closing line), and never anything in brackets, a call or an id.";

const DIRECTOR_RULES: &str = "You are the action director of a live practice interview app. You never speak to anyone. A speaker (an AI interviewer or meeting attendee) talks with a candidate. After each line the speaker says aloud, you perform the app actions that line calls for, with your tools, exactly as the speaker's own instructions below say the speaker should call them.

In the conversation, assistant turns are the speaker's earlier spoken lines, user turns are the candidate's words or app markers such as [event: start], and system notes are the app's notes to the speaker (phase, time, board summary). The last user message holds the line just spoken.

Actions:
- show_question: the line states the problem, or gives the candidate a fact from the question card. Send the question in one short line and the full list of brief card lines from the round script, plus every fact given so far.
- next_phase: the line moves the round on to the next phase, for example a transition such as \"Let's move on to the design.\" Pass the id of the phase being left, from the Phase line of the app note.
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
pub fn line_message(candidate: &str, draft: &TurnDraft, speaker: &str, spoken: &str) -> String {
    let mut parts: Vec<String> = vec![format!("The candidate's turn: {}", candidate.trim())];
    for m in draft.messages.iter().filter(|m| m.role == Role::System) {
        parts.push(format!(
            "The app note the speaker saw:\n{}",
            m.text().trim()
        ));
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
    // The speaker's instructions with the tool instructions the live call never sees.
    let speaker_system = panelist.director_system.clone();
    let mut messages =
        super::prompt::perspective(state, &panelist.panelist_id, state.history.clone());
    // Its system prompt and tools differ from the live call's: no thinking block made there is valid here.
    crate::claude::strip_thinking(&mut messages);
    super::prompt::strip_empty_text(&mut messages);
    // The history ends on the turn's user message (recorded at turn start); the line follows it as another user
    // message, which the API joins with it.
    if let Some(block) = messages
        .last_mut()
        .filter(|m| m.role != Role::System)
        .and_then(|m| {
            m.content
                .iter_mut()
                .rev()
                .find(|b| matches!(b, ContentBlock::Text { .. }))
        })
    {
        block.set_cache_control(Some(CacheControl::ephemeral()));
    }
    // The whole utterance this reply answers (the request may have carried only part of it).
    let candidate = match draft.input.speech() {
        Some(_) => state
            .unanswered
            .get(&panelist.panelist_id)
            .map(|u| u.text())
            .unwrap_or_else(|| draft.input.text()),
        None => draft.input.text(),
    };
    messages.push(Message::user_text(line_message(
        &candidate,
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
