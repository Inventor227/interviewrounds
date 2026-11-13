//! Live session state and the in-memory registry. The model history here is append-only: earlier messages are
//! never edited (prompt caching and preserved thinking both depend on it); corrections go in as new system notes.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, broadcast};

use super::markers::{EventKind, UserInput};
use super::prompt::{self, TurnDraft};
use super::tools::{self, ToolCall};
use super::{Brief, PhasePublic, RoundStateMsg, ServerEvent};
use crate::claude::{ContentBlock, Message, MessagesRequest, Role, SystemBlock};
use crate::config::Config;
use crate::content::{Catalog, Persona, Phase, RoundConfig};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Interview,
    Meeting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Junior,
    Mid,
    Senior,
    Staff,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Junior => "junior",
            Level::Mid => "mid",
            Level::Senior => "senior",
            Level::Staff => "staff",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    Warm,
    Neutral,
    Tough,
}

impl Style {
    pub fn as_str(self) -> &'static str {
        match self {
            Style::Warm => "warm",
            Style::Neutral => "neutral",
            Style::Tough => "tough",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceKind {
    Fish,
    Fake,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSettings {
    pub level: Level,
    pub style: Style,
    pub voice: VoiceKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Created,
    Live,
    Paused,
    Scoring,
    Scored,
    Failed,
    Abandoned,
}

/// Model settings for the live voice turns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveSettings {
    pub model: String,
    /// Used once when the live model fails before saying anything, and for the director.
    pub fast_model: String,
    pub effort: String,
    pub max_tokens: u32,
}

impl LiveSettings {
    pub fn from_config(cfg: &Config) -> Self {
        LiveSettings {
            model: cfg.live_model.clone(),
            fast_model: cfg.fast_model.clone(),
            effort: cfg.live_effort.clone(),
            max_tokens: 300,
        }
    }
}

/// One AI person in the round. `system` is rendered once at creation and never changes, so the prompt cache holds.
#[derive(Clone, Debug)]
pub struct Panelist {
    pub panelist_id: String,
    pub persona: Persona,
    pub seat: u8,
    /// The live call's prompt: what to say. Tool instructions are not in it (`prompt::live_view`).
    pub system: Vec<SystemBlock>,
    /// The same instructions with the tool instructions kept, for the director (`prompt::director_view`).
    pub director_system: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelSeat {
    pub panelist_id: String,
    pub persona_id: String,
}

/// Hidden meeting state; each attendee sees its own part in the per-turn note (`crate::meeting`).
pub use crate::meeting::MeetingState;

/// What is needed to start a session.
#[derive(Clone, Debug)]
pub struct NewSession {
    pub id: String,
    pub identity_id: String,
    pub mode: Mode,
    pub round_id: String,
    pub settings: SessionSettings,
    /// Empty = the round's panel: lead `p1`, second `p2`.
    pub panel: Vec<PanelSeat>,
    /// Question card id in the round's bank; None = the first card.
    pub question_id: Option<String>,
    pub meeting: Option<MeetingState>,
}

/// One line of the human-readable turn log (for the transcript, scoring and resume).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    /// `candidate`, `app` (event markers) or a panelist id.
    pub speaker: String,
    pub text: String,
    /// Milliseconds since round start, pauses excluded.
    pub at_ms: u64,
    #[serde(default)]
    pub interrupted: bool,
    /// For an interrupted agent turn: the part the candidate heard.
    #[serde(default)]
    pub heard: Option<String>,
}

/// The candidate's current utterance as recorded for one panelist, until that panelist's Fish transcript shows a
/// reply to it. One rule keeps every word in the history and the turn log once: the words already committed in
/// earlier (frozen) messages are `base`; on each request the utterance minus `base` goes into the trailing message
/// (`tail`), which is replaced while it is the last message in the history and frozen into `base` once anything
/// follows it. The turn log keeps the same rule with its own frozen words (`line_frozen`, `line_tail`), because a
/// line and a message stop being last at different times (a typed event follows only the line, a reply committed
/// late follows only the message).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Unanswered {
    /// Words of this utterance in frozen user messages (nothing in them is rewritten again).
    pub base: String,
    /// Words of this utterance in the trailing user message.
    pub tail: String,
    /// That trailing message, while it is the last one in the history.
    pub tail_idx: Option<usize>,
    /// Words of this utterance in turn-log lines that are no longer rewritten.
    pub line_frozen: String,
    /// Words of this utterance in the candidate line at `line_idx`.
    pub line_tail: String,
    /// The candidate line in the turn log that ends with `line_tail`, while it is the last line.
    pub line_idx: Option<usize>,
    /// That line's text before `line_tail`.
    pub line_base: String,
    /// The app event already logged for this utterance (Fish repeats it on every request).
    pub event: Option<EventKind>,
    /// A reply to it was committed (e.g. from the browser's playback report). Kept until Fish's transcript shows
    /// that reply: when Fish dropped it (a cut after a word), its next requests repeat these words.
    pub answered: bool,
}

impl Unanswered {
    /// Everything recorded for this utterance.
    pub fn text(&self) -> String {
        join_words(&self.base, &self.tail)
    }

    /// The candidate line can no longer be rewritten (something follows it): its words are frozen.
    fn freeze_line(&mut self) {
        self.line_frozen = join_words(&self.line_frozen, &self.line_tail);
        self.line_tail.clear();
        self.line_idx = None;
        self.line_base.clear();
    }
}

fn join_words(a: &str, b: &str) -> String {
    match (a.trim().is_empty(), b.trim().is_empty()) {
        (true, _) => b.trim().to_string(),
        (_, true) => a.trim().to_string(),
        _ => format!("{} {}", a.trim(), b.trim()),
    }
}

/// A reply that was spoken (or streamed) but is not in the history yet, because the voice platform may not have
/// played it: Fish starts speculative replies on interim transcripts and throws most of them away, a request can be
/// cut off mid-stream, and the hold line can be spoken while another turn runs. The user message it answers is
/// already recorded (always, at turn start). The reply is committed when playback is confirmed (the browser's
/// `voice.spoken` report through `confirm_spoken`, or the panelist's next Fish request showing it in the transcript)
/// and dropped when that panelist's next request shows it was not played. Parked replies are kept per panelist.
#[derive(Clone, Debug)]
pub struct Provisional {
    pub id: u64,
    pub panelist_id: String,
    pub input: UserInput,
    /// The draft the reply was made from (its note goes in with the reply); None = draft again when committing.
    pub draft: Option<TurnDraft>,
    /// The assistant content to record.
    pub reply: Vec<ContentBlock>,
    /// What was streamed to the voice.
    pub spoken: String,
    /// The director's tool calls, when they arrive before the reply is committed; applied with the commit.
    pub tool_calls: Vec<ToolCall>,
    /// When the reply was spoken (the turn log time, whenever it is committed).
    pub parked_at: Instant,
    /// The director request for this line. It is sent only once the reply is confirmed as played (a draft the
    /// voice platform throws away never costs a director call); see `SessionState::take_director_jobs`.
    pub director: Option<MessagesRequest>,
}

/// A director call to run now: its reply was committed (`SessionState::take_director_jobs`).
#[derive(Clone, Debug)]
pub struct DirectorJob {
    pub turn_id: u64,
    pub panelist_id: String,
    pub req: MessagesRequest,
}

/// Everything a finished turn adds.
#[derive(Debug)]
pub struct TurnCommit {
    pub draft: TurnDraft,
    /// The final assistant content, verbatim (thinking and text).
    pub reply: Vec<ContentBlock>,
    /// What was actually streamed to the voice (filtered).
    pub spoken: String,
    /// Tool calls to apply with the commit (the director's, when known already).
    pub tool_calls: Vec<ToolCall>,
    /// The reply was the pre-drafted hand-over line.
    pub handover_line_used: bool,
}

pub struct SessionState {
    pub id: String,
    pub identity_id: String,
    pub mode: Mode,
    pub round: RoundConfig,
    pub settings: SessionSettings,
    pub panel: Vec<Panelist>,
    /// Panelist id holding the floor.
    pub floor: String,
    pub phase_idx: usize,
    pub started_at: Instant,
    pub paused_total_ms: u64,
    pub paused_since: Option<Instant>,
    /// Append-only model history shared by the panel.
    pub history: Vec<Message>,
    pub turns: Vec<Turn>,
    /// Board summary from the board engine; goes into each turn note, never into the system prompt.
    pub board_text: String,
    pub meeting: Option<MeetingState>,
    pub hints_given: u8,
    pub hint_max_level: u8,
    /// What each panelist last streamed to the voice (filtered), to detect interruptions.
    pub last_agent_text: HashMap<String, String>,
    pub status: SessionStatus,
    pub brief: Option<Brief>,
    pub closing_line: Option<String>,
    pub live: LiveSettings,
    pub question: serde_json::Value,
    /// Pre-drafted first lines for panelists who were handed the floor.
    pub pending_handover: HashMap<String, String>,
    /// Server notes for the next turn (resume, meeting changes); consumed when that turn commits.
    pub pending_notes: Vec<String>,
    /// Per panelist: what the candidate heard of the last line, recomputed from Fish's transcript each request.
    pub heard_note: HashMap<String, String>,
    pub two_minute_warned: bool,
    pub last_speaker: Option<String>,
    pub turn_note_template: String,
    pub events: broadcast::Sender<ServerEvent>,
    /// Serialises turns of one session; held across a whole streamed turn, separately from the state lock.
    pub turn_lock: Arc<Mutex<()>>,
    /// Spoken turns waiting for the voice platform to confirm them (oldest first).
    pub provisional: Vec<Provisional>,
    /// Ids of recently committed turns (a director that finishes after the commit applies its calls then).
    pub recent_commits: std::collections::VecDeque<u64>,
    pub next_turn_id: u64,
    /// Playback reported before its reply finished streaming (the voice starts speaking from the first words), per
    /// panelist: words heard, when. The reply is committed as soon as it is parked.
    pub early_confirm: HashMap<String, (String, Instant)>,
    /// Per panelist: the candidate's speech already recorded since this panelist's last reply that Fish's own
    /// transcript shows. Fish repeats (and may revise) it in its next request, so it is revised in place or only the
    /// new words are added, never recorded twice.
    pub unanswered: HashMap<String, Unanswered>,
    /// Director calls made in this session (drafts included), for the log.
    pub director_calls: u32,
    /// Dev voice spike only: this many next replies are sent empty (to observe the voice platform).
    pub dev_empty_replies: u8,
    /// Director calls of committed replies, waiting for the caller to send them.
    pub director_jobs: Vec<DirectorJob>,
    /// Replies to the candidate's speech committed so far: each one closes a candidate utterance (the board
    /// Scribe runs after it).
    pub speech_commits: u64,
    /// Which panelist each assistant message and system note of `history` belongs to (by index). With two or more
    /// panelists, each one sees the others' lines as "Name said: ..." user-side notes, never as its own turns, and
    /// never sees their notes.
    pub message_owners: HashMap<usize, String>,
    /// Background meeting state updates: one per confirmed user turn, one at a time.
    pub meeting_updates: crate::meeting::live::Updates,
}

impl SessionState {
    pub fn new(
        spec: NewSession,
        catalog: &Catalog,
        live: LiveSettings,
        now: Instant,
    ) -> anyhow::Result<SessionState> {
        let round = catalog
            .round(&spec.round_id)
            .ok_or_else(|| anyhow!("unknown round {}", spec.round_id))?
            .clone();
        let mut meeting = spec.meeting.clone();
        let seats = if let (Mode::Meeting, Some(m), true) =
            (spec.mode, meeting.as_ref(), spec.panel.is_empty())
        {
            // A meeting's panel is its attendees, in plan order.
            m.attendees
                .iter()
                .map(|a| PanelSeat {
                    panelist_id: a.panelist_id.clone(),
                    persona_id: a.persona_id.clone(),
                })
                .collect()
        } else if spec.panel.is_empty() {
            let mut seats = vec![PanelSeat {
                panelist_id: "p1".into(),
                persona_id: round.panel.lead.clone(),
            }];
            if let Some(second) = &round.panel.second {
                seats.push(PanelSeat {
                    panelist_id: "p2".into(),
                    persona_id: second.clone(),
                });
            }
            seats
        } else {
            spec.panel.clone()
        };
        if let Some(m) = meeting.as_mut() {
            let ids: Vec<String> = seats.iter().map(|s| s.panelist_id.clone()).collect();
            m.set_panelists(&ids);
        }
        let voices: Vec<Persona> = seats
            .iter()
            .map(|s| {
                catalog
                    .persona(&s.persona_id)
                    .cloned()
                    .ok_or_else(|| anyhow!("unknown persona {}", s.persona_id))
            })
            .collect::<anyhow::Result<_>>()?;
        // Meeting attendees borrow a persona's voice and look but keep their own name and role.
        let personas: Vec<Persona> = match meeting.as_ref().filter(|_| spec.mode == Mode::Meeting) {
            Some(m) => voices
                .iter()
                .zip(&m.attendees)
                .map(|(p, a)| Persona {
                    display_name: a.name.clone(),
                    title: a.role.clone(),
                    ..p.clone()
                })
                .collect(),
            None => voices.clone(),
        };
        let question = catalog
            .bank_card(&round.question_pool, spec.question_id.as_deref())
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        let panel_view: Vec<(String, &Persona)> = seats
            .iter()
            .zip(&personas)
            .map(|(s, p)| (s.panelist_id.clone(), p))
            .collect();
        let mut panel = Vec::with_capacity(seats.len());
        for (seat, (s, persona)) in seats.iter().zip(&personas).enumerate() {
            let text = match meeting.as_ref().filter(|_| spec.mode == Mode::Meeting) {
                Some(m) => {
                    crate::meeting::live::render_system(catalog, &round, m, seat, &voices[seat])
                }
                None => prompt::render_system(
                    catalog,
                    &round,
                    persona,
                    seat,
                    &panel_view,
                    &question,
                    &spec.settings,
                ),
            }
            .with_context(|| format!("rendering the prompt for {}", s.panelist_id))?;
            panel.push(Panelist {
                panelist_id: s.panelist_id.clone(),
                persona: persona.clone(),
                seat: seat as u8,
                system: vec![SystemBlock::cached(prompt::live_view(&text))],
                director_system: prompt::director_view(&text),
            });
        }
        let turn_note_template = catalog
            .prompt("house-rules.turn-note")
            .unwrap_or(prompt::DEFAULT_TURN_NOTE)
            .to_string();
        let (events, _) = broadcast::channel(64);
        // A meeting opens with the plan's line, spoken word for word by the chair (or, when the user chairs, the
        // decision maker) on [event: start], with no model call.
        let mut pending_handover = HashMap::new();
        let mut floor = panel[0].panelist_id.clone();
        if let Some(opener) = meeting
            .as_ref()
            .filter(|_| spec.mode == Mode::Meeting)
            .and_then(|m| {
                m.opening_speaker()
                    .map(|a| (a.panelist_id.clone(), m.opening_line.clone()))
            })
            .filter(|(pid, _)| panel.iter().any(|p| &p.panelist_id == pid))
        {
            floor = opener.0.clone();
            if !opener.1.trim().is_empty() {
                pending_handover.insert(opener.0, opener.1);
            }
        }
        Ok(SessionState {
            id: spec.id,
            identity_id: spec.identity_id,
            mode: spec.mode,
            floor,
            round,
            settings: spec.settings,
            panel,
            phase_idx: 0,
            started_at: now,
            paused_total_ms: 0,
            paused_since: None,
            history: Vec::new(),
            turns: Vec::new(),
            board_text: String::new(),
            meeting,
            hints_given: 0,
            hint_max_level: 0,
            last_agent_text: HashMap::new(),
            status: SessionStatus::Live,
            brief: None,
            closing_line: None,
            live,
            question,
            pending_handover,
            pending_notes: Vec::new(),
            heard_note: HashMap::new(),
            two_minute_warned: false,
            last_speaker: None,
            turn_note_template,
            events,
            turn_lock: Arc::new(Mutex::new(())),
            provisional: Vec::new(),
            recent_commits: std::collections::VecDeque::new(),
            next_turn_id: 1,
            early_confirm: HashMap::new(),
            unanswered: HashMap::new(),
            director_calls: 0,
            dev_empty_replies: 0,
            director_jobs: Vec::new(),
            speech_commits: 0,
            message_owners: HashMap::new(),
            meeting_updates: Default::default(),
        })
    }

    /// Appends to the history, remembering which panelist an assistant message or system note belongs to. Every
    /// assistant message must go through here (R28 perspective).
    pub fn push_message(&mut self, panelist_id: &str, message: Message) {
        if matches!(message.role, Role::Assistant | Role::System) {
            self.message_owners
                .insert(self.history.len(), panelist_id.to_string());
        }
        self.history.push(message);
    }

    /// Meetings the user chairs: no attendee moves the phases, so they follow the schedule.
    /// When the phase moves, the browser gets a `round.state` (returned and broadcast).
    pub fn sync_meeting_phase(&mut self, now: Instant) -> Option<ServerEvent> {
        if !self.meeting.as_ref().is_some_and(|m| m.user_chairs) {
            return None;
        }
        let elapsed_min = self.elapsed_ms(now) as f64 / 60_000.0;
        let due = crate::meeting::live::scheduled_phase(&self.round, elapsed_min);
        if due <= self.phase_idx {
            return None;
        }
        self.phase_idx = due;
        let ev = ServerEvent::RoundState(self.round_state(now));
        let _ = self.events.send(ev.clone());
        Some(ev)
    }

    pub fn panelist(&self, id: &str) -> Option<&Panelist> {
        self.panel.iter().find(|p| p.panelist_id == id)
    }

    /// The requested panelist when known, else whoever holds the floor.
    pub fn resolve_panelist(&self, id: Option<&str>) -> String {
        match id {
            Some(id) if self.panelist(id).is_some() => id.to_string(),
            _ => self.floor.clone(),
        }
    }

    pub fn display_name(&self, panelist_id: &str) -> String {
        self.panelist(panelist_id)
            .map(|p| p.persona.display_name.clone())
            .unwrap_or_else(|| panelist_id.to_string())
    }

    /// Round time so far, pauses excluded.
    pub fn elapsed_ms(&self, now: Instant) -> u64 {
        let total = now.saturating_duration_since(self.started_at).as_millis() as u64;
        let paused = self.paused_total_ms
            + self
                .paused_since
                .map(|p| now.saturating_duration_since(p).as_millis() as u64)
                .unwrap_or(0);
        total.saturating_sub(paused)
    }

    pub fn current_phase(&self) -> &Phase {
        let i = self
            .phase_idx
            .min(self.round.phases.len().saturating_sub(1));
        &self.round.phases[i]
    }

    /// Minutes left in the current phase on the round's schedule (negative once its boundary has passed).
    pub fn phase_minutes_left(&self, now: Instant) -> f64 {
        let end: f64 = self
            .round
            .phases
            .iter()
            .take(self.phase_idx + 1)
            .map(|p| p.minutes)
            .sum();
        end - self.elapsed_ms(now) as f64 / 60_000.0
    }

    pub fn round_minutes_left(&self, now: Instant) -> f64 {
        self.round.target_minutes - self.elapsed_ms(now) as f64 / 60_000.0
    }

    /// `round.state` for the browser.
    pub fn round_state(&self, now: Instant) -> RoundStateMsg {
        let phase = self.current_phase();
        RoundStateMsg {
            status: self.status,
            phase_id: phase.id.clone(),
            phase_index: self.phase_idx,
            phases: self
                .round
                .phases
                .iter()
                .map(|p| PhasePublic {
                    id: p.id.clone(),
                    title: p.title.clone(),
                    minutes: p.minutes,
                })
                .collect(),
            elapsed_s: self.elapsed_ms(now) / 1000,
            remaining_s: (self.round_minutes_left(now).max(0.0) * 60.0) as u64,
            phase_remaining_s: (self.phase_minutes_left(now).max(0.0) * 60.0) as u64,
            brief: self.brief.clone().unwrap_or_default(),
            floor: self.floor.clone(),
        }
    }

    /// Compares Fish's record of this panelist's last line with what we streamed. Fish keeps only the words
    /// actually spoken, so a shorter prefix means the candidate cut in. Sets or clears `heard_note[panelist]`.
    pub fn observe_fish_transcript(&mut self, panelist_id: &str, fish_last: Option<&str>) {
        self.heard_note.remove(panelist_id);
        let (Some(fish), Some(ours)) = (fish_last, self.last_agent_text.get(panelist_id)) else {
            return;
        };
        match compare_spoken(ours, fish) {
            Heard::All | Heard::Unknown => {
                let previous = self
                    .turns
                    .iter()
                    .rev()
                    .filter(|t| t.speaker == panelist_id)
                    .nth(1)
                    .map(|t| t.text.as_str());
                let undelivered = matches!(compare_spoken(ours, fish), Heard::Unknown)
                    && previous.is_some_and(|p| matches!(compare_spoken(p, fish), Heard::All));
                if undelivered {
                    self.heard_note.insert(
                        panelist_id.to_string(),
                        format!(
                            "Your last line was never played to the candidate: they did not hear \"{}\". \
                             Do not assume it landed.",
                            ours.trim()
                        ),
                    );
                }
            }
            Heard::Part => {
                self.heard_note.insert(
                    panelist_id.to_string(),
                    format!(
                        "The candidate cut in while you were speaking. They heard only: \"{}\". \
                         The rest of your last line was not heard; do not assume it landed.",
                        fish.trim()
                    ),
                );
                if let Some(turn) = self
                    .turns
                    .iter_mut()
                    .rev()
                    .find(|t| t.speaker == panelist_id)
                {
                    turn.interrupted = true;
                    turn.heard = Some(fish.trim().to_string());
                }
            }
        }
    }

    pub fn new_turn_id(&mut self) -> u64 {
        let id = self.next_turn_id;
        self.next_turn_id += 1;
        id
    }

    /// Commits a turn now and remembers its id.
    pub fn commit_now(&mut self, id: u64, commit: TurnCommit, now: Instant) -> Vec<ServerEvent> {
        let events = self.commit_turn(commit, now);
        self.recent_commits.push_back(id);
        while self.recent_commits.len() > 32 {
            self.recent_commits.pop_front();
        }
        events
    }

    /// Forgets the recorded speech once Fish's transcript (`fish_last`) shows this panelist's committed reply: the
    /// words Fish sends next are a new utterance. Run after `resolve_provisional`.
    pub fn sync_unanswered(&mut self, panelist_id: &str, fish_last: Option<&str>) {
        let shown = match (fish_last, self.last_agent_text.get(panelist_id)) {
            (Some(fish), Some(last)) => compare_spoken(last, fish) != Heard::Unknown,
            _ => false,
        };
        if shown && self.unanswered.get(panelist_id).is_some_and(|u| u.answered) {
            self.unanswered.remove(panelist_id);
        }
    }

    /// Records the turn's user message now (the candidate's words are never lost, whatever happens to the reply)
    /// and leaves only the note in the draft. `draft.input` carries the whole utterance Fish sent; see `Unanswered`
    /// for the one rule that keeps each word once.
    pub fn record_user(&mut self, draft: &mut TurnDraft, now: Instant) {
        if draft.user_committed || draft.messages.is_empty() {
            return;
        }
        let mut user = draft.messages.remove(0);
        draft.user_committed = true;
        user.content
            .iter_mut()
            .for_each(|c| c.set_cache_control(None));
        let panelist = draft.panelist_id.clone();
        let at_ms = self.elapsed_ms(now);
        let event = draft.input.event();

        let Some(speech) = draft.input.speech().map(str::to_string) else {
            // A typed app event on its own: always its own message (anything recorded before it is now frozen).
            self.history.push(user);
            self.push_app_turn(event, at_ms);
            return;
        };

        let mut u = self.unanswered.remove(&panelist).unwrap_or_default();
        // Interim revisions keep the start of the utterance; speech that starts differently is a new utterance
        // (the previous one was answered by a reply we never saw committed).
        if !u.answered && !u.text().is_empty() && !same_start(&u.text(), &speech) {
            u = Unanswered::default();
        }
        // Anything after the trailing message (a reply, another panelist's turn) freezes it.
        let last_idx = self.history.len().checked_sub(1);
        if u.tail_idx.is_some() && u.tail_idx != last_idx {
            u.base = u.text();
            u.tail.clear();
            u.tail_idx = None;
        }
        if u.line_idx.is_some() && u.line_idx != self.turns.len().checked_sub(1) {
            u.freeze_line();
        }

        let words = after_common_prefix(&u.base, &speech);
        let new_event = event.filter(|k| u.event != Some(*k));
        let with_marker = |w: &str| match event {
            Some(k) if w.is_empty() => k.marker().to_string(),
            Some(k) => format!("{w}\n{}", k.marker()),
            None => w.to_string(),
        };
        // Pending tool results only exist while the history ends on an assistant turn, i.e. when a new message
        // is pushed below; a replaced trailing message keeps its own blocks.
        user.content
            .retain(|b| !matches!(b, ContentBlock::Text { .. }));
        match u.tail_idx {
            // A transcript that shrank back into the frozen words leaves the trailing message as it is.
            Some(idx) if !with_marker(&words).trim().is_empty() => {
                let msg = &mut self.history[idx];
                msg.content
                    .retain(|b| !matches!(b, ContentBlock::Text { .. }));
                msg.content.push(ContentBlock::text(with_marker(&words)));
                u.tail = words.clone();
            }
            Some(_) => {}
            None => {
                let ends_on_user = self.history.last().is_some_and(|m| m.role == Role::User);
                if !words.trim().is_empty() || new_event.is_some() || !ends_on_user {
                    // With nothing new and the history ending on an assistant turn, the note still needs a user
                    // message before it: the words are repeated there (rare), never in the turn log.
                    let text = if words.trim().is_empty() && new_event.is_none() {
                        tracing::info!(session_id = %self.id, panelist_id = %panelist, "repeated words recorded again to keep the history valid");
                        speech.clone()
                    } else {
                        with_marker(&words)
                    };
                    user.content.push(ContentBlock::text(text));
                    self.history.push(user);
                    if !words.trim().is_empty() {
                        u.tail = words.clone();
                        u.tail_idx = Some(self.history.len() - 1);
                    }
                }
            }
        }

        // The turn log follows the same rule, measured against its own frozen words.
        let line_words = after_common_prefix(&u.line_frozen, &speech);
        if !line_words.trim().is_empty() {
            match u.line_idx.and_then(|i| self.turns.get_mut(i)) {
                Some(line) if line.speaker == "candidate" => {
                    line.text = join_words(&u.line_base, &line_words);
                }
                _ => {
                    let (idx, line_base) = self.push_candidate_words(&line_words, at_ms);
                    u.line_idx = Some(idx);
                    u.line_base = line_base;
                }
            }
            u.line_tail = line_words;
        }
        if let Some(k) = new_event {
            self.push_app_turn(Some(k), at_ms);
            u.event = Some(k);
            // The app line follows the candidate line, so it can no longer grow in place.
            u.freeze_line();
        }
        self.unanswered.insert(panelist, u);
    }

    /// Adds candidate words to the turn log (joining the candidate's line when it is the last entry); returns the
    /// line's index and its text before these words.
    fn push_candidate_words(&mut self, words: &str, at_ms: u64) -> (usize, String) {
        if let Some(t) = self.turns.last_mut()
            && t.speaker == "candidate"
        {
            let before = t.text.clone();
            t.text = join_words(&before, words);
            return (self.turns.len() - 1, before);
        }
        self.turns.push(Turn {
            speaker: "candidate".into(),
            text: words.trim().to_string(),
            at_ms,
            interrupted: false,
            heard: None,
        });
        (self.turns.len() - 1, String::new())
    }

    fn push_app_turn(&mut self, event: Option<super::markers::EventKind>, at_ms: u64) {
        if let Some(kind) = event {
            self.turns.push(Turn {
                speaker: "app".into(),
                text: kind.marker().to_string(),
                at_ms,
                interrupted: false,
                heard: None,
            });
        }
    }

    /// Parks a spoken reply until the voice platform confirms it (at once, if playback was already reported).
    pub fn park(&mut self, p: Provisional) -> Vec<ServerEvent> {
        if let Some((heard, at)) = self.early_confirm.remove(&p.panelist_id) {
            let fresh = at.elapsed() < std::time::Duration::from_secs(15);
            if fresh && compare_spoken(&p.spoken, &heard) != Heard::Unknown {
                tracing::info!(session_id = %self.id, panelist_id = %p.panelist_id, turn_id = p.id, "reply confirmed by playback before it finished");
                return self.commit_parked(p, None);
            }
            if fresh {
                // About another reply of this panelist (still streaming): keep it for that one.
                self.early_confirm
                    .insert(p.panelist_id.clone(), (heard, at));
            }
        }
        self.provisional.push(p);
        Vec::new()
    }

    /// Director calls whose replies were committed since the last call; the caller sends them
    /// (`oai::spawn_directors`).
    pub fn take_director_jobs(&mut self) -> Vec<DirectorJob> {
        std::mem::take(&mut self.director_jobs)
    }

    fn commit_parked(&mut self, p: Provisional, heard: Option<&str>) -> Vec<ServerEvent> {
        if let Some(req) = p.director.clone() {
            self.director_jobs.push(DirectorJob {
                turn_id: p.id,
                panelist_id: p.panelist_id.clone(),
                req,
            });
        }
        let draft = match p.draft {
            Some(d) => d,
            None => {
                let mut d = prompt::draft_turn(self, &p.panelist_id, &p.input, p.parked_at);
                d.messages.retain(|m| m.role != Role::User);
                d.user_committed = true;
                d
            }
        };
        let events = self.commit_now(
            p.id,
            TurnCommit {
                draft,
                reply: p.reply,
                spoken: p.spoken.clone(),
                tool_calls: p.tool_calls,
                handover_line_used: false,
            },
            p.parked_at,
        );
        if let Some(heard) = heard
            && let Some(turn) = self
                .turns
                .iter_mut()
                .rev()
                .find(|t| t.speaker == p.panelist_id)
        {
            turn.interrupted = true;
            turn.heard = Some(heard.trim().to_string());
        }
        events
    }

    /// Settles this panelist's parked replies against its Fish session's transcript (`fish_last`: the newest
    /// assistant message there). The newest parked reply Fish has (all of it, or the start of it, meaning the
    /// candidate cut in) is committed, marked interrupted when only part was played. Replies Fish does not have were
    /// drafts it threw away and are dropped. Other panelists' parked replies are never touched (their own sessions
    /// settle them).
    pub fn resolve_provisional(
        &mut self,
        panelist_id: &str,
        fish_last: Option<&str>,
    ) -> Vec<ServerEvent> {
        let (mine, others): (Vec<Provisional>, Vec<Provisional>) =
            std::mem::take(&mut self.provisional)
                .into_iter()
                .partition(|p| p.panelist_id == panelist_id);
        self.provisional = others;
        if mine.is_empty() {
            return Vec::new();
        }
        // Fish's newest line is the one already committed: nothing parked was played.
        let already = fish_last.is_some_and(|fish| {
            self.last_agent_text
                .get(panelist_id)
                .is_some_and(|last| compare_spoken(last, fish) == Heard::All)
        });
        let mut played = None;
        let n = mine.len();
        if let (Some(fish), false) = (fish_last, already) {
            for p in mine.into_iter().rev() {
                if played.is_none() && compare_spoken(&p.spoken, fish) != Heard::Unknown {
                    played = Some(p);
                }
            }
        }
        let dropped = n - usize::from(played.is_some());
        if dropped > 0 {
            tracing::info!(session_id = %self.id, panelist_id = %panelist_id, dropped, "unplayed replies dropped");
        }
        match (played, fish_last) {
            (Some(p), Some(fish)) => {
                let part = compare_spoken(&p.spoken, fish) == Heard::Part;
                tracing::info!(session_id = %self.id, panelist_id = %p.panelist_id, turn_id = p.id, interrupted = part, "played reply committed");
                self.commit_parked(p, part.then_some(fish))
            }
            _ => Vec::new(),
        }
    }

    /// The browser reports that `panelist_id`'s voice started playing `text_prefix` (the reply's text so far,
    /// `voice.spoken`). The matching parked reply is committed at once and its tool actions run now (brief card,
    /// phase, hint, hand-over, end), so they happen while the line plays; the panelist's older parked replies are
    /// dropped. A report that arrives before the reply finished streaming is kept and applied when it is parked.
    /// Returns the events the actions produced (also broadcast on the session's event channel).
    pub fn confirm_spoken(&mut self, panelist_id: &str, text_prefix: &str) -> Vec<ServerEvent> {
        let Some(i) = self.provisional.iter().rposition(|p| {
            p.panelist_id == panelist_id && compare_spoken(&p.spoken, text_prefix) != Heard::Unknown
        }) else {
            // Unless it is about the line already committed (a reply to a typed event, or a repeat report).
            let committed = self
                .last_agent_text
                .get(panelist_id)
                .is_some_and(|last| compare_spoken(last, text_prefix) != Heard::Unknown);
            if !committed {
                self.early_confirm.insert(
                    panelist_id.to_string(),
                    (text_prefix.to_string(), Instant::now()),
                );
            }
            return Vec::new();
        };
        let p = self.provisional.remove(i);
        // This panelist's older parked replies were superseded by this one.
        let mut seen = 0;
        self.provisional.retain(|q| {
            let older = q.panelist_id == panelist_id && seen < i;
            seen += 1;
            !older
        });
        tracing::info!(session_id = %self.id, panelist_id = %panelist_id, turn_id = p.id, "reply confirmed by playback");
        self.commit_parked(p, None)
    }

    /// On pause and at session end: parked replies were never confirmed as played (a confirmed reply is committed at
    /// once, by `confirm_spoken` or when it is parked after an early report), so they are dropped. The candidate's
    /// words are already recorded. Returns the events of anything committed (none today; kept for the caller's
    /// broadcast path).
    pub fn flush_provisional(&mut self) -> Vec<ServerEvent> {
        let dropped = std::mem::take(&mut self.provisional).len();
        self.early_confirm.clear();
        if dropped > 0 {
            tracing::info!(session_id = %self.id, dropped, "unplayed replies dropped at flush");
        }
        Vec::new()
    }

    /// The director finished for turn `id`: its calls ride with the parked turn, are applied now if the turn is
    /// already committed, and are dropped if the turn was never played.
    pub fn director_done(&mut self, id: u64, calls: Vec<ToolCall>) -> Vec<ServerEvent> {
        if let Some(p) = self.provisional.iter_mut().find(|p| p.id == id) {
            p.tool_calls.extend(calls);
            return Vec::new();
        }
        if self.recent_commits.contains(&id) {
            return self.apply_tool_calls(&calls);
        }
        if !calls.is_empty() {
            tracing::info!(session_id = %self.id, turn_id = id, "director calls of an unplayed reply dropped");
        }
        Vec::new()
    }

    /// Applies tool calls (from the director) and broadcasts their events.
    pub fn apply_tool_calls(&mut self, calls: &[ToolCall]) -> Vec<ServerEvent> {
        let mut events = Vec::new();
        for call in calls {
            events.extend(tools::apply(self, call));
        }
        for ev in &events {
            let _ = self.events.send(ev.clone());
        }
        events
    }

    /// Appends a finished turn to the history, applies its tool calls and broadcasts their events.
    pub fn commit_turn(&mut self, commit: TurnCommit, now: Instant) -> Vec<ServerEvent> {
        let TurnCommit {
            draft,
            reply,
            spoken,
            tool_calls,
            handover_line_used,
        } = commit;
        let panelist = draft.panelist_id.clone();
        let at_ms = self.elapsed_ms(now);
        if draft.input.speech().is_some() {
            self.speech_commits += 1;
        }
        let mut draft = draft;
        if !draft.user_committed {
            // A whole turn committed at once (hand-over line, tests): its words are a new utterance.
            if self.unanswered.get(&panelist).is_some_and(|u| u.answered) {
                self.unanswered.remove(&panelist);
            }
            self.record_user(&mut draft, now);
        }

        let used = draft.notes_used.min(self.pending_notes.len());
        self.pending_notes.drain(..used);
        self.heard_note.remove(&panelist);
        self.two_minute_warned |= draft.warned_two_minutes;
        if let Some(u) = self.unanswered.get_mut(&panelist) {
            u.answered = true;
            u.base = u.text();
            u.tail.clear();
            u.tail_idx = None;
            u.freeze_line();
        }

        // The note and the reply follow the user message they answer. When another reply was recorded after that
        // message (joined panel, a late confirmation), the history cannot take a note after an assistant turn: the
        // line goes to the next turn's note instead.
        let ends_on_user = self.history.last().is_some_and(|m| m.role == Role::User);
        if ends_on_user {
            let mut messages = draft.messages;
            for m in &mut messages {
                m.content.iter_mut().for_each(|c| c.set_cache_control(None));
            }
            for m in messages {
                self.push_message(&panelist, m);
            }
            if !reply.is_empty() {
                self.push_message(
                    &panelist,
                    Message {
                        role: Role::Assistant,
                        content: reply,
                    },
                );
            }
        } else if !spoken.trim().is_empty() {
            let name = self.display_name(&panelist);
            self.pending_notes
                .push(format!("Earlier, {name} also said: \"{}\"", spoken.trim()));
        }

        // The turn log stays in time order when a reply is committed late.
        let at = self
            .turns
            .iter()
            .rposition(|t| t.at_ms <= at_ms)
            .map_or(0, |i| i + 1);
        // Stored line positions after the insert move down by one.
        for u in self.unanswered.values_mut() {
            if let Some(i) = u.line_idx.as_mut()
                && *i >= at
            {
                *i += 1;
            }
        }
        self.turns.insert(
            at,
            Turn {
                speaker: panelist.clone(),
                text: spoken.clone(),
                at_ms,
                interrupted: false,
                heard: None,
            },
        );
        self.last_agent_text.insert(panelist.clone(), spoken);
        // A late reply (another reply came after it) does not make this panelist the last speaker.
        if ends_on_user {
            self.last_speaker = Some(panelist.clone());
        }
        if handover_line_used {
            self.pending_handover.remove(&panelist);
        }
        if matches!(
            draft.input,
            UserInput::Event(super::markers::EventKind::Handover)
        ) {
            self.floor = panelist.clone();
        }

        // A meeting judges each confirmed user turn in the background (the reply to it was played).
        if self.meeting.is_some() && draft.input.speech().is_some() {
            let confirmed = self.turns.len();
            self.meeting_updates.request(confirmed);
        }

        // No subscriber (no socket yet) is fine.
        self.apply_tool_calls(&tool_calls)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Heard {
    All,
    Part,
    Unknown,
}

fn words(text: &str) -> Vec<String> {
    text.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '\'' || c == '\u{2019}' {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .replace('\u{2019}', "'")
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

/// Whether two transcripts start with the same word (interim revisions keep the start of an utterance).
fn same_start(a: &str, b: &str) -> bool {
    match (words(a).first(), words(b).first()) {
        (Some(x), Some(y)) => x == y,
        _ => true,
    }
}

/// The words of `text` after the longest common word prefix with `prev` (case and punctuation ignored), in
/// `text`'s own spelling. "So fast" then "So first, are" gives "first, are".
fn after_common_prefix(prev: &str, text: &str) -> String {
    let p = words(prev);
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let mut consumed = 0;
    for (i, token) in tokens.iter().enumerate() {
        let w = words(token);
        let fits = !w.is_empty()
            && consumed + w.len() <= p.len()
            && p[consumed..consumed + w.len()] == w[..];
        if !fits && !w.is_empty() {
            return tokens[i..].join(" ");
        }
        consumed += w.len();
    }
    String::new()
}

/// Whether `fish` (what was played) is all of `ours`, a strict prefix of it, or something else.
fn compare_spoken(ours: &str, fish: &str) -> Heard {
    let (o, f) = (words(ours), words(fish));
    if f.is_empty() || o.is_empty() {
        return Heard::Unknown;
    }
    if o == f {
        return Heard::All;
    }
    if f.len() > o.len() {
        return Heard::Unknown;
    }
    let last = f.len() - 1;
    let prefix = f[..last] == o[..last] && o[last].starts_with(&f[last]);
    if prefix { Heard::Part } else { Heard::Unknown }
}

/// Live sessions in memory, by session id.
#[derive(Clone, Default)]
pub struct Registry {
    inner: Arc<RwLock<HashMap<String, Arc<Mutex<SessionState>>>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Mutex<SessionState>>> {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    /// Adds (or replaces) a session and returns its handle.
    pub fn insert(&self, state: SessionState) -> Arc<Mutex<SessionState>> {
        let id = state.id.clone();
        let handle = Arc::new(Mutex::new(state));
        self.inner
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, handle.clone());
        handle
    }

    /// Ends a session: waits (up to 10 s) for a turn in flight, drops its unconfirmed parked replies, then removes
    /// it. Returns the final state handle and the events the flush produced.
    pub async fn end_session(
        &self,
        id: &str,
    ) -> Option<(Arc<Mutex<SessionState>>, Vec<ServerEvent>)> {
        let handle = self.get(id)?;
        // Let a turn in flight finish (and park) first, but never wait long.
        let turn_lock = handle.lock().await.turn_lock.clone();
        let _turn =
            tokio::time::timeout(std::time::Duration::from_secs(10), turn_lock.lock_owned()).await;
        let events = handle.lock().await.flush_provisional();
        // The last confirmed turn's meeting update lands (bounded) before the final state is read.
        crate::meeting::live::drain(&handle, crate::meeting::live::DRAIN_WAIT).await;
        self.remove(id);
        Some((handle, events))
    }

    pub fn remove(&self, id: &str) -> Option<Arc<Mutex<SessionState>>> {
        self.inner
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
    }

    pub fn len(&self) -> usize {
        self.inner.read().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_words_follow_the_common_prefix() {
        assert_eq!(
            after_common_prefix("So first,", "So first, are the seats assigned?"),
            "are the seats assigned?"
        );
        assert_eq!(after_common_prefix("so FIRST", "So first."), "");
        assert_eq!(
            after_common_prefix("So fast", "So first, are"),
            "first, are"
        );
        assert_eq!(
            after_common_prefix("Yes.", "Yes, and the cache"),
            "and the cache"
        );
        assert_eq!(after_common_prefix("", "Hi there"), "Hi there");
    }

    #[test]
    fn spoken_prefix_detection() {
        let ours = "Tell me how you'd shard the database and what key you'd pick.";
        assert_eq!(compare_spoken(ours, "Tell me how you'd"), Heard::Part);
        assert_eq!(compare_spoken(ours, "Tell me how you'd sha"), Heard::Part);
        assert_eq!(
            compare_spoken(
                ours,
                "tell me how you'd shard the database and what key you'd pick"
            ),
            Heard::All
        );
        assert_eq!(
            compare_spoken(ours, "Something else entirely."),
            Heard::Unknown
        );
        assert_eq!(compare_spoken(ours, ""), Heard::Unknown);
        assert_eq!(compare_spoken("It\u{2019}s fine.", "It's fine"), Heard::All);
    }
}
