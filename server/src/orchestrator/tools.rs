//! Tools the live model can call. They run inside the server when the turn commits (fire-and-forget: the next
//! request opens with an "ok" result for each) and reach the browser as WebSocket events.

use std::time::Instant;

use serde_json::{Value, json};

use super::state::SessionState;
use super::{Brief, ServerEvent};
use crate::claude::ToolDef;

#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    /// The panelist whose reply made the call.
    pub panelist_id: String,
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> ToolDef {
    ToolDef {
        name: name.into(),
        description: description.into(),
        input_schema: json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        }),
        strict: Some(true),
    }
}

/// Fixed order and content: tools sit at the very front of the cached prefix.
pub fn definitions() -> Vec<ToolDef> {
    vec![
        tool(
            "show_question",
            "Puts the problem on the candidate's brief card. Call it when you first state the problem, and again with the full list of lines when you add a fact you just gave them.",
            json!({
                "question": {"type": "string", "description": "The problem in one short line."},
                "lines": {"type": "array", "items": {"type": "string"}, "description": "Key facts, one short line each."}
            }),
            &["question", "lines"],
        ),
        tool(
            "next_phase",
            "Moves the round to the next phase. Call it right after your spoken transition line.",
            json!({
                "from": {"type": "string", "description": "Id of the phase being left (the Phase line of the latest app note)."}
            }),
            &[],
        ),
        tool(
            "hand_over",
            "Passes the floor to another panelist. Say your short line to the candidate first.",
            json!({
                "to": {"type": "string", "description": "Panelist id of the colleague taking the floor."},
                "line": {"type": "string", "description": "The exact first line they will say, in their voice."}
            }),
            &["to", "line"],
        ),
        tool(
            "point_at",
            "Pulses one board item while you ask about it. Use the item id from the board summary. At most once per turn.",
            json!({"item_id": {"type": "string"}}),
            &["item_id"],
        ),
        tool(
            "give_hint",
            "Records a hint you just gave, with its ladder level.",
            json!({"level": {"type": "integer", "enum": [1, 2, 3, 4, 5]}}),
            &["level"],
        ),
        tool(
            "end_round",
            "Ends the session after your closing line.",
            json!({"closing_line": {"type": "string", "description": "The exact closing line you just said."}}),
            &["closing_line"],
        ),
    ]
}

fn str_arg<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str).map(str::trim)
}

/// Applies one call to the session and returns the events for the browser.
pub fn apply(state: &mut SessionState, call: &ToolCall) -> Vec<ServerEvent> {
    let now = Instant::now();
    let input = &call.input;
    match call.name.as_str() {
        "show_question" => {
            let question = str_arg(input, "question").unwrap_or_default().to_string();
            let lines = input
                .get("lines")
                .and_then(Value::as_array)
                .map(|ls| {
                    ls.iter()
                        .filter_map(Value::as_str)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            state.brief = Some(Brief { question, lines });
            vec![ServerEvent::RoundState(state.round_state(now))]
        }
        "next_phase" => {
            // A call that names a phase already left is ignored (a late or repeated call must not skip a phase).
            // A `from` that names no earlier phase (a title, a typo) does not block the move.
            let from = str_arg(input, "from").filter(|f| !f.is_empty());
            let left = &state.round.phases[..state.phase_idx.min(state.round.phases.len())];
            if let Some(from) = from
                && left.iter().any(|p| p.id == from)
            {
                tracing::info!(session_id = %state.id, from, current = %state.current_phase().id, "stale next_phase ignored");
                return Vec::new();
            }
            if state.phase_idx + 1 < state.round.phases.len() {
                state.phase_idx += 1;
                vec![ServerEvent::RoundState(state.round_state(now))]
            } else {
                Vec::new()
            }
        }
        "hand_over" => {
            let to = str_arg(input, "to").unwrap_or_default().to_string();
            let line = str_arg(input, "line").unwrap_or_default().to_string();
            if to == call.panelist_id || state.panelist(&to).is_none() {
                tracing::warn!(session_id = %state.id, to = %to, "hand_over to an unknown panelist ignored");
                return Vec::new();
            }
            // A second hand-over to the panelist who already holds the floor (two directors of the same speaker, one
            // per reply) would replace the opening line they are about to say, or already said.
            if state.floor == to {
                tracing::info!(session_id = %state.id, from = %call.panelist_id, to = %to, "hand_over to the panelist on the floor ignored");
                return Vec::new();
            }
            state.floor = to.clone();
            if !line.is_empty() {
                state.pending_handover.insert(to.clone(), line.clone());
            }
            vec![ServerEvent::HandOver {
                from: call.panelist_id.clone(),
                to,
                opening_line: line,
            }]
        }
        "point_at" => match str_arg(input, "item_id").filter(|s| !s.is_empty()) {
            Some(item) => vec![ServerEvent::PointAt {
                panelist_id: call.panelist_id.clone(),
                item_id: item.to_string(),
            }],
            None => Vec::new(),
        },
        "give_hint" => {
            let level = input
                .get("level")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 5) as u8;
            state.hints_given = state.hints_given.saturating_add(1);
            state.hint_max_level = state.hint_max_level.max(level);
            vec![
                ServerEvent::Hint {
                    panelist_id: call.panelist_id.clone(),
                    level,
                    at_ms: state.elapsed_ms(now),
                },
                ServerEvent::RoundState(state.round_state(now)),
            ]
        }
        "end_round" => {
            let line = str_arg(input, "closing_line")
                .unwrap_or_default()
                .to_string();
            state.closing_line = Some(line.clone());
            vec![ServerEvent::RoundEnding { closing_line: line }]
        }
        other => {
            tracing::warn!(session_id = %state.id, tool = other, "unknown tool call ignored");
            Vec::new()
        }
    }
}
