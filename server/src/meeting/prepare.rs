//! `prepare`: turns the user's `MeetingSetup` into a `MeetingPlan` with one model call (structured output).
//!
//! The model writes what needs judgement: missing objections, cares and background, the concerns behind each
//! person's position, who runs the meeting, the opening line, success criteria and tips. The server then makes the
//! plan safe to use whatever the model wrote:
//! - every field the user filled is taken from the setup verbatim (the model's copy is ignored);
//! - starting stance and patience follow the fixed rules (personality and difficulty), stance within one step of the
//!   model's;
//! - the chair is checked against the attendee names (an approver, a Grace voice, or Grace added as chair);
//!   templates decide whether the user chairs;
//! - voices and looks are assigned here, not by the model: the template's (or user's) `voice_base` first, then a
//!   balanced default, with no shared persona, avatar or voice;
//! - the opening line fits in about eight seconds of speech;
//! - nothing generated repeats the user's walk away point.
//!
//! If the model call fails, the same rules build a plan without it (templates are fully pre-filled).

use std::collections::HashSet;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    Concern, ConcernStatus, DecisionPower, Difficulty, Hidden, MeetingPlan, MeetingSetup,
    Personality, PlanAttendee, WalkAway, data_block, data_rule, id_stem, plain, validate_setup,
};
use crate::claude::{
    Message, MessagesRequest, MessagesResponse, OutputConfig, SystemBlock, Usage, fallbacks_for,
};
use crate::content::Catalog;
use crate::orchestrator::LlmApi;
use crate::orchestrator::prompt::fill;

/// Meeting prepare runs on the most capable model; the user waits on the setup page.
pub const PREPARE_MODEL: &str = "claude-opus-5-5";
pub const PREPARE_EFFORT: &str = "medium";
const PREPARE_MAX_TOKENS: u32 = 12_000;
const PREPARE_TIMEOUT: Duration = Duration::from_secs(120);

/// The persona that chairs when no attendee runs the meeting.
pub const CHAIR_PERSONA: &str = "persona.grace";

/// About eight seconds of speech at a natural pace.
pub const OPENING_MAX_WORDS: usize = 20;

#[derive(Debug, thiserror::Error)]
pub enum PrepareError {
    /// The setup breaks a rule; the message is for the user.
    #[error("{0}")]
    Invalid(String),
    /// The content folder lacks what a plan needs (personas).
    #[error("content: {0}")]
    Content(String),
}

/// The plan as the model writes it (a flat schema structured output supports; the server finishes it).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ModelPlan {
    pub user_chairs: bool,
    pub chair_attendee: Option<String>,
    pub attendees: Vec<ModelAttendee>,
    pub opening_line: String,
    pub success_criteria: Vec<String>,
    pub tips: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ModelAttendee {
    pub name: String,
    pub cares_about: Vec<String>,
    pub likely_objections: Vec<String>,
    pub decision_power: Option<DecisionPower>,
    pub knows: String,
    pub stance: i64,
    pub concerns: Vec<ModelConcern>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ModelConcern {
    pub text: String,
}

/// Prepares a plan. Errors only for an invalid setup or missing content; a failed model call falls back to the
/// rules alone (logged).
pub async fn prepare(
    llm: &dyn LlmApi,
    catalog: &Catalog,
    setup: &MeetingSetup,
) -> Result<MeetingPlan, PrepareError> {
    prepare_with_usage(llm, catalog, setup).await.plan
}

/// A prepared plan (or why there is none) and what the model call used, for the ledger. The usage is kept even
/// when the plan fails after the model answered.
#[derive(Debug)]
pub struct Prepared {
    pub plan: Result<MeetingPlan, PrepareError>,
    /// The model that answered and its token usage.
    pub usage: Option<(String, Usage)>,
}

/// `prepare`, also returning the model usage so the caller can record the spend.
pub async fn prepare_with_usage(
    llm: &dyn LlmApi,
    catalog: &Catalog,
    setup: &MeetingSetup,
) -> Prepared {
    if let Err(msg) = validate_setup(setup) {
        return Prepared {
            plan: Err(PrepareError::Invalid(msg)),
            usage: None,
        };
    }
    let (model, usage) = match build_request(catalog, setup) {
        Some(req) => call_model(llm, &req).await,
        None => {
            tracing::warn!(
                "content has no prompts/meeting-prepare.md; preparing without the model"
            );
            (None, None)
        }
    };
    Prepared {
        plan: build_plan(catalog, setup, model.as_ref()),
        usage,
    }
}

async fn call_model(
    llm: &dyn LlmApi,
    req: &MessagesRequest,
) -> (Option<ModelPlan>, Option<(String, Usage)>) {
    let started = std::time::Instant::now();
    let resp = match tokio::time::timeout(PREPARE_TIMEOUT, llm.create(req)).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "meeting prepare call failed; using the rules alone");
            return (None, None);
        }
        Err(_) => {
            tracing::warn!("meeting prepare call timed out; using the rules alone");
            return (None, None);
        }
    };
    tracing::info!(
        model = %resp.model,
        prepare_ms = started.elapsed().as_millis() as u64,
        input_tokens = resp.usage.input_tokens,
        output_tokens = resp.usage.output_tokens,
        stop = resp.stop_reason.as_deref().unwrap_or(""),
        "meeting prepare"
    );
    let model = if resp.model.is_empty() {
        req.model.clone()
    } else {
        resp.model.clone()
    };
    (parse_model_plan(&resp), Some((model, resp.usage.clone())))
}

/// The model's JSON, unless it refused, ran out of tokens or wrote something else.
pub fn parse_model_plan(resp: &MessagesResponse) -> Option<ModelPlan> {
    match resp.stop_reason.as_deref() {
        Some("refusal") | Some("max_tokens") => {
            tracing::warn!(stop = ?resp.stop_reason, "meeting prepare reply unusable");
            return None;
        }
        _ => {}
    }
    match serde_json::from_str::<ModelPlan>(resp.text().trim()) {
        Ok(p) => Some(p),
        Err(e) => {
            // The error can quote the model's text; log only its kind and where.
            tracing::warn!(kind = ?e.classify(), line = e.line(), column = e.column(), "meeting prepare reply is not a plan");
            None
        }
    }
}

/// The prepare request: the content prompt with the setup, template and persona roster filled in.
pub fn build_request(catalog: &Catalog, setup: &MeetingSetup) -> Option<MessagesRequest> {
    let template = catalog.prompt("meeting-prepare")?;
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
    let template_json = setup
        .template_id
        .and_then(|t| catalog.templates.get(t.as_str()))
        .map(pretty)
        .unwrap_or_else(|| "none".to_string());
    // The walk away point stays on the server: nothing the model writes for attendees can repeat it.
    let walk = WalkAway::new(setup.walk_away.as_deref());
    let mut shown = setup.clone();
    shown.walk_away = None;
    shown.key_facts.retain(|f| !walk.hits(f));
    shown.notes = shown
        .notes
        .as_deref()
        .map(|n| walk.drop_sentences(n))
        .filter(|n| !n.is_empty());
    let vars = std::collections::HashMap::from([
        (
            "setup_json",
            data_block(
                "meeting_setup",
                &serde_json::to_string_pretty(&shown).unwrap_or_default(),
            ),
        ),
        ("template_json", template_json),
        ("personas_json", pretty(&roster(catalog))),
    ]);
    Some(MessagesRequest {
        model: PREPARE_MODEL.into(),
        max_tokens: PREPARE_MAX_TOKENS,
        system: vec![SystemBlock::text(format!(
            "{}\n\n{}",
            fill(template, &vars),
            data_rule(&["meeting_setup"])
        ))],
        messages: vec![Message::user_text(
            "Prepare the meeting plan for this setup now, following the rules.",
        )],
        // Opus 5.5 always thinks; effort sets the depth.
        thinking: None,
        output_config: Some(OutputConfig {
            effort: Some(PREPARE_EFFORT.into()),
            format: Some(json!({"type": "json_schema", "schema": model_schema()})),
        }),
        fallbacks: fallbacks_for(PREPARE_MODEL),
        ..MessagesRequest::default()
    })
}

/// The structured output schema: the plan's shape without the parts the server decides (voices, looks, ids) and
/// without the keywords structured output does not take (lengths, ranges, conditionals).
pub fn model_schema() -> Value {
    let strings = json!({"type": "array", "items": {"type": "string"}});
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["user_chairs", "chair_attendee", "attendees", "opening_line", "success_criteria", "tips"],
        "properties": {
            "user_chairs": {"type": "boolean"},
            "chair_attendee": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "attendees": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["name", "role", "cares_about", "personality", "likely_objections",
                                 "decision_power", "knows", "stance", "concerns", "patience"],
                    "properties": {
                        "name": {"type": "string"},
                        "role": {"type": "string"},
                        "cares_about": strings,
                        "personality": {"enum": ["supportive", "neutral", "skeptical", "hostile"]},
                        "likely_objections": strings,
                        "decision_power": {"enum": ["approver", "influencer", "observer"]},
                        "knows": {"type": "string"},
                        "stance": {"type": "integer"},
                        "concerns": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["id", "text", "status"],
                                "properties": {
                                    "id": {"type": "string"},
                                    "text": {"type": "string"},
                                    "status": {"enum": ["open"]}
                                }
                            }
                        },
                        "patience": {"type": "integer"}
                    }
                }
            },
            "opening_line": {"type": "string"},
            "success_criteria": strings,
            "tips": strings
        }
    })
}

/// The persona roster the prompt shows: id, name, title, style, look, voice and the voice's gender.
fn roster(catalog: &Catalog) -> Value {
    Value::Array(
        catalog
            .personas
            .values()
            .map(|p| {
                json!({
                    "id": p.id,
                    "display_name": p.display_name,
                    "title": p.title,
                    "style": p.style,
                    "avatar_id": p.avatar_id,
                    "voice_id": p.voice_id,
                    "gender": voice_gender(catalog, &p.voice_id),
                })
            })
            .collect(),
    )
}

fn voice_gender(catalog: &Catalog, voice_id: &str) -> String {
    catalog
        .voices
        .as_ref()
        .and_then(|v| v.get("voices"))
        .and_then(|v| v.get(voice_id))
        .and_then(|v| v.get("gender"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

/// Who runs the meeting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChairPick {
    /// The user runs it; no AI attendee chairs.
    User,
    /// This attendee (index into the setup's attendees).
    Attendee(usize),
    /// Grace joins as chair.
    AddGrace,
}

/// The server-side chair check. The model's pick stands only when it names an attendee who may chair: one who
/// borrows Grace's voice, or an approver. Otherwise Grace joins as chair when there is a free seat, else the approver
/// chairs.
pub fn resolve_chair(
    names: &[String],
    powers: &[DecisionPower],
    voice_bases: &[Option<String>],
    model_chair: Option<&str>,
    user_chairs: bool,
) -> ChairPick {
    if user_chairs {
        return ChairPick::User;
    }
    if let Some(i) = voice_bases
        .iter()
        .position(|v| v.as_deref() == Some(CHAIR_PERSONA))
    {
        return ChairPick::Attendee(i);
    }
    let named = model_chair
        .map(str::trim)
        .and_then(|c| names.iter().position(|n| n.trim().eq_ignore_ascii_case(c)));
    if let Some(i) = named
        && powers[i] == DecisionPower::Approver
    {
        return ChairPick::Attendee(i);
    }
    let grace_taken = names.iter().any(|n| n.trim().eq_ignore_ascii_case("grace"));
    if names.len() < super::MAX_ATTENDEES && !grace_taken {
        return ChairPick::AddGrace;
    }
    ChairPick::Attendee(
        powers
            .iter()
            .position(|p| *p == DecisionPower::Approver)
            .unwrap_or(0),
    )
}

/// Builds the plan from the setup and (when the call worked) the model's plan, applying every server rule.
pub fn build_plan(
    catalog: &Catalog,
    setup: &MeetingSetup,
    model: Option<&ModelPlan>,
) -> Result<MeetingPlan, PrepareError> {
    let template = setup
        .template_id
        .and_then(|t| catalog.templates.get(t.as_str()));
    let user_chairs = match template {
        Some(t) => t
            .get("user_chairs")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        None => model.is_some_and(|m| m.user_chairs),
    };
    let leak = WalkAway::new(setup.walk_away.as_deref());
    let find = |name: &str| -> Option<&ModelAttendee> {
        model?
            .attendees
            .iter()
            .find(|m| m.name.trim().eq_ignore_ascii_case(name.trim()))
    };

    let mut attendees: Vec<PlanAttendee> = Vec::with_capacity(setup.attendees.len() + 1);
    for a in &setup.attendees {
        let m = find(&a.name);
        let generated = |list: &[String], max: usize| -> Vec<String> {
            let mut out: Vec<String> = Vec::new();
            for s in list.iter().map(|s| plain(s)) {
                if !s.is_empty()
                    && !leak.hits(&s)
                    && !out.iter().any(|o| o.eq_ignore_ascii_case(&s))
                {
                    out.push(s);
                }
                if out.len() == max {
                    break;
                }
            }
            out
        };
        let cares_about = if a.cares_about.is_empty() {
            m.map(|m| generated(&m.cares_about, 3)).unwrap_or_default()
        } else {
            a.cares_about.clone()
        };
        let likely_objections = if a.likely_objections.is_empty() {
            let from_model = m
                .map(|m| generated(&m.likely_objections, 3))
                .unwrap_or_default();
            if from_model.is_empty() {
                default_objections(&cares_about)
            } else {
                from_model
            }
        } else {
            a.likely_objections.clone()
        };
        let knows = match a.knows.as_deref().filter(|k| !k.trim().is_empty()) {
            Some(k) => Some(k.to_string()),
            None => m
                .map(|m| plain(&m.knows))
                .filter(|k| !k.is_empty() && !leak.hits(k)),
        };
        let decision_power = a
            .decision_power
            .or_else(|| m.and_then(|m| m.decision_power))
            .unwrap_or_default();

        let rule = starting_stance(a.personality, setup.difficulty);
        let stance = match m {
            Some(m) => {
                let s = m.stance.clamp(-2, 2) as i8;
                let s = s.clamp(rule - 1, rule + 1).clamp(-2, 2);
                if a.personality == Personality::Supportive {
                    s.max(0)
                } else {
                    s
                }
            }
            None => rule,
        };
        let mut concern_texts: Vec<String> = m
            .map(|m| {
                let texts: Vec<String> = m.concerns.iter().map(|c| c.text.clone()).collect();
                generated(&texts, 5)
            })
            .unwrap_or_default();
        if concern_texts.is_empty() {
            concern_texts = likely_objections
                .iter()
                .chain(&cares_about)
                .take(3)
                .cloned()
                .collect();
        }
        if concern_texts.is_empty() {
            concern_texts.push("Hears a clear, specific ask.".into());
        }
        // Concern ids are unique across the plan ("Dr. Rhea" and "Dr. Tom" give rhea_1 and tom_1; two Sams give
        // sam_1 and sam2_1).
        let mut stem = id_stem(&a.name);
        let taken = |stem: &str| {
            attendees.iter().any(|p: &PlanAttendee| {
                p.hidden
                    .concerns
                    .iter()
                    .any(|c| c.id.starts_with(&format!("{stem}_")))
            })
        };
        if taken(&stem) {
            let base = stem.clone();
            let mut n = 2;
            while taken(&format!("{base}{n}")) {
                n += 1;
            }
            stem = format!("{base}{n}");
        }
        let concerns = concern_texts
            .into_iter()
            .enumerate()
            .map(|(i, text)| Concern {
                id: format!("{stem}_{}", i + 1),
                text,
                status: ConcernStatus::Open,
            })
            .collect();
        attendees.push(PlanAttendee {
            name: a.name.clone(),
            role: a.role.clone(),
            cares_about,
            personality: a.personality,
            likely_objections,
            decision_power,
            knows,
            voice_base: a.voice_base.clone(),
            hidden: Hidden {
                stance,
                concerns,
                patience: starting_patience(a.personality, setup.difficulty),
                persona_id: String::new(),
                avatar_id: String::new(),
                voice_id: String::new(),
            },
        });
    }

    // Somebody decides. When the user named no approver (the setup page may send the default "influencer" for
    // everyone), the model's approver pick wins, else the first attendee.
    if !attendees
        .iter()
        .any(|a| a.decision_power == DecisionPower::Approver)
    {
        let picked = attendees.iter().position(|a| {
            find(&a.name).and_then(|m| m.decision_power) == Some(DecisionPower::Approver)
        });
        if let Some(a) = attendees.get_mut(picked.unwrap_or(0)) {
            a.decision_power = DecisionPower::Approver;
        }
    }

    let names: Vec<String> = attendees.iter().map(|a| a.name.clone()).collect();
    let powers: Vec<DecisionPower> = attendees.iter().map(|a| a.decision_power).collect();
    let bases: Vec<Option<String>> = attendees.iter().map(|a| a.voice_base.clone()).collect();
    let pick = resolve_chair(
        &names,
        &powers,
        &bases,
        model.and_then(|m| m.chair_attendee.as_deref()),
        user_chairs,
    );
    let chair_attendee = match pick {
        ChairPick::User => None,
        ChairPick::Attendee(i) => Some(attendees[i].name.clone()),
        ChairPick::AddGrace => {
            let grace = grace_chair(catalog);
            let name = grace.name.clone();
            attendees.push(grace);
            Some(name)
        }
    };

    let assigned = assign_personas(catalog, &attendees, chair_attendee.as_deref())?;
    for (a, (persona_id, avatar_id, voice_id)) in attendees.iter_mut().zip(assigned) {
        a.hidden.persona_id = persona_id;
        a.hidden.avatar_id = avatar_id;
        a.hidden.voice_id = voice_id;
    }

    let chair_opens = template
        .and_then(|t| t.get("who_speaks_first"))
        .and_then(Value::as_str)
        == Some("chair");
    let opening_line = model
        .and_then(|m| fit_opening(&m.opening_line))
        .filter(|l| !leak.hits(l))
        .unwrap_or_else(|| default_opening(user_chairs, chair_opens).to_string());

    let success_criteria = {
        let mut out: Vec<String> = model
            .map(|m| {
                m.success_criteria
                    .iter()
                    .map(|s| plain(s))
                    .filter(|s| !s.is_empty() && !leak.hits(s))
                    .take(4)
                    .collect()
            })
            .unwrap_or_default();
        if out.is_empty() {
            out.push(
                template
                    .and_then(|t| t.get("success"))
                    .and_then(Value::as_str)
                    .map(plain)
                    .unwrap_or_else(|| format!("They agree to this: {}", plain(&setup.goal))),
            );
        }
        out
    };
    let tips = three_tips(model, template, user_chairs);

    Ok(MeetingPlan {
        user_chairs,
        chair_attendee,
        attendees,
        opening_line,
        success_criteria,
        tips,
    })
}

/// supportive 1, neutral 0, skeptical -1, hostile -2; friendly +1, tough -1; within -2..2; supportive never below 0.
pub fn starting_stance(p: Personality, d: Difficulty) -> i8 {
    let adj = match d {
        Difficulty::Friendly => 1,
        Difficulty::Realistic => 0,
        Difficulty::Tough => -1,
    };
    let s = (p.base_stance() + adj).clamp(-2, 2);
    if p == Personality::Supportive {
        s.max(0)
    } else {
        s
    }
}

/// hostile 1, skeptical 2, neutral 3, supportive 4; tough -1 (at least 1), friendly +1.
pub fn starting_patience(p: Personality, d: Difficulty) -> u8 {
    match d {
        Difficulty::Friendly => p.base_patience() + 1,
        Difficulty::Realistic => p.base_patience(),
        Difficulty::Tough => p.base_patience().saturating_sub(1).max(1),
    }
}

fn default_objections(cares_about: &[String]) -> Vec<String> {
    let out: Vec<String> = cares_about
        .iter()
        .take(3)
        .map(|c| format!("Walk me through {}.", c.trim().trim_end_matches('.')))
        .collect();
    if out.is_empty() {
        vec![
            "What exactly are you asking us for?".into(),
            "Why now?".into(),
            "What happens if this goes wrong?".into(),
        ]
    } else {
        out
    }
}

fn grace_chair(catalog: &Catalog) -> PlanAttendee {
    let name = catalog
        .persona(CHAIR_PERSONA)
        .map(|p| p.display_name.clone())
        .unwrap_or_else(|| "Grace".into());
    PlanAttendee {
        name,
        role: "Chief of Staff".into(),
        cares_about: vec!["a clear decision".into(), "keeping to time".into()],
        personality: Personality::Neutral,
        likely_objections: vec!["What exactly do you need decided today?".into()],
        decision_power: DecisionPower::Observer,
        knows: Some("Runs this meeting and keeps it to time.".into()),
        voice_base: Some(CHAIR_PERSONA.into()),
        hidden: Hidden {
            stance: 0,
            concerns: vec![Concern {
                id: "grace_1".into(),
                text: "The ask is clear and a decision is reached.".into(),
                status: ConcernStatus::Open,
            }],
            patience: 3,
            persona_id: String::new(),
            avatar_id: String::new(),
            voice_id: String::new(),
        },
    }
}

/// Persona preference by personality: tough voices for pushback, warm ones for supporters. Grace is kept for the
/// chair.
fn preference(p: Personality) -> [&'static str; 7] {
    match p {
        Personality::Hostile | Personality::Skeptical => [
            "persona.viktor",
            "persona.ana",
            "persona.daniel",
            "persona.priya",
            "persona.sam",
            "persona.maya",
            "persona.leo",
        ],
        Personality::Neutral => [
            "persona.ana",
            "persona.daniel",
            "persona.priya",
            "persona.leo",
            "persona.sam",
            "persona.maya",
            "persona.viktor",
        ],
        Personality::Supportive => [
            "persona.priya",
            "persona.sam",
            "persona.maya",
            "persona.leo",
            "persona.ana",
            "persona.daniel",
            "persona.viktor",
        ],
    }
}

/// Voices and looks: a `voice_base` (from the template or the user) is kept when its look and voice are still free;
/// everyone else gets a balanced default (alternating voice genders, never guessed from names) from a preference
/// list that suits their personality. No two attendees share a persona, an avatar or a voice. Grace's persona goes
/// to the chair only.
pub fn assign_personas(
    catalog: &Catalog,
    attendees: &[PlanAttendee],
    chair: Option<&str>,
) -> Result<Vec<(String, String, String)>, PrepareError> {
    let mut used_personas: HashSet<String> = HashSet::new();
    let mut used_avatars: HashSet<String> = HashSet::new();
    let mut used_voices: HashSet<String> = HashSet::new();
    let mut genders: Vec<String> = Vec::new();
    let mut out: Vec<Option<(String, String, String)>> = vec![None; attendees.len()];

    let take = |id: &str,
                used_personas: &mut HashSet<String>,
                used_avatars: &mut HashSet<String>,
                used_voices: &mut HashSet<String>|
     -> Option<(String, String, String, String)> {
        let p = catalog.persona(id)?;
        if used_personas.contains(&p.id)
            || used_avatars.contains(&p.avatar_id)
            || used_voices.contains(&p.voice_id)
        {
            return None;
        }
        used_personas.insert(p.id.clone());
        used_avatars.insert(p.avatar_id.clone());
        used_voices.insert(p.voice_id.clone());
        Some((
            p.id.clone(),
            p.avatar_id.clone(),
            p.voice_id.clone(),
            voice_gender(catalog, &p.voice_id),
        ))
    };

    // First the chair's Grace and every voice_base that is still free, in seat order.
    for (i, a) in attendees.iter().enumerate() {
        let is_chair = chair.is_some_and(|c| c == a.name);
        let wanted = a.voice_base.as_deref().filter(|v| {
            // Grace's look and voice belong to whoever chairs.
            *v != CHAIR_PERSONA || is_chair || chair.is_none()
        });
        if let Some(v) = wanted
            && let Some((pid, av, vo, g)) =
                take(v, &mut used_personas, &mut used_avatars, &mut used_voices)
        {
            out[i] = Some((pid, av, vo));
            genders.push(g);
        }
    }
    // Then a balanced default for the rest.
    for (i, a) in attendees.iter().enumerate() {
        if out[i].is_some() {
            continue;
        }
        let females = genders.iter().filter(|g| *g == "female").count();
        let males = genders.iter().filter(|g| *g == "male").count();
        let target = if females < males {
            "female"
        } else if males < females {
            "male"
        } else if i % 2 == 0 {
            "female"
        } else {
            "male"
        };
        let prefs = preference(a.personality);
        let gender_of = |id: &str| {
            catalog
                .persona(id)
                .map(|p| voice_gender(catalog, &p.voice_id))
                .unwrap_or_default()
        };
        let mut candidates: Vec<String> = prefs
            .iter()
            .filter(|id| gender_of(id) == target)
            .map(|s| s.to_string())
            .collect();
        candidates.extend(prefs.iter().map(|s| s.to_string()));
        // Anyone else in the content, Grace last.
        let mut rest: Vec<String> = catalog
            .personas
            .keys()
            .filter(|k| k.as_str() != CHAIR_PERSONA)
            .cloned()
            .collect();
        rest.push(CHAIR_PERSONA.into());
        candidates.extend(rest);
        let mut picked = None;
        for c in candidates {
            if let Some(found) = take(&c, &mut used_personas, &mut used_avatars, &mut used_voices) {
                picked = Some(found);
                break;
            }
        }
        let (pid, av, vo, g) = picked
            .ok_or_else(|| PrepareError::Content(format!("no free persona left for {}", a.name)))?;
        out[i] = Some((pid, av, vo));
        genders.push(g);
    }
    Ok(out.into_iter().flatten().collect())
}

/// The opening line, cleaned and cut to about eight seconds of speech: the whole line if it fits, else its first and
/// last sentences (the welcome and the hand-over or question), else the last sentence. None when nothing fits.
pub fn fit_opening(line: &str) -> Option<String> {
    let line = plain(line)
        .trim_matches(|c: char| c == '"' || c == '\u{201c}' || c == '\u{201d}')
        .trim()
        .to_string();
    if line.is_empty() {
        return None;
    }
    let words = |s: &str| s.split_whitespace().count();
    if words(&line) <= OPENING_MAX_WORDS {
        return Some(line);
    }
    let sentences = sentences(&line);
    if sentences.len() >= 2 {
        let first = &sentences[0];
        let last = &sentences[sentences.len() - 1];
        let both = format!("{first} {last}");
        if words(&both) <= OPENING_MAX_WORDS {
            return Some(both);
        }
        if words(last) <= OPENING_MAX_WORDS {
            return Some(last.clone());
        }
    }
    None
}

fn sentences(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        if matches!(c, '.' | '?' | '!') && chars.get(i + 1).is_none_or(|n| n.is_whitespace()) {
            let s = cur.trim().to_string();
            if !s.is_empty() {
                out.push(s);
            }
            cur.clear();
        }
    }
    let s = cur.trim().to_string();
    if !s.is_empty() {
        out.push(s);
    }
    out
}

fn default_opening(user_chairs: bool, chair_opens: bool) -> &'static str {
    if user_chairs {
        "Thanks for setting this up. Over to you."
    } else if chair_opens {
        "Thanks for coming, everyone. What are we here to decide today?"
    } else {
        "Thanks for coming, everyone. Over to you."
    }
}

fn three_tips(
    model: Option<&ModelPlan>,
    template: Option<&Value>,
    user_chairs: bool,
) -> Vec<String> {
    let mut tips: Vec<String> = Vec::new();
    let mut push = |s: String| {
        let s = plain(&s);
        if !s.is_empty() && tips.len() < 3 && !tips.iter().any(|t| t.eq_ignore_ascii_case(&s)) {
            tips.push(s);
        }
    };
    if let Some(m) = model {
        m.tips.iter().cloned().for_each(&mut push);
    }
    if let Some(list) = template
        .and_then(|t| t.get("tips"))
        .and_then(Value::as_array)
    {
        list.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .for_each(&mut push);
    }
    let defaults: [&str; 3] = if user_chairs {
        [
            "Name the issue early, with one specific example.",
            "Listen, then restate their view before you answer.",
            "End with one agreed action and a date.",
        ]
    } else {
        [
            "Say what you want decided in your first minute.",
            "Answer number questions with the number first.",
            "End by asking for a decision and a date.",
        ]
    };
    defaults.iter().map(|s| s.to_string()).for_each(&mut push);
    tips
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_is_cut_to_eight_seconds() {
        assert_eq!(
            fit_opening("Thanks for coming. Over to you.").as_deref(),
            Some("Thanks for coming. Over to you.")
        );
        let long = "Welcome everyone, thanks for making the time today. We have Tom from the fund with us and we will \
                    keep this tight and focused on the numbers. Over to you.";
        assert_eq!(
            fit_opening(long).as_deref(),
            Some("Welcome everyone, thanks for making the time today. Over to you.")
        );
        assert_eq!(fit_opening("  "), None);
    }

    #[test]
    fn walk_away_numbers_are_caught() {
        let w = WalkAway::new(Some("Nothing below 120,000 base"));
        assert!(w.hits("Our band tops out at 120000."));
        assert!(!w.hits("The band is wide."));
        assert!(!WalkAway::new(None).hits("120000"));
        assert!(
            WalkAway::new(Some("No less than 1.2 million"))
                .hits("Would you take less than 1.2 million?")
        );
        assert!(!WalkAway::new(Some("No less than 1.2 million")).hits("We have 12 clinics."));
    }

    #[test]
    fn stance_and_patience_follow_the_rules() {
        assert_eq!(
            starting_stance(Personality::Supportive, Difficulty::Tough),
            0
        );
        assert_eq!(starting_stance(Personality::Hostile, Difficulty::Tough), -2);
        assert_eq!(
            starting_stance(Personality::Skeptical, Difficulty::Friendly),
            0
        );
        assert_eq!(
            starting_patience(Personality::Hostile, Difficulty::Tough),
            1
        );
        assert_eq!(
            starting_patience(Personality::Neutral, Difficulty::Friendly),
            4
        );
    }
}
