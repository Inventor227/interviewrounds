//! The hidden state of a meeting: per attendee a stance (-2 hostile to +2 champion), concerns that move from open to
//! partly to resolved, and patience; plus whether the user has made the ask, the agreed next steps and the decision
//! the approver would give now.
//!
//! After each user turn, `update` asks the fast model to judge the last exchange (structured output,
//! `content/prompts/meeting-state.md`) and `apply_update` bounds the result: a stance moves at most one step per
//! user turn and stays within -2..2, concern texts and ids stay fixed (at most one new concern per attendee per
//! turn), patience stays within 0..start, the ask once made stays made, and the outcome is worked out from the
//! approver's state by fixed rules, so it is earned.

use std::collections::HashMap;

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    ConcernStatus, DecisionPower, Difficulty, MeetingPlan, MeetingSetup, Personality, TemplateId,
    id_stem, plain,
};
use crate::claude::{
    Message, MessagesRequest, OutputConfig, SystemBlock, fallbacks_for, thinking_for,
};
use crate::content::Catalog;
use crate::orchestrator::LlmApi;
use crate::orchestrator::Turn;
use crate::orchestrator::prompt::fill;

const UPDATE_EFFORT: &str = "medium";
const UPDATE_MAX_TOKENS: u32 = 3000;
/// The longest a concern list grows (new concerns the user raised).
const MAX_CONCERNS: usize = 8;
const MAX_NEXT_STEPS: usize = 6;
/// Nobody stays silent for more than this many user turns.
const MAX_SILENT_TURNS: u32 = 3;

/// The decision the approver would give.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Outcome {
    #[serde(rename = "approved")]
    Approved,
    #[serde(rename = "approved_with_conditions")]
    WithConditions,
    #[serde(rename = "need_more_info")]
    NeedInfo,
    #[serde(rename = "not_now")]
    NotNow,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Approved => "approved",
            Outcome::WithConditions => "approved_with_conditions",
            Outcome::NeedInfo => "need_more_info",
            Outcome::NotNow => "not_now",
        }
    }

    /// How the decision is said aloud.
    pub fn words(self) -> &'static str {
        match self {
            Outcome::Approved => "approved",
            Outcome::WithConditions => "approved with conditions",
            Outcome::NeedInfo => "need more information",
            Outcome::NotNow => "not now",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConcernState {
    pub id: String,
    pub text: String,
    pub status: ConcernStatus,
    /// The user's words that moved it, when it moved.
    #[serde(default)]
    pub evidence_quote: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AttendeeState {
    pub name: String,
    pub role: String,
    pub personality: Personality,
    pub decision_power: DecisionPower,
    pub cares_about: Vec<String>,
    pub likely_objections: Vec<String>,
    #[serde(default)]
    pub knows: Option<String>,
    pub persona_id: String,
    /// The session's panelist id for this attendee (`p1`.. in plan order unless the session says otherwise).
    pub panelist_id: String,
    pub stance: i8,
    /// Why the stance last moved (empty when it did not).
    #[serde(default)]
    pub stance_reason: String,
    pub patience: u8,
    pub patience_start: u8,
    pub concerns: Vec<ConcernState>,
    /// User turns since this attendee last spoke.
    #[serde(default)]
    pub turns_silent: u32,
}

impl AttendeeState {
    /// Open concerns first, then partly ones, each in importance order (the plan lists the most important first).
    pub fn unsettled(&self) -> Vec<&ConcernState> {
        let mut out: Vec<&ConcernState> = self
            .concerns
            .iter()
            .filter(|c| c.status == ConcernStatus::Open)
            .collect();
        out.extend(
            self.concerns
                .iter()
                .filter(|c| c.status == ConcernStatus::Partly),
        );
        out
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct NextStep {
    pub owner: String,
    pub action: String,
    pub due: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Decision {
    pub outcome: Outcome,
    pub reason: String,
    #[serde(default)]
    pub conditions: Vec<String>,
    #[serde(default)]
    pub missing_info: Vec<String>,
}

/// Everything the live attendees and the report need about the meeting, hidden from the browser.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MeetingState {
    pub title: String,
    pub template_id: Option<TemplateId>,
    pub goal: String,
    pub user_role: String,
    pub ask: Option<String>,
    /// Used only to check the user did not go below it; never shown to attendees.
    pub walk_away: Option<String>,
    pub key_facts: Vec<String>,
    pub notes: Option<String>,
    pub difficulty: Difficulty,
    pub user_chairs: bool,
    /// The chair's name; None when the user chairs.
    pub chair: Option<String>,
    pub opening_line: String,
    pub attendees: Vec<AttendeeState>,
    pub next_speaker: Option<String>,
    #[serde(default)]
    pub next_speaker_instruction: String,
    #[serde(default)]
    pub user_contradiction: Option<String>,
    #[serde(default)]
    pub ask_made: bool,
    #[serde(default)]
    pub ask_text: String,
    #[serde(default)]
    pub next_steps: Vec<NextStep>,
    pub decision: Decision,
    #[serde(default)]
    pub below_walk_away: Option<bool>,
    /// Updates applied so far.
    #[serde(default)]
    pub updates: u32,
}

impl MeetingState {
    /// The starting state from a prepared plan. Panelist ids are `p1`, `p2`, ... in the plan's attendee order (the
    /// session may reassign them with `set_panelists`).
    pub fn from_parts(setup: &MeetingSetup, plan: &MeetingPlan) -> MeetingState {
        let attendees: Vec<AttendeeState> = plan
            .attendees
            .iter()
            .enumerate()
            .map(|(i, a)| AttendeeState {
                name: a.name.clone(),
                role: a.role.clone(),
                personality: a.personality,
                decision_power: a.decision_power,
                cares_about: a.cares_about.clone(),
                likely_objections: a.likely_objections.clone(),
                knows: a.knows.clone(),
                persona_id: a.hidden.persona_id.clone(),
                panelist_id: format!("p{}", i + 1),
                stance: a.hidden.stance.clamp(-2, 2),
                stance_reason: String::new(),
                patience: a.hidden.patience,
                patience_start: a.hidden.patience,
                concerns: a
                    .hidden
                    .concerns
                    .iter()
                    .map(|c| ConcernState {
                        id: c.id.clone(),
                        text: c.text.clone(),
                        status: c.status,
                        evidence_quote: String::new(),
                    })
                    .collect(),
                turns_silent: 0,
            })
            .collect();
        let names: Vec<&str> = attendees.iter().map(|a| a.name.as_str()).collect();
        let kind = setup.template_id.map(|t| t.kind()).unwrap_or("Meeting");
        let mut state = MeetingState {
            title: format!("{kind} with {}", join_names(&names)),
            template_id: setup.template_id,
            goal: setup.goal.trim().to_string(),
            user_role: setup.user_role.trim().to_string(),
            ask: setup.ask.clone().filter(|s| !s.trim().is_empty()),
            walk_away: setup.walk_away.clone().filter(|s| !s.trim().is_empty()),
            key_facts: setup.key_facts.clone(),
            notes: setup.notes.clone().filter(|s| !s.trim().is_empty()),
            difficulty: setup.difficulty,
            user_chairs: plan.user_chairs,
            chair: if plan.user_chairs {
                None
            } else {
                plan.chair_attendee.clone()
            },
            opening_line: plan.opening_line.clone(),
            attendees,
            next_speaker: None,
            next_speaker_instruction: String::new(),
            user_contradiction: None,
            ask_made: false,
            ask_text: String::new(),
            next_steps: Vec::new(),
            decision: Decision {
                outcome: Outcome::NeedInfo,
                reason: String::new(),
                conditions: Vec::new(),
                missing_info: Vec::new(),
            },
            below_walk_away: None,
            updates: 0,
        };
        state.decision = decision(&state, None, false);
        state
    }

    /// From the two JSON documents stored in `meeting_plans` (`setup`, `plan`).
    pub fn from_json(setup: &Value, plan: &Value) -> anyhow::Result<MeetingState> {
        let setup: MeetingSetup =
            serde_json::from_value(setup.clone()).context("stored meeting setup")?;
        let plan: MeetingPlan =
            serde_json::from_value(plan.clone()).context("stored meeting plan")?;
        Ok(MeetingState::from_parts(&setup, &plan))
    }

    /// Gives attendee `i` the session's panelist id `ids[i]` (seat order is the plan's attendee order).
    pub fn set_panelists(&mut self, ids: &[String]) {
        for (a, id) in self.attendees.iter_mut().zip(ids) {
            a.panelist_id = id.clone();
        }
    }

    pub fn attendee(&self, name: &str) -> Option<&AttendeeState> {
        self.attendees
            .iter()
            .find(|a| a.name.trim().eq_ignore_ascii_case(name.trim()))
    }

    pub fn by_panelist(&self, panelist_id: &str) -> Option<&AttendeeState> {
        self.attendees.iter().find(|a| a.panelist_id == panelist_id)
    }

    /// The decision maker: the first approver, else the first attendee.
    pub fn approver(&self) -> Option<&AttendeeState> {
        self.attendees
            .iter()
            .find(|a| a.decision_power == DecisionPower::Approver)
            .or_else(|| self.attendees.first())
    }

    pub fn chair_attendee(&self) -> Option<&AttendeeState> {
        self.chair.as_deref().and_then(|c| self.attendee(c))
    }

    /// Who speaks the opening line: the chair, or the decision maker when the user chairs.
    pub fn opening_speaker(&self) -> Option<&AttendeeState> {
        self.chair_attendee().or_else(|| self.approver())
    }

    /// Who closes the meeting and calls end_round: the chair, or the decision maker when the user chairs.
    pub fn closer(&self) -> Option<&AttendeeState> {
        self.opening_speaker()
    }

    pub fn outcome(&self) -> Outcome {
        self.decision.outcome
    }
}

fn join_names(names: &[&str]) -> String {
    match names {
        [] => "the team".into(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The decision from the approver's state, first matching rule:
/// 1. no ask made and the decision phase has started: not now;
/// 2. approver stance -1 or less: not now;
/// 3. approver stance 1 or more and nothing open or partly: approved;
/// 4. nothing open (only partly or resolved): approved with conditions;
/// 5. otherwise: need more information.
pub fn decide(state: &MeetingState, decision_phase_started: bool) -> Outcome {
    let Some(approver) = state.approver() else {
        return Outcome::NeedInfo;
    };
    if !state.ask_made && decision_phase_started {
        return Outcome::NotNow;
    }
    if approver.stance <= -1 {
        return Outcome::NotNow;
    }
    let open = approver
        .concerns
        .iter()
        .any(|c| c.status == ConcernStatus::Open);
    let partly = approver
        .concerns
        .iter()
        .any(|c| c.status == ConcernStatus::Partly);
    if approver.stance >= 1 && !open && !partly {
        return Outcome::Approved;
    }
    if !open {
        return Outcome::WithConditions;
    }
    Outcome::NeedInfo
}

fn decision(
    state: &MeetingState,
    raw: Option<&ModelDecision>,
    decision_phase_started: bool,
) -> Decision {
    let outcome = decide(state, decision_phase_started);
    let approver = state.approver();
    let listed = |list: &[String]| -> Vec<String> {
        list.iter()
            .map(|s| plain(s))
            .filter(|s| !s.is_empty())
            .take(4)
            .collect()
    };
    let concerns_with = |status: ConcernStatus| -> Vec<String> {
        approver
            .map(|a| {
                a.concerns
                    .iter()
                    .filter(|c| c.status == status)
                    .map(|c| c.text.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    let agrees = raw.is_some_and(|r| r.outcome == Some(outcome));
    let conditions = if outcome == Outcome::WithConditions {
        let from_model = raw.map(|r| listed(&r.conditions)).unwrap_or_default();
        if agrees && !from_model.is_empty() {
            from_model
        } else {
            concerns_with(ConcernStatus::Partly)
                .into_iter()
                .map(|t| format!("Follow up on this: {t}"))
                .collect()
        }
    } else {
        Vec::new()
    };
    let missing_info = if outcome == Outcome::NeedInfo {
        let from_model = raw.map(|r| listed(&r.missing_info)).unwrap_or_default();
        if agrees && !from_model.is_empty() {
            from_model
        } else {
            concerns_with(ConcernStatus::Open)
        }
    } else {
        Vec::new()
    };
    let reason = raw
        .filter(|_| agrees)
        .map(|r| plain(&r.reason))
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| {
            match outcome {
                Outcome::Approved => "You answered what I needed to hear.",
                Outcome::WithConditions => "Yes, as long as the open points get closed.",
                Outcome::NeedInfo => "I need more before I can decide.",
                Outcome::NotNow if !state.ask_made && decision_phase_started => {
                    "I haven't heard a clear ask yet."
                }
                Outcome::NotNow => "I'm not convinced yet.",
            }
            .to_string()
        });
    Decision {
        outcome,
        reason,
        conditions,
        missing_info,
    }
}

/// What the state model returns (structured output).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ModelUpdate {
    pub attendees: Vec<ModelAttendeeUpdate>,
    pub next_speaker: String,
    pub next_speaker_instruction: String,
    pub user_contradiction: Option<String>,
    pub ask_made: bool,
    pub ask_text: String,
    pub next_steps: Vec<NextStep>,
    pub decision_guidance: Option<ModelDecision>,
    pub below_walk_away: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ModelAttendeeUpdate {
    pub name: String,
    pub stance: i64,
    pub stance_reason: String,
    pub patience: i64,
    pub concerns: Vec<ModelConcernUpdate>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ModelConcernUpdate {
    pub id: String,
    pub text: String,
    pub status: Option<ConcernStatus>,
    pub evidence_quote: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ModelDecision {
    pub outcome: Option<Outcome>,
    pub reason: String,
    pub conditions: Vec<String>,
    pub missing_info: Vec<String>,
}

/// Where the meeting is when the update runs.
#[derive(Clone, Debug)]
pub struct UpdateContext {
    pub model: String,
    pub phase_id: String,
    pub minutes_left: f64,
    pub decision_phase_started: bool,
}

/// Structured output schema for the state model.
pub fn update_schema() -> Value {
    let strings = json!({"type": "array", "items": {"type": "string"}});
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["attendees", "next_speaker", "next_speaker_instruction", "user_contradiction", "ask_made",
                     "ask_text", "next_steps", "decision_guidance", "below_walk_away"],
        "properties": {
            "attendees": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["name", "stance", "stance_reason", "patience", "concerns"],
                    "properties": {
                        "name": {"type": "string"},
                        "stance": {"type": "integer"},
                        "stance_reason": {"type": "string"},
                        "patience": {"type": "integer"},
                        "concerns": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["id", "text", "status", "evidence_quote"],
                                "properties": {
                                    "id": {"type": "string"},
                                    "text": {"type": "string"},
                                    "status": {"enum": ["open", "partly", "resolved"]},
                                    "evidence_quote": {"type": "string"}
                                }
                            }
                        }
                    }
                }
            },
            "next_speaker": {"type": "string"},
            "next_speaker_instruction": {"type": "string"},
            "user_contradiction": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "ask_made": {"type": "boolean"},
            "ask_text": {"type": "string"},
            "next_steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["owner", "action", "due"],
                    "properties": {
                        "owner": {"type": "string"},
                        "action": {"type": "string"},
                        "due": {"type": "string"}
                    }
                }
            },
            "decision_guidance": {
                "type": "object",
                "additionalProperties": false,
                "required": ["outcome", "reason", "conditions", "missing_info"],
                "properties": {
                    "outcome": {"enum": ["approved", "approved_with_conditions", "need_more_info", "not_now"]},
                    "reason": {"type": "string"},
                    "conditions": strings,
                    "missing_info": strings
                }
            },
            "below_walk_away": {"anyOf": [{"type": "boolean"}, {"type": "null"}]}
        }
    })
}

/// The exchange as the prompt shows it: `[42s] Rhea: ...` / `[50s] User: ...` (app markers left out).
pub fn render_exchange(state: &MeetingState, turns: &[Turn]) -> String {
    let names: HashMap<&str, &str> = state
        .attendees
        .iter()
        .map(|a| (a.panelist_id.as_str(), a.name.as_str()))
        .collect();
    turns
        .iter()
        .filter(|t| t.speaker != "app" && !t.text.trim().is_empty())
        .map(|t| {
            let who = if t.speaker == "candidate" {
                "User"
            } else {
                names.get(t.speaker.as_str()).copied().unwrap_or("Attendee")
            };
            let text = match (&t.heard, t.interrupted) {
                (Some(heard), true) => format!("{heard} (cut off by the user)"),
                _ => t.text.trim().to_string(),
            };
            format!("[{}s] {who}: {text}", t.at_ms / 1000)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The state the prompt shows the model (no walk away, no texts it must not rewrite beyond the concerns).
fn state_json(state: &MeetingState) -> Value {
    json!({
        "attendees": state.attendees.iter().map(|a| json!({
            "name": a.name,
            "role": a.role,
            "personality": a.personality.as_str(),
            "decision_power": a.decision_power.as_str(),
            "stance": a.stance,
            "patience": a.patience,
            "patience_start": a.patience_start,
            "concerns": a.concerns.iter().map(|c| json!({
                "id": c.id, "text": c.text, "status": c.status.as_str(),
            })).collect::<Vec<_>>(),
            "turns_silent": a.turns_silent,
        })).collect::<Vec<_>>(),
        "ask_made": state.ask_made,
        "ask_text": state.ask_text,
        "next_steps": state.next_steps,
    })
}

/// The state update request for the last exchange.
pub fn build_update_request(
    prompt_template: &str,
    state: &MeetingState,
    last_exchange: &[Turn],
    ctx: &UpdateContext,
) -> MessagesRequest {
    let key_facts = if state.key_facts.is_empty() {
        "none".to_string()
    } else {
        format!("\n{}", state.key_facts.join("\n"))
    };
    let vars = HashMap::from([
        ("meeting_goal", state.goal.clone()),
        ("user_role", state.user_role.clone()),
        (
            "ask",
            state.ask.clone().unwrap_or_else(|| "not given".into()),
        ),
        (
            "walk_away",
            state.walk_away.clone().unwrap_or_else(|| "none".into()),
        ),
        ("key_facts", key_facts),
        ("phase_id", ctx.phase_id.clone()),
        (
            "minutes_left",
            format!("{}", ctx.minutes_left.max(0.0).round() as i64),
        ),
        ("user_chairs", state.user_chairs.to_string()),
        (
            "chair_name",
            state.chair.clone().unwrap_or_else(|| "none".into()),
        ),
        (
            "state_json",
            serde_json::to_string_pretty(&state_json(state)).unwrap_or_default(),
        ),
        ("last_exchange", render_exchange(state, last_exchange)),
    ]);
    MessagesRequest {
        model: ctx.model.clone(),
        max_tokens: UPDATE_MAX_TOKENS,
        system: vec![SystemBlock::text(fill(prompt_template, &vars))],
        messages: vec![Message::user_text(
            "Update the meeting state after the last exchange.",
        )],
        thinking: thinking_for(&ctx.model),
        output_config: Some(OutputConfig {
            effort: Some(UPDATE_EFFORT.into()),
            format: Some(json!({"type": "json_schema", "schema": update_schema()})),
        }),
        fallbacks: fallbacks_for(&ctx.model),
        ..MessagesRequest::default()
    }
}

/// Calls the state model and returns its raw judgement (not yet bounded; see `apply_update`).
pub async fn fetch_update(llm: &dyn LlmApi, req: &MessagesRequest) -> anyhow::Result<ModelUpdate> {
    let resp = llm.create(req).await.map_err(|e| anyhow!("{e}"))?;
    if matches!(
        resp.stop_reason.as_deref(),
        Some("refusal") | Some("max_tokens")
    ) {
        return Err(anyhow!(
            "state update stopped: {}",
            resp.stop_reason.unwrap_or_default()
        ));
    }
    serde_json::from_str(resp.text().trim()).context("state update reply is not a state")
}

/// `state::update`: the state after the last exchange. Runs on `ctx.model` (FAST_MODEL); the session runs it in the
/// background after each user turn and puts the result into the next turn's note.
pub async fn update(
    llm: &dyn LlmApi,
    catalog: &Catalog,
    state: &MeetingState,
    last_exchange: &[Turn],
    ctx: &UpdateContext,
) -> anyhow::Result<MeetingState> {
    let template = catalog
        .prompt("meeting-state")
        .ok_or_else(|| anyhow!("content has no prompts/meeting-state.md"))?;
    let req = build_update_request(template, state, last_exchange, ctx);
    let raw = fetch_update(llm, &req).await?;
    Ok(apply_update(
        state,
        &raw,
        &speakers(last_exchange),
        ctx.decision_phase_started,
    ))
}

/// Panelist ids that spoke in these turns.
pub fn speakers(turns: &[Turn]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in turns {
        if t.speaker != "candidate" && t.speaker != "app" && !out.contains(&t.speaker) {
            out.push(t.speaker.clone());
        }
    }
    out
}

/// Applies the model's judgement to `prev` with every bound enforced. `spoke`: panelist ids that spoke in the
/// exchange (their silence count resets; everyone else's grows by one).
pub fn apply_update(
    prev: &MeetingState,
    raw: &ModelUpdate,
    spoke: &[String],
    decision_phase_started: bool,
) -> MeetingState {
    let mut next = prev.clone();
    next.updates = prev.updates + 1;
    for a in &mut next.attendees {
        a.turns_silent = if spoke.contains(&a.panelist_id) {
            0
        } else {
            a.turns_silent.saturating_add(1)
        };
        let Some(r) = raw
            .attendees
            .iter()
            .find(|r| r.name.trim().eq_ignore_ascii_case(a.name.trim()))
        else {
            a.stance_reason.clear();
            continue;
        };

        // Concerns: known ids change status only; texts and ids stay as they were.
        let mut newly_resolved = false;
        for c in &mut a.concerns {
            if let Some(rc) = r.concerns.iter().find(|rc| rc.id.trim() == c.id) {
                if let Some(status) = rc.status {
                    if status == ConcernStatus::Resolved && c.status != ConcernStatus::Resolved {
                        newly_resolved = true;
                    }
                    if status != c.status {
                        c.evidence_quote = plain(&rc.evidence_quote);
                    }
                    c.status = status;
                }
            }
        }
        // At most one new concern per turn, raised by the user, open.
        if a.concerns.len() < MAX_CONCERNS
            && let Some(new) = r.concerns.iter().find(|rc| {
                !rc.text.trim().is_empty()
                    && !a.concerns.iter().any(|c| {
                        c.id == rc.id.trim() || c.text.eq_ignore_ascii_case(rc.text.trim())
                    })
            })
        {
            let stem = id_stem(&a.name);
            let mut n = a.concerns.len() + 1;
            while a.concerns.iter().any(|c| c.id == format!("{stem}_{n}")) {
                n += 1;
            }
            a.concerns.push(ConcernState {
                id: format!("{stem}_{n}"),
                text: plain(&new.text),
                status: ConcernStatus::Open,
                evidence_quote: String::new(),
            });
        }

        // Stance: one step at most per user turn, within -2..2.
        let wanted = r.stance.clamp(-2, 2) as i8;
        let stance = wanted.clamp(a.stance - 1, a.stance + 1).clamp(-2, 2);
        a.stance_reason = if stance != a.stance {
            plain(&r.stance_reason)
        } else {
            String::new()
        };
        a.stance = stance;

        // Patience: back to the start when a concern was resolved, else what the model says within 0..start.
        a.patience = if newly_resolved {
            a.patience_start
        } else {
            r.patience.clamp(0, a.patience_start as i64) as u8
        };
    }

    next.ask_made = prev.ask_made || raw.ask_made;
    if !raw.ask_text.trim().is_empty() {
        next.ask_text = plain(&raw.ask_text);
    }
    if !raw.next_steps.is_empty() {
        next.next_steps = raw
            .next_steps
            .iter()
            .filter(|s| !s.action.trim().is_empty())
            .take(MAX_NEXT_STEPS)
            .map(|s| NextStep {
                owner: plain(&s.owner),
                action: plain(&s.action),
                due: plain(&s.due),
            })
            .collect();
    }
    next.user_contradiction = raw
        .user_contradiction
        .as_deref()
        .map(plain)
        .filter(|s| !s.is_empty());
    next.below_walk_away = if next.walk_away.is_some() {
        raw.below_walk_away.or(prev.below_walk_away)
    } else {
        None
    };

    // Next speaker: the model's pick when it names an attendee, unless someone has been silent too long.
    let silent = next
        .attendees
        .iter()
        .filter(|a| a.turns_silent > MAX_SILENT_TURNS)
        .max_by_key(|a| a.turns_silent)
        .map(|a| a.name.clone());
    let named = next.attendee(&raw.next_speaker).map(|a| a.name.clone());
    let impatient = next
        .attendees
        .iter()
        .find(|a| a.patience == 0)
        .map(|a| a.name.clone());
    next.next_speaker = silent
        .clone()
        .or(named.clone())
        .or(impatient)
        .or_else(|| next.approver().map(|a| a.name.clone()));
    next.next_speaker_instruction = if silent.is_some() && silent != named {
        "Ask your most important open question.".into()
    } else {
        plain(&raw.next_speaker_instruction)
    };

    next.decision = decision(
        &next,
        raw.decision_guidance.as_ref(),
        decision_phase_started,
    );
    next
}

/// Stance in words, for prompts.
pub fn stance_words(stance: i8) -> &'static str {
    match stance {
        i8::MIN..=-2 => "against it, but a strong answer can move you",
        -1 => "skeptical but open",
        0 => "undecided",
        1 => "leaning in favour",
        _ => "in favour, a champion",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_joined_for_the_title() {
        assert_eq!(join_names(&["Rhea"]), "Rhea");
        assert_eq!(join_names(&["Rhea", "Tom"]), "Rhea and Tom");
        assert_eq!(join_names(&["A", "B", "C"]), "A, B and C");
    }
}
