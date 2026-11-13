//! Meeting rehearsal: the setup the user submits (`content/schema/meeting-setup.schema.json`), the plan prepared from
//! it (`meeting-plan.schema.json`, with a server-only `hidden` block per attendee), and the hidden state of each
//! attendee that moves with what the user actually says.
//!
//! - `prepare`: one model call turns a setup into a plan (missing objections, starting stance and concerns, chair,
//!   voices and looks, the opening line). The server keeps the user's words, picks voices and checks the chair.
//! - `state`: after every user turn a fast model call updates stances and concerns in the background; the server
//!   bounds every move and works out the decision from the approver's state.
//! - `live`: the attendee prompts and the per-turn note each attendee sees (only its own hidden state).

pub mod prepare;
pub mod state;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use prepare::{PREPARE_MODEL, prepare};
pub use state::{MeetingState, Outcome};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Personality {
    Supportive,
    Neutral,
    Skeptical,
    Hostile,
}

impl Personality {
    pub fn as_str(self) -> &'static str {
        match self {
            Personality::Supportive => "supportive",
            Personality::Neutral => "neutral",
            Personality::Skeptical => "skeptical",
            Personality::Hostile => "hostile",
        }
    }

    /// Starting stance before difficulty: supportive 1, neutral 0, skeptical -1, hostile -2.
    pub fn base_stance(self) -> i8 {
        match self {
            Personality::Supportive => 1,
            Personality::Neutral => 0,
            Personality::Skeptical => -1,
            Personality::Hostile => -2,
        }
    }

    /// User turns before this attendee pushes harder, before difficulty.
    pub fn base_patience(self) -> u8 {
        match self {
            Personality::Hostile => 1,
            Personality::Skeptical => 2,
            Personality::Neutral => 3,
            Personality::Supportive => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionPower {
    Approver,
    #[default]
    Influencer,
    Observer,
}

impl DecisionPower {
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionPower::Approver => "approver",
            DecisionPower::Influencer => "influencer",
            DecisionPower::Observer => "observer",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Difficulty {
    Friendly,
    #[default]
    Realistic,
    Tough,
}

impl Difficulty {
    pub fn as_str(self) -> &'static str {
        match self {
            Difficulty::Friendly => "friendly",
            Difficulty::Realistic => "realistic",
            Difficulty::Tough => "tough",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingLength {
    Short,
    Full,
}

impl MeetingLength {
    pub fn as_str(self) -> &'static str {
        match self {
            MeetingLength::Short => "short",
            MeetingLength::Full => "full",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateId {
    InvestorPitch,
    ClientProposal,
    ExecUpdate,
    SalaryNegotiation,
    PerformanceReview,
    ProjectKickoff,
}

impl TemplateId {
    pub fn as_str(self) -> &'static str {
        match self {
            TemplateId::InvestorPitch => "investor_pitch",
            TemplateId::ClientProposal => "client_proposal",
            TemplateId::ExecUpdate => "exec_update",
            TemplateId::SalaryNegotiation => "salary_negotiation",
            TemplateId::PerformanceReview => "performance_review",
            TemplateId::ProjectKickoff => "project_kickoff",
        }
    }

    /// Short name of the kind of meeting, for the attendee prompt.
    pub fn kind(self) -> &'static str {
        match self {
            TemplateId::InvestorPitch => "Investor pitch",
            TemplateId::ClientProposal => "Client proposal",
            TemplateId::ExecUpdate => "Exec status update",
            TemplateId::SalaryNegotiation => "Salary negotiation",
            TemplateId::PerformanceReview => "Performance review",
            TemplateId::ProjectKickoff => "Project kickoff",
        }
    }
}

/// `attendee.schema.json`: one attendee as the user (or a template) describes them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attendee {
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub cares_about: Vec<String>,
    pub personality: Personality,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub likely_objections: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_power: Option<DecisionPower>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knows: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_base: Option<String>,
}

/// `meeting-setup.schema.json`: what the user submits to `POST /api/meetings/prepare`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MeetingSetup {
    /// None = a custom meeting.
    pub template_id: Option<TemplateId>,
    pub goal: String,
    pub user_role: String,
    pub attendees: Vec<Attendee>,
    pub length: MeetingLength,
    /// Plain lines ("Round: 1.5 million dollars"); see `board_numbers` for the board's cards.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_facts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walk_away: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub difficulty: Difficulty,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConcernStatus {
    Open,
    Partly,
    Resolved,
}

impl ConcernStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ConcernStatus::Open => "open",
            ConcernStatus::Partly => "partly",
            ConcernStatus::Resolved => "resolved",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Concern {
    pub id: String,
    pub text: String,
    pub status: ConcernStatus,
}

/// Server only: never sent to the browser.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Hidden {
    /// -2 hostile to +2 champion.
    pub stance: i8,
    pub concerns: Vec<Concern>,
    /// User turns before this attendee pushes harder.
    pub patience: u8,
    pub persona_id: String,
    pub avatar_id: String,
    pub voice_id: String,
}

/// One attendee of a prepared plan: the user's fields (kept as written, empty ones filled) plus `hidden`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanAttendee {
    pub name: String,
    pub role: String,
    pub cares_about: Vec<String>,
    pub personality: Personality,
    /// Shown on the setup page as suggestions the user can keep or delete.
    pub likely_objections: Vec<String>,
    pub decision_power: DecisionPower,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knows: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_base: Option<String>,
    pub hidden: Hidden,
}

/// `meeting-plan.schema.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MeetingPlan {
    #[serde(default)]
    pub user_chairs: bool,
    /// Name of the attendee who chairs; None exactly when `user_chairs`.
    pub chair_attendee: Option<String>,
    pub attendees: Vec<PlanAttendee>,
    /// What the chair (or, when the user chairs, the decision maker) says first.
    pub opening_line: String,
    pub success_criteria: Vec<String>,
    pub tips: Vec<String>,
}

impl MeetingPlan {
    /// `MeetingPlanPublic`: the plan with every `attendees[].hidden` removed.
    pub fn public(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(list) = v.get_mut("attendees").and_then(Value::as_array_mut) {
            for a in list {
                if let Some(obj) = a.as_object_mut() {
                    obj.remove("hidden");
                }
            }
        }
        v
    }

    /// The attendee who decides: the first approver (prepare makes sure there is one), else the first attendee.
    pub fn approver(&self) -> Option<&PlanAttendee> {
        self.attendees
            .iter()
            .find(|a| a.decision_power == DecisionPower::Approver)
            .or_else(|| self.attendees.first())
    }
}

/// Field limits from the schemas.
pub const MAX_ATTENDEES: usize = 3;
const MAX_GOAL: usize = 200;
const MAX_USER_ROLE: usize = 80;
const MAX_NAME: usize = 24;
const MAX_ROLE: usize = 48;
const MAX_LIST: usize = 5;
const MAX_KEY_FACTS: usize = 8;
const MAX_NOTES: usize = 8000;

fn chars(s: &str) -> usize {
    s.chars().count()
}

/// Checks a setup against the schema's rules and the ones the schema cannot say (unique names, no blank text).
/// The message is shown to the user as is.
pub fn validate_setup(setup: &MeetingSetup) -> Result<(), String> {
    let goal = setup.goal.trim();
    if goal.is_empty() {
        return Err("Say what you want from this meeting.".into());
    }
    if chars(goal) > MAX_GOAL {
        return Err(format!(
            "Keep the goal to one line ({MAX_GOAL} characters at most)."
        ));
    }
    let role = setup.user_role.trim();
    if role.is_empty() || chars(role) > MAX_USER_ROLE {
        return Err(format!(
            "Add your role in the meeting ({MAX_USER_ROLE} characters at most)."
        ));
    }
    if setup.attendees.is_empty() {
        return Err("Add at least one attendee.".into());
    }
    if setup.attendees.len() > MAX_ATTENDEES {
        return Err(format!(
            "A meeting can have at most {MAX_ATTENDEES} attendees."
        ));
    }
    let mut names: Vec<String> = Vec::new();
    for a in &setup.attendees {
        let name = a.name.trim();
        if name.is_empty() || chars(name) > MAX_NAME {
            return Err(format!(
                "Every attendee needs a name ({MAX_NAME} characters at most)."
            ));
        }
        let key = name.to_lowercase();
        if names.contains(&key) {
            return Err(format!(
                "Two attendees are called {name}. Give each a different name."
            ));
        }
        names.push(key);
        if a.role.trim().is_empty() || chars(a.role.trim()) > MAX_ROLE {
            return Err(format!(
                "Add a role for {name} ({MAX_ROLE} characters at most)."
            ));
        }
        if a.cares_about.len() > MAX_LIST || a.likely_objections.len() > MAX_LIST {
            return Err(format!(
                "{name} can have at most {MAX_LIST} cares and {MAX_LIST} objections."
            ));
        }
        if a.cares_about
            .iter()
            .chain(&a.likely_objections)
            .any(|s| s.trim().is_empty())
        {
            return Err(format!("Remove the empty lines for {name}."));
        }
        if let Some(v) = &a.voice_base
            && !is_persona_id(v)
        {
            return Err(format!("The voice for {name} is not one we have."));
        }
    }
    if setup.key_facts.len() > MAX_KEY_FACTS {
        return Err(format!("Add at most {MAX_KEY_FACTS} key facts."));
    }
    if setup.key_facts.iter().any(|f| f.trim().is_empty()) {
        return Err("Remove the empty key facts.".into());
    }
    if setup.notes.as_deref().is_some_and(|n| chars(n) > MAX_NOTES) {
        return Err(format!("Notes can be {MAX_NOTES} characters at most."));
    }
    Ok(())
}

/// `persona.<lowercase letters>`.
pub fn is_persona_id(s: &str) -> bool {
    s.strip_prefix("persona.")
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_lowercase()))
}

/// A key number card on the meeting board (`board.v1` `meeting.numbers[]`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyNumber {
    pub id: String,
    pub label: String,
    pub value: String,
}

/// The one conversion between the three key fact shapes: the setup's plain lines become the board's number cards
/// `{id, label, value}`. "Round: 1.5 million" splits on the colon; otherwise the value starts at the first word with
/// a digit ("Launch is slipping 3 weeks" → "Launch is slipping" / "3 weeks"; "40 paying clinics" → "Paying clinics" /
/// "40"). A line with no number is all label.
pub fn board_numbers(key_facts: &[String]) -> Vec<KeyNumber> {
    key_facts
        .iter()
        .map(|f| f.trim())
        .filter(|f| !f.is_empty())
        .enumerate()
        .map(|(i, fact)| {
            let (label, value) = split_fact(fact);
            KeyNumber {
                id: format!("k{}", i + 1),
                label,
                value,
            }
        })
        .collect()
}

fn split_fact(fact: &str) -> (String, String) {
    if let Some((l, v)) = fact.split_once(':')
        && !l.trim().is_empty()
        && !v.trim().is_empty()
    {
        return (l.trim().to_string(), v.trim().to_string());
    }
    let words: Vec<&str> = fact.split_whitespace().collect();
    match words
        .iter()
        .position(|w| w.chars().any(|c| c.is_ascii_digit()))
    {
        Some(0) => {
            let rest = words[1..].join(" ");
            if rest.is_empty() {
                (String::new(), fact.to_string())
            } else {
                (capitalise(&rest), words[0].to_string())
            }
        }
        Some(i) => (words[..i].join(" "), words[i..].join(" ")),
        None => (fact.to_string(), String::new()),
    }
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(first) => first.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// A template's `{label, value}` key facts as the setup's plain lines ("Round: 1.5 million dollars, seed").
pub fn template_key_facts(template: &Value) -> Vec<String> {
    template
        .get("key_facts")
        .and_then(Value::as_array)
        .map(|facts| {
            facts
                .iter()
                .filter_map(|f| {
                    let label = f.get("label")?.as_str()?.trim();
                    let value = f.get("value")?.as_str()?.trim();
                    Some(format!("{label}: {value}"))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Copy the user reads: no em or en dashes, no runs of spaces.
pub(crate) fn plain(s: &str) -> String {
    s.replace(" \u{2014} ", ", ")
        .replace(" \u{2013} ", ", ")
        .replace(['\u{2014}', '\u{2013}'], ", ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The first name, lowercase letters and digits only (for concern ids such as `rhea_1`).
pub(crate) fn id_stem(name: &str) -> String {
    let stem: String = name
        .split_whitespace()
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    if stem.is_empty() { "a".into() } else { stem }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_facts_split_into_number_cards() {
        let cards = board_numbers(&[
            "Round: 1.5 million dollars, seed".into(),
            "Launch is slipping 3 weeks".into(),
            "40 paying clinics".into(),
            "Strong team".into(),
        ]);
        let pairs: Vec<(&str, &str, &str)> = cards
            .iter()
            .map(|c| (c.id.as_str(), c.label.as_str(), c.value.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("k1", "Round", "1.5 million dollars, seed"),
                ("k2", "Launch is slipping", "3 weeks"),
                ("k3", "Paying clinics", "40"),
                ("k4", "Strong team", ""),
            ]
        );
    }

    #[test]
    fn plain_copy_has_no_dashes() {
        assert_eq!(
            plain("Lead with the ask \u{2014} then numbers"),
            "Lead with the ask, then numbers"
        );
        assert_eq!(id_stem("Dr. Rhea Kapoor"), "dr");
        assert_eq!(id_stem("Rhea"), "rhea");
    }
}
