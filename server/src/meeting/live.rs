//! The meeting inside a live session: each attendee's stable prompt (`content/prompts/round-meeting.md`), the part of
//! the per-turn note that carries this attendee's hidden state and the chair's time rules, and the background state
//! update after each user turn.
//!
//! Each attendee sees only its own stance and concerns. Other attendees' lines reach it as "Name said: ..." (see
//! `orchestrator::prompt::perspective`), never as its own turns.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use anyhow::anyhow;
use tokio::sync::Mutex;

use super::state::{
    AttendeeState, MeetingState, UpdateContext, apply_update, build_update_request, fetch_update,
    speakers, stance_words,
};
use super::ConcernStatus;
use crate::content::{Catalog, Persona, RoundConfig};
use crate::orchestrator::prompt::fill;
use crate::orchestrator::{LlmApi, SessionState, Turn};

/// What the chair says to force the decision.
pub const DECISION_LINE: &str = "We need to wrap up. What exactly are you asking us for?";
/// The chair's close when no ask was made.
pub const REGROUP_LINE: &str = "Let's regroup when you have a clear proposal.";
/// Under this many seconds left, the chair forces the decision.
pub const DECISION_SECONDS: f64 = 120.0;

/// Where the meeting is in time, for one turn note.
#[derive(Clone, Debug)]
pub struct Clock {
    pub remaining_s: f64,
    /// The current phase is the decision phase or later.
    pub decision_started: bool,
    /// The current phase's time is up (and it is not the last phase).
    pub phase_over: bool,
    pub round_over: bool,
}

impl Clock {
    pub fn of(state: &SessionState, now: Instant) -> Clock {
        let last_phase = state.phase_idx + 1 >= state.round.phases.len();
        Clock {
            remaining_s: state.round_minutes_left(now) * 60.0,
            decision_started: decision_started(&state.round, state.phase_idx),
            phase_over: state.phase_minutes_left(now) <= 0.0 && !last_phase,
            round_over: state.round_minutes_left(now) <= 0.0,
        }
    }
}

/// Index of the meeting round's `decision` phase.
pub fn decision_index(round: &RoundConfig) -> Option<usize> {
    round.phases.iter().position(|p| p.id == "decision")
}

pub fn decision_started(round: &RoundConfig, phase_idx: usize) -> bool {
    decision_index(round).is_some_and(|d| phase_idx >= d)
}

/// The phase the schedule says it is (used when the user chairs: the app moves the phases on time).
pub fn scheduled_phase(round: &RoundConfig, elapsed_min: f64) -> usize {
    let mut end = 0.0;
    for (i, p) in round.phases.iter().enumerate() {
        end += p.minutes;
        if elapsed_min < end {
            return i;
        }
    }
    round.phases.len().saturating_sub(1)
}

fn num(x: f64) -> String {
    if x.fract() == 0.0 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// `round-meeting.md` split into its base (before the first `## ` heading) and named sections.
fn split_sections(text: &str) -> (String, HashMap<String, String>) {
    let mut base = String::new();
    let mut sections: HashMap<String, String> = HashMap::new();
    let mut current: Option<String> = None;
    for line in text.split_inclusive('\n') {
        if let Some(h) = line.strip_prefix("## ") {
            current = Some(h.trim().to_string());
            sections.entry(h.trim().to_string()).or_default();
            continue;
        }
        match &current {
            None => base.push_str(line),
            Some(k) => sections.entry(k.clone()).or_default().push_str(line),
        }
    }
    (
        base.trim().to_string(),
        sections
            .into_iter()
            .map(|(k, v)| (k, v.trim().to_string()))
            .collect(),
    )
}

/// The stable prompt for attendee `idx`: the base of `round-meeting.md`, then `## chair` for the chair or
/// `## attendee` for everyone else, then `## user_chairs` when the user runs the meeting. The walk away point is never
/// in it.
pub fn render_system(
    catalog: &Catalog,
    round: &RoundConfig,
    meeting: &MeetingState,
    idx: usize,
    persona: &Persona,
) -> anyhow::Result<String> {
    let script = catalog
        .prompt("round-meeting")
        .ok_or_else(|| anyhow!("content has no prompts/round-meeting.md"))?;
    let a = meeting
        .attendees
        .get(idx)
        .ok_or_else(|| anyhow!("no attendee {idx}"))?;
    let (base, sections) = split_sections(script);

    let others: Vec<String> = meeting
        .attendees
        .iter()
        .filter(|o| o.name != a.name)
        .map(|o| format!("{}, {}, {}", o.name, o.role, o.personality.as_str()))
        .collect();
    let mut context: Vec<String> = meeting.key_facts.clone();
    if let Some(notes) = &meeting.notes {
        let trimmed: String = notes.trim().chars().take(2000).collect();
        context.push(format!("Notes from the user: {trimmed}"));
    }
    let interrupt = persona
        .interrupts_after_seconds
        .unwrap_or(round.interrupt_after_seconds);
    let vars: HashMap<&str, String> = HashMap::from([
        ("attendee.name", a.name.clone()),
        ("attendee.role", a.role.clone()),
        ("attendee.cares_about", a.cares_about.join(", ")),
        ("attendee.personality", a.personality.as_str().into()),
        (
            "attendee.likely_objections",
            a.likely_objections
                .iter()
                .map(|o| format!("\n- {o}"))
                .collect::<String>(),
        ),
        ("attendee.decision_power", a.decision_power.as_str().into()),
        (
            "attendee.knows",
            a.knows
                .clone()
                .unwrap_or_else(|| "Nothing beyond the invite.".into()),
        ),
        ("attendee.opening_stance", stance_words(a.stance).into()),
        ("persona.speech_habits", persona.speech_habits.join("; ")),
        ("meeting.title", meeting.title.clone()),
        ("meeting.user_name", "the user".into()),
        ("meeting.user_role", meeting.user_role.clone()),
        ("meeting.goal", meeting.goal.clone()),
        (
            "meeting.context",
            if context.is_empty() {
                "none given".into()
            } else {
                context.join("; ")
            },
        ),
        (
            "meeting.others",
            if others.is_empty() {
                "Nobody else".into()
            } else {
                others.join("; ")
            },
        ),
        (
            "meeting.chair_name",
            meeting.chair.clone().unwrap_or_else(|| "the user".into()),
        ),
        (
            "meeting.approver_name",
            meeting
                .approver()
                .map(|x| x.name.clone())
                .unwrap_or_default(),
        ),
        ("difficulty", meeting.difficulty.as_str().into()),
        ("length", round.length.clone()),
        ("target_minutes", num(round.target_minutes)),
        (
            "phases_script",
            round
                .phases
                .iter()
                .map(|p| format!("- {} ({} min): {}", p.id, num(p.minutes), p.goal))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        ("interrupt_after_seconds", interrupt.to_string()),
    ]);

    let is_chair = !meeting.user_chairs && meeting.chair.as_deref() == Some(a.name.as_str());
    let mut parts = vec![base];
    let role_key = if is_chair { "chair" } else { "attendee" };
    if let Some(s) = sections.get(role_key) {
        parts.push(format!("## {role_key}\n{s}"));
    }
    if meeting.user_chairs
        && let Some(s) = sections.get("user_chairs")
    {
        parts.push(format!("## user_chairs\n{s}"));
    }
    Ok(fill(&parts.join("\n\n"), &vars))
}

fn quoted_list(items: &[String]) -> String {
    items
        .iter()
        .map(|i| format!("\"{}\"", i.trim().trim_end_matches('.')))
        .collect::<Vec<_>>()
        .join("; ")
}

fn named(a: &AttendeeState) -> String {
    format!("{} (panelist id {})", a.name, a.panelist_id)
}

/// The meeting part of the turn note for the attendee on `panelist_id`: its own hidden state (never anyone
/// else's), who the state says speaks next, the decision when it is the decision maker's to give, and the chair and
/// time rules. Also the time line that replaces the interview one (attendees other than the chair never keep time;
/// nobody does when the user chairs).
pub fn turn_parts(
    meeting: &MeetingState,
    panelist_id: &str,
    clock: &Clock,
) -> (String, Vec<String>) {
    let Some(me) = meeting.by_panelist(panelist_id) else {
        return (String::new(), Vec::new());
    };
    let mut notes: Vec<String> = Vec::new();
    let is_chair = !meeting.user_chairs && meeting.chair.as_deref() == Some(me.name.as_str());
    let is_approver = meeting.approver().is_some_and(|a| a.name == me.name);
    let closer = meeting.closer();
    let is_closer = closer.is_some_and(|c| c.name == me.name);

    // Own hidden state.
    let mut own = format!(
        "Meeting state, for you only, never say it aloud. You are {}. Your position now: {}",
        me.name,
        stance_words(me.stance)
    );
    if !me.stance_reason.is_empty() {
        own.push_str(&format!(" (it just moved: {})", me.stance_reason));
    }
    own.push('.');
    let unsettled = me.unsettled();
    if unsettled.is_empty() {
        own.push_str(
            " Your concerns are all settled; acknowledge that and ask only about details.",
        );
    } else {
        let list: Vec<String> = unsettled
            .iter()
            .map(|c| {
                let tag = if c.status == ConcernStatus::Partly {
                    " (partly answered)"
                } else {
                    ""
                };
                format!("\"{}\"{tag}", c.text.trim_end_matches('.'))
            })
            .collect();
        own.push_str(&format!(
            " Your open concerns, most important first: {}.",
            list.join("; ")
        ));
    }
    let settled: Vec<String> = me
        .concerns
        .iter()
        .filter(|c| c.status == ConcernStatus::Resolved)
        .map(|c| c.text.clone())
        .collect();
    if !settled.is_empty() {
        own.push_str(&format!(
            " Settled, do not ask again: {}.",
            quoted_list(&settled)
        ));
    }
    if me.patience == 0 {
        own.push_str(
            " Your patience has run out: press politely but firmly for a specific answer.",
        );
    }
    notes.push(own);

    if let Some(c) = &meeting.user_contradiction {
        notes.push(format!(
            "The user contradicted their own facts: {c}. If it bears on your concerns, point it out briefly."
        ));
    }
    if meeting.ask_made {
        if !meeting.ask_text.is_empty() {
            notes.push(format!(
                "The user has made the ask: \"{}\".",
                meeting.ask_text
            ));
        }
    } else if clock.decision_started || clock.remaining_s < DECISION_SECONDS {
        notes.push("The user has not made a clear ask yet.".into());
    }

    // Who speaks next.
    if let Some(next) = meeting
        .next_speaker
        .as_deref()
        .and_then(|n| meeting.attendee(n))
    {
        let instruction = meeting.next_speaker_instruction.trim();
        if next.name == me.name {
            if !instruction.is_empty() {
                notes.push(format!("You speak next. {instruction}"));
            }
        } else if meeting.user_chairs {
            notes.push(format!(
                "If the user's last words were meant for {}, say one short line and hand over to {} with their first question in their own voice{}.",
                next.name,
                named(next),
                if instruction.is_empty() { String::new() } else { format!(", built on this: {instruction}") }
            ));
        } else {
            notes.push(format!(
                "The app picked {} to speak next{}. Unless you must answer the user first, give them the floor: one short line that names them, then hand over to {} with their first question, in their voice, under twenty five words.",
                next.name,
                if instruction.is_empty() { String::new() } else { format!(" ({instruction})") },
                named(next)
            ));
        }
    }

    // The decision, for the decision maker once it is time.
    if is_approver
        && (clock.decision_started || clock.remaining_s < DECISION_SECONDS || meeting.ask_made)
    {
        let d = &meeting.decision;
        let mut line = format!(
            "If you are asked for a decision, it is: {}. Reason: {}",
            d.outcome.words(),
            d.reason.trim_end_matches('.')
        );
        if !d.conditions.is_empty() {
            line.push_str(&format!(". Conditions: {}", quoted_list(&d.conditions)));
        }
        if !d.missing_info.is_empty() {
            line.push_str(&format!(
                ". What you still need: {}",
                quoted_list(&d.missing_info)
            ));
        }
        line.push_str(". Say it in your own words, in one or two sentences.");
        notes.push(line);
    }

    // Who runs the meeting.
    let mut time_line = String::new();
    if meeting.user_chairs {
        notes.push(
            "The user runs this meeting. Never welcome anyone, keep time, move the agenda, ask what they want from you, or push for a decision. Answer and push back as yourself."
                .into(),
        );
        if is_approver {
            notes.push(
                "Give your decision only when the user asks for one or for your agreement.".into(),
            );
        }
        if clock.round_over && is_closer {
            time_line =
                "Time is up. Say one short closing line in character, then end the meeting.".into();
        }
    } else if let Some(chair) = meeting.chair_attendee() {
        if is_chair {
            if clock.round_over {
                time_line = closing_instruction(meeting);
            } else if clock.remaining_s < DECISION_SECONDS && !clock.decision_started {
                time_line = format!(
                    "Under two minutes left. Force the decision now: say \"{DECISION_LINE}\" and move to the decision phase."
                );
            } else if clock.decision_started && meeting.ask_made && !is_approver {
                if let Some(a) = meeting.approver() {
                    time_line = format!(
                        "The ask is made. Give the floor to {} to state the decision: hand over to {} with their decision line.",
                        a.name,
                        named(a)
                    );
                }
            } else if clock.phase_over {
                time_line = "Time check: this phase is over. Say one short transition line and move to the next phase.".into();
            }
        } else if clock.round_over {
            time_line = format!(
                "Time is up and {} closes the meeting. Say at most a few words and hand over to {} with their closing line.",
                chair.name,
                named(chair)
            );
        } else if clock.remaining_s < DECISION_SECONDS && !clock.decision_started {
            time_line = format!(
                "Under two minutes left and {} runs the meeting. Hand over to {} with this line for them: \"{DECISION_LINE}\"",
                chair.name,
                named(chair)
            );
        }
    }
    (time_line, notes)
}

/// The chair's close: next steps read back with owners and dates, or the regroup line when no ask was made.
fn closing_instruction(meeting: &MeetingState) -> String {
    if !meeting.ask_made {
        return format!("Time is up. Close with \"{REGROUP_LINE}\" and end the meeting.");
    }
    let steps: Vec<String> = meeting
        .next_steps
        .iter()
        .map(|s| {
            let mut t = format!("{} will {}", s.owner, s.action);
            if !s.due.trim().is_empty() {
                t.push_str(&format!(" by {}", s.due));
            }
            t
        })
        .collect();
    if steps.is_empty() {
        "Time is up. Close in one or two sentences with the decision and who does what next, then end the meeting."
            .into()
    } else {
        format!(
            "Time is up. Read back the next steps in one or two sentences ({}), then end the meeting.",
            steps.join("; ")
        )
    }
}

/// The note for `[event: ending]` in a meeting: the closer closes, anyone else hands the floor to the closer.
pub fn ending_note(meeting: &MeetingState, panelist_id: &str) -> Option<String> {
    let closer = meeting.closer()?;
    if closer.panelist_id == panelist_id {
        Some(if meeting.user_chairs {
            "Time is up. Say one short closing line in character, then end the meeting.".into()
        } else {
            closing_instruction(meeting)
        })
    } else {
        Some(format!(
            "Time is up and {} closes. Say at most a few words and hand over to {} with their closing line.",
            closer.name,
            named(closer)
        ))
    }
}

/// One background state update: the state, the exchange it judges and where the meeting is.
#[derive(Clone, Debug)]
pub struct UpdateJob {
    pub state: MeetingState,
    pub exchange: Vec<Turn>,
    pub ctx: UpdateContext,
}

/// The update to run after the user's newest words: the last attendee line before them and the words themselves.
/// None outside meetings or when the newest turn is not the user's.
pub fn update_job(st: &SessionState, now: Instant) -> Option<UpdateJob> {
    let meeting = st.meeting.as_ref()?;
    let user = st.turns.iter().rposition(|t| t.speaker == "candidate")?;
    if st.turns[user + 1..].iter().any(|t| t.speaker != "app") {
        return None;
    }
    let mut exchange: Vec<Turn> = Vec::new();
    if let Some(prev) = st.turns[..user]
        .iter()
        .rev()
        .find(|t| t.speaker != "candidate" && t.speaker != "app")
    {
        exchange.push(prev.clone());
    }
    exchange.push(st.turns[user].clone());
    Some(UpdateJob {
        state: meeting.clone(),
        exchange,
        ctx: UpdateContext {
            model: st.live.fast_model.clone(),
            phase_id: st.current_phase().id.clone(),
            minutes_left: st.round_minutes_left(now),
            decision_phase_started: decision_started(&st.round, st.phase_idx),
        },
    })
}

/// Runs a state update off the voice path. The result is bounded against the state as it is when the reply
/// arrives (another update may have landed meanwhile) and shows up in the next turn's note.
pub fn spawn_update(
    llm: Arc<dyn LlmApi>,
    catalog: Arc<Catalog>,
    session: Arc<Mutex<SessionState>>,
    job: UpdateJob,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let started = Instant::now();
        let Some(template) = catalog.prompt("meeting-state") else {
            tracing::warn!("content has no prompts/meeting-state.md; meeting state not updated");
            return;
        };
        let req = build_update_request(template, &job.state, &job.exchange, &job.ctx);
        let raw = match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            fetch_update(llm.as_ref(), &req),
        )
        .await
        {
            Ok(Ok(raw)) => raw,
            Ok(Err(e)) => {
                tracing::warn!(error = %format!("{e:#}"), "meeting state update failed");
                return;
            }
            Err(_) => {
                tracing::warn!("meeting state update timed out");
                return;
            }
        };
        let mut st = session.lock().await;
        let session_id = st.id.clone();
        if let Some(current) = st.meeting.as_mut() {
            *current = apply_update(
                current,
                &raw,
                &speakers(&job.exchange),
                job.ctx.decision_phase_started,
            );
            tracing::info!(
                session_id = %session_id,
                update_ms = started.elapsed().as_millis() as u64,
                outcome = current.decision.outcome.as_str(),
                next = current.next_speaker.as_deref().unwrap_or(""),
                "meeting state updated"
            );
        }
    })
}
