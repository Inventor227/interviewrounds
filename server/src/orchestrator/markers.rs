//! Event markers the browser types into the voice session (`[event: time_check]`) versus real speech.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UserInput {
    Speech(String),
    Event(EventKind),
    /// Candidate speech and an app event in the same turn (e.g. `[event: long_answer]` sent while they talk).
    SpeechWithEvent(String, EventKind),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EventKind {
    Start,
    TimeCheck,
    Handover,
    Resume,
    SilenceCheck,
    /// Sent while the candidate is still talking: their answer has run past the round's limit.
    LongAnswer,
    Ending,
}

impl EventKind {
    pub fn name(self) -> &'static str {
        match self {
            EventKind::Start => "start",
            EventKind::TimeCheck => "time_check",
            EventKind::Handover => "handover",
            EventKind::Resume => "resume",
            EventKind::SilenceCheck => "silence_check",
            EventKind::LongAnswer => "long_answer",
            EventKind::Ending => "ending",
        }
    }

    /// The exact text the browser sends, e.g. `[event: time_check]`.
    pub fn marker(self) -> &'static str {
        match self {
            EventKind::Start => "[event: start]",
            EventKind::TimeCheck => "[event: time_check]",
            EventKind::Handover => "[event: handover]",
            EventKind::Resume => "[event: resume]",
            EventKind::SilenceCheck => "[event: silence_check]",
            EventKind::LongAnswer => "[event: long_answer]",
            EventKind::Ending => "[event: ending]",
        }
    }

    fn from_name(name: &str) -> Option<EventKind> {
        Some(match name {
            "start" => EventKind::Start,
            "time_check" | "timecheck" => EventKind::TimeCheck,
            "handover" | "hand_over" => EventKind::Handover,
            "resume" => EventKind::Resume,
            "silence_check" | "silence" => EventKind::SilenceCheck,
            "long_answer" | "longanswer" => EventKind::LongAnswer,
            "ending" | "end" => EventKind::Ending,
            _ => return None,
        })
    }
}

impl UserInput {
    /// The text that goes into the history as the user turn.
    pub fn text(&self) -> String {
        match self {
            UserInput::Speech(s) => s.clone(),
            UserInput::Event(kind) => kind.marker().to_string(),
            UserInput::SpeechWithEvent(s, kind) => format!("{s}\n{}", kind.marker()),
        }
    }

    /// The app event of this turn, if any.
    pub fn event(&self) -> Option<EventKind> {
        match self {
            UserInput::Speech(_) => None,
            UserInput::Event(k) | UserInput::SpeechWithEvent(_, k) => Some(*k),
        }
    }

    /// The candidate's words in this turn, if any.
    pub fn speech(&self) -> Option<&str> {
        match self {
            UserInput::Speech(s) | UserInput::SpeechWithEvent(s, _) => Some(s),
            UserInput::Event(_) => None,
        }
    }
}

/// `[event: <name>]` (whole message, any case and spacing) is an event; anything else is speech.
/// Unknown event names stay speech so nothing the candidate says is ever dropped.
pub fn parse_user_input(text: &str) -> UserInput {
    let trimmed = text.trim();
    let event = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .and_then(|inner| {
            let (tag, name) = inner.split_once(':')?;
            if !tag.trim().eq_ignore_ascii_case("event") {
                return None;
            }
            let name = name.trim().to_ascii_lowercase();
            let kind = EventKind::from_name(&name);
            if kind.is_none() {
                tracing::warn!(event = %name, "unknown event marker; treated as speech");
            }
            kind
        });
    match event {
        Some(kind) => UserInput::Event(kind),
        None => UserInput::Speech(trimmed.to_string()),
    }
}

/// One turn from all the user messages Fish sent since our last reply (Fish can hold more than one, for example a
/// typed `[event: long_answer]` next to the candidate's speech, or speech we never answered). Speech parts are
/// joined; the newest event wins. None when there is nothing.
pub fn parse_user_turn<S: AsRef<str>>(parts: &[S]) -> Option<UserInput> {
    let mut speech: Vec<String> = Vec::new();
    let mut event = None;
    for part in parts {
        match parse_user_input(part.as_ref()) {
            UserInput::Speech(s) if s.is_empty() => {}
            UserInput::Speech(s) => speech.push(s),
            UserInput::Event(k) => event = Some(k),
            UserInput::SpeechWithEvent(s, k) => {
                speech.push(s);
                event = Some(k);
            }
        }
    }
    let speech = speech.join(" ");
    match (speech.is_empty(), event) {
        (true, None) => None,
        (true, Some(k)) => Some(UserInput::Event(k)),
        (false, None) => Some(UserInput::Speech(speech)),
        (false, Some(k)) => Some(UserInput::SpeechWithEvent(speech, k)),
    }
}
