//! `GET /api/content/catalog`: the public parts of `content/` (prompt-only fields stripped).

use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

use crate::app::AppState;
use crate::content::{Persona, RoundConfig};

/// `RoundPublic` (docs/protocol.md): a round without goals, coverage, rubric, bank and timing knobs.
pub fn round_public(r: &RoundConfig) -> Value {
    let mut v = json!({
        "id": r.id,
        "title": r.title,
        "role": r.role,
        "round_type": r.round_type,
        "length": r.length,
        "target_minutes": r.target_minutes,
        "phases": r.phases.iter().map(|p| {
            let mut phase = json!({"id": p.id, "minutes": p.minutes});
            if let Some(title) = &p.title {
                phase["title"] = json!(title);
            }
            phase
        }).collect::<Vec<_>>(),
        "hands": r.hands,
        "board_kit": r.board_kit,
        "panel": {"lead": r.panel.lead, "second": r.panel.second},
    });
    if let Some(summary) = &r.summary {
        v["summary"] = json!(summary);
    }
    v
}

/// `PersonaPublic`.
pub fn persona_public(p: &Persona) -> Value {
    json!({
        "id": p.id,
        "display_name": p.display_name,
        "title": p.title,
        "avatar_id": p.avatar_id,
        "style": p.style,
    })
}

const ROLES: [(&str, &str, &str); 2] = [
    (
        "sde",
        "Software engineer",
        "Coding, system design, object design and behavioral rounds.",
    ),
    (
        "pm",
        "Product manager",
        "Product sense, execution and leadership rounds.",
    ),
];

pub async fn catalog(State(app): State<AppState>) -> Json<Value> {
    let cat = &app.catalog;
    let roles: Vec<Value> = ROLES
        .iter()
        .filter(|(id, _, _)| cat.rounds.values().any(|r| r.role == *id))
        .map(|(id, title, summary)| json!({"id": id, "title": title, "summary": summary}))
        .collect();
    Json(json!({
        "roles": roles,
        "rounds": cat.rounds.values().map(round_public).collect::<Vec<_>>(),
        "meeting_templates": cat.templates.values().cloned().collect::<Vec<_>>(),
        "personas": cat.personas.values().map(persona_public).collect::<Vec<_>>(),
    }))
}
