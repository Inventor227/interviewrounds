//! Event markers the browser types into the voice session (`[event: time_check]`) versus real speech.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UserInput {
    Speech(String),
    Event(EventKind),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EventKind {
    Start,
    TimeCheck,
    Handover,
    Resume,
    SilenceCheck,
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
            "ending" | "end" => EventKind::Ending,
            _ => return None,
        })
    }
}

impl UserInput {
    /// The text that goes into the history as the user turn.
    pub fn text(&self) -> &str {
        match self {
            UserInput::Speech(s) => s,
            UserInput::Event(kind) => kind.marker(),
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
            EventKind::from_name(&name.trim().to_ascii_lowercase())
        });
    match event {
        Some(kind) => UserInput::Event(kind),
        None => UserInput::Speech(trimmed.to_string()),
    }
}
