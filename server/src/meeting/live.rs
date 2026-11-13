//! The meeting inside a live session: each attendee's stable prompt (`content/prompts/round-meeting.md`), the part of
//! the per-turn note that carries this attendee's hidden state and the chair's time rules, and the background state
//! update after each user turn.
//!
//! Each attendee sees only its own stance and concerns. Other attendees' lines reach it as "Name said: ..." (see
//! `orchestrator::prompt::perspective`), never as its own turns.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use anyhow::anyhow;
use futures::future::BoxFuture;
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

use super::state::{
    AttendeeState, MeetingState, UpdateContext, apply_update, build_update_request,
    decision_if_asked, fetch_update, stance_words,
};
use super::{ConcernStatus, data_block, data_rule};
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
        context.push(format!("Notes from the candidate: {trimmed}"));
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
        ("meeting.user_name", "the candidate".into()),
        ("meeting.user_role", meeting.user_role.clone()),
        ("meeting.goal", data_block("user_facts", &meeting.goal)),
        (
            "meeting.context",
            if context.is_empty() {
                "none given".into()
            } else {
                data_block("user_facts", &context.join("\n"))
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
            meeting
                .chair
                .clone()
                .unwrap_or_else(|| "the candidate".into()),
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
    // Names, roles, cares, objections, notes and the title are typed by the user: none of them may carry a
    // director-only marker. The phase script is ours and keeps its markers.
    let vars: HashMap<&str, String> = vars
        .into_iter()
        .map(|(k, v)| match k {
            "phases_script" => (k, v),
            _ => (k, super::no_markers(&v)),
        })
        .collect();

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
    parts.push(data_rule(&["user_facts"]));
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
            "The candidate contradicted their own facts: {c}. If it bears on your concerns, point it out briefly."
        ));
    }
    if meeting.ask_made {
        if !meeting.ask_text.is_empty() {
            notes.push(format!(
                "The candidate has made the ask: \"{}\".",
                meeting.ask_text
            ));
        }
    } else if !meeting.user_chairs
        && (clock.decision_started || clock.remaining_s < DECISION_SECONDS)
    {
        notes.push("The candidate has not made a clear ask yet.".into());
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
                "If the candidate's last words were meant for {}, say one short line and hand over to {} with their first question in their own voice{}.",
                next.name,
                named(next),
                if instruction.is_empty() { String::new() } else { format!(", built on this: {instruction}") }
            ));
        } else {
            notes.push(format!(
                "The app picked {} to speak next{}. Unless you must answer the candidate first, give them the floor: one short line that names them, then hand over to {} with their first question, in their voice, under twenty five words.",
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
        // The user's newest words are not judged yet (the state follows confirmed turns), so when no ask is on
        // record the decision is given for the case that those words were the ask.
        let if_asked;
        let (d, lead) = if meeting.ask_made {
            (&meeting.decision, "If you are asked for a decision, it is")
        } else {
            if_asked = decision_if_asked(meeting, clock.decision_started);
            (
                &if_asked,
                "If the candidate's last words were a clear ask for a decision, your decision is",
            )
        };
        let mut line = format!(
            "{lead}: {}. Reason: {}",
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
        if !meeting.ask_made {
            line.push_str(if meeting.user_chairs {
                " If they have not asked yet, answer as yourself and do not decide."
            } else {
                " If they have not said what they want, do not decide yet."
            });
        }
        notes.push(line);
    }

    // Who runs the meeting.
    let mut time_line = String::new();
    if meeting.user_chairs {
        notes.push(
            "The candidate runs this meeting. Never welcome anyone, keep time, move the agenda, ask what they want from you, or push for a decision. Answer and push back as yourself."
                .into(),
        );
        if is_approver {
            notes.push(
                "Give your decision only when the candidate asks for one or for your agreement."
                    .into(),
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

/// How long a decision turn waits for an update still running.
pub const DECISION_WAIT: Duration = Duration::from_millis(1500);
/// How long the end of a session waits for the last update.
pub const DRAIN_WAIT: Duration = Duration::from_secs(4);
/// The longest one state update may take.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(20);
/// The most turns one update judges (several confirmed turns can be judged together).
const MAX_EXCHANGE_TURNS: usize = 10;

/// Runs a spawned task inside the caller's context, e.g. the usage ledger's session scope:
/// `|session_id, fut| Box::pin(usage::LLM_SESSION.scope(uuid, fut))`.
pub type TaskScope =
    Arc<dyn Fn(String, BoxFuture<'static, ()>) -> BoxFuture<'static, ()> + Send + Sync>;

/// The background state updates of one session. One runs at a time; requests made while one runs are coalesced
/// into the next, which judges every confirmed turn since the last applied update. Each run carries a sequence
/// number; a result is discarded when the state moved on under it or the session closed.
#[derive(Debug, Default)]
pub struct Updates {
    /// Sequence number of the newest request (one per confirmed user turn).
    pub requested: u64,
    /// Requests up to this number are done (applied, discarded or failed).
    pub finished: u64,
    /// The run in flight.
    pub in_flight: Option<u64>,
    /// Turns up to here (`SessionState::turns[..confirmed_turns]`) are confirmed: their replies were committed.
    /// Only confirmed turns are judged.
    pub confirmed_turns: usize,
    /// Per user turn (index into `SessionState::turns`): how much of its text (bytes) has been judged. Words added
    /// to a turn after it was judged are judged in the next run.
    pub judged_len: HashMap<usize, usize>,
    /// No more runs; late results are dropped.
    pub closed: bool,
    pub wake: Arc<Notify>,
    pub runner: Option<JoinHandle<()>>,
    /// Results applied and discarded (stale), for tests and logs.
    pub applied: u64,
    pub discarded: u64,
}

impl Updates {
    /// A user turn was confirmed: `confirmed_turns` is `SessionState::turns.len()` right after its reply was
    /// committed. Judge it (soon).
    pub fn request(&mut self, confirmed_turns: usize) {
        if self.closed {
            return;
        }
        self.confirmed_turns = self.confirmed_turns.max(confirmed_turns);
        self.requested += 1;
        self.wake.notify_one();
    }

    /// Nothing is running or waiting, or nothing ever will (no runner, or it stopped).
    pub fn settled(&self) -> bool {
        let runner_gone = self.runner.as_ref().is_none_or(|h| h.is_finished());
        self.closed || runner_gone || (self.in_flight.is_none() && self.finished >= self.requested)
    }

    /// Stops the runner; results still in flight are dropped.
    pub fn close(&mut self) {
        self.closed = true;
        self.wake.notify_one();
        if let Some(h) = self.runner.take() {
            h.abort();
        }
    }
}

impl Drop for Updates {
    fn drop(&mut self) {
        self.close();
    }
}

/// One state update: what it judges and the state it was built on.
#[derive(Clone, Debug)]
pub struct UpdateJob {
    pub seq: u64,
    pub state: MeetingState,
    pub exchange: Vec<Turn>,
    pub ctx: UpdateContext,
    /// The user turns it judges and their text length then, recorded in `judged_len` once applied.
    pub judged: Vec<(usize, usize)>,
    /// `MeetingState::updates` when built; a result for another value is stale.
    pub base_updates: u32,
}

/// The next update: every confirmed user turn not judged yet (or with words added since it was judged), after the
/// attendee line that came before the first of them. Turns past the confirmed boundary (speech whose reply was not
/// played yet) wait for their own confirmation. None outside meetings or when nothing waits.
pub fn next_job(st: &SessionState, seq: u64, now: Instant) -> Option<UpdateJob> {
    let meeting = st.meeting.as_ref()?;
    let u = &st.meeting_updates;
    let confirmed = u.confirmed_turns.min(st.turns.len());
    let waiting: Vec<usize> = (0..confirmed)
        .filter(|&i| {
            let t = &st.turns[i];
            t.speaker == "candidate" && t.text.len() > u.judged_len.get(&i).copied().unwrap_or(0)
        })
        .collect();
    let (&first, &last) = (waiting.first()?, waiting.last()?);
    let start = st.turns[..first]
        .iter()
        .rposition(|t| t.speaker != "candidate" && t.speaker != "app")
        .unwrap_or(first);
    let start = start.max((last + 1).saturating_sub(MAX_EXCHANGE_TURNS));
    let exchange: Vec<Turn> = st.turns[start..=last]
        .iter()
        .filter(|t| t.speaker != "app")
        .cloned()
        .collect();
    let judged = (start..=last)
        .filter(|&i| st.turns[i].speaker == "candidate")
        .map(|i| (i, st.turns[i].text.len()))
        .collect();
    Some(UpdateJob {
        seq,
        state: meeting.clone(),
        exchange,
        ctx: UpdateContext {
            model: st.live.fast_model.clone(),
            fallback_model: Some(st.live.fallback_model.clone()),
            phase_id: st.current_phase().id.clone(),
            minutes_left: st.round_minutes_left(now),
            decision_phase_started: decision_started(&st.round, st.phase_idx),
        },
        judged,
        base_updates: meeting.updates,
    })
}

/// Starts the session's update runner if it has none (idempotent). Called by the live endpoint on each turn of a
/// meeting; the commit of a confirmed user turn requests the updates (`Updates::request`).
pub fn ensure_runner(
    st: &mut SessionState,
    session: &Arc<Mutex<SessionState>>,
    llm: Arc<dyn LlmApi>,
    catalog: Arc<Catalog>,
    scope: Option<&TaskScope>,
) {
    if st.meeting.is_none() || st.meeting_updates.runner.is_some() || st.meeting_updates.closed {
        return;
    }
    let fut: BoxFuture<'static, ()> = Box::pin(run_updates(
        Arc::downgrade(session),
        st.meeting_updates.wake.clone(),
        llm,
        catalog,
    ));
    let fut = match scope {
        Some(scope) => scope(st.id.clone(), fut),
        None => fut,
    };
    st.meeting_updates.runner = Some(tokio::spawn(fut));
}

async fn run_updates(
    session: Weak<Mutex<SessionState>>,
    wake: Arc<Notify>,
    llm: Arc<dyn LlmApi>,
    catalog: Arc<Catalog>,
) {
    let Some(template) = catalog.prompt("meeting-state").map(str::to_string) else {
        tracing::warn!("content has no prompts/meeting-state.md; meeting state not updated");
        return;
    };
    loop {
        let job = {
            let Some(handle) = session.upgrade() else {
                return;
            };
            let mut st = handle.lock().await;
            let u = &st.meeting_updates;
            if u.closed {
                return;
            }
            if u.finished >= u.requested {
                None
            } else {
                let seq = u.requested;
                match next_job(&st, seq, Instant::now()) {
                    Some(job) => {
                        st.meeting_updates.in_flight = Some(seq);
                        Some(job)
                    }
                    None => {
                        st.meeting_updates.finished = seq;
                        None
                    }
                }
            }
        };
        let Some(job) = job else {
            wake.notified().await;
            continue;
        };

        let started = Instant::now();
        let req = build_update_request(&template, &job.state, &job.exchange, &job.ctx);
        let result = tokio::time::timeout(
            UPDATE_TIMEOUT,
            fetch_update(llm.as_ref(), &req, job.ctx.fallback_model.as_deref()),
        )
        .await;

        let Some(handle) = session.upgrade() else {
            return;
        };
        let mut st = handle.lock().await;
        st.meeting_updates.in_flight = None;
        if st.meeting_updates.closed {
            return;
        }
        st.meeting_updates.finished = st.meeting_updates.finished.max(job.seq);
        let session_id = st.id.clone();
        let raw = match result {
            Ok(Ok(raw)) => raw,
            Ok(Err(e)) => {
                tracing::warn!(session_id = %session_id, error = %e, "meeting state update failed");
                continue;
            }
            Err(_) => {
                tracing::warn!(session_id = %session_id, "meeting state update timed out");
                continue;
            }
        };
        let stale = st
            .meeting
            .as_ref()
            .is_none_or(|m| m.updates != job.base_updates);
        if stale {
            st.meeting_updates.discarded += 1;
            tracing::info!(session_id = %session_id, seq = job.seq, "stale meeting state update discarded");
            continue;
        }
        let decision_started = job.ctx.decision_phase_started;
        if let Some(current) = st.meeting.as_mut() {
            *current = apply_update(current, &raw, &job.exchange, decision_started);
        }
        for (i, len) in &job.judged {
            let judged = st.meeting_updates.judged_len.entry(*i).or_default();
            *judged = (*judged).max(*len);
        }
        st.meeting_updates.applied += 1;
        tracing::info!(
            session_id = %session_id,
            seq = job.seq,
            update_ms = started.elapsed().as_millis() as u64,
            "meeting state updated"
        );
        if let Some(m) = st.meeting.as_ref() {
            tracing::debug!(
                session_id = %session_id,
                outcome = m.decision.outcome.as_str(),
                next = m.next_speaker.as_deref().unwrap_or(""),
                "meeting state"
            );
        }
    }
}

/// Waits (at most `limit`) until no state update is running or waiting. True when settled.
pub async fn wait_settled(session: &Arc<Mutex<SessionState>>, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        {
            let st = session.lock().await;
            if st.meeting.is_none() || st.meeting_updates.settled() {
                return true;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Whether this panelist's turn is the one that may state or call for the decision while an update is still
/// running (then the turn waits up to `DECISION_WAIT` for it).
pub fn decision_wait_needed(st: &SessionState, panelist_id: &str, now: Instant) -> bool {
    let Some(m) = st.meeting.as_ref() else {
        return false;
    };
    if st.meeting_updates.settled() {
        return false;
    }
    let clock = Clock::of(st, now);
    let due = clock.decision_started || clock.remaining_s < DECISION_SECONDS || m.ask_made;
    let me = m.by_panelist(panelist_id).map(|a| a.name.as_str());
    let decides =
        m.approver().map(|a| a.name.as_str()) == me || (!m.user_chairs && m.chair.as_deref() == me);
    due && decides
}

/// At session end: lets the last update land (at most `limit`), then closes the runner so nothing changes the
/// final state after it is read.
pub async fn drain(session: &Arc<Mutex<SessionState>>, limit: Duration) {
    let settled = wait_settled(session, limit).await;
    let mut st = session.lock().await;
    if !settled {
        tracing::warn!(session_id = %st.id, "meeting state update still running at the end; dropped");
    }
    st.meeting_updates.close();
}
