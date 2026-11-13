//! `/ws/session/{id}` (docs/protocol.md, WebSocket).
//!
//! One `Hub` per live session holds the numbered server frames (replayed after a reconnect), the per-token record
//! of processed client frames (`ack`), and drives the round: a `round.state` snapshot every second while the round
//! is live or paused and on every change, the time check at each phase boundary, saving turns and the live state,
//! and ending the session on the hard stop, after the closing line, or when the browser has been gone too long.
//!
//! The round clock runs only while the round has started, is not paused, and at least one socket is connected.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

use crate::app::AppState;
use crate::error::AppError;
use crate::orchestrator::markers::EventKind;
use crate::orchestrator::{ServerEvent, SessionState, SessionStatus};
use crate::persist::{self, TokenRecord};

pub const CLOSE_BAD_TOKEN: u16 = 4401;
pub const CLOSE_UNKNOWN_SESSION: u16 = 4404;
pub const CLOSE_ENDED: u16 = 4409;
/// Server restart: transient, the browser reconnects.
pub const CLOSE_RESTART: u16 = 1012;
/// The socket fell too far behind the broadcast: transient, the reconnect replays what it missed.
const CLOSE_LAGGED: u16 = 1013;

/// Numbered frames kept in memory per session (all of them stay in `session_frames`).
const BUFFER_FRAMES: usize = 2000;

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
    /// After `round.ending`, the session ends as `completed` if the browser has not ended it by then.
    pub ending_grace: Duration,
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
            ending_grace: Duration::from_secs(60),
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

struct HubInner {
    next_seq: u64,
    buffer: VecDeque<Arc<Value>>,
    connections: usize,
    disconnected_since: Option<Instant>,
    attached_at: Instant,
    ended: bool,
    last_sig: Option<String>,
    /// Phase index whose boundary already got its `time_check_due` frame.
    flagged_phase: Option<usize>,
    saved_turns: usize,
    saved_key: String,
    last_seen_saved: Option<Instant>,
    ending_since: Option<Instant>,
}

pub struct Hub {
    pub session_id: Uuid,
    tx: broadcast::Sender<Out>,
    inner: Mutex<HubInner>,
    acks: std::sync::Mutex<HashMap<i64, u64>>,
    /// `uses_whiteboard` per phase, for the `round.state` phases list.
    whiteboard: Vec<bool>,
}

fn frame(t: &str, seq: u64, d: Value) -> Value {
    json!({"t": t, "seq": seq, "d": d})
}

impl Hub {
    /// Sends a numbered frame (buffered and replayed after reconnects). Returns its seq.
    pub async fn emit(&self, db: &PgPool, t: &str, d: Value) -> u64 {
        let (seq, f) = {
            let mut h = self.inner.lock().await;
            let seq = h.next_seq;
            h.next_seq += 1;
            let f = Arc::new(frame(t, seq, d));
            h.buffer.push_back(f.clone());
            while h.buffer.len() > BUFFER_FRAMES {
                h.buffer.pop_front();
            }
            let _ = self.tx.send(Out::Frame(f.clone()));
            (seq, f)
        };
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
        seq
    }

    /// Sends an unnumbered frame (`seq: 0`, never replayed).
    pub fn send0(&self, t: &str, d: Value) {
        let _ = self.tx.send(Out::Frame(Arc::new(frame(t, 0, d))));
    }

    /// Ends the socket side: `round.ended`, then close 4409 for everyone.
    pub async fn finish(&self, db: &PgPool, reason: &str) {
        self.inner.lock().await.ended = true;
        self.emit(db, "round.ended", json!({ "reason": reason }))
            .await;
        let _ = self.tx.send(Out::Close {
            code: CLOSE_ENDED,
            reason: "session ended",
            tokens: None,
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

    pub async fn connections(&self) -> usize {
        self.inner.lock().await.connections
    }

    /// How long the round has had no socket (None while one is connected or before the first one).
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
            "select frame from session_frames where session_id = $1 and seq > $2 order by seq",
        )
        .bind(self.session_id)
        .bind(last_seq as i64)
        .fetch_all(db)
        .await;
        rows.unwrap_or_default().into_iter().map(Arc::new).collect()
    }
}

/// Live hubs by session id.
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

    /// Closes every live socket (graceful shutdown: 1012, so browsers reconnect to the new server).
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
    let (whiteboard, events) = {
        let st = handle.lock().await;
        (
            st.round.phases.iter().map(|p| p.uses_whiteboard).collect(),
            st.events.subscribe(),
        )
    };
    let (tx, _) = broadcast::channel(256);
    let hub = Arc::new(Hub {
        session_id: id,
        tx,
        inner: Mutex::new(HubInner {
            next_seq,
            buffer: stored.into_iter().map(Arc::new).collect(),
            connections: 0,
            disconnected_since: None,
            attached_at: Instant::now(),
            ended: false,
            last_sig: None,
            flagged_phase: None,
            saved_turns: 0,
            saved_key: String::new(),
            last_seen_saved: None,
            ending_since: None,
        }),
        acks: std::sync::Mutex::new(HashMap::new()),
        whiteboard,
    });
    {
        let mut map = app.hubs.inner.write().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(&key) {
            return existing.clone();
        }
        map.insert(key, hub.clone());
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
        if hub.inner.lock().await.ended {
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
            other => {
                if matches!(other, ServerEvent::RoundEnding { .. }) {
                    hub.inner.lock().await.ending_since = Some(Instant::now());
                }
                hub.emit(&app.db, &t, d).await;
            }
        }
    }
}

/// The per-session loop: state ticks, time checks, saving, and the end conditions.
async fn drive(app: AppState, hub: Arc<Hub>, handle: Arc<Mutex<SessionState>>) {
    let timing = app.timing.clone();
    let mut tick = tokio::time::interval(timing.tick);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let now = Instant::now();

        let (v, owed, phase_idx, status, elapsed_ms, hard_stop_ms, key, snap) = {
            let st = handle.lock().await;
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
            )
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

            let end = if status != SessionStatus::Created && elapsed_ms >= hard_stop_ms {
                Some("time_limit")
            } else if h
                .ending_since
                .is_some_and(|t| now.duration_since(t) >= timing.ending_grace)
            {
                Some("completed")
            } else if h.connections == 0 && status == SessionStatus::Created {
                (now.duration_since(h.attached_at) >= timing.start_limit).then_some("disconnected")
            } else if h.connections == 0 {
                h.disconnected_since
                    .is_some_and(|t| now.duration_since(t) >= timing.offline_limit)
                    .then_some("disconnected")
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
            if let Err(err) = persist::end_session(&app, hub.session_id, reason).await {
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
    ws.on_upgrade(move |socket| run_socket(app, id, socket))
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

fn error_frame(code: &str, message: &str, op_id: Option<&str>) -> Value {
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
        let _ = sink.send(close(CLOSE_ENDED, "session ended")).await;
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
    {
        let mut h = hub.inner.lock().await;
        h.connections += 1;
        h.disconnected_since = None;
    }
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
            SessionStatus::Live => {
                run_clock(&mut st, now);
                false
            }
            _ => false,
        }
    };
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
    if let Err(err) = res {
        tracing::warn!(session_id = %hub.session_id, error = %err, "could not save the socket start");
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
        stop_clock(&mut *handle.lock().await, Instant::now());
        let _ = sqlx::query("update sessions set last_socket_at = now() where id = $1")
            .bind(hub.session_id)
            .execute(&app.db)
            .await;
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

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let msg = match incoming {
                    Some(Ok(m)) => m,
                    _ => return None,
                };
                let raw = match msg {
                    WsMessage::Text(t) => t.as_str().to_string(),
                    WsMessage::Close(_) => return None,
                    _ => continue,
                };
                let Ok(env) = serde_json::from_str::<Envelope>(&raw) else {
                    let f = with_ack(&error_frame("bad_frame", "Frames are JSON {t, seq, d}.", None), hub.ack_for(token_id));
                    if sink.send(text(&f)).await.is_err() { return None; }
                    continue;
                };
                for reply in handle_frame(app, hub, handle, token_id, env).await {
                    if sink.send(text(&with_ack(&reply, hub.ack_for(token_id)))).await.is_err() {
                        return None;
                    }
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

/// Handles one client frame. Returns direct replies (unnumbered); numbered replies go through the hub.
async fn handle_frame(
    app: &AppState,
    hub: &Arc<Hub>,
    handle: &Arc<Mutex<SessionState>>,
    token_id: i64,
    env: Envelope,
) -> Vec<Value> {
    match env.t.as_str() {
        "ping" => return vec![frame("pong", 0, json!({}))],
        "hello" => return Vec::new(),
        _ => {}
    }
    if env.seq > 0 && env.seq <= hub.ack_for(token_id) {
        // Already processed under this token (a replay after a reconnect).
        return Vec::new();
    }
    let result = process(app, hub, handle, &env).await;
    match result {
        Ok(replies) => {
            if env.seq > 0 {
                hub.set_ack(token_id, env.seq);
                let db = app.db.clone();
                let seq = env.seq;
                tokio::spawn(async move { persist::save_client_seq(&db, token_id, seq).await });
            }
            replies
        }
        Err(err) => {
            // Not acked: the client keeps the frame and sends it again after its next reconnect.
            tracing::warn!(session_id = %hub.session_id, t = %env.t, error = %format!("{err:#}"), "client frame failed");
            vec![error_frame(
                "server_error",
                "That did not save. It will be sent again.",
                None,
            )]
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
            let t_ms = elapsed_ms(handle).await;
            let rev = store_board_op(&app.db, id, op_id, src, op, d, t_ms).await?;
            if let Some(rev) = rev {
                hub.emit(&app.db, "board.ack", json!({"op_id": op_id, "rev": rev}))
                    .await;
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
            .bind(segment)
            .bind(str_field(d, "panelist_id"))
            .bind(d["first_at_ms"].as_i64().unwrap_or(0))
            .bind(d["final_at_ms"].as_i64().unwrap_or(0))
            .bind(d["text"].as_str().unwrap_or(""))
            .execute(&app.db)
            .await?;
            Ok(Vec::new())
        }
        "head.samples" => {
            let samples = d["samples"].as_array().cloned().unwrap_or_default();
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
        "board.ghost_reject" => {
            store_event(app, id, "board.ghost_reject", d).await?;
            Ok(Vec::new())
        }
        "ui.event" => {
            store_event(app, id, "ui.event", d).await?;
            let kind = d["kind"].as_str().unwrap_or("");
            match kind {
                "pause" | "resume" => {
                    let now = Instant::now();
                    let changed = {
                        let mut st = handle.lock().await;
                        match (kind, st.status) {
                            ("pause", SessionStatus::Live) => {
                                st.status = SessionStatus::Paused;
                                stop_clock(&mut st, now);
                                Some((state_value(hub, &st, now, false), "paused"))
                            }
                            ("resume", SessionStatus::Paused) => {
                                st.status = SessionStatus::Live;
                                if hub.connections().await > 0 {
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
                }
                "end" => {
                    let reason = d["reason"].as_str().unwrap_or("user_ended");
                    persist::end_session(app, id, reason).await?;
                }
                _ => {}
            }
            Ok(Vec::new())
        }
        other => Ok(vec![error_frame(
            "unknown_type",
            &format!("Unknown frame type {other}."),
            None,
        )]),
    }
}

/// Stores a board op as received (`accepted` null until the board engine evaluates it). Returns the rev to ack
/// with: the count of stored ops so far, which equals the board rev while every op is accepted. A duplicate of a
/// stored op returns None (its ack was already sent and is replayed by seq).
async fn store_board_op(
    db: &PgPool,
    id: Uuid,
    op_id: &str,
    src: &str,
    op: &str,
    d: &Value,
    t_ms: i64,
) -> anyhow::Result<Option<i64>> {
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
        return Ok(None);
    }
    let rev: i64 = sqlx::query_scalar(
        "select coalesce(max(rev), 0) + 1 from board_ops where session_id = $1 and accepted is not false",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
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
    .bind(src)
    .bind(op)
    .bind(d.get("args").cloned().unwrap_or_else(|| json!({})))
    .bind(d.get("at_ms").and_then(Value::as_i64))
    .bind(t_ms)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(rev))
}
