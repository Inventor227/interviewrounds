//! Builds the live Claude request: a stable system prompt per panelist (cached for the whole session), the
//! session's own append-only history, the new user turn, and a mid-conversation system note with everything that
//! changes turn to turn (phase and time, the board, notes).

use std::collections::HashMap;
use std::time::Instant;

use anyhow::{Context, anyhow};
use serde_json::Value;

use super::markers::{EventKind, UserInput};
use super::state::{SessionSettings, SessionState, ToolsMode};
use super::{director, tools};
use crate::claude::{
    CacheControl, ContentBlock, Message, MessagesRequest, OutputConfig, Role, SystemBlock,
    ToolChoice, fallbacks_for, thinking_for,
};
use crate::content::{Catalog, Persona, RoundConfig, section};

/// Used when the content has no turn-note template.
pub const DEFAULT_TURN_NOTE: &str = "[App note, do not read aloud]
Phase: {phase.id}, {phase.index} of {phase.count}. About {phase.minutes_left} min left in this phase, {round.minutes_left} min left in the round.
Phase goal: {phase.goal}
Phases done: {phases_done}. Hints given: {hints_given}, highest level {hint_max_level}. Floor: {floor}.
{time_line}
{board_text}
{notes}";

/// The new messages one turn adds before the reply, plus what they consumed from the state.
#[derive(Clone, Debug)]
pub struct TurnDraft {
    pub panelist_id: String,
    pub input: UserInput,
    /// The new user message, then the system note.
    pub messages: Vec<Message>,
    pub tool_result_ids: Vec<String>,
    pub notes_used: usize,
    pub warned_two_minutes: bool,
    /// The user message is already in the history (recorded when the turn started); `messages` holds the note only.
    pub user_committed: bool,
}

/// The request for one live turn. Pure: the state is not changed (the turn is committed after streaming).
pub fn build_live_request(
    state: &SessionState,
    panelist_id: &str,
    input: &UserInput,
    now: Instant,
) -> MessagesRequest {
    prepare_live_turn(state, panelist_id, input, now).0
}

/// The request and the draft to commit once the reply is done.
pub fn prepare_live_turn(
    state: &SessionState,
    panelist_id: &str,
    input: &UserInput,
    now: Instant,
) -> (MessagesRequest, TurnDraft) {
    let panelist = state
        .panelist(panelist_id)
        .or_else(|| state.panelist(&state.floor))
        .unwrap_or(&state.panel[0]);
    let draft = draft_turn(state, &panelist.panelist_id, input, now);
    (
        request_for_draft(state, &panelist.panelist_id, &draft),
        draft,
    )
}

/// The live request for a draft: the history, then the draft's messages (the user message and the note, or only the
/// note once the user message is recorded).
pub fn request_for_draft(
    state: &SessionState,
    panelist_id: &str,
    draft: &TurnDraft,
) -> MessagesRequest {
    let panelist = state
        .panelist(panelist_id)
        .or_else(|| state.panelist(&state.floor))
        .unwrap_or(&state.panel[0]);
    let mut messages = state.history.clone();
    messages.extend(draft.messages.clone());
    // Second cache breakpoint on the newest user turn (in the history when it was recorded at turn start), so the
    // growing history is read from cache next turn. It exists only in the request; the stored history carries none.
    if let Some(block) = messages
        .iter_mut()
        .rev()
        .find(|m| m.role == Role::User)
        .and_then(|m| m.content.last_mut())
    {
        block.set_cache_control(Some(CacheControl::ephemeral()));
    }

    let model = state.live.model.clone();
    let (system, tools, tool_choice) = match state.live.tools {
        ToolsMode::Inline => (
            panelist.system.clone(),
            tools::definitions(),
            Some(ToolChoice::Auto),
        ),
        // Speech only: the director turns the line into tool actions afterwards. The note sits after the cached
        // block, so the cached speaker prompt stays the same with or without it.
        ToolsMode::Director => {
            let mut system = panelist.system.clone();
            system.push(SystemBlock::text(director::SPEAK_ONLY_NOTE));
            (system, Vec::new(), None)
        }
    };
    MessagesRequest {
        thinking: thinking_for(&model),
        fallbacks: fallbacks_for(&model),
        model,
        max_tokens: state.live.max_tokens,
        system,
        messages,
        tools,
        tool_choice,
        output_config: Some(OutputConfig::effort(&state.live.effort)),
        stream: true,
    }
}

/// The user message (tool results owed by the last reply first, then the input) and the system note.
pub fn draft_turn(
    state: &SessionState,
    panelist_id: &str,
    input: &UserInput,
    now: Instant,
) -> TurnDraft {
    let mut content: Vec<ContentBlock> = state
        .pending_tool_results
        .iter()
        .map(ContentBlock::tool_result_ok)
        .collect();
    content.push(ContentBlock::text(input.text()));
    let (note, warned_two_minutes) = turn_note(state, panelist_id, input, now);
    TurnDraft {
        panelist_id: panelist_id.to_string(),
        input: input.clone(),
        messages: vec![
            Message {
                role: Role::User,
                content,
            },
            Message::system_text(note),
        ],
        tool_result_ids: state.pending_tool_results.clone(),
        notes_used: state.pending_notes.len(),
        warned_two_minutes,
        user_committed: false,
    }
}

/// The per-turn system note and whether it carries the two-minute warning.
pub fn turn_note(
    state: &SessionState,
    panelist_id: &str,
    input: &UserInput,
    now: Instant,
) -> (String, bool) {
    let phase = state.current_phase();
    let phase_left = state.phase_minutes_left(now);
    let round_left = state.round_minutes_left(now);
    let last_phase = state.phase_idx + 1 >= state.round.phases.len();

    let mut warned = false;
    let time_line = if round_left <= 0.0 {
        "Time is up for the round. Close now in one line, then call end_round with that line."
            .to_string()
    } else if phase_left <= 0.0 && !last_phase {
        format!(
            "Time check: the {} phase is over. Say one short transition line and call next_phase.",
            phase.id
        )
    } else if round_left <= 2.0 && !state.two_minute_warned {
        warned = true;
        "About two minutes are left in the round. Say so once, briefly.".to_string()
    } else {
        String::new()
    };

    let mut notes: Vec<String> = Vec::new();
    if let Some(kind) = input.event()
        && let Some(note) = event_note(state, kind, time_line.is_empty())
    {
        notes.push(note);
    }
    if let Some(heard) = state.heard_note.get(panelist_id) {
        notes.push(heard.clone());
    }
    if let Some(prev) = state.last_speaker.as_deref().filter(|p| *p != panelist_id)
        && let Some(said) = state
            .last_agent_text
            .get(prev)
            .filter(|s| !s.trim().is_empty())
    {
        notes.push(format!(
            "{} spoke last and said: \"{}\". Do not repeat it.",
            state.display_name(prev),
            said.trim()
        ));
    }
    notes.extend(state.pending_notes.iter().cloned());
    if let Some(meeting) = state
        .meeting
        .as_ref()
        .filter(|m| !m.hidden.trim().is_empty())
    {
        notes.push(format!(
            "Meeting state, for you only: {}",
            meeting.hidden.trim()
        ));
    }

    let board_text = if !state.board_text.trim().is_empty() {
        state.board_text.trim().to_string()
    } else if state.round.hands == "none" {
        "No board in this round.".to_string()
    } else {
        "Board: nothing drawn yet.".to_string()
    };
    let phases_done = if state.phase_idx == 0 {
        "none".to_string()
    } else {
        state.round.phases[..state.phase_idx.min(state.round.phases.len())]
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };

    let vars: HashMap<&str, String> = HashMap::from([
        ("phase.id", phase.id.clone()),
        ("phase.index", (state.phase_idx + 1).to_string()),
        ("phase.count", state.round.phases.len().to_string()),
        ("phase.minutes_left", minutes(phase_left)),
        ("phase.goal", phase.goal.clone()),
        ("round.minutes_left", minutes(round_left)),
        ("phases_done", phases_done),
        ("hints_given", state.hints_given.to_string()),
        ("hint_max_level", state.hint_max_level.to_string()),
        ("time_line", time_line),
        ("floor", state.display_name(&state.floor)),
        ("board_text", board_text),
        ("notes", notes.join("\n")),
    ]);
    (tidy(&fill(&state.turn_note_template, &vars)), warned)
}

/// The note an app event adds to the turn.
fn event_note(state: &SessionState, kind: EventKind, no_time_line: bool) -> Option<String> {
    Some(match kind {
        EventKind::Start => "The round starts now. Open as the round script says.".into(),
        EventKind::TimeCheck => {
            if !no_time_line {
                return None;
            }
            "Time check from the app: no boundary has passed; carry on.".into()
        }
        EventKind::Handover => "You now hold the floor. Your colleague just handed over to you; ask your first question in one or two sentences.".into(),
        EventKind::Resume => "The call dropped and the candidate is back. Say \"Welcome back.\", one line about where you were, then a question.".into(),
        EventKind::SilenceCheck => format!(
            "The candidate has been quiet for about {} seconds, so check in once with a short line such as \"Want to think out loud?\", then wait.",
            state.round.silence_wait_seconds
        ),
        EventKind::LongAnswer => format!(
            "The candidate's answer has run past about {} seconds and they may still be talking. Cut in politely now with one short line and one focused question that steers back to the phase goal, such as \"Let me pause you there.\" followed by your question.",
            state.round.interrupt_after_seconds
        ),
        EventKind::Ending => "Time is up. Close now in one line, with no feedback, then call end_round with that line.".into(),
    })
}

/// Whole minutes for the note: 0 once time is up, at least 1 while any is left.
fn minutes(m: f64) -> String {
    if m <= 0.0 {
        "0".into()
    } else {
        format!("{}", (m.round() as i64).max(1))
    }
}

/// Drops blank lines left by empty placeholders.
fn tidy(text: &str) -> String {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Replaces `{key}` for known keys in one pass (inserted text is not scanned again); unknown braces stay.
pub fn fill(template: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = String::with_capacity(template.len() + 256);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close)
                if after[..close]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') =>
            {
                let key = &after[..close];
                match vars.get(key) {
                    Some(v) => out.push_str(v),
                    None => out.push_str(&rest[open..open + close + 2]),
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn num(x: f64) -> String {
    if x.fract() == 0.0 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

fn list(items: &[String]) -> String {
    items.iter().map(|i| format!("\n- {i}")).collect::<String>()
}

fn persona_card(p: &Persona) -> String {
    let mut card = String::new();
    if let Some(b) = p.behaviour.as_deref().filter(|b| !b.trim().is_empty()) {
        card.push_str(b.trim());
    }
    if !p.speech_habits.is_empty() {
        card.push_str("\nHow you speak:");
        card.push_str(&list(&p.speech_habits));
    }
    if !p.never.is_empty() {
        card.push_str("\nNever:");
        card.push_str(&list(&p.never));
    }
    card.trim().to_string()
}

fn role_words(role: &str) -> &'static str {
    match role {
        "sde" => "software engineer",
        "pm" => "product manager",
        _ => "",
    }
}

/// The full stable system prompt for one panelist (house rules with persona, level, style, panel rules and the
/// round script with its question card). Rendered once per session.
pub fn render_system(
    catalog: &Catalog,
    round: &RoundConfig,
    persona: &Persona,
    seat: usize,
    panel: &[(String, &Persona)],
    question: &Value,
    settings: &SessionSettings,
) -> anyhow::Result<String> {
    let house = catalog
        .prompt("house-rules")
        .ok_or_else(|| anyhow!("content has no prompts/house-rules.md"))?;
    let mut vars: HashMap<&str, String> = HashMap::new();
    vars.insert("persona.display_name", persona.display_name.clone());
    vars.insert("persona.title", persona.title.clone());
    vars.insert("persona.card", persona_card(persona));
    vars.insert("seniority", settings.level.as_str().into());
    vars.insert("role", role_words(&round.role).into());
    vars.insert(
        "round_name",
        format!("{}, {} round", round.title, round.length),
    );
    vars.insert("length", round.length.clone());
    vars.insert("target_minutes", num(round.target_minutes));
    vars.insert(
        "silence_wait_seconds",
        round.silence_wait_seconds.to_string(),
    );
    vars.insert(
        "interrupt_after_seconds",
        persona
            .interrupts_after_seconds
            .unwrap_or(round.interrupt_after_seconds)
            .to_string(),
    );
    vars.insert(
        "level_rules",
        catalog
            .prompt("levels")
            .and_then(|t| section(t, settings.level.as_str()))
            .unwrap_or("")
            .to_string(),
    );
    vars.insert(
        "style_rules",
        catalog
            .prompt("styles")
            .and_then(|t| section(t, settings.style.as_str()))
            .unwrap_or("")
            .to_string(),
    );
    vars.insert(
        "phases_script",
        round
            .phases
            .iter()
            .map(|p| {
                let mut line = format!("- {} ({} min): {}", p.id, num(p.minutes), p.goal);
                if !p.must_cover.is_empty() {
                    line.push_str(&format!(" Must cover: {}.", p.must_cover.join(", ")));
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n"),
    );
    // The question card: strings as they are, string lists as one line per item; missing fields empty.
    for key in QUESTION_KEYS {
        let field = &key["question.".len()..];
        let text = match question.get(field) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(items)) => list(
                &items
                    .iter()
                    .filter_map(|i| i.as_str().map(str::to_string))
                    .collect::<Vec<_>>(),
            ),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };
        vars.insert(key, text);
    }

    // Panel rules: lead and second each get their section of hand-over.md.
    let lead = panel.first();
    let second = panel.get(1);
    let mut panel_rules = String::new();
    if let (Some((lead_id, lead_p)), Some((second_id, second_p))) = (lead, second) {
        let focus = round
            .panel
            .second_enters_phase
            .as_deref()
            .and_then(|id| round.phases.iter().find(|p| p.id == id))
            .map(|p| p.goal.clone())
            .unwrap_or_default();
        vars.insert("panel.lead.id", lead_id.clone());
        vars.insert("panel.lead.display_name", lead_p.display_name.clone());
        vars.insert("panel.second.id", second_id.clone());
        vars.insert("panel.second.display_name", second_p.display_name.clone());
        vars.insert("panel.second.title", second_p.title.clone());
        vars.insert("panel.second.focus", focus);
        vars.insert(
            "panel.second_enters_phase",
            round.panel.second_enters_phase.clone().unwrap_or_default(),
        );
        let key = if seat == 0 { "lead" } else { "second" };
        if let Some(rules) = catalog.prompt("hand-over").and_then(|t| section(t, key)) {
            panel_rules = fill(rules, &vars);
        }
    }
    vars.insert("panel_rules", panel_rules);

    let script_name = format!("round-{}", round.round_type.replace('_', "-"));
    let script = catalog
        .prompt(&script_name)
        .with_context(|| format!("content has no prompts/{script_name}.md"))?;
    vars.insert("round_script", fill(script, &vars));

    Ok(tidy_blank_runs(&fill(house, &vars)))
}

const QUESTION_KEYS: [&str; 7] = [
    "question.title",
    "question.prompt",
    "question.brief_lines",
    "question.facts_if_asked",
    "question.follow_ups",
    "question.twist",
    "question.interviewer_notes",
];

/// Collapses three or more newlines (left by empty sections) into one blank line.
fn tidy_blank_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = 0;
    for line in text.lines() {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_replaces_known_keys_once() {
        let vars = HashMap::from([("a", "{b}".to_string()), ("b", "B".to_string())]);
        assert_eq!(
            fill("x {a} {b} {c} {not a key!}", &vars),
            "x {b} B {c} {not a key!}"
        );
        assert_eq!(fill("{", &vars), "{");
    }
}
