//! `/ws/session/{id}` (docs/protocol.md, WebSocket).
//!
//! One `Hub` per session holds the numbered server frames (replayed after a reconnect), the per-token record
//! of processed client frames (`ack`), and drives the round: a `round.state` snapshot every second while the round
//! is live or paused and on every change, the time check at each phase boundary, saving turns and the live state,
//! and ending the session (hard stop, wall-clock ceiling, closing line, browser gone too long).
//!
//! The round clock runs only while the round has started, is not paused, and at least one socket is connected.
//! After the end the hub stays up through scoring (`report.progress`, `report.ready` go out on it) and closes
//! its sockets with 4409 once the report is done, or after `scoring_hold`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::{Mutex, Notify, broadcast};
use uuid::Uuid;

use crate::app::AppState;
use crate::error::AppError;
use crate::live_board::{self, LiveBoard};
use crate::orchestrator::markers::EventKind;
use crate::orchestrator::{ServerEvent, SessionState, SessionStatus, oai};
use crate::persist::{self, TokenRecord};
use crate::scoring::ReportEvents;

pub const CLOSE_BAD_TOKEN: u16 = 4401;
pub const CLOSE_UNKNOWN_SESSION: u16 = 4404;
pub const CLOSE_ENDED: u16 = 4409;
/// Server restart: transient, the browser reconnects.
pub const CLOSE_RESTART: u16 = 1012;
/// A frame could not be saved: transient, the browser reconnects and sends it again (it was not acked).
const CLOSE_RETRY: u16 = 1011;
/// The socket fell too far behind the broadcast: transient, the reconnect replays what it missed.
const CLOSE_LAGGED: u16 = 1013;
/// Nothing heard from the client for too long, or too many frames: transient.
const CLOSE_GOING_AWAY: u16 = 1001;
const CLOSE_POLICY: u16 = 1008;

/// Numbered frames kept in memory per session (all of them stay in `session_frames` until the hub closes).
const BUFFER_FRAMES: usize = 2000;
/// Largest replay read from the database.
const REPLAY_LIMIT: i64 = 5000;
/// Largest client message.
pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// Client frames allowed per second on one socket.
const FRAMES_PER_SECOND: u32 = 60;
/// Per-frame stored-size limits.
const MAX_HEAD_SAMPLES: usize = 100;
const MAX_TEXT_CHARS: usize = 2000;
const MAX_OP_ARGS_BYTES: usize = 16 * 1024;
const MAX_BOARD_OPS: i64 = 5000;

/// Playback reports applied to the live turn logic. Replies to speech can be parked until they are known to
/// have been played (Fish drafts speculative replies it never plays); the browser reports the first words it
/// heard (`voice.spoken`), and the end of a session settles what is still parked against Fish's transcript.
pub trait Playback {
    /// The browser heard `heard` (the start of a reply) from `panelist_id`. Returns whether a parked reply matched.
    fn played(&mut self, panelist_id: &str, heard: &str, now: Instant) -> bool;
    /// At the end: commits the parked reply Fish played last (`fish_last`, its newest assistant line) and drops
    /// the rest.
    fn settle_unplayed(&mut self, fish_last: Option<&str>, now: Instant);
}

/// Replies to speech are parked until played (`SessionState::confirm_spoken`); at the end the floor panelist's
/// parked replies are settled against Fish's newest line and the rest are dropped.
impl Playback for SessionState {
    fn played(&mut self, panelist_id: &str, heard: &str, _now: Instant) -> bool {
        let before = self.recent_commits.back().copied();
        // The actions of the committed reply are broadcast on the session's event channel.
        let _ = self.confirm_spoken(panelist_id, heard);
        self.recent_commits.back().copied() != before
    }

    fn settle_unplayed(&mut self, fish_last: Option<&str>, _now: Instant) {
        if fish_last.is_some() {
            let floor = self.floor.clone();
            let _ = self.resolve_provisional(&floor, fish_last);
        }
        let _ = self.flush_provisional();
    }
}

/// Scoring progress goes out on the session's socket (docs/protocol.md: `report.progress`, `report.ready`,
/// `error {code: "report_failed"}`).
pub struct SocketReportEvents(pub AppState);

#[async_trait::async_trait]
impl ReportEvents for SocketReportEvents {
    async fn progress(&self, session_id: &str, stage: &str, pct: u8) {
        send_to_session(
            &self.0,
            session_id,
            "report.progress",
            json!({"stage": stage, "pct": pct}),
        )
        .await;
    }

    async fn card(&self, session_id: &str, card: &Value) {
        send_to_session(
            &self.0,
            session_id,
            "report.progress",
            json!({"stage": "card", "pct": 50, "card": card}),
        )
        .await;
    }

    async fn ready(&self, session_id: &str) {
        send_to_session(
            &self.0,
            session_id,
            "report.ready",
            json!({ "session_id": session_id }),
        )
        .await;
    }

    async fn failed(&self, session_id: &str) {
        send_to_session(
            &self.0,
            session_id,
            "error",
            json!({"code": "report_failed", "message": "The report could not be made. Try again."}),
        )
        .await;
    }
}

/// Timing of the live session machinery (tests shorten it).
#[derive(Clone, Debug)]
pub struct SessionTiming {
    /// `round.state` tick and housekeeping interval.
    pub tick: Duration,
    /// A started round with no socket for this long ends with `disconnected` (also the resume window).
    pub offline_limit: Duration,
    /// A created session that never got a socket is abandoned after this.
    pub start_limit: Duration,
    /// Time allowed for the first frame (`hello`).
    pub hello_timeout: Duration,
    /// After an end is requested, the round ends this long after the closing line ...
    pub closing_grace: Duration,
    /// ... or this long after the request, whichever comes first.
    pub ending_limit: Duration,
    /// Wall-clock ceiling: a round ends once its total pause (user pauses and time offline) passes this.
    pub pause_limit: Duration,
    /// How long the socket stays open for the report after the end.
    pub scoring_hold: Duration,
    /// A socket that sends nothing (not even a ping) for this long is closed.
    pub read_timeout: Duration,
    /// How often the background sweep runs.
    pub janitor: Duration,
}

impl Default for SessionTiming {
    fn default() -> Self {
        SessionTiming {
            tick: Duration::from_secs(1),
            offline_limit: Duration::from_secs(180),
            start_limit: Duration::from_secs(600),
            hello_timeout: Duration::from_secs(10),
            closing_grace: Duration::from_secs(3),
            ending_limit: Duration::from_secs(20),
            pause_limit: Duration::from_secs(600),
            scoring_hold: Duration::from_secs(120),
            read_timeout: Duration::from_secs(45),
            janitor: Duration::from_secs(30),
        }
    }
}

#[derive(Clone, Debug)]
pub enum Out {
    Frame(Arc<Value>),
    /// Close sockets: all of them, or only those of the listed tokens.
    Close {
        code: u16,
        reason: &'static str,
        tokens: Option<Vec<i64>>,
    },
}

/// An end that was asked for (the browser's "end", or the interviewer's `end_round`): the closing line is
/// spoken first, then the round ends.
#[derive(Clone, Debug)]
struct Ending {
    since: Instant,
    reason: String,
    /// Turn count when it was asked for; the closing line is a reply to `[event: ending]` after it.
    turns_at: usize,
    closing_done: Option<Instant>,
}

struct HubInner {
    next_seq: u64,
    buffer: VecDeque<Arc<Value>>,
    connections: usize,
    disconnected_since: Option<Instant>,
    attached_at: Instant,
    /// When the round started (first hello), for the wall-clock ceiling.
    wall_start: Option<DateTime<Utc>>,
    ended: bool,
    last_sig: Option<String>,
    /// Phase index whose boundary already got its `time_check_due` frame.
    flagged_phase: Option<usize>,
    saved_turns: usize,
    saved_key: String,
    last_seen_saved: Option<Instant>,
    ending: Option<Ending>,
    /// The round clock is held after the socket dropped (or the server restarted) mid-round. A reconnect alone
    /// does not restart it (the browser reconnects at the mic tap, before the user is back in the room); the next
    /// live turn or `ui.event resume` does (`Hub::wake`).
    held: bool,
    /// The hold was logged as a pause event; its end is logged as a resume.
    held_logged: bool,
}

pub struct Hub {
    pub session_id: Uuid,
    tx: broadcast::Sender<Out>,
    inner: Mutex<HubInner>,
    acks: std::sync::Mutex<HashMap<i64, u64>>,
    /// `uses_whiteboard` per phase, for the `round.state` phases list.
    whiteboard: Vec<bool>,
    /// Serialises Fish bookkeeping (join, resume, settlement) for this session.
    pub fish_lock: Mutex<()>,
    /// Keeps numbered frames in seq order.
    emit_lock: Mutex<()>,
    /// Voice handed out per panelist for its open Fish session (a repeated join gets the same one).
    pub voices: std::sync::Mutex<HashMap<String, (String, Value)>>,
    /// Last prompt cache prewarm.
    pub last_prewarm: std::sync::Mutex<Option<Instant>>,
    /// The board item the user last touched or created (`board.focus`); the Scribe resolves "that" with it.
    focus: std::sync::Mutex<Option<String>>,
    report_done: Notify,
    /// The round's board (`None` for rounds without one).
    pub board: Mutex<Option<LiveBoard>>,
}

fn frame(t: &str, seq: u64, d: Value) -> Value {
    json!({"t": t, "seq": seq, "d": d})
}

impl Hub {
    /// Sends a numbered frame (stored, then broadcast; replayed after reconnects). Returns its seq.
    pub async fn emit(&self, db: &PgPool, t: &str, d: Value) -> u64 {
        // Emits run one at a time (seq order = broadcast order); the state lock is held only briefly, so a slow
        // database does not stall the driver or the socket bookkeeping.
        let _order = self.emit_lock.lock().await;
        let seq = {
            let mut h = self.inner.lock().await;
            let seq = h.next_seq;
            h.next_seq += 1;
            seq
        };
        let f = Arc::new(frame(t, seq, d));
        // Stored before it is broadcast, so a socket replaying from the database cannot miss it.
        let res = sqlx::query(
            "insert into session_frames (session_id, seq, frame) values ($1, $2, $3) on conflict do nothing",
        )
        .bind(self.session_id)
        .bind(seq as i64)
        .bind(f.as_ref())
        .execute(db)
        .await;
        if let Err(err) = res {
            tracing::warn!(session_id = %self.session_id, error = %err, "could not store a server frame");
        }
        let mut h = self.inner.lock().await;
        h.buffer.push_back(f.clone());
        while h.buffer.len() > BUFFER_FRAMES {
            h.buffer.pop_front();
        }
        let _ = self.tx.send(Out::Frame(f));
        seq
    }

    /// Sends an unnumbered frame (`seq: 0`, never replayed).
    pub fn send0(&self, t: &str, d: Value) {
        let _ = self.tx.send(Out::Frame(Arc::new(frame(t, 0, d))));
    }

    /// The round is over: `round.ended` now; the sockets stay for the report and close with 4409 once it is
    /// done (`send_to_session` with `report.ready`) or after `scoring_hold`.
    /// `report_coming`: false for a round with nothing to score (the sockets close right away).
    pub async fn finish(self: &Arc<Self>, app: &AppState, reason: &str, report_coming: bool) {
        {
            let mut h = self.inner.lock().await;
            if h.ended {
                return;
            }
            h.ended = true;
        }
        self.emit(&app.db, "round.ended", json!({ "reason": reason }))
            .await;
        let (hub, app) = (self.clone(), app.clone());
        tokio::spawn(async move {
            if report_coming {
                tokio::select! {
                    _ = hub.report_done.notified() => {}
                    _ = tokio::time::sleep(app.timing.scoring_hold) => {}
                }
            }
            hub.close_all(CLOSE_ENDED, "session ended");
            app.hubs.remove(&hub.session_id.to_string());
            let _ = sqlx::query("delete from session_frames where session_id = $1")
                .bind(hub.session_id)
                .execute(&app.db)
                .await;
        });
    }

    /// Closes the sockets of revoked tokens with 4401.
    pub fn kick(&self, tokens: Vec<i64>) {
        if tokens.is_empty() {
            return;
        }
        let _ = self.tx.send(Out::Close {
            code: CLOSE_BAD_TOKEN,
            reason: "token expired",
            tokens: Some(tokens),
        });
    }

    pub fn close_all(&self, code: u16, reason: &'static str) {
        let _ = self.tx.send(Out::Close {
            code,
            reason,
            tokens: None,
        });
    }

    fn ack_for(&self, token_id: i64) -> u64 {
        self.acks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&token_id)
            .copied()
            .unwrap_or(0)
    }

    fn set_ack(&self, token_id: i64, seq: u64) {
        let mut acks = self.acks.lock().unwrap_or_else(|e| e.into_inner());
        let e = acks.entry(token_id).or_insert(0);
        *e = (*e).max(seq);
    }

    /// The board item in focus (latest `board.focus`).
    pub fn focus(&self) -> Option<String> {
        self.focus.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub async fn connections(&self) -> usize {
        self.inner.lock().await.connections
    }

    pub async fn is_ended(&self) -> bool {
        self.inner.lock().await.ended
    }

    /// An end has been asked for and the closing line may still be spoken.
    pub async fn is_ending(&self) -> bool {
        let h = self.inner.lock().await;
        h.ending.is_some() && !h.ended
    }

    /// Asks for the end: the round ends after the closing line (or `ending_limit`). Kept: the first reason.
    pub async fn request_end(&self, reason: &str, turns_now: usize, closing_done: bool) {
        let mut h = self.inner.lock().await;
        match h.ending.as_mut() {
            None => {
                h.ending = Some(Ending {
                    since: Instant::now(),
                    reason: reason.to_string(),
                    turns_at: turns_now,
                    closing_done: closing_done.then(Instant::now),
                });
            }
            // The interviewer's end_round after the user asked to end: the closing line is spoken, so the
            // round ends after the grace instead of waiting for the ending limit. The user's reason stays.
            Some(e) if closing_done && e.closing_done.is_none() => {
                e.closing_done = Some(Instant::now());
            }
            Some(_) => {}
        }
    }

    /// The user is back (a live turn, or `ui.event resume`): a clock held since a socket drop or a restart runs
    /// again. A reconnect alone never does this.
    pub async fn wake(&self, app: &AppState, handle: &Mutex<SessionState>) {
        let (logged, connected) = {
            let mut h = self.inner.lock().await;
            if !h.held {
                return;
            }
            h.held = false;
            let connected = h.connections > 0;
            // Without a socket the clock stays stopped; the resume is logged when the next connect runs it.
            let logged = connected && std::mem::take(&mut h.held_logged);
            (logged, connected)
        };
        let at_ms = {
            let mut st = handle.lock().await;
            let now = Instant::now();
            if st.status == SessionStatus::Live && connected {
                run_clock(&mut st, now);
            }
            st.elapsed_ms(now) as i64
        };
        if logged {
            let d = json!({"kind": "resume", "reason": "back", "at_ms": at_ms});
            if let Err(err) = store_event(app, self.session_id, "ui.event", &d).await {
                tracing::warn!(session_id = %self.session_id, error = %err, "could not log the return");
            }
        }
    }

    /// How long the round has had no socket (None while one is connected, or once ended).
    pub async fn offline_for(&self) -> Option<Duration> {
        let h = self.inner.lock().await;
        if h.connections > 0 || h.ended {
            return None;
        }
        h.disconnected_since.map(|t| t.elapsed())
    }

    /// Frames with seq above `last_seq`, from memory or (when older than the buffer) from the database.
    async fn frames_after(&self, db: &PgPool, last_seq: u64) -> Vec<Arc<Value>> {
        {
            let h = self.inner.lock().await;
            let front = h
                .buffer
                .front()
                .and_then(|f| f["seq"].as_u64())
                .unwrap_or(h.next_seq);
            if front <= last_seq + 1 {
                return h
                    .buffer
                    .iter()
                    .filter(|f| f["seq"].as_u64().unwrap_or(0) > last_seq)
                    .cloned()
                    .collect();
            }
        }
        let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
            "select frame from session_frames where session_id = $1 and seq > $2 order by seq limit $3",
        )
        .bind(self.session_id)
        .bind(last_seq as i64)
        .bind(REPLAY_LIMIT)
        .fetch_all(db)
        .await;
        rows.unwrap_or_default().into_iter().map(Arc::new).collect()
    }
}

/// Hubs by session id.
#[derive(Clone, Default)]
pub struct Hubs {
    inner: Arc<RwLock<HashMap<String, Arc<Hub>>>>,
}

impl Hubs {
    pub fn get(&self, id: &str) -> Option<Arc<Hub>> {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    pub fn remove(&self, id: &str) -> Option<Arc<Hub>> {
        self.inner
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
    }

    /// Closes every live socket (graceful shutdown: 1012, so browsers reconnect to the next server).
    pub fn close_all(&self, code: u16, reason: &'static str) {
        for hub in self
            .inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            hub.close_all(code, reason);
        }
    }
}

/// Sends a numbered frame to a session's sockets (scoring uses it for `report.progress`, `report.ready`, and
/// `error {code: "report_failed"}`). `report.ready` and `report_failed` end the socket's scoring hold: the
/// sockets then close with 4409. Returns false when the session has no hub (nobody is listening).
pub async fn send_to_session(app: &AppState, session_id: &str, t: &str, d: Value) -> bool {
    let Some(hub) = app.hubs.get(session_id) else {
        return false;
    };
    let terminal = t == "report.ready" || (t == "error" && d["code"] == "report_failed");
    hub.emit(&app.db, t, d).await;
    if terminal {
        hub.report_done.notify_one();
    }
    true
}

type Seen = Option<DateTime<Utc>>;

/// Creates the hub of a live session (once) and starts its driver and event forwarder.
pub async fn attach(app: &AppState, id: Uuid, handle: Arc<Mutex<SessionState>>) -> Arc<Hub> {
    let key = id.to_string();
    if let Some(hub) = app.hubs.get(&key) {
        return hub;
    }
    let stored: Vec<Value> = sqlx::query_scalar(
        "select frame from (select seq, frame from session_frames where session_id = $1 \
           order by seq desc limit $2) f order by seq",
    )
    .bind(id)
    .bind(BUFFER_FRAMES as i64)
    .fetch_all(&app.db)
    .await
    .unwrap_or_default();
    let next_seq = stored
        .last()
        .and_then(|f| f["seq"].as_u64())
        .map_or(1, |s| s + 1);
    // A started round reloaded after a restart counts as offline since its last socket.
    let seen: Option<(Seen, Seen)> =
        sqlx::query_as("select started_at, last_socket_at from sessions where id = $1")
            .bind(id)
            .fetch_optional(&app.db)
            .await
            .unwrap_or_default();
    let (started_at, last_socket_at) = seen.unwrap_or_default();
    let focus: Option<String> =
        sqlx::query_scalar("select board_focus from sessions where id = $1")
            .bind(id)
            .fetch_optional(&app.db)
            .await
            .ok()
            .flatten()
            .flatten();
    let now = Instant::now();
    let disconnected_since = started_at.map(|_| {
        let gone = last_socket_at
            .map(|t| (Utc::now() - t).to_std().unwrap_or_default())
            .unwrap_or_default();
        now.checked_sub(gone).unwrap_or(now)
    });
    let (whiteboard, events, board) = {
        let mut st = handle.lock().await;
        let mut board = LiveBoard::load(&app.db, id, &st).await;
        if let Some(lb) = board.as_mut()
            && lb.session.rev() > 0
        {
            // Reloaded with a drawn board: the interviewer sees it on the next turn.
            lb.refresh_text(&mut st);
        }
        (
            st.round.phases.iter().map(|p| p.uses_whiteboard).collect(),
            st.events.subscribe(),
            board,
        )
    };
    let prewarm = board
        .as_ref()
        .map(|lb| (lb.session.board.clone(), handle.clone()));
    // A live round loaded after a restart is held until the user is back; the hold is logged as a pause so the
    // report's round time leaves it out too.
    let restart_pause: Option<i64> = match started_at {
        Some(_) => {
            let st = handle.lock().await;
            (st.status == SessionStatus::Live).then(|| st.elapsed_ms(Instant::now()) as i64)
        }
        None => None,
    };
    let (tx, _) = broadcast::channel(256);
    let hub = Arc::new(Hub {
        session_id: id,
        tx,
        inner: Mutex::new(HubInner {
            next_seq,
            buffer: stored.into_iter().map(Arc::new).collect(),
            connections: 0,
            disconnected_since,
            attached_at: now,
            wall_start: started_at,
            ended: false,
            last_sig: None,
            flagged_phase: None,
            saved_turns: 0,
            saved_key: String::new(),
            last_seen_saved: None,
            ending: None,
            // A started round loaded after a restart waits for the user like one whose socket dropped.
            held: started_at.is_some(),
            held_logged: restart_pause.is_some(),
        }),
        acks: std::sync::Mutex::new(HashMap::new()),
        whiteboard,
        fish_lock: Mutex::new(()),
        emit_lock: Mutex::new(()),
        voices: std::sync::Mutex::new(HashMap::new()),
        last_prewarm: std::sync::Mutex::new(None),
        focus: std::sync::Mutex::new(focus),
        report_done: Notify::new(),
        board: Mutex::new(board),
    });
    {
        let mut map = app.hubs.inner.write().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(&key) {
            return existing.clone();
        }
        map.insert(key, hub.clone());
    }
    if let Some(at_ms) = restart_pause {
        let d = json!({"kind": "pause", "reason": "restart", "at_ms": at_ms});
        if let Err(err) = store_event(app, id, "ui.event", &d).await {
            tracing::warn!(session_id = %id, error = %err, "could not log the restart hold");
        }
    }
    if let Some((board, handle)) = prewarm {
        let round_type = handle.lock().await.round.round_type.clone();
        live_board::prewarm_scribe(app, id, board, round_type);
    }
    tokio::spawn(forward_events(app.clone(), hub.clone(), events));
    tokio::spawn(drive(app.clone(), hub.clone(), handle));
    hub
}

// ---------- round state ----------

/// Where the current phase ends on the round clock.
fn boundary_ms(st: &SessionState) -> u64 {
    let minutes: f64 = st
        .round
        .phases
        .iter()
        .take(st.phase_idx + 1)
        .map(|p| p.minutes)
        .sum();
    (minutes * 60_000.0) as u64
}

/// The current phase is out of time and no `[event: time_check]` has arrived since.
pub fn time_check_owed(st: &SessionState, now: Instant) -> bool {
    let b = boundary_ms(st);
    st.status == SessionStatus::Live
        && st.elapsed_ms(now) >= b
        && !st
            .turns
            .iter()
            .any(|t| t.speaker == "app" && t.text == EventKind::TimeCheck.marker() && t.at_ms >= b)
}

fn round_state_value(hub: &Hub, mut v: Value, time_check_due: bool) -> Value {
    if let Some(phases) = v.get_mut("phases").and_then(Value::as_array_mut) {
        for (p, wb) in phases.iter_mut().zip(&hub.whiteboard) {
            p["uses_whiteboard"] = json!(wb);
        }
    }
    v["time_check_due"] = json!(time_check_due);
    v
}

/// What makes a `round.state` a change (the clock fields are not).
fn sig(v: &Value) -> String {
    format!(
        "{}|{}|{}|{}",
        v["status"], v["phase_index"], v["floor"], v["brief"]
    )
}

fn state_value(hub: &Hub, st: &SessionState, now: Instant, time_check_due: bool) -> Value {
    let v = serde_json::to_value(st.round_state(now)).unwrap_or(Value::Null);
    round_state_value(hub, v, time_check_due)
}

/// Pauses the round clock (no-op when already stopped).
pub fn stop_clock(st: &mut SessionState, now: Instant) {
    if st.paused_since.is_none() {
        st.paused_since = Some(now);
    }
}

/// Restarts the round clock.
pub fn run_clock(st: &mut SessionState, now: Instant) {
    if let Some(since) = st.paused_since.take() {
        st.paused_total_ms += now.saturating_duration_since(since).as_millis() as u64;
    }
}

async fn set_db_status(db: &PgPool, id: Uuid, status: &str) {
    let res = sqlx::query(
        "update sessions set status = $2 where id = $1 and status in ('created', 'live', 'paused')",
    )
    .bind(id)
    .bind(status)
    .execute(db)
    .await;
    if let Err(err) = res {
        tracing::warn!(session_id = %id, error = %err, "could not save the session status");
    }
}

/// Tool events from the live turns go to the browser: `round.state` as a snapshot, the rest numbered.
async fn forward_events(
    app: AppState,
    hub: Arc<Hub>,
    mut events: broadcast::Receiver<ServerEvent>,
) {
    loop {
        let ev = match events.recv().await {
            Ok(ev) => ev,
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!(session_id = %hub.session_id, missed = n, "event forwarder lagged");
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => break,
        };
        if hub.is_ended().await {
            break;
        }
        let value = serde_json::to_value(&ev).unwrap_or(Value::Null);
        let t = value["t"].as_str().unwrap_or("").to_string();
        let d = value["d"].clone();
        match ev {
            ServerEvent::RoundState(_) => {
                let v = round_state_value(&hub, d, false);
                hub.inner.lock().await.last_sig = Some(sig(&v));
                hub.send0("round.state", v);
            }
            ServerEvent::Hint { level, at_ms, .. } => {
                // For the report's hint timeline; the browser learns of hints from the spoken line.
                if let Err(err) = store_event(
                    &app,
                    hub.session_id,
                    "hint",
                    &json!({"level": level, "at_ms": at_ms}),
                )
                .await
                {
                    tracing::warn!(session_id = %hub.session_id, error = %err, "could not store a hint");
                }
            }
            other => {
                if matches!(other, ServerEvent::RoundEnding { .. }) {
                    // end_round comes with the closing line already spoken.
                    hub.request_end("completed", 0, true).await;
                }
                hub.emit(&app.db, &t, d).await;
            }
        }
    }
}

/// The closing line after an end request: an agent turn following `[event: ending]`.
fn closing_spoken(st: &SessionState, from: usize) -> bool {
    let turns = &st.turns[from.min(st.turns.len())..];
    turns
        .iter()
        .position(|t| t.speaker == "app" && t.text == EventKind::Ending.marker())
        .is_some_and(|i| {
            turns[i + 1..]
                .iter()
                .any(|t| t.speaker != "app" && t.speaker != "candidate")
        })
}

/// How long an armed closing line waits for an app event to answer before the server asks the browser to end.
pub const CLOSING_NUDGE_MS: u64 = 5_000;

/// The per-session loop: state ticks, time checks, saving, and the end conditions.
async fn drive(app: AppState, hub: Arc<Hub>, handle: Arc<Mutex<SessionState>>) {
    let timing = app.timing.clone();
    let mut tick = tokio::time::interval(timing.tick);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let now = Instant::now();

        let (v, owed, phase_idx, status, elapsed_ms, hard_stop_ms, key, snap, speech_commits) = {
            let mut st = handle.lock().await;
            // A round with its own closing line (a retry) says it at its time, with no model call: armed here,
            // asked for with a time check, spoken on the next app event (`SessionState::arm_timed_close`).
            if st.arm_timed_close(now) {
                tracing::info!(session_id = %hub.session_id, "closing line due");
            }
            let owed = time_check_owed(&st, now);
            let elapsed = st.elapsed_ms(now);
            let key = format!(
                "{}|{}|{}|{}|{:?}|{}|{}|{}|{}",
                st.turns.len(),
                st.history.len(),
                st.phase_idx,
                st.floor,
                st.status,
                st.brief.as_ref().map_or(0, |b| b.lines.len() + 1),
                st.turns.iter().filter(|t| t.interrupted).count(),
                st.pending_notes.len(),
                elapsed / 10_000,
            );
            (
                state_value(&hub, &st, now, false),
                owed,
                st.phase_idx,
                st.status,
                elapsed,
                (st.round.hard_stop_minutes * 60_000.0) as u64,
                key.clone(),
                persist::snapshot(&st, now),
                st.speech_commits,
            )
        };
        // The armed closing line found no app event to answer (the time check was missed): the server asks the
        // browser to end, and its `[event: ending]` gets the line. The ending limit stops the round if even that
        // never comes.
        let overdue = {
            let st = handle.lock().await;
            st.closing_overdue(now, CLOSING_NUDGE_MS)
                .map(|line| (line, st.turns.len()))
        };
        if let Some((line, turns)) = overdue
            && !hub.is_ending().await
        {
            tracing::info!(session_id = %hub.session_id, "closing line overdue; asking the browser to end");
            hub.request_end("completed", turns, false).await;
            hub.emit(&app.db, "round.ending", json!({ "closing_line": line }))
                .await;
        }
        // A reply to the candidate's speech was committed without a playback report (Fish's next request
        // confirmed it): the Scribe catches up here.
        let scribe_due = hub
            .board
            .lock()
            .await
            .as_ref()
            .is_some_and(|lb| lb.scribe_due(speech_commits));
        if scribe_due {
            live_board::after_utterance(&app, &hub, &handle);
        }
        // The closing line of a requested end, checked against the state outside the hub lock.
        let closing = {
            let from = hub.inner.lock().await.ending.as_ref().map(|e| e.turns_at);
            match from {
                Some(from) => closing_spoken(&*handle.lock().await, from),
                None => false,
            }
        };

        let (connections, save_from, save, write_seen, end) = {
            let mut h = hub.inner.lock().await;
            if h.ended {
                break;
            }
            let s = sig(&v);
            if owed && h.flagged_phase != Some(phase_idx) {
                h.flagged_phase = Some(phase_idx);
                h.last_sig = Some(s);
                hub.send0("round.state", round_state_value(&hub, v, true));
            } else if h.last_sig.as_deref() != Some(s.as_str()) {
                h.last_sig = Some(s);
                hub.send0("round.state", v);
            } else if h.connections > 0
                && matches!(status, SessionStatus::Live | SessionStatus::Paused)
            {
                hub.send0("round.state", v);
            }

            let save = h.saved_key != key;
            let save_from = h.saved_turns.saturating_sub(2);
            if save {
                h.saved_key = key;
            }
            let write_seen = h.connections > 0
                && h.last_seen_saved
                    .is_none_or(|t| now.duration_since(t) >= Duration::from_secs(15));
            if write_seen {
                h.last_seen_saved = Some(now);
            }

            if let Some(e) = h.ending.as_mut()
                && e.closing_done.is_none()
                && closing
            {
                e.closing_done = Some(now);
            }
            // Total pause so far: wall time since the start minus round time.
            let paused_ms = h.wall_start.map_or(0, |start| {
                ((Utc::now() - start).num_milliseconds().max(0) as u64).saturating_sub(elapsed_ms)
            });
            let end: Option<String> = if let Some(e) = &h.ending {
                let done = e
                    .closing_done
                    .is_some_and(|t| now.duration_since(t) >= timing.closing_grace)
                    || now.duration_since(e.since) >= timing.ending_limit;
                done.then(|| e.reason.clone())
            } else if status != SessionStatus::Created && elapsed_ms >= hard_stop_ms {
                Some("time_limit".into())
            } else if status != SessionStatus::Created
                && paused_ms >= timing.pause_limit.as_millis() as u64
            {
                // The wall-clock ceiling: hard stop plus at most `pause_limit` of pauses.
                Some("time_limit".into())
            } else if h.connections == 0 && status == SessionStatus::Created {
                (now.duration_since(h.attached_at) >= timing.start_limit)
                    .then(|| "disconnected".into())
            } else if h.connections == 0 {
                h.disconnected_since
                    .is_some_and(|t| now.duration_since(t) >= timing.offline_limit)
                    .then(|| "disconnected".into())
            } else {
                None
            };
            (h.connections, save_from, save, write_seen, end)
        };

        if save {
            match persist::save_live(&app.db, hub.session_id, &snap, save_from).await {
                Ok(()) => hub.inner.lock().await.saved_turns = snap.turns.len(),
                Err(err) => {
                    tracing::warn!(session_id = %hub.session_id, error = %err, "could not save the live state");
                    hub.inner.lock().await.saved_key.clear();
                }
            }
        }
        if write_seen && connections > 0 {
            let _ = sqlx::query("update sessions set last_socket_at = now() where id = $1")
                .bind(hub.session_id)
                .execute(&app.db)
                .await;
        }
        if let Some(reason) = end {
            if let Err(err) = persist::end_session(&app, hub.session_id, &reason).await {
                tracing::error!(session_id = %hub.session_id, error = %format!("{err:#}"), "could not end the session");
                continue;
            }
            break;
        }
    }
}

// ---------- the socket ----------

#[derive(Debug, Deserialize)]
struct Envelope {
    t: String,
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    d: Value,
}

/// `GET /ws/session/{id}`. The upgrade is always accepted; problems are reported with a close code, which
/// browsers can read (a refused upgrade only shows as 1006).
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    State(app): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok())
        && origin.trim_end_matches('/') != app.config.app_origin
    {
        return AppError::Forbidden.into_response();
    }
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| run_socket(app, id, socket))
}

fn text(v: &Value) -> WsMessage {
    WsMessage::Text(v.to_string().into())
}

fn close(code: u16, reason: &str) -> WsMessage {
    WsMessage::Close(Some(CloseFrame {
        code,
        reason: reason.to_string().into(),
    }))
}

fn with_ack(f: &Value, ack: u64) -> Value {
    let mut v = f.clone();
    v["ack"] = json!(ack);
    v
}

pub(crate) fn error_frame(code: &str, message: &str, op_id: Option<&str>) -> Value {
    let mut d = json!({"code": code, "message": message});
    if let Some(op) = op_id {
        d["op_id"] = json!(op);
    }
    frame("error", 0, d)
}

async fn run_socket(app: AppState, id: String, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // hello first
    let first = tokio::time::timeout(app.timing.hello_timeout, stream.next()).await;
    let hello: Option<Envelope> = match first {
        Ok(Some(Ok(WsMessage::Text(t)))) => serde_json::from_str(t.as_str()).ok(),
        _ => None,
    };
    let Some(hello) = hello.filter(|h| h.t == "hello") else {
        let _ = sink.send(close(CLOSE_BAD_TOKEN, "hello expected")).await;
        return;
    };
    let token = hello.d["client_token"].as_str().unwrap_or("").to_string();
    let last_seq = hello.d["last_seq"].as_u64().unwrap_or(0);

    let Ok(uuid) = Uuid::parse_str(&id) else {
        let _ = sink
            .send(close(CLOSE_UNKNOWN_SESSION, "no such session"))
            .await;
        return;
    };
    let row = match persist::fetch_session(&app.db, uuid).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            let _ = sink
                .send(close(CLOSE_UNKNOWN_SESSION, "no such session"))
                .await;
            return;
        }
        Err(err) => {
            tracing::warn!(session_id = %id, error = %err, "socket hello: database error");
            let _ = sink.send(close(1011, "try again")).await;
            return;
        }
    };
    let record = match persist::check_token(&app.db, uuid, &token).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            let _ = sink
                .send(close(CLOSE_BAD_TOKEN, "token unknown or expired"))
                .await;
            return;
        }
        Err(_) => {
            let _ = sink.send(close(1011, "try again")).await;
            return;
        }
    };
    if !row.is_open() {
        // While the report is being made the socket still carries report.progress / report.ready.
        if let Some(hub) = app.hubs.get(&id).filter(|_| row.status == "scoring") {
            let mut rx = hub.tx.subscribe();
            if let Some(msg) = serve_ended(
                &app,
                &hub,
                &record,
                last_seq,
                &mut sink,
                &mut stream,
                &mut rx,
            )
            .await
            {
                let _ = sink.send(msg).await;
            }
        } else {
            let _ = sink.send(close(CLOSE_ENDED, "session ended")).await;
        }
        return;
    }
    let handle = match persist::load_live(&app, uuid).await {
        Ok(Some(h)) => h,
        Ok(None) => {
            let _ = sink.send(close(CLOSE_ENDED, "session ended")).await;
            return;
        }
        Err(err) => {
            tracing::error!(session_id = %id, error = %format!("{err:#}"), "could not load the session");
            let _ = sink.send(close(1011, "try again")).await;
            return;
        }
    };
    let hub = attach(&app, uuid, handle.clone()).await;
    let mut rx = hub.tx.subscribe();
    // A resume may have revoked this token between the check above and the subscription (its kick was sent
    // before we listened).
    if !matches!(
        persist::check_token(&app.db, uuid, &token).await,
        Ok(Some(_))
    ) {
        let _ = sink
            .send(close(CLOSE_BAD_TOKEN, "token unknown or expired"))
            .await;
        return;
    }
    connect(&app, &hub, &handle, record).await;

    let result = serve_socket(
        &app,
        &hub,
        &handle,
        record.token_id,
        last_seq,
        &mut sink,
        &mut stream,
        &mut rx,
    )
    .await;
    if let Some(msg) = result {
        let _ = sink.send(msg).await;
    }
    disconnect(&app, &hub, &handle).await;
}

async fn connect(app: &AppState, hub: &Hub, handle: &Mutex<SessionState>, record: TokenRecord) {
    hub.set_ack(record.token_id, record.last_client_seq);
    let (held, resume_owed) = {
        let mut h = hub.inner.lock().await;
        h.connections += 1;
        h.disconnected_since = None;
        let owed = !h.held && std::mem::take(&mut h.held_logged);
        (h.held, owed)
    };
    let now = Instant::now();
    let started = {
        let mut st = handle.lock().await;
        match st.status {
            SessionStatus::Created => {
                // The round clock starts with the first socket.
                st.started_at = now;
                st.paused_total_ms = 0;
                st.paused_since = None;
                st.status = SessionStatus::Live;
                true
            }
            // Back after a drop: the clock waits for the user's next turn or `ui.event resume`.
            SessionStatus::Live if !held => {
                run_clock(&mut st, now);
                false
            }
            _ => false,
        }
    };
    if started {
        hub.inner.lock().await.wall_start = Some(Utc::now());
    }
    if resume_owed {
        // The user came back while no socket was connected; the clock runs from now.
        let d = json!({"kind": "resume", "reason": "back", "at_ms": elapsed_ms(handle).await});
        if let Err(err) = store_event(app, hub.session_id, "ui.event", &d).await {
            tracing::warn!(session_id = %hub.session_id, error = %err, "could not log the return");
        }
    }
    let res = if started {
        sqlx::query(
            "update sessions set status = 'live', started_at = now(), last_socket_at = now() \
             where id = $1 and status = 'created'",
        )
        .bind(hub.session_id)
        .execute(&app.db)
        .await
    } else {
        sqlx::query("update sessions set last_socket_at = now() where id = $1")
            .bind(hub.session_id)
            .execute(&app.db)
            .await
    };
    match res {
        // The database no longer has it waiting to start: a newer session replaced it. It does not go live.
        Ok(r) if started && r.rows_affected() == 0 => {
            handle.lock().await.status = SessionStatus::Abandoned;
            tracing::info!(session_id = %hub.session_id, "hello for a replaced session");
            hub.close_all(CLOSE_ENDED, "session replaced");
        }
        Ok(_) => {}
        Err(err) => {
            tracing::warn!(session_id = %hub.session_id, error = %err, "could not save the socket start");
        }
    }
}

async fn disconnect(app: &AppState, hub: &Hub, handle: &Mutex<SessionState>) {
    let last = {
        let mut h = hub.inner.lock().await;
        h.connections = h.connections.saturating_sub(1);
        if h.connections == 0 {
            h.disconnected_since = Some(Instant::now());
        }
        h.connections == 0
    };
    if last {
        // A drop while live stops the round clock like a pause; it is logged as one so the report's round time
        // leaves it out too.
        let live_at = {
            let mut st = handle.lock().await;
            let now = Instant::now();
            let live = st.status == SessionStatus::Live;
            let at = live.then(|| st.elapsed_ms(now) as i64);
            stop_clock(&mut st, now);
            at
        };
        if let Some(at_ms) = live_at {
            let started = hub.inner.lock().await.wall_start.is_some();
            if started {
                let mut h = hub.inner.lock().await;
                h.held = true;
                h.held_logged = true;
                drop(h);
                let d = json!({"kind": "pause", "reason": "disconnected", "at_ms": at_ms});
                if let Err(err) = store_event(app, hub.session_id, "ui.event", &d).await {
                    tracing::warn!(session_id = %hub.session_id, error = %err, "could not log the drop");
                }
            }
        }
        let _ = sqlx::query("update sessions set last_socket_at = now() where id = $1")
            .bind(hub.session_id)
            .execute(&app.db)
            .await;
    }
}

/// Client frames allowed on one socket: a burst for the replay after `hello` (the client keeps up to 1,000
/// unacked frames), then `FRAMES_PER_SECOND`.
struct FrameBudget {
    tokens: f64,
    last: Instant,
}

impl FrameBudget {
    const BURST: f64 = 1000.0;
    const STEADY_CAP: f64 = 2.0 * FRAMES_PER_SECOND as f64;

    fn new() -> Self {
        FrameBudget {
            tokens: Self::BURST,
            last: Instant::now(),
        }
    }

    fn take(&mut self) -> bool {
        let now = Instant::now();
        let refill = now.duration_since(self.last).as_secs_f64() * FRAMES_PER_SECOND as f64;
        self.last = now;
        // Refill up to the steady cap; the opening burst is not topped up again once spent.
        self.tokens = (self.tokens + refill).min(self.tokens.max(Self::STEADY_CAP));
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

/// Sends the frames numbered above `last_seq`; returns the highest seq sent.
async fn replay<S>(
    app: &AppState,
    hub: &Hub,
    token_id: i64,
    last_seq: u64,
    sink: &mut S,
) -> Option<u64>
where
    S: futures::Sink<WsMessage> + Unpin,
{
    let mut sent_up_to = last_seq;
    for f in hub.frames_after(&app.db, last_seq).await {
        sent_up_to = sent_up_to.max(f["seq"].as_u64().unwrap_or(0));
        if sink
            .send(text(&with_ack(&f, hub.ack_for(token_id))))
            .await
            .is_err()
        {
            return None;
        }
    }
    Some(sent_up_to)
}

/// A socket of an ended round waiting for its report: replay, then forward frames until the hub closes it.
async fn serve_ended<S, R>(
    app: &AppState,
    hub: &Hub,
    record: &TokenRecord,
    last_seq: u64,
    sink: &mut S,
    stream: &mut R,
    rx: &mut broadcast::Receiver<Out>,
) -> Option<WsMessage>
where
    S: futures::Sink<WsMessage> + Unpin,
    R: futures::Stream<Item = Result<WsMessage, axum::Error>> + Unpin,
{
    hub.set_ack(record.token_id, record.last_client_seq);
    let mut sent_up_to = replay(app, hub, record.token_id, last_seq, sink).await?;
    // Only frames from the client count as signs of life; our own sends do not.
    let mut last_client = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(last_client + app.timing.read_timeout) => {
                return Some(close(CLOSE_GOING_AWAY, "no frames"));
            }
            incoming = stream.next() => {
                last_client = tokio::time::Instant::now();
                match incoming.map(|r| r.map_err(|_| ())) {
                    Some(Ok(WsMessage::Text(t))) => {
                        if let Ok(env) = serde_json::from_str::<Envelope>(t.as_str())
                            && env.t == "ping"
                        {
                            let pong = with_ack(&frame("pong", 0, json!({})), hub.ack_for(record.token_id));
                            if sink.send(text(&pong)).await.is_err() { return None; }
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(())) => return None,
                    Some(Ok(_)) => {}
                }
            }
            out = rx.recv() => match out {
                Ok(Out::Frame(f)) => {
                    let seq = f["seq"].as_u64().unwrap_or(0);
                    if seq > 0 {
                        if seq <= sent_up_to { continue; }
                        sent_up_to = seq;
                    }
                    if sink.send(text(&with_ack(&f, hub.ack_for(record.token_id)))).await.is_err() {
                        return None;
                    }
                }
                Ok(Out::Close { code, reason, tokens }) => {
                    if tokens.as_ref().is_none_or(|t| t.contains(&record.token_id)) {
                        return Some(close(code, reason));
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => return Some(close(CLOSE_LAGGED, "reconnect to catch up")),
                Err(broadcast::error::RecvError::Closed) => return Some(close(CLOSE_ENDED, "session ended")),
            }
        }
    }
}

/// Runs one connection after `hello`. Returns the close frame to send, if any.
#[allow(clippy::too_many_arguments)]
async fn serve_socket<S, R>(
    app: &AppState,
    hub: &Arc<Hub>,
    handle: &Arc<Mutex<SessionState>>,
    token_id: i64,
    last_seq: u64,
    sink: &mut S,
    stream: &mut R,
    rx: &mut broadcast::Receiver<Out>,
) -> Option<WsMessage>
where
    S: futures::Sink<WsMessage> + Unpin,
    R: futures::Stream<Item = Result<WsMessage, axum::Error>> + Unpin,
{
    // Replay what the client missed, then the current state (with the time check if one is still owed).
    let mut sent_up_to = replay(app, hub, token_id, last_seq, sink).await?;
    let snapshot = {
        let st = handle.lock().await;
        let now = Instant::now();
        state_value(hub, &st, now, time_check_owed(&st, now))
    };
    if sink
        .send(text(&with_ack(
            &frame("round.state", 0, snapshot),
            hub.ack_for(token_id),
        )))
        .await
        .is_err()
    {
        return None;
    }

    let mut budget = FrameBudget::new();
    // Only frames from the client count as signs of life; our own sends (the 1 s round.state) do not.
    let mut last_client = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(last_client + app.timing.read_timeout) => {
                return Some(close(CLOSE_GOING_AWAY, "no frames"));
            }
            incoming = stream.next() => {
                last_client = tokio::time::Instant::now();
                let msg = match incoming {
                    Some(Ok(m)) => m,
                    _ => return None,
                };
                let raw = match msg {
                    WsMessage::Text(t) => t.as_str().to_string(),
                    WsMessage::Close(_) => return None,
                    _ => continue,
                };
                let parsed = serde_json::from_str::<Envelope>(&raw);
                // A replayed frame we already processed costs nothing.
                let duplicate = parsed.as_ref().is_ok_and(|e| e.seq > 0 && e.seq <= hub.ack_for(token_id));
                if !duplicate && !budget.take() {
                    return Some(close(CLOSE_POLICY, "too many frames"));
                }
                let Ok(env) = parsed else {
                    let f = with_ack(&error_frame("bad_frame", "Frames are JSON {t, seq, d}.", None), hub.ack_for(token_id));
                    if sink.send(text(&f)).await.is_err() { return None; }
                    continue;
                };
                let (replies, failed) = handle_frame(app, hub, handle, token_id, env).await;
                for reply in replies {
                    if sink.send(text(&with_ack(&reply, hub.ack_for(token_id)))).await.is_err() {
                        return None;
                    }
                }
                if failed {
                    // Not acked, and nothing after it is processed: the client keeps it and sends it again.
                    return Some(close(CLOSE_RETRY, "try again"));
                }
            }
            out = rx.recv() => {
                match out {
                    Ok(Out::Frame(f)) => {
                        let seq = f["seq"].as_u64().unwrap_or(0);
                        if seq > 0 {
                            if seq <= sent_up_to { continue; }
                            sent_up_to = seq;
                        }
                        if sink.send(text(&with_ack(&f, hub.ack_for(token_id)))).await.is_err() {
                            return None;
                        }
                    }
                    Ok(Out::Close { code, reason, tokens }) => {
                        if tokens.as_ref().is_none_or(|t| t.contains(&token_id)) {
                            return Some(close(code, reason));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        return Some(close(CLOSE_LAGGED, "reconnect to catch up"));
                    }
                    Err(broadcast::error::RecvError::Closed) => return Some(close(CLOSE_RESTART, "restarting")),
                }
            }
        }
    }
}

fn str_field<'a>(d: &'a Value, key: &str) -> Option<&'a str> {
    d.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn clip(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// Handles one client frame. Returns direct replies (unnumbered; numbered replies go through the hub) and
/// whether it failed to save (then it is not acked and the connection closes).
async fn handle_frame(
    app: &AppState,
    hub: &Arc<Hub>,
    handle: &Arc<Mutex<SessionState>>,
    token_id: i64,
    env: Envelope,
) -> (Vec<Value>, bool) {
    match env.t.as_str() {
        "ping" => return (vec![frame("pong", 0, json!({}))], false),
        "hello" => return (Vec::new(), false),
        _ => {}
    }
    if env.seq > 0 && env.seq <= hub.ack_for(token_id) {
        // Already processed under this token (a replay after a reconnect).
        return (Vec::new(), false);
    }
    match process(app, hub, handle, &env).await {
        Ok(replies) => {
            if env.seq > 0 {
                hub.set_ack(token_id, env.seq);
                let db = app.db.clone();
                let seq = env.seq;
                tokio::spawn(async move { persist::save_client_seq(&db, token_id, seq).await });
            }
            (replies, false)
        }
        Err(err) => {
            tracing::warn!(session_id = %hub.session_id, t = %env.t, error = %format!("{err:#}"), "client frame failed");
            (
                vec![error_frame(
                    "server_error",
                    "That did not save. It will be sent again.",
                    None,
                )],
                true,
            )
        }
    }
}

async fn elapsed_ms(handle: &Mutex<SessionState>) -> i64 {
    handle.lock().await.elapsed_ms(Instant::now()) as i64
}

async fn store_event(app: &AppState, id: Uuid, kind: &str, d: &Value) -> anyhow::Result<()> {
    sqlx::query(
        "insert into session_events (session_id, kind, at_ms, data) values ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(kind)
    .bind(d.get("at_ms").and_then(Value::as_i64))
    .bind(d)
    .execute(&app.db)
    .await?;
    Ok(())
}

async fn process(
    app: &AppState,
    hub: &Arc<Hub>,
    handle: &Arc<Mutex<SessionState>>,
    env: &Envelope,
) -> anyhow::Result<Vec<Value>> {
    let id = hub.session_id;
    let d = &env.d;
    if hub.is_ended().await {
        // The round is over: frames are acked (so the client stops resending) but nothing more is stored.
        return Ok(Vec::new());
    }
    match env.t.as_str() {
        "board.op" => {
            let (Some(op_id), Some(src), Some(op)) = (
                str_field(d, "op_id"),
                str_field(d, "src"),
                str_field(d, "op"),
            ) else {
                return Ok(vec![error_frame(
                    "op_rejected",
                    "A board op needs op_id, src and op.",
                    d.get("op_id").and_then(Value::as_str),
                )]);
            };
            let args_len = d.get("args").map_or(0, |a| a.to_string().len());
            if args_len > MAX_OP_ARGS_BYTES || op_id.len() > 200 {
                return Ok(vec![error_frame(
                    "op_rejected",
                    "That board op is too large.",
                    Some(op_id),
                )]);
            }
            if hub.board.lock().await.is_some() {
                return live_board::client_op(app, hub, handle, d).await;
            }
            // A round without a board: the op is only stored.
            let t_ms = elapsed_ms(handle).await;
            match store_board_op(&app.db, id, op_id, src, op, d, t_ms).await? {
                Stored::Rev(rev) => {
                    hub.emit(&app.db, "board.ack", json!({"op_id": op_id, "rev": rev}))
                        .await;
                }
                Stored::Duplicate => {}
                Stored::Full => {
                    return Ok(vec![error_frame(
                        "op_rejected",
                        "The board is full.",
                        Some(op_id),
                    )]);
                }
            }
            Ok(Vec::new())
        }
        "transcript.mark" => {
            let Some(segment) = str_field(d, "segment_id") else {
                return Ok(vec![error_frame(
                    "bad_frame",
                    "transcript.mark needs segment_id.",
                    None,
                )]);
            };
            sqlx::query(
                "insert into marks (session_id, segment_id, panelist_id, first_at_ms, final_at_ms, text) \
                 values ($1, $2, $3, $4, $5, $6) on conflict (session_id, segment_id) do nothing",
            )
            .bind(id)
            .bind(clip(segment, 200))
            .bind(str_field(d, "panelist_id").map(|p| clip(p, 64)))
            .bind(d["first_at_ms"].as_i64().unwrap_or(0))
            .bind(d["final_at_ms"].as_i64().unwrap_or(0))
            .bind(clip(d["text"].as_str().unwrap_or(""), MAX_TEXT_CHARS))
            .execute(&app.db)
            .await?;
            Ok(Vec::new())
        }
        "head.samples" => {
            let mut samples = d["samples"].as_array().cloned().unwrap_or_default();
            samples.truncate(MAX_HEAD_SAMPLES);
            if let (Some(first), Some(last)) = (samples.first(), samples.last()) {
                sqlx::query(
                    "insert into head_batches (session_id, first_t_ms, last_t_ms, samples) values ($1, $2, $3, $4)",
                )
                .bind(id)
                .bind(first["t_ms"].as_i64().unwrap_or(0))
                .bind(last["t_ms"].as_i64().unwrap_or(0))
                .bind(Value::Array(samples))
                .execute(&app.db)
                .await?;
            }
            Ok(Vec::new())
        }
        "voice.state" => {
            if let Some(latency) = d.get("latency").filter(|l| l.is_object()) {
                let at = |k: &str| latency.get(k).and_then(Value::as_i64);
                let split = |a: Option<i64>, b: Option<i64>| a.zip(b).map(|(a, b)| b - a);
                tracing::info!(
                    session_id = %id,
                    panelist_id = d["panelist_id"].as_str().unwrap_or(""),
                    to_thinking_ms = split(at("user_final_at_ms"), at("thinking_at_ms")),
                    to_first_text_ms = split(at("user_final_at_ms"), at("first_text_at_ms")),
                    "voice latency"
                );
            }
            store_event(app, id, "voice.state", d).await?;
            Ok(Vec::new())
        }
        "board.focus" => {
            // Latest wins; the board engine ignores ids it does not have.
            let item = str_field(d, "item_id").map(|i| clip(i, 200).to_string());
            *hub.focus.lock().unwrap_or_else(|e| e.into_inner()) = item.clone();
            live_board::set_focus(hub, item.clone()).await;
            sqlx::query("update sessions set board_focus = $2 where id = $1")
                .bind(id)
                .bind(&item)
                .execute(&app.db)
                .await?;
            Ok(Vec::new())
        }
        "voice.spoken" => {
            // The start of a reply as the browser played it: the parked reply is committed, its director call
            // goes out, and the candidate's utterance it answered goes to the Scribe. Nothing is stored.
            if let (Some(pid), Some(heard)) =
                (str_field(d, "panelist_id"), str_field(d, "text_prefix"))
            {
                let heard = clip(heard, 200);
                let (matched, jobs) = {
                    let mut st = handle.lock().await;
                    let matched = st.played(pid, heard, Instant::now());
                    (matched, st.take_director_jobs())
                };
                tracing::debug!(session_id = %id, panelist_id = pid, matched, "voice spoken");
                oai::spawn_directors(app, handle, &id.to_string(), jobs);
                if matched {
                    live_board::after_utterance(app, hub, handle);
                }
            }
            Ok(Vec::new())
        }
        "board.ghost_reject" => {
            store_event(app, id, "board.ghost_reject", d).await?;
            if let Some(op_id) = str_field(d, "op_id") {
                let t_ms = elapsed_ms(handle).await;
                live_board::reject_ghost(app, hub, t_ms, clip(op_id, 200)).await;
            }
            Ok(Vec::new())
        }
        "ui.event" => {
            store_event(app, id, "ui.event", d).await?;
            let kind = d["kind"].as_str().unwrap_or("");
            match kind {
                "pause" | "resume" => {
                    let now = Instant::now();
                    let connected = hub.connections().await > 0;
                    let changed = {
                        let mut st = handle.lock().await;
                        match (kind, st.status) {
                            ("pause", SessionStatus::Live) => {
                                st.status = SessionStatus::Paused;
                                stop_clock(&mut st, now);
                                // Replies not yet played are dropped; the candidate's words stay.
                                let _ = st.flush_provisional();
                                Some((state_value(hub, &st, now, false), "paused"))
                            }
                            ("resume", SessionStatus::Paused) => {
                                st.status = SessionStatus::Live;
                                if connected {
                                    run_clock(&mut st, now);
                                }
                                Some((state_value(hub, &st, now, false), "live"))
                            }
                            _ => None,
                        }
                    };
                    if let Some((v, status)) = changed {
                        set_db_status(&app.db, id, status).await;
                        hub.inner.lock().await.last_sig = Some(sig(&v));
                        hub.send0("round.state", v);
                    }
                    if kind == "resume" {
                        hub.wake(app, handle).await;
                    }
                }
                "end" => {
                    // The interviewer says goodbye first (the browser sends `[event: ending]`); the round ends
                    // after that line, after POST /end, or after `ending_limit`.
                    let reason = d["reason"]
                        .as_str()
                        .filter(|r| persist::END_REASONS.contains(r))
                        .unwrap_or("user_ended");
                    let turns = {
                        let mut st = handle.lock().await;
                        if st.status == SessionStatus::Paused {
                            st.status = SessionStatus::Live;
                            run_clock(&mut st, Instant::now());
                        }
                        st.turns.len()
                    };
                    hub.request_end(reason, turns, false).await;
                }
                _ => {}
            }
            Ok(Vec::new())
        }
        other => Ok(vec![error_frame(
            "unknown_type",
            &format!("Unknown frame type {}.", clip(other, 40)),
            None,
        )]),
    }
}

enum Stored {
    Rev(i64),
    Duplicate,
    Full,
}

/// Stores a board op as received (`accepted` null until the board engine evaluates it). The ack carries the
/// count of stored ops so far, which equals the board rev while every op is accepted. A duplicate of a stored
/// op is not acked again (its ack was already sent and is replayed by seq).
async fn store_board_op(
    db: &PgPool,
    id: Uuid,
    op_id: &str,
    src: &str,
    op: &str,
    d: &Value,
    t_ms: i64,
) -> anyhow::Result<Stored> {
    let mut tx = db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtext($1::text))")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let existing: Option<Option<bool>> =
        sqlx::query_scalar("select accepted from board_ops where session_id = $1 and op_id = $2")
            .bind(id)
            .bind(op_id)
            .fetch_optional(&mut *tx)
            .await?;
    if matches!(existing, Some(None) | Some(Some(true))) {
        tx.commit().await?;
        return Ok(Stored::Duplicate);
    }
    let (count, rev): (i64, i64) = sqlx::query_as(
        "select count(*), coalesce(max(rev) filter (where accepted is not false), 0) + 1 \
         from board_ops where session_id = $1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= MAX_BOARD_OPS {
        tx.commit().await?;
        return Ok(Stored::Full);
    }
    sqlx::query(
        "insert into board_ops (session_id, op_id, rev_base, rev, accepted, src, op, args, at_ms, t_ms) \
         values ($1, $2, $3, $4, null, $5, $6, $7, $8, $9) \
         on conflict (session_id, op_id) do update set rev_base = excluded.rev_base, rev = excluded.rev, \
           accepted = null, src = excluded.src, op = excluded.op, args = excluded.args, \
           at_ms = excluded.at_ms, t_ms = excluded.t_ms \
         where board_ops.accepted = false",
    )
    .bind(id)
    .bind(op_id)
    .bind(d.get("rev_base").and_then(Value::as_i64))
    .bind(rev)
    .bind(clip(src, 40))
    .bind(clip(op, 40))
    .bind(d.get("args").cloned().unwrap_or_else(|| json!({})))
    .bind(d.get("at_ms").and_then(Value::as_i64))
    .bind(t_ms)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Stored::Rev(rev))
}
