//! The server's board for one session: the board, its start state and the op log. Applies client and server
//! ops the way docs/protocol.md (Board ops) says the server answers them, handles undo by replay, and keeps
//! the pending Scribe ghosts.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};

use super::apply::{self, BoardError, Op};
use super::{Board, BoardOp, GhostOp, OpLogEntry, Src, summary};

/// How long a focus set by the client counts as what "that" means.
pub const FOCUS_TTL: Duration = Duration::from_secs(20);

/// What the server answers a `board.op` with.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ApplyOutcome {
    /// Committed: answer `board.ack {op_id, rev}`, send `board.apply` to the other clients.
    Accepted { rev: u64 },
    /// The `op_id` was already committed: nothing changed, nothing logged.
    Duplicate,
    /// Answer `error {code, message, op_id}`; when `ghost_dropped`, also send the new `board.ghosts`.
    Rejected {
        code: String,
        message: String,
        ghost_dropped: bool,
    },
}

#[derive(Clone, Debug)]
pub struct BoardSession {
    /// The round's start board (undo replays from here).
    pub start: Board,
    pub board: Board,
    pub op_log: Vec<OpLogEntry>,
    /// Round start on the transcript clock; `t` in the log is seconds since then.
    pub origin: Instant,
    server_seq: u64,
    scribe_calls: u64,
    /// When the client last set the focus.
    focus_at: Option<Instant>,
}

impl BoardSession {
    pub fn new(start: Board) -> Self {
        Self::with_origin(start, Instant::now())
    }

    pub fn with_origin(start: Board, origin: Instant) -> Self {
        BoardSession {
            board: start.clone(),
            start,
            op_log: Vec::new(),
            origin,
            server_seq: 0,
            scribe_calls: 0,
            focus_at: None,
        }
    }

    /// Seconds since round start, to the millisecond.
    pub fn now_t(&self) -> f64 {
        (self.origin.elapsed().as_secs_f64() * 1000.0).round() / 1000.0
    }

    pub fn rev(&self) -> u64 {
        self.board.rev
    }

    /// A `board.op` from a client, timed now.
    pub fn apply_client_op(&mut self, op: BoardOp) -> ApplyOutcome {
        let t = self.now_t();
        self.apply_client_op_at(op, t)
    }

    pub fn apply_client_op_at(&mut self, op: BoardOp, t: f64) -> ApplyOutcome {
        self.apply_logged(op, t)
    }

    /// A raw `board.op` payload. A frame without a usable `op_id` or `src` is rejected and not logged; any other
    /// bad frame (unknown op, bad args) is rejected and logged with `accepted: false`.
    pub fn apply_client_value(&mut self, v: &Value) -> ApplyOutcome {
        let t = self.now_t();
        self.apply_client_value_at(v, t)
    }

    pub fn apply_client_value_at(&mut self, v: &Value, t: f64) -> ApplyOutcome {
        let op_id = v
            .get("op_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let src = v
            .get("src")
            .and_then(|s| serde_json::from_value::<Src>(s.clone()).ok());
        let name = v
            .get("op")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        // The op log needs an op_id, a src and an op name; a frame without them is answered but not logged.
        let (Some(op_id), Some(src), Some(name)) = (op_id, src, name) else {
            return rejected("op_id, src and op are required", false);
        };
        let op = BoardOp {
            op_id: op_id.to_string(),
            src,
            op: name.to_string(),
            args: v.get("args").cloned().unwrap_or(Value::Object(Map::new())),
            rev_base: None,
            at_ms: None,
        };
        if self.is_duplicate(&op.op_id) {
            return ApplyOutcome::Duplicate;
        }
        // Envelope fields beyond these are checked like the args: the frame must match the schema.
        let envelope_ok = v.as_object().is_some_and(|o| {
            o.keys().all(|k| {
                matches!(
                    k.as_str(),
                    "op_id" | "src" | "op" | "args" | "rev_base" | "at_ms"
                )
            }) && o.get("rev_base").is_none_or(|r| r.as_u64().is_some())
                && o.get("at_ms").is_none_or(Value::is_number)
        });
        if !envelope_ok {
            let dropped = self.record_rejected(&op, t);
            return rejected("the op envelope does not match the schema", dropped);
        }
        self.apply_logged(op, t)
    }

    /// An op the server makes (`interviewer` or `scribe`), with a fresh `op_id`. Returns the op as sent in
    /// `board.apply`.
    pub fn apply_server_op(&mut self, src: Src, op: &str, args: Value) -> (BoardOp, ApplyOutcome) {
        let t = self.now_t();
        self.apply_server_op_at(src, op, args, t)
    }

    pub fn apply_server_op_at(
        &mut self,
        src: Src,
        op: &str,
        args: Value,
        t: f64,
    ) -> (BoardOp, ApplyOutcome) {
        let prefix = match src {
            Src::Interviewer => "iv",
            Src::Scribe => "sc",
            Src::Hand => "hd",
            Src::VoiceGrammar => "vg",
        };
        let op_id = loop {
            self.server_seq += 1;
            let id = format!("srv.{prefix}.{}", self.server_seq);
            if !self.is_duplicate(&id) && !self.op_log.iter().any(|e| e.op_id == id) {
                break id;
            }
        };
        let op = BoardOp {
            op_id,
            src,
            op: op.to_string(),
            args,
            rev_base: None,
            at_ms: None,
        };
        let out = self.apply_logged(op.clone(), t);
        (op, out)
    }

    /// An item or edge id that is not on the board (`<prefix>1`, `<prefix>2`, ...).
    pub fn fresh_item_id(&mut self, prefix: &str) -> String {
        loop {
            self.server_seq += 1;
            let id = format!("{prefix}{}", self.server_seq);
            let used = self.board.items.iter().any(|i| i.id() == id)
                || self.board.edges.iter().any(|e| e.id == id);
            if !used {
                return id;
            }
        }
    }

    /// The next Scribe call number. Neither its id prefix `x<n>_` (items, edges) nor its ghost op ids `sc<n>.<i>`
    /// are in use, so a session rebuilt from a stored board and log never repeats an earlier call.
    pub fn next_scribe_call(&mut self) -> u64 {
        loop {
            self.scribe_calls += 1;
            let prefix = format!("x{}_", self.scribe_calls);
            let op_prefix = format!("sc{}.", self.scribe_calls);
            let used = self.board.items.iter().any(|i| i.id().starts_with(&prefix))
                || self.board.edges.iter().any(|e| e.id.starts_with(&prefix))
                || self
                    .board
                    .op_ids
                    .iter()
                    .any(|id| id.starts_with(&op_prefix))
                || self
                    .board
                    .ghosts
                    .iter()
                    .any(|g| g.op_id.starts_with(&op_prefix))
                || self.op_log.iter().any(|e| e.op_id.starts_with(&op_prefix));
            if !used {
                return self.scribe_calls;
            }
        }
    }

    pub fn is_duplicate(&self, op_id: &str) -> bool {
        self.board.op_ids.iter().any(|id| id == op_id)
    }

    /// Logs an op as not accepted and drops a pending ghost with its `op_id` (a rejected op, or a dismissed
    /// ghost). Returns whether a ghost was dropped.
    pub fn record_rejected(&mut self, op: &BoardOp, t: f64) -> bool {
        let dropped = self.drop_ghost(&op.op_id);
        self.op_log.push(OpLogEntry {
            op_id: op.op_id.clone(),
            t,
            rev: self.board.rev,
            src: op.src,
            op: op.op.clone(),
            args: if op.args.is_object() {
                op.args.clone()
            } else {
                Value::Object(Map::new())
            },
            accepted: false,
        });
        dropped
    }

    pub fn ghosts(&self) -> &[GhostOp] {
        &self.board.ghosts
    }

    /// Replaces the pending ghosts (`board.ghosts` carries the full list), minus any already committed.
    pub fn set_ghosts(&mut self, ghosts: Vec<GhostOp>) -> &[GhostOp] {
        let committed: HashSet<&str> = self.board.op_ids.iter().map(String::as_str).collect();
        let mut seen = HashSet::new();
        let kept: Vec<GhostOp> = ghosts
            .into_iter()
            .filter(|g| !committed.contains(g.op_id.as_str()) && seen.insert(g.op_id.clone()))
            .collect();
        self.board.ghosts = kept;
        &self.board.ghosts
    }

    /// Adds new ghosts after the pending ones and returns the full list to send. A Scribe call works on a copy
    /// of the board, so each new ghost must still apply (in order, after the ones before it) to the board as it is
    /// now; ghosts that no longer apply (an item deleted by hand meanwhile) are dropped.
    pub fn push_ghosts(&mut self, ghosts: Vec<GhostOp>) -> &[GhostOp] {
        let mut scratch = self.board.clone();
        let fresh: Vec<GhostOp> = ghosts
            .into_iter()
            .filter(|g| {
                !self.is_duplicate(&g.op_id)
                    && apply::apply(&mut scratch, &BoardOp::from_ghost(g)).is_ok()
            })
            .collect();
        let mut all = std::mem::take(&mut self.board.ghosts);
        all.extend(fresh);
        self.set_ghosts(all)
    }

    /// The item the candidate last touched or created (`board.focus {item_id}` from the client), which "that",
    /// "this" and "it" refer to. Unknown ids are ignored (returns false, focus unchanged); `None` clears it. Focus
    /// is client state: no rev change, nothing logged.
    pub fn set_focus(&mut self, item_id: Option<String>) -> bool {
        match item_id {
            Some(ref id) if !self.board.items.iter().any(|i| i.id() == id) => false,
            _ => {
                self.board.focus = item_id;
                self.focus_at = Some(Instant::now());
                true
            }
        }
    }

    /// The focus the Scribe resolves "that" with: fresh for [`FOCUS_TTL`].
    pub fn scribe_focus(&self) -> Option<&str> {
        self.fresh_focus(FOCUS_TTL)
    }

    /// The focus while it is fresh (set within `ttl`), else `None`.
    pub fn fresh_focus(&self, ttl: Duration) -> Option<&str> {
        let fresh = self.focus_at.is_some_and(|at| at.elapsed() < ttl);
        if fresh {
            self.board.focus.as_deref()
        } else {
            None
        }
    }

    /// `board.ghost_reject {op_id}`: removes the ghost and logs its op as not accepted. False (and nothing
    /// changes) when no pending ghost has that `op_id`.
    pub fn reject_ghost(&mut self, op_id: &str) -> bool {
        let t = self.now_t();
        self.reject_ghost_at(op_id, t)
    }

    pub fn reject_ghost_at(&mut self, op_id: &str, t: f64) -> bool {
        let Some(g) = self.board.ghosts.iter().find(|g| g.op_id == op_id).cloned() else {
            return false;
        };
        self.record_rejected(&BoardOp::from_ghost(&g), t)
    }

    /// The interviewer's board text; with `since_rev`, includes what changed since that rev.
    pub fn summary(&self, since_rev: Option<u64>) -> String {
        match since_rev {
            Some(r) => {
                let prev = self.board_at(r);
                summary::summary(&self.board, Some((r, &prev)))
            }
            None => summary::summary(&self.board, None),
        }
    }

    /// The board as it was at `rev` (the start board for revs before it, the current board for revs after it),
    /// rebuilt from the log. Ghosts and focus are not part of the history.
    pub fn board_at(&self, rev: u64) -> Board {
        if rev >= self.board.rev {
            return self.board.clone();
        }
        let mut replay = BoardSession::with_origin(self.start.clone(), self.origin);
        for e in self.op_log.iter().filter(|e| e.accepted && e.rev <= rev) {
            replay.apply_logged(e.to_op(), e.t);
        }
        replay.board
    }

    fn drop_ghost(&mut self, op_id: &str) -> bool {
        let before = self.board.ghosts.len();
        self.board.ghosts.retain(|g| g.op_id != op_id);
        self.board.ghosts.len() != before
    }

    fn apply_logged(&mut self, op: BoardOp, t: f64) -> ApplyOutcome {
        if self.is_duplicate(&op.op_id) {
            return ApplyOutcome::Duplicate;
        }
        let result = if op.op == "undo" {
            self.undo(&op)
        } else {
            apply::apply(&mut self.board, &op).map(|_| ())
        };
        match result {
            Ok(()) => {
                self.op_log.push(OpLogEntry {
                    op_id: op.op_id,
                    t,
                    rev: self.board.rev,
                    src: op.src,
                    op: op.op,
                    args: op.args,
                    accepted: true,
                });
                ApplyOutcome::Accepted {
                    rev: self.board.rev,
                }
            }
            Err(e) => {
                let dropped = self.record_rejected(&op, t);
                rejected(&e.to_string(), dropped)
            }
        }
    }

    /// Protocol undo: rebuild from the start board, replaying every accepted op except undos and undone ops.
    fn undo(&mut self, op: &BoardOp) -> Result<(), BoardError> {
        let Op::Undo {
            target_op_id: target,
        } = apply::parse(op)?
        else {
            return Err(BoardError::Invalid("not an undo".into()));
        };
        let entry = self
            .op_log
            .iter()
            .find(|e| e.accepted && e.op_id == target)
            .ok_or_else(|| BoardError::Rejected(format!("{target} is not an accepted op")))?;
        if entry.op == "undo" {
            return Err(BoardError::Rejected("an undo cannot be undone".into()));
        }
        let mut undone = self.undone();
        if !undone.insert(target.clone()) {
            return Err(BoardError::Rejected(format!("{target} is already undone")));
        }

        let mut b = self.start.clone();
        for e in &self.op_log {
            if !e.accepted || e.op == "undo" || undone.contains(&e.op_id) {
                continue;
            }
            // Ops that fail now (an edge to an undone item) are dropped from the result.
            let _ = apply::apply(&mut b, &e.to_op());
        }
        let mut op_ids = self.board.op_ids.clone();
        op_ids.push(op.op_id.clone());
        let committed: HashSet<&str> = op_ids.iter().map(String::as_str).collect();
        b.ghosts = self
            .board
            .ghosts
            .iter()
            .filter(|g| !committed.contains(g.op_id.as_str()))
            .cloned()
            .collect();
        b.focus = self
            .board
            .focus
            .clone()
            .filter(|f| b.items.iter().any(|i| i.id() == f.as_str()));
        b.rev = self.board.rev + 1;
        b.op_ids = op_ids;
        self.board = b;
        Ok(())
    }

    /// Targets of accepted undos.
    fn undone(&self) -> HashSet<String> {
        self.op_log
            .iter()
            .filter(|e| e.accepted && e.op == "undo")
            .filter_map(|e| {
                e.args
                    .get("target_op_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect()
    }
}

fn rejected(message: &str, ghost_dropped: bool) -> ApplyOutcome {
    ApplyOutcome::Rejected {
        code: "op_rejected".into(),
        message: message.to_string(),
        ghost_dropped,
    }
}
