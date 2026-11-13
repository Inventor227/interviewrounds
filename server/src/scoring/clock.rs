//! Round time: milliseconds since the round started on the server clock, pauses left out. Turn times
//! (`turns.started_ms`) are already round time; everything else (transcript marks stamped by the headset's clock,
//! Fish item times, server receive times) goes through [`RoundClock`] so evidence, answers and pauses share one
//! clock.

/// Maps server wall time and headset (client) time to round time.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoundClock {
    /// Server wall time (epoch ms) when the round started.
    pub start_wall_ms: i64,
    /// Paused spans in server wall time (start, end), sorted and not overlapping.
    pub pauses: Vec<(i64, i64)>,
    /// Server wall time minus headset time (epoch ms), estimated from the marks.
    pub client_offset_ms: i64,
}

/// Anything below this is already relative time, not an epoch timestamp (1e11 ms is 1973).
const EPOCH_FLOOR_MS: i64 = 100_000_000_000;

impl RoundClock {
    /// `pauses` are (start, end) in server wall time, in any order; an open pause ends at `i64::MAX`.
    pub fn new(start_wall_ms: i64, mut pauses: Vec<(i64, i64)>, client_offset_ms: i64) -> Self {
        pauses.retain(|(a, b)| b > a);
        pauses.sort_unstable();
        let mut merged: Vec<(i64, i64)> = Vec::new();
        for (a, b) in pauses {
            match merged.last_mut() {
                Some(last) if a <= last.1 => last.1 = last.1.max(b),
                _ => merged.push((a, b)),
            }
        }
        RoundClock {
            start_wall_ms,
            pauses: merged,
            client_offset_ms,
        }
    }

    /// Round time of a server wall time: elapsed since the start, minus the paused time before it. A time
    /// inside a pause maps to the moment the pause began.
    pub fn wall_to_round(&self, wall_ms: i64) -> i64 {
        let mut paused = 0i64;
        for &(a, b) in &self.pauses {
            // Only the part of a pause after the round started counts.
            let a = a.max(self.start_wall_ms);
            if b <= a {
                continue;
            }
            if wall_ms <= a {
                break;
            }
            paused += wall_ms.min(b) - a;
        }
        (wall_ms - self.start_wall_ms - paused).max(0)
    }

    /// Round time of a headset timestamp. Values that are already relative (old clients) pass through.
    pub fn client_to_round(&self, client_ms: i64) -> i64 {
        if client_ms < EPOCH_FLOOR_MS {
            return client_ms.max(0);
        }
        self.wall_to_round(client_ms.saturating_add(self.client_offset_ms))
    }

    /// Headset clock offset: the median of (server receive time − headset final time) over the marks. The
    /// network delay is small and the median ignores the odd late delivery.
    pub fn offset_from(pairs: &[(i64, i64)]) -> i64 {
        let mut d: Vec<i64> = pairs
            .iter()
            .filter(|(_, client)| *client >= EPOCH_FLOOR_MS)
            .map(|(received, client)| received - client)
            .collect();
        if d.is_empty() {
            return 0;
        }
        d.sort_unstable();
        d[d.len() / 2]
    }
}

/// One `ui.event` as a hold toggle: (wall ms, pause?, outage kind?), or `None` for other events.
pub fn hold_toggle(data: &serde_json::Value, wall_ms: i64) -> Option<(i64, bool, bool)> {
    let outage = matches!(data["reason"].as_str(), Some("degraded" | "model_back"));
    match data["kind"].as_str() {
        Some("pause") => Some((wall_ms, true, outage)),
        Some("resume") => Some((wall_ms, false, outage)),
        _ => None,
    }
}

/// Held spans from pause/resume events of two kinds, each paired within its own kind (server wall time, in order):
/// the model outage (`degraded: true`: `pause/degraded` then `resume/model_back`) and everything else (user pauses,
/// dropped sockets, restarts). The kinds overlap in any order; [`RoundClock::new`] merges the spans into their
/// union. An outage still open at the end runs to `end_ms` (the clock stayed held to the end); an open user pause is
/// dropped as in [`pause_spans`].
pub fn hold_spans(events: &[(i64, bool, bool)], end_ms: i64) -> Vec<(i64, i64)> {
    let of = |degraded: bool| -> Vec<(i64, bool)> {
        events
            .iter()
            .filter(|e| e.2 == degraded)
            .map(|e| (e.0, e.1))
            .collect()
    };
    let mut spans = pause_spans(&of(false), end_ms);
    let outage = of(true);
    spans.extend(pause_spans(&outage, end_ms));
    // The last outage pause with no resume after it held the clock to the end.
    let mut open: Option<i64> = None;
    for &(at, is_pause) in &outage {
        match (is_pause, open) {
            (true, None) => open = Some(at),
            (false, Some(_)) => open = None,
            _ => {}
        }
    }
    if let Some(a) = open
        && end_ms > a
    {
        spans.push((a, end_ms));
    }
    spans
}

/// Paused spans from pause/resume events (server wall time, in order). A pause with no resume is ignored.
pub fn pause_spans(events: &[(i64, bool)], end_ms: i64) -> Vec<(i64, i64)> {
    let mut spans = Vec::new();
    let mut open: Option<i64> = None;
    for &(at, is_pause) in events {
        match (is_pause, open) {
            (true, None) => open = Some(at),
            (false, Some(a)) => {
                spans.push((a, at));
                open = None;
            }
            _ => {}
        }
    }
    // A pause never resumed is the round ending while paused: the clock ran again for the closing lines, so
    // it does not count (`end_ms` is kept for callers that want to cap it).
    let _ = (open, end_ms);
    spans
}
