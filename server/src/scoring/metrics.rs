//! Delivery metrics, computed by our code from the transcript timing and the head samples (no model).
//!
//! Every time here is milliseconds since the session started. Timing fields (pace, fillers per minute, long
//! pauses, answer lengths, interruptions) are `None` or empty when the session had no audio timing (fake voice,
//! or no `transcript.mark` frames arrived).

use serde::{Deserialize, Serialize};

/// Pace bands (words per minute): below 110 slow, 110 to 170 good, above 170 fast.
pub const WPM_SLOW_BELOW: f64 = 110.0;
pub const WPM_FAST_ABOVE: f64 = 170.0;
/// Filler bands (per minute of the user's speech): below 2 good, 2 to 5 okay, above 5 work on it.
pub const FILLER_GOOD_BELOW: f64 = 2.0;
pub const FILLER_OKAY_UP_TO: f64 = 5.0;
/// A silence longer than this inside one answer is a long pause.
pub const LONG_PAUSE_MS: i64 = 4_000;
/// Looking at the interviewer: head yaw within this many degrees of the floor panelist.
pub const GAZE_CONE_DEG: f64 = 15.0;
/// Speaking rate used to estimate speech time when there is no audio timing (words per minute).
pub const ESTIMATE_WPM: f64 = 150.0;

/// One row of `turns`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TurnRec {
    pub seq: i32,
    /// `user`, `agent` or `system`.
    pub speaker: String,
    pub panelist_id: Option<String>,
    /// `speech`, `event` or `note`.
    pub kind: String,
    pub text: String,
    pub started_ms: Option<i64>,
    pub ended_ms: Option<i64>,
    pub interrupted: bool,
}

impl TurnRec {
    /// The words actually said: the text without `[event: ...]` marker lines.
    pub fn speech(&self) -> String {
        speech_text(&self.text)
    }

    pub fn is_user_speech(&self) -> bool {
        self.speaker == "user" && self.kind == "speech" && !self.speech().is_empty()
    }

    pub fn is_agent_speech(&self) -> bool {
        self.speaker == "agent" && self.kind == "speech" && !self.speech().is_empty()
    }
}

/// One final user transcript segment (`marks`), with times already relative to the session start.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MarkRec {
    pub segment_id: String,
    pub panelist_id: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

impl MarkRec {
    pub fn dur_ms(&self) -> i64 {
        (self.end_ms - self.start_ms).max(0)
    }

    /// Speaking time of the segment: its span, but never less than its words at 250 wpm (a segment whose
    /// first partial and final arrive together would otherwise add words and no time).
    pub fn speech_ms(&self) -> i64 {
        self.dur_ms()
            .max(word_count(&self.text) as i64 * 60_000 / 250)
    }
}

/// One `head.samples` entry: yaw and pitch in degrees relative to the floor panelist's eyes.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HeadSample {
    #[serde(default)]
    pub t_ms: f64,
    #[serde(default)]
    pub yaw: f64,
    #[serde(default)]
    pub pitch: f64,
    #[serde(default)]
    pub speaking: bool,
    #[serde(default)]
    pub target: Option<String>,
}

/// A hint the interviewer gave.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HintRec {
    pub level: u8,
    pub t_ms: i64,
    pub accepted: bool,
}

/// What the metrics need to know about the session besides the records.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MetricsContext {
    /// True when the session had audio timing (Fish voice and at least one transcript mark).
    pub timing: bool,
    pub round_type: String,
    pub hints: Vec<HintRec>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FillerCount {
    pub word: String,
    pub count: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Pause {
    pub t_sec: f64,
    pub dur_sec: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct AnswerLen {
    pub t_start_sec: f64,
    pub dur_sec: f64,
    /// `ok`, `short` or `long`.
    pub flag: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct HintOut {
    pub level: u8,
    pub t_sec: f64,
    pub accepted: bool,
}

/// `report.v1` `delivery`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct DeliveryMetrics {
    pub wpm: Option<f64>,
    pub wpm_band: Option<String>,
    pub filler_per_min: Option<f64>,
    pub filler_band: Option<String>,
    pub filler_top: Vec<FillerCount>,
    pub long_pauses: Vec<Pause>,
    pub talk_ratio_user: Option<f64>,
    pub answers: Vec<AnswerLen>,
    pub gaze_on_speaker_pct: Option<f64>,
    pub user_interruptions: Option<i64>,
    pub hints: Vec<HintOut>,
}

/// How much the candidate said: decides whether there is enough signal to score.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Signal {
    /// User speech turns with at least three words.
    pub answers: usize,
    /// Seconds of user speech (from the marks with timing, else estimated from the word count).
    pub speech_sec: f64,
}

impl Signal {
    /// Fewer than 2 answers or under 90 s of speech is not enough to score.
    pub fn enough(&self) -> bool {
        self.answers >= 2 && self.speech_sec >= 90.0
    }
}

pub fn signal(turns: &[TurnRec], marks: &[MarkRec], timing: bool) -> Signal {
    let user: Vec<String> = turns
        .iter()
        .filter(|t| t.is_user_speech())
        .map(TurnRec::speech)
        .collect();
    let answers = user.iter().filter(|t| word_count(t) >= 3).count();
    let speech_sec = if timing && !marks.is_empty() {
        marks.iter().map(MarkRec::speech_ms).sum::<i64>() as f64 / 1000.0
    } else {
        let words: usize = user.iter().map(|t| word_count(t)).sum();
        words as f64 * 60.0 / ESTIMATE_WPM
    };
    Signal {
        answers,
        speech_sec,
    }
}

/// Computes `delivery` (research 07 §D.4).
pub fn compute(
    turns: &[TurnRec],
    marks: &[MarkRec],
    head: &[HeadSample],
    ctx: &MetricsContext,
) -> DeliveryMetrics {
    let timing = ctx.timing && !marks.is_empty();
    let mut marks: Vec<MarkRec> = marks.to_vec();
    marks.sort_by_key(|m| (m.start_ms, m.end_ms));

    // The user's words: the timed segments when we have them, else the stored turns.
    let user_text: String = if timing {
        marks
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        turns
            .iter()
            .filter(|t| t.is_user_speech())
            .map(TurnRec::speech)
            .collect::<Vec<_>>()
            .join("\n")
    };
    let user_words = word_count(&user_text);
    let speaking_ms: i64 = marks.iter().map(MarkRec::speech_ms).sum();
    let minutes = speaking_ms as f64 / 60_000.0;

    let fillers = count_fillers(&user_text);
    let filler_total: i64 = fillers.iter().map(|f| f.count).sum();

    let mut m = DeliveryMetrics {
        filler_top: fillers.into_iter().take(3).collect(),
        ..DeliveryMetrics::default()
    };

    if timing && minutes > 0.0 {
        let wpm = user_words as f64 / minutes;
        m.wpm = Some(round1(wpm));
        m.wpm_band = Some(wpm_band(wpm).to_string());
        let per_min = filler_total as f64 / minutes;
        m.filler_per_min = Some(round1(per_min));
        m.filler_band = Some(filler_band(per_min).to_string());
    }

    // Share of the words spoken in the room that were the user's.
    let agent_words: usize = turns
        .iter()
        .filter(|t| t.is_agent_speech())
        .map(|t| word_count(&t.speech()))
        .sum();
    let turn_user_words: usize = turns
        .iter()
        .filter(|t| t.is_user_speech())
        .map(|t| word_count(&t.speech()))
        .sum();
    if turn_user_words + agent_words > 0 {
        m.talk_ratio_user = Some(round2(
            turn_user_words as f64 / (turn_user_words + agent_words) as f64,
        ));
    }

    if timing {
        let (answers, pauses) = answers_and_pauses(&marks, turns, &ctx.round_type);
        m.answers = answers;
        m.long_pauses = pauses;
        m.user_interruptions = Some(
            turns
                .iter()
                .filter(|t| t.speaker == "agent" && t.interrupted)
                .count() as i64,
        );
    }

    // Head samples are measured only in the headset with a live voice; without timing the field stays null.
    if ctx.timing {
        m.gaze_on_speaker_pct = gaze_on_speaker(head);
    }
    m.hints = ctx
        .hints
        .iter()
        .map(|h| HintOut {
            level: h.level.clamp(1, 5),
            t_sec: round1(h.t_ms.max(0) as f64 / 1000.0),
            accepted: h.accepted,
        })
        .collect();
    m
}

pub fn wpm_band(wpm: f64) -> &'static str {
    if wpm < WPM_SLOW_BELOW {
        "slow"
    } else if wpm > WPM_FAST_ABOVE {
        "fast"
    } else {
        "good"
    }
}

pub fn filler_band(per_min: f64) -> &'static str {
    if per_min < FILLER_GOOD_BELOW {
        "good"
    } else if per_min > FILLER_OKAY_UP_TO {
        "work_on_it"
    } else {
        "okay"
    }
}

/// Groups the user's segments into answers (an agent turn between two segments starts a new answer) and lists
/// the silences longer than 4 s inside an answer. The wait before an answer starts is not a pause.
fn answers_and_pauses(
    marks: &[MarkRec],
    turns: &[TurnRec],
    round_type: &str,
) -> (Vec<AnswerLen>, Vec<Pause>) {
    let mut agent_starts: Vec<i64> = turns
        .iter()
        .filter(|t| t.is_agent_speech())
        .filter_map(|t| t.started_ms)
        .collect();
    agent_starts.sort_unstable();

    let mut groups: Vec<Vec<&MarkRec>> = Vec::new();
    let mut pauses = Vec::new();
    for mark in marks {
        let new_group = match groups.last().and_then(|g| g.last()) {
            None => true,
            Some(prev) => agent_starts
                .iter()
                .any(|&a| a > prev.end_ms && a <= mark.start_ms),
        };
        if new_group {
            groups.push(vec![mark]);
        } else {
            let prev = groups.last().and_then(|g| g.last()).copied();
            if let Some(prev) = prev {
                let gap = mark.start_ms - prev.end_ms;
                if gap > LONG_PAUSE_MS {
                    pauses.push(Pause {
                        t_sec: round1(prev.end_ms as f64 / 1000.0),
                        dur_sec: round1(gap as f64 / 1000.0),
                    });
                }
            }
            if let Some(g) = groups.last_mut() {
                g.push(mark);
            }
        }
    }

    let (short_below, long_above) = answer_bounds(round_type);
    let answers = groups
        .iter()
        .filter_map(|g| {
            let start = g.first()?.start_ms;
            let end = g.iter().map(|m| m.end_ms).max()?;
            let dur = (end - start).max(0) as f64 / 1000.0;
            let flag = if dur > long_above {
                "long"
            } else if dur < short_below {
                "short"
            } else {
                "ok"
            };
            Some(AnswerLen {
                t_start_sec: round1(start as f64 / 1000.0),
                dur_sec: round1(dur),
                flag: flag.to_string(),
            })
        })
        .collect();
    (answers, pauses)
}

/// (short below, long above) in seconds. Story rounds want 60 to 180 s answers; elsewhere quick answers are
/// normal, so only monologues are flagged.
fn answer_bounds(round_type: &str) -> (f64, f64) {
    match round_type {
        "behavioral" | "pm_leadership" => (30.0, 180.0),
        "meeting" => (0.0, 120.0),
        _ => (0.0, 180.0),
    }
}

/// Share of the user's speaking samples with the head within ±15° of the panelist holding the floor (yaw only:
/// looking down at the desk or the sheet does not count against them). The samples are already relative to
/// whoever held the floor at that moment, so a hand-over moves the target with it. Seats sit about 30° apart, so a
/// sample within the cone can only be aimed at the floor panelist, never at a neighbour.
pub fn gaze_on_speaker(head: &[HeadSample]) -> Option<f64> {
    let speaking: Vec<&HeadSample> = head.iter().filter(|s| s.speaking).collect();
    if speaking.is_empty() {
        return None;
    }
    let on = speaking
        .iter()
        .filter(|s| s.yaw.is_finite() && s.yaw.abs() <= GAZE_CONE_DEG)
        .count();
    Some(round2(on as f64 / speaking.len() as f64))
}

/// Filler words and phrases counted (research 07 §D.4). "like" counts only as a filler (set off by commas).
const FILLER_WORDS: [&str; 5] = ["um", "uh", "er", "basically", "actually"];
const FILLER_PHRASES: [&str; 3] = ["you know", "sort of", "i mean"];

/// Fillers in the text, most frequent first (ties by word).
pub fn count_fillers(text: &str) -> Vec<FillerCount> {
    let mut counts: Vec<(String, i64)> = Vec::new();
    let mut add = |w: &str, n: i64| {
        if n == 0 {
            return;
        }
        match counts.iter_mut().find(|(k, _)| k == w) {
            Some((_, c)) => *c += n,
            None => counts.push((w.to_string(), n)),
        }
    };
    let lower = text.to_lowercase();
    let words: Vec<String> = lower
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .map(normalize_filler)
        .collect();
    for f in FILLER_WORDS {
        add(f, words.iter().filter(|w| w.as_str() == f).count() as i64);
    }
    for phrase in FILLER_PHRASES {
        let parts: Vec<&str> = phrase.split(' ').collect();
        let n = words
            .windows(parts.len())
            .enumerate()
            .filter(|(i, w)| {
                w.iter().zip(&parts).all(|(a, b)| a.as_str() == *b)
                    // "do you know", "if you know" are questions, not fillers.
                    && !(phrase == "you know"
                        && *i > 0
                        && matches!(words[i - 1].as_str(), "do" | "did" | "if" | "don't" | "you'd"))
            })
            .count();
        add(phrase, n as i64);
    }
    // "like" set off as its own clause: "it was, like, slow".
    let like = lower
        .split([',', '.', '!', '?', ';', ':', '\n'])
        .filter(|clause| clause.trim() == "like")
        .count();
    add("like", like as i64);
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    counts
        .into_iter()
        .map(|(word, count)| FillerCount { word, count })
        .collect()
}

fn normalize_filler(w: &str) -> String {
    let squeeze = |w: &str, base: &str, tail: char| {
        w.starts_with(base) && w[base.len()..].chars().all(|c| c == tail)
    };
    if squeeze(w, "um", 'm') {
        "um".into()
    } else if squeeze(w, "uh", 'h') {
        "uh".into()
    } else if w == "erm" || squeeze(w, "er", 'r') {
        "er".into()
    } else {
        w.to_string()
    }
}

pub fn word_count(text: &str) -> usize {
    text.split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count()
}

/// Text without `[event: ...]` marker lines.
pub fn speech_text(text: &str) -> String {
    text.lines()
        .filter(|l| !is_marker(l))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub fn is_marker(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('[')
        && t.ends_with(']')
        && t[1..]
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("event")
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}
