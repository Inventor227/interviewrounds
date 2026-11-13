//! The hire verdict, by a fixed rule over the competency scores (research 07 §D.3), never by the model.

use serde::Serialize;

use crate::orchestrator::Mode;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    StrongNoHire,
    NoHire,
    LeaningNoHire,
    LeaningHire,
    Hire,
    StrongHire,
}

impl Verdict {
    /// 1 (strong no hire) to 6 (strong hire).
    pub fn index(self) -> u8 {
        match self {
            Verdict::StrongNoHire => 1,
            Verdict::NoHire => 2,
            Verdict::LeaningNoHire => 3,
            Verdict::LeaningHire => 4,
            Verdict::Hire => 5,
            Verdict::StrongHire => 6,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Verdict::StrongNoHire => "strong_no_hire",
            Verdict::NoHire => "no_hire",
            Verdict::LeaningNoHire => "leaning_no_hire",
            Verdict::LeaningHire => "leaning_hire",
            Verdict::Hire => "hire",
            Verdict::StrongHire => "strong_hire",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

impl Confidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Confidence::Low => "low",
            Confidence::Medium => "medium",
            Confidence::High => "high",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Length {
    Short,
    Full,
}

impl Length {
    pub fn parse(s: &str) -> Length {
        if s == "full" {
            Length::Full
        } else {
            Length::Short
        }
    }
}

/// Floating point slack so 3.6 computed from integer scores still counts as 3.6.
const EPS: f32 = 1e-4;

/// The verdict and its confidence.
///
/// `scores` are the competency scores (null = not observed, left out of the average, equal weights). The table:
/// Strong Hire avg ≥ 3.6 and min ≥ 3; Hire avg ≥ 3.0 and min ≥ 2; Leaning Hire avg ≥ 2.6 and min ≥ 2; Leaning No
/// Hire avg ≥ 2.2; No Hire avg ≥ 1.6; else Strong No Hire. A red flag is Strong No Hire whatever the scores.
/// Meeting mode has no hire verdict, and neither does a session with no scored competency.
///
/// Confidence: low when under 60% of the phases were covered or the round is short; medium at 60% or more; high
/// when every phase was covered and every competency has at least two evidence items
/// (`min_evidence_per_competency`).
pub fn decide(
    scores: &[Option<f32>],
    red_flag: bool,
    coverage_pct: f32,
    length: Length,
    mode: Mode,
    min_evidence_per_competency: usize,
) -> (Option<Verdict>, Confidence) {
    let confidence = if length == Length::Short || coverage_pct + EPS < 0.6 {
        Confidence::Low
    } else if coverage_pct + EPS >= 1.0 && min_evidence_per_competency >= 2 {
        Confidence::High
    } else {
        Confidence::Medium
    };
    if mode == Mode::Meeting {
        return (None, confidence);
    }
    if red_flag {
        return (Some(Verdict::StrongNoHire), confidence);
    }
    let scored: Vec<f32> = scores.iter().flatten().copied().collect();
    if scored.is_empty() {
        return (None, confidence);
    }
    let avg = scored.iter().sum::<f32>() / scored.len() as f32;
    let min = scored.iter().copied().fold(f32::INFINITY, f32::min);
    let at_least = |x: f32, bar: f32| x + EPS >= bar;
    let verdict = if at_least(avg, 3.6) && at_least(min, 3.0) {
        Verdict::StrongHire
    } else if at_least(avg, 3.0) && at_least(min, 2.0) {
        Verdict::Hire
    } else if at_least(avg, 2.6) && at_least(min, 2.0) {
        Verdict::LeaningHire
    } else if at_least(avg, 2.2) {
        Verdict::LeaningNoHire
    } else if at_least(avg, 1.6) {
        Verdict::NoHire
    } else {
        Verdict::StrongNoHire
    };
    (Some(verdict), confidence)
}

/// Mean of the scored competencies, two decimals; None when nothing was scored.
pub fn overall(scores: &[Option<f32>]) -> Option<f64> {
    let scored: Vec<f32> = scores.iter().flatten().copied().collect();
    if scored.is_empty() {
        return None;
    }
    let avg = scored.iter().sum::<f32>() as f64 / scored.len() as f64;
    Some((avg * 100.0).round() / 100.0)
}
