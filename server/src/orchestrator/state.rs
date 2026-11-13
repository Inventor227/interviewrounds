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

/// Hidden meeting state the attendee prompts see in their per-turn note (filled by the meeting tasks).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MeetingState {
    pub hidden: String,
}

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

/// A turn that was spoken (or streamed) but is not in the history yet, because the voice platform may not have
/// played it: Fish starts speculative replies on interim transcripts and throws most of them away, a request can be
/// cut off mid-stream, and the hold line can be spoken while another turn runs. It is committed once the voice
/// platform shows it was played (its transcript in the next request, or the browser reporting playback), and
/// dropped when the next request shows it was not.
#[derive(Clone, Debug)]
pub struct Provisional {
    pub id: u64,
    pub panelist_id: String,
    pub input: UserInput,
    /// The draft the reply was made from; None = draft again when committing.
    pub draft: Option<TurnDraft>,
    /// Tool round trips inside the turn (inline tools).
    pub extra: Vec<Message>,
    /// The assistant content to record.
    pub reply: Vec<ContentBlock>,
    /// What was streamed to the voice.
    pub spoken: String,
    /// Tool calls to apply when the turn is committed (inline calls, then the director's when it finishes).
    pub tool_calls: Vec<ToolCall>,
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
    /// Dev voice spike only: this many next replies are sent empty (to observe the voice platform).
    pub dev_empty_replies: u8,
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
        let seats = if spec.panel.is_empty() {
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
        let personas: Vec<Persona> = seats
            .iter()
            .map(|s| {
                catalog
                    .persona(&s.persona_id)
                    .cloned()
                    .ok_or_else(|| anyhow!("unknown persona {}", s.persona_id))
            })
            .collect::<anyhow::Result<_>>()?;
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
            let text = prompt::render_system(
                catalog,
                &round,
                persona,
                seat,
                &panel_view,
                &question,
                &spec.settings,
            )
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
        Ok(SessionState {
            id: spec.id,
            identity_id: spec.identity_id,
            mode: spec.mode,
            floor: panel[0].panelist_id.clone(),
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
            meeting: spec.meeting,
            hints_given: 0,
            hint_max_level: 0,
            last_agent_text: HashMap::new(),
            status: SessionStatus::Live,
            brief: None,
            closing_line: None,
            live,
            question,
            pending_tool_results: Vec::new(),
            pending_handover: HashMap::new(),
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
            dev_empty_replies: 0,
        })
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

    /// Parks a spoken turn until the voice platform confirms it.
    pub fn park(&mut self, p: Provisional) {
        self.provisional.push(p);
    }

    fn commit_parked(&mut self, p: Provisional, heard: Option<&str>, now: Instant) {
        let draft = match p.draft {
            Some(d) => d,
            None => prompt::draft_turn(self, &p.panelist_id, &p.input, now),
        };
        self.commit_now(
            p.id,
            TurnCommit {
                draft,
                extra: p.extra,
                reply: p.reply,
                spoken: p.spoken.clone(),
                tool_calls: p.tool_calls,
                handover_line_used: false,
            },
            now,
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
    }

    /// Settles parked turns against Fish's transcript (`fish_last`: its newest assistant message). The newest parked
    /// turn whose line Fish has (all of it, or the start of it, which means the candidate cut in) is committed now,
    /// marked interrupted when only part was played. Turns Fish does not have were drafts it threw away: they are
    /// dropped, and their words come back in Fish's newer user message anyway.
    pub fn resolve_provisional(&mut self, fish_last: Option<&str>, now: Instant) {
        let parked = std::mem::take(&mut self.provisional);
        let n = parked.len();
        let mut played = None;
        if let Some(fish) = fish_last {
            for p in parked.into_iter().rev() {
                if played.is_none() && compare_spoken(&p.spoken, fish) != Heard::Unknown {
                    played = Some(p);
                }
            }
        }
        let dropped = n - usize::from(played.is_some());
        if dropped > 0 {
            tracing::info!(session_id = %self.id, dropped, "unplayed replies dropped");
        }
        if let (Some(p), Some(fish)) = (played, fish_last) {
            let part = compare_spoken(&p.spoken, fish) == Heard::Part;
            tracing::info!(session_id = %self.id, panelist_id = %p.panelist_id, turn_id = p.id, interrupted = part, "played reply committed");
            self.commit_parked(p, part.then_some(fish), now);
        }
    }

    /// The browser reports that the voice started playing `heard` (the text so far) for `panelist_id`: the matching
    /// parked turn is committed at once, so its tool calls reach the screen while it is spoken. Returns whether one
    /// was found.
    pub fn confirm_spoken(&mut self, panelist_id: &str, heard: &str, now: Instant) -> bool {
        let Some(i) = self.provisional.iter().rposition(|p| {
            p.panelist_id == panelist_id && compare_spoken(&p.spoken, heard) != Heard::Unknown
        }) else {
            return false;
        };
        // Older parked turns were superseded by this one.
        let mut parked = std::mem::take(&mut self.provisional);
        let p = parked.remove(i);
        parked.drain(..i);
        self.provisional = parked;
        tracing::info!(session_id = %self.id, panelist_id = %panelist_id, turn_id = p.id, "reply confirmed by playback");
        self.commit_parked(p, None, now);
        true
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

        self.pending_tool_results
            .retain(|id| !draft.tool_result_ids.contains(id));
        let used = draft.notes_used.min(self.pending_notes.len());
        self.pending_notes.drain(..used);
        self.heard_note.remove(&panelist);
        self.two_minute_warned |= draft.warned_two_minutes;

        let mut messages = draft.messages;
        for m in &mut messages {
            m.content.iter_mut().for_each(|c| c.set_cache_control(None));
        }
        self.history.extend(messages);
        self.history.extend(extra);
        if !reply.is_empty() {
            for block in &reply {
                if let ContentBlock::ToolUse { id, .. } = block {
                    self.pending_tool_results.push(id.clone());
                }
            }
            self.history.push(Message {
                role: Role::Assistant,
                content: reply,
            });
        }

        if let Some(said) = draft.input.speech() {
            self.turns.push(Turn {
                speaker: "candidate".into(),
                text: said.to_string(),
                at_ms,
                interrupted: false,
                heard: None,
            });
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
