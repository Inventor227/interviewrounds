//! Live session state and the in-memory registry. The model history here is append-only: earlier messages are
//! never edited (prompt caching and preserved thinking both depend on it); corrections go in as new system notes.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, broadcast};

use super::markers::UserInput;
use super::prompt::{self, TurnDraft};
use super::tools::{self, ToolCall};
use super::{Brief, PhasePublic, RoundStateMsg, ServerEvent};
use crate::claude::{ContentBlock, Message, Role, SystemBlock};
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

/// Where the live interviewer's tool calls come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolsMode {
    /// The live call carries no tools and only speaks; after the reply, the director (a fast second call on
    /// `fast_model`) turns the spoken line into tool actions. Fastest first token.
    Director,
    /// The live call carries the tools itself (calls continue after tool use).
    Inline,
}

/// Model settings for the live voice turns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveSettings {
    pub model: String,
    /// Used once when the live model fails before saying anything, and for the director.
    pub fast_model: String,
    pub effort: String,
    pub max_tokens: u32,
    pub tools: ToolsMode,
}

impl LiveSettings {
    pub fn from_config(cfg: &Config) -> Self {
        LiveSettings {
            model: cfg.live_model.clone(),
            fast_model: cfg.fast_model.clone(),
            effort: cfg.live_effort.clone(),
            max_tokens: 300,
            tools: if cfg.live_tools == "inline" {
                ToolsMode::Inline
            } else {
                ToolsMode::Director
            },
        }
    }
}

/// One AI person in the round. `system` is rendered once at creation and never changes, so the prompt cache holds.
#[derive(Clone, Debug)]
pub struct Panelist {
    pub panelist_id: String,
    pub persona: Persona,
    pub seat: u8,
    pub system: Vec<SystemBlock>,
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
    /// Tool round trips inside the turn (inline tools).
    pub extra: Vec<Message>,
    /// The assistant content to record.
    pub reply: Vec<ContentBlock>,
    /// What was streamed to the voice.
    pub spoken: String,
    /// Tool calls to apply when the reply is committed (inline calls, then the director's when it finishes).
    pub tool_calls: Vec<ToolCall>,
    /// When the reply was spoken (the turn log time, whenever it is committed).
    pub parked_at: Instant,
}

/// Everything a finished turn adds.
#[derive(Debug)]
pub struct TurnCommit {
    pub draft: TurnDraft,
    /// Messages between the draft and the reply (a tool-only reply and its "ok" results).
    pub extra: Vec<Message>,
    /// The final assistant content, verbatim (thinking, text, tool calls).
    pub reply: Vec<ContentBlock>,
    /// What was actually streamed to the voice (filtered).
    pub spoken: String,
    /// Every tool call made in this turn, in order.
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
    /// Tool calls of the last reply still owed an "ok" result (sent at the start of the next user message).
    pub pending_tool_results: Vec<String>,
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
    /// Per panelist: the candidate's words already recorded that this panelist has not answered with a played reply
    /// yet. Fish repeats them in its next request (its transcript has no reply after them), so they are not
    /// recorded twice.
    pub unanswered: HashMap<String, String>,
    /// Dev voice spike only: this many next replies are sent empty (to observe the voice platform).
    pub dev_empty_replies: u8,
    /// Which panelist spoke each assistant message of `history` (by index). With two or more panelists, each one
    /// sees the others' lines as "Name said: ..." user-side notes, never as its own turns.
    pub assistant_speakers: HashMap<usize, String>,
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
                system: vec![SystemBlock::cached(text)],
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
            pending_tool_results: Vec::new(),
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
            dev_empty_replies: 0,
            assistant_speakers: HashMap::new(),
        })
    }

    /// Appends to the history, remembering which panelist spoke an assistant message.
    pub fn push_message(&mut self, panelist_id: &str, message: Message) {
        if message.role == Role::Assistant {
            self.assistant_speakers
                .insert(self.history.len(), panelist_id.to_string());
        }
        self.history.push(message);
    }

    /// Meetings the user chairs: no attendee moves the phases, so they follow the schedule.
    pub fn sync_meeting_phase(&mut self, now: Instant) {
        if self.meeting.as_ref().is_some_and(|m| m.user_chairs) {
            let elapsed_min = self.elapsed_ms(now) as f64 / 60_000.0;
            let due = crate::meeting::live::scheduled_phase(&self.round, elapsed_min);
            self.phase_idx = self.phase_idx.max(due);
        }
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

    /// The part of `input` this panelist has not recorded yet: speech Fish repeats from an earlier request (its
    /// draft reply was never played) is cut off the front. None when nothing is new.
    pub fn new_words(&self, panelist_id: &str, input: UserInput) -> Option<UserInput> {
        let Some(done) = self
            .unanswered
            .get(panelist_id)
            .filter(|d| !d.trim().is_empty())
        else {
            return Some(input);
        };
        let fresh = |speech: &str| match strip_word_prefix(done, speech) {
            Some(rest) => rest,
            None => speech.to_string(),
        };
        match input {
            UserInput::Speech(s) => {
                let rest = fresh(&s);
                (!rest.trim().is_empty()).then_some(UserInput::Speech(rest))
            }
            UserInput::SpeechWithEvent(s, k) => {
                let rest = fresh(&s);
                Some(if rest.trim().is_empty() {
                    UserInput::Event(k)
                } else {
                    UserInput::SpeechWithEvent(rest, k)
                })
            }
            event => Some(event),
        }
    }

    /// Records the turn's user message now (the candidate's words are never lost, whatever happens to the reply)
    /// and leaves only the note in the draft. With `repeat_only`, nothing new was said: no message is added unless
    /// the history would otherwise not end on a user message.
    pub fn record_user(&mut self, draft: &mut TurnDraft, repeat_only: bool, now: Instant) {
        if draft.user_committed || draft.messages.is_empty() {
            return;
        }
        let mut user = draft.messages.remove(0);
        draft.user_committed = true;
        let ends_on_user = self.history.last().is_some_and(|m| m.role == Role::User);
        if repeat_only && ends_on_user {
            return;
        }
        user.content
            .iter_mut()
            .for_each(|c| c.set_cache_control(None));
        self.history.push(user);
        self.pending_tool_results
            .retain(|id| !draft.tool_result_ids.contains(id));
        if repeat_only {
            return;
        }
        let at_ms = self.elapsed_ms(now);
        if let Some(said) = draft.input.speech() {
            let unanswered = self
                .unanswered
                .entry(draft.panelist_id.clone())
                .or_default();
            if !unanswered.is_empty() {
                unanswered.push(' ');
            }
            unanswered.push_str(said);
            // Words that continue the candidate's last line join it in the turn log.
            match self.turns.last_mut() {
                Some(t) if t.speaker == "candidate" => {
                    t.text.push(' ');
                    t.text.push_str(said);
                }
                _ => self.turns.push(Turn {
                    speaker: "candidate".into(),
                    text: said.to_string(),
                    at_ms,
                    interrupted: false,
                    heard: None,
                }),
            }
        }
        if let Some(kind) = draft.input.event() {
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
        }
        self.provisional.push(p);
        Vec::new()
    }

    fn commit_parked(&mut self, p: Provisional, heard: Option<&str>) -> Vec<ServerEvent> {
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
                extra: p.extra,
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

    /// On pause and at session end: parked replies whose playback was reported are committed (their actions,
    /// end_round included, run now); the rest were never played and are dropped. The candidate's words are already
    /// recorded either way.
    pub fn flush_provisional(&mut self) -> Vec<ServerEvent> {
        let parked = std::mem::take(&mut self.provisional);
        let mut events = Vec::new();
        let mut dropped = 0;
        for p in parked {
            let reported = self
                .early_confirm
                .get(&p.panelist_id)
                .is_some_and(|(heard, _)| compare_spoken(&p.spoken, heard) != Heard::Unknown);
            if reported {
                self.early_confirm.remove(&p.panelist_id);
                events.extend(self.commit_parked(p, None));
            } else {
                dropped += 1;
            }
        }
        if dropped > 0 {
            tracing::info!(session_id = %self.id, dropped, "unplayed replies dropped at flush");
        }
        events
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
            extra,
            reply,
            spoken,
            tool_calls,
            handover_line_used,
        } = commit;
        let panelist = draft.panelist_id.clone();
        let at_ms = self.elapsed_ms(now);
        let mut draft = draft;
        if !draft.user_committed {
            self.record_user(&mut draft, false, now);
        }

        let used = draft.notes_used.min(self.pending_notes.len());
        self.pending_notes.drain(..used);
        self.heard_note.remove(&panelist);
        self.two_minute_warned |= draft.warned_two_minutes;
        self.unanswered.remove(&panelist);

        // The note and the reply follow the user message they answer. When another reply was recorded after that
        // message (joined panel, a late confirmation), the history cannot take a note after an assistant turn: the
        // line goes to the next turn's note instead.
        let ends_on_user = self.history.last().is_some_and(|m| m.role == Role::User);
        if ends_on_user {
            let mut messages = draft.messages;
            for m in &mut messages {
                m.content.iter_mut().for_each(|c| c.set_cache_control(None));
            }
            self.history.extend(messages);
            for m in extra {
                self.push_message(&panelist, m);
            }
            if !reply.is_empty() {
                for block in &reply {
                    if let ContentBlock::ToolUse { id, .. } = block {
                        self.pending_tool_results.push(id.clone());
                    }
                }
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

        self.turns.push(Turn {
            speaker: panelist.clone(),
            text: spoken.clone(),
            at_ms,
            interrupted: false,
            heard: None,
        });
        self.last_agent_text.insert(panelist.clone(), spoken);
        self.last_speaker = Some(panelist.clone());
        if handover_line_used {
            self.pending_handover.remove(&panelist);
        }
        if matches!(
            draft.input,
            UserInput::Event(super::markers::EventKind::Handover)
        ) {
            self.floor = panelist.clone();
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

/// `text` without its leading words that equal `prefix`'s words (case and punctuation ignored; the last prefix word
/// may be cut short). None when `text` does not start with `prefix`.
fn strip_word_prefix(prefix: &str, text: &str) -> Option<String> {
    let want = words(prefix);
    if want.is_empty() {
        return Some(text.to_string());
    }
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let mut seen: Vec<String> = Vec::new();
    for (i, token) in tokens.iter().enumerate() {
        seen.extend(words(token));
        if seen.len() >= want.len() {
            let last = want.len() - 1;
            let same = seen[..last] == want[..last] && seen[last].starts_with(&want[last]);
            if !same || seen.len() > want.len() {
                return None;
            }
            return Some(tokens[i + 1..].join(" "));
        }
    }
    None
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

    /// Ends a session: flushes its parked replies (confirmed ones are committed and their actions run; unplayed ones
    /// are dropped), then removes it. Returns the final state handle and the events the flush produced.
    pub async fn end_session(
        &self,
        id: &str,
    ) -> Option<(Arc<Mutex<SessionState>>, Vec<ServerEvent>)> {
        let handle = self.get(id)?;
        let events = handle.lock().await.flush_provisional();
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
    fn word_prefix_is_stripped() {
        assert_eq!(
            strip_word_prefix("So first,", "So first, are the seats assigned?").as_deref(),
            Some("are the seats assigned?")
        );
        assert_eq!(
            strip_word_prefix("so FIRST", "So first.").as_deref(),
            Some("")
        );
        assert_eq!(strip_word_prefix("Hello there", "Hi there"), None);
        assert_eq!(strip_word_prefix("a b c", "a b"), None);
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
