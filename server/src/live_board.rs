//! The board of a live session, between the socket and the board engine: client ops are applied by
//! [`BoardSession`] (acked with the new rev, or answered `op_rejected`), stored in `board_ops` and `boards`, and turned
//! into the interviewer's board text for the next live turn. After each candidate utterance the Scribe suggests edits
//! off the hot path; they reach the browser as `board.ghosts`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::app::AppState;
use crate::board::{self, ApplyOutcome, Board, BoardKit, BoardSession, GhostOp};
use crate::orchestrator::{Brief, SessionState, initial_brief};
use crate::scribe::{Scribe, ScribeInput};
use crate::usage::LLM_SESSION;
use crate::ws::{Hub, error_frame};

/// Ops kept per session (the socket's own cap).
pub const MAX_OPS: usize = 5000;
/// Candidate utterances sent to the Scribe: the newest one plus up to two before it.
const SCRIBE_UTTERANCES: usize = 3;
/// A (model, kit) whose Scribe schema was warmed this recently is not warmed again (the API keeps a compiled
/// schema for about a day).
const PREWARM_EVERY: Duration = Duration::from_secs(12 * 3600);
/// Code language of a coding board when the question card names none.
const DEFAULT_LANGUAGE: &str = "python";

/// One session's board and the bookkeeping around it.
pub struct LiveBoard {
    pub session: BoardSession,
    round_type: String,
    /// The interviewer's "Changed since" diff starts at this rev: the board as it was when the interviewer last
    /// replied.
    base_rev: u64,
    /// Rev of the latest board text.
    text_rev: u64,
    /// Interviewer lines in the turn log when the latest board text was made.
    agent_turns: usize,
    /// One Scribe call at a time; a call asked for meanwhile runs right after it.
    scribe_busy: bool,
    scribe_again: bool,
    /// `SessionState::speech_commits` already handed to the Scribe.
    scribe_seen: u64,
}

/// The empty board a round starts with: the round's kit, the brief card, and an empty code or meeting section.
pub fn start_board(st: &SessionState) -> Option<Board> {
    let kit: BoardKit = board::parse_enum(st.round.board_kit.as_deref()?)?;
    let brief = st
        .brief
        .clone()
        .or_else(|| initial_brief(&st.question))
        .unwrap_or_default();
    let question_id = st.question.get("id").and_then(Value::as_str);
    let language = st
        .question
        .pointer("/reference_solution/language")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_LANGUAGE);
    let coding = kit == BoardKit::Coding;
    let v = json!({
        "schema": "ir.board.v1",
        "round": {
            "id": st.id,
            "type": kit.as_str(),
            "question_id": question_id,
            "language": if coding { Some(language) } else { None },
        },
        "rev": 0,
        "size": {"w": 64, "h": 40},
        "brief": {"question": brief.question, "lines": brief.lines},
        "items": [],
        "edges": [],
        "code": if coding {
            json!({"language": language, "lines": [], "approach": [],
                   "complexity": {"time": null, "space": null}, "trace": []})
        } else {
            Value::Null
        },
        "meeting": if kit == BoardKit::Meeting {
            json!({"agenda": [], "shown": [], "parked": []})
        } else {
            Value::Null
        },
        "focus": null,
        "ghosts": [],
        "op_ids": [],
    });
    match serde_json::from_value(v) {
        Ok(b) => Some(b),
        Err(err) => {
            tracing::warn!(session_id = %st.id, error = %err, "could not build the start board");
            None
        }
    }
}

type StoredOp = (String, String, String, Value, Option<i64>);

impl LiveBoard {
    /// The session's board: the start board, then every stored op replayed in order (a reload after a restart
    /// gets the same board, log and rev). `None` for a round without a board.
    pub async fn load(db: &PgPool, id: Uuid, st: &SessionState) -> Option<LiveBoard> {
        let start = start_board(st)?;
        let mut session = BoardSession::new(start);
        let stored: Vec<StoredOp> = sqlx::query_as(
            "select op_id, src, op, args, t_ms from board_ops where session_id = $1 order by id",
        )
        .bind(id)
        .fetch_all(db)
        .await
        .unwrap_or_else(|err| {
            tracing::warn!(session_id = %id, error = %err, "could not read the stored board ops");
            Vec::new()
        });
        for (op_id, src, op, args, t_ms) in stored {
            let v = json!({"op_id": op_id, "src": src, "op": op, "args": args});
            session.apply_client_value_at(&v, t_ms.unwrap_or(0) as f64 / 1000.0);
        }
        let rev = session.rev();
        Some(LiveBoard {
            session,
            round_type: st.round.round_type.clone(),
            base_rev: rev,
            text_rev: rev,
            agent_turns: agent_turns(st),
            scribe_busy: false,
            scribe_again: false,
            scribe_seen: st.speech_commits,
        })
    }

    /// A Scribe call is owed: a reply to the candidate's speech was committed since the last call.
    pub fn scribe_due(&self, speech_commits: u64) -> bool {
        !self.scribe_busy && speech_commits > self.scribe_seen
    }

    /// Keeps the board's brief card equal to the session's (the interviewer's show_question changes it).
    fn sync_brief(&mut self, st: &SessionState) {
        if let Some(Brief { question, lines }) = &st.brief {
            let brief = board::Brief {
                question: question.clone(),
                lines: lines.clone(),
            };
            self.session.start.brief = brief.clone();
            self.session.board.brief = brief;
        }
    }

    /// Writes the interviewer's board text for the next live turn. The diff covers what changed since the
    /// interviewer last replied.
    pub fn refresh_text(&mut self, st: &mut SessionState) {
        self.sync_brief(st);
        let agents = agent_turns(st);
        if agents > self.agent_turns {
            self.base_rev = self.text_rev;
            self.agent_turns = agents;
        }
        let rev = self.session.rev();
        st.board_text = if self.base_rev < rev {
            self.session.summary(Some(self.base_rev))
        } else {
            self.session.summary(None)
        };
        self.text_rev = rev;
    }
}

fn agent_turns(st: &SessionState) -> usize {
    st.turns
        .iter()
        .filter(|t| t.speaker != "candidate" && t.speaker != "app")
        .count()
}

/// Stores an op as the board engine judged it. A rejected op can be sent again (fixed) under its op_id; an
/// accepted one is final.
async fn store_op(
    db: &PgPool,
    id: Uuid,
    d: &Value,
    accepted: bool,
    rev: Option<u64>,
    t_ms: i64,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "insert into board_ops (session_id, op_id, rev_base, rev, accepted, src, op, args, at_ms, t_ms) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         on conflict (session_id, op_id) do update set rev_base = excluded.rev_base, rev = excluded.rev, \
           accepted = excluded.accepted, src = excluded.src, op = excluded.op, args = excluded.args, \
           at_ms = excluded.at_ms, t_ms = excluded.t_ms \
         where board_ops.accepted is not true",
    )
    .bind(id)
    .bind(d["op_id"].as_str().unwrap_or_default())
    .bind(d.get("rev_base").and_then(Value::as_i64))
    .bind(rev.map(|r| r as i64))
    .bind(accepted)
    .bind(d["src"].as_str().unwrap_or_default())
    .bind(d["op"].as_str().unwrap_or_default())
    .bind(d.get("args").cloned().unwrap_or_else(|| json!({})))
    .bind(d.get("at_ms").and_then(Value::as_i64))
    .bind(t_ms)
    .execute(db)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// The board document and its plain summary (the scorer reads it).
async fn save_board(db: &PgPool, id: Uuid, lb: &LiveBoard) {
    let doc = serde_json::to_value(&lb.session.board).unwrap_or(Value::Null);
    let res = sqlx::query(
        "insert into boards (session_id, rev, doc, summary, updated_at) values ($1, $2, $3, $4, now()) \
         on conflict (session_id) do update set rev = excluded.rev, doc = excluded.doc, \
           summary = excluded.summary, updated_at = now()",
    )
    .bind(id)
    .bind(lb.session.rev() as i64)
    .bind(doc)
    .bind(lb.session.summary(None))
    .execute(db)
    .await;
    if let Err(err) = res {
        tracing::warn!(session_id = %id, error = %err, "could not save the board");
    }
}

fn ghosts_frame(ghosts: &[GhostOp]) -> Value {
    json!({ "ghosts": ghosts })
}

/// `board.op`: applies the op, stores it, acks it with the new rev (numbered, so a reconnect replays it) or
/// answers `op_rejected`. A repeat of an accepted op is not acked again (the first ack is replayed by seq), unless
/// its first save failed.
pub async fn client_op(
    app: &AppState,
    hub: &Arc<Hub>,
    handle: &Arc<Mutex<SessionState>>,
    d: &Value,
) -> anyhow::Result<Vec<Value>> {
    let id = hub.session_id;
    let op_id = d["op_id"].as_str().unwrap_or_default().to_string();
    let t_ms = handle.lock().await.elapsed_ms(Instant::now()) as i64;
    let mut guard = hub.board.lock().await;
    let Some(lb) = guard.as_mut() else {
        return Ok(Vec::new());
    };
    if lb.session.op_log.len() >= MAX_OPS && !lb.session.is_duplicate(&op_id) {
        return Ok(vec![error_frame(
            "op_rejected",
            "The board is full.",
            Some(&op_id),
        )]);
    }
    match lb.session.apply_client_value_at(d, t_ms as f64 / 1000.0) {
        ApplyOutcome::Accepted { rev } => {
            store_op(&app.db, id, d, true, Some(rev), t_ms).await?;
            {
                let mut st = handle.lock().await;
                lb.refresh_text(&mut st);
            }
            save_board(&app.db, id, lb).await;
            drop(guard);
            hub.emit(&app.db, "board.ack", json!({"op_id": op_id, "rev": rev}))
                .await;
            Ok(Vec::new())
        }
        ApplyOutcome::Duplicate => {
            let rev = lb
                .session
                .op_log
                .iter()
                .rev()
                .find(|e| e.op_id == op_id && e.accepted)
                .map(|e| e.rev);
            // Applied before, but its save failed (the frame came back unacked): save and ack it now.
            let saved_now = store_op(&app.db, id, d, true, rev, t_ms).await?;
            drop(guard);
            if saved_now && let Some(rev) = rev {
                hub.emit(&app.db, "board.ack", json!({"op_id": op_id, "rev": rev}))
                    .await;
            }
            Ok(Vec::new())
        }
        ApplyOutcome::Rejected {
            code,
            message,
            ghost_dropped,
        } => {
            store_op(&app.db, id, d, false, None, t_ms).await?;
            let ghosts = ghost_dropped.then(|| ghosts_frame(lb.session.ghosts()));
            drop(guard);
            if let Some(g) = ghosts {
                hub.emit(&app.db, "board.ghosts", g).await;
            }
            Ok(vec![error_frame(&code, &message, Some(&op_id))])
        }
    }
}

/// `board.ghost_reject {op_id}`: drops the suggestion (logged as not accepted) and sends the new ghost list.
pub async fn reject_ghost(app: &AppState, hub: &Arc<Hub>, t_ms: i64, op_id: &str) {
    let mut guard = hub.board.lock().await;
    let Some(lb) = guard.as_mut() else {
        return;
    };
    let ghost = lb
        .session
        .ghosts()
        .iter()
        .find(|g| g.op_id == op_id)
        .cloned();
    let Some(ghost) = ghost else {
        return;
    };
    if !lb.session.reject_ghost_at(op_id, t_ms as f64 / 1000.0) {
        return;
    }
    let frame = ghosts_frame(lb.session.ghosts());
    drop(guard);
    let d = json!({"op_id": ghost.op_id, "src": ghost.src, "op": ghost.op, "args": ghost.args});
    if let Err(err) = store_op(&app.db, hub.session_id, &d, false, None, t_ms).await {
        tracing::warn!(session_id = %hub.session_id, error = %err, "could not store a dismissed suggestion");
    }
    hub.emit(&app.db, "board.ghosts", frame).await;
}

/// `board.focus {item_id|null}`: the item "that" refers to for the Scribe. Unknown ids are ignored.
pub async fn set_focus(hub: &Hub, item: Option<String>) {
    if let Some(lb) = hub.board.lock().await.as_mut() {
        lb.session.set_focus(item);
    }
}

/// Runs the Scribe when the candidate finished an utterance since its last call (a reply to their speech was
/// committed). Never blocks: the call runs in its own task, one at a time per session.
pub fn after_utterance(app: &AppState, hub: &Arc<Hub>, handle: &Arc<Mutex<SessionState>>) {
    let (app, hub, handle) = (app.clone(), hub.clone(), handle.clone());
    tokio::spawn(async move {
        let session = hub.session_id;
        LLM_SESSION
            .scope(session, scribe_loop(app, hub, handle))
            .await;
    });
}

async fn scribe_loop(app: AppState, hub: Arc<Hub>, handle: Arc<Mutex<SessionState>>) {
    let Some(scribe) = Scribe::from_catalog(&app.catalog, &app.config.fast_model) else {
        return;
    };
    loop {
        let (commits, utterances) = {
            let st = handle.lock().await;
            let mut said: Vec<String> = st
                .turns
                .iter()
                .rev()
                .filter(|t| t.speaker == "candidate" && !t.text.trim().is_empty())
                .take(SCRIBE_UTTERANCES)
                .map(|t| t.text.clone())
                .collect();
            said.reverse();
            (st.speech_commits, said)
        };
        let job = {
            let mut guard = hub.board.lock().await;
            let Some(lb) = guard.as_mut() else {
                return;
            };
            if lb.scribe_busy {
                lb.scribe_again = true;
                return;
            }
            if commits <= lb.scribe_seen || utterances.is_empty() {
                return;
            }
            lb.scribe_seen = commits;
            lb.scribe_busy = true;
            {
                let st = handle.lock().await;
                lb.sync_brief(&st);
            }
            let call_no = lb.session.next_scribe_call();
            (
                lb.session.board.clone(),
                lb.session.scribe_focus().map(str::to_string),
                lb.round_type.clone(),
                call_no,
            )
        };
        let (board, focus, round_type, call_no) = job;
        let input = ScribeInput {
            round_type: &round_type,
            board: &board,
            focus: focus.as_deref(),
            utterances: &utterances,
            call_no,
        };
        let ghosts = scribe.suggest(app.llm.as_ref(), &input).await;
        let (frame, again) = {
            let mut guard = hub.board.lock().await;
            let Some(lb) = guard.as_mut() else {
                return;
            };
            lb.scribe_busy = false;
            let again = std::mem::take(&mut lb.scribe_again);
            let frame = (!ghosts.is_empty()).then(|| ghosts_frame(lb.session.push_ghosts(ghosts)));
            (frame, again)
        };
        if let Some(frame) = frame {
            hub.emit(&app.db, "board.ghosts", frame).await;
        }
        if !again {
            return;
        }
    }
}

static PREWARMED: LazyLock<std::sync::Mutex<HashMap<(String, String), Instant>>> =
    LazyLock::new(Default::default);

/// Compiles the Scribe's output schema for this board kit ahead of the first real suggestion (a cold schema adds
/// one to two seconds, enough to time out the first call). One small call per (model, kit) per
/// [`PREWARM_EVERY`]; a structured-output request cannot be a zero-token prewarm, so it asks for a few tokens.
pub fn prewarm_scribe(app: &AppState, session: Uuid, board: Board, round_type: String) {
    let model = app.config.fast_model.clone();
    let key = (model.clone(), board.round.kit.as_str().to_string());
    {
        let mut warm = PREWARMED.lock().unwrap_or_else(|e| e.into_inner());
        if warm
            .get(&key)
            .is_some_and(|at| at.elapsed() < PREWARM_EVERY)
        {
            return;
        }
        warm.insert(key, Instant::now());
    }
    let Some(scribe) = Scribe::from_catalog(&app.catalog, &model) else {
        return;
    };
    let llm = app.llm.clone();
    tokio::spawn(LLM_SESSION.scope(session, async move {
        let said = vec!["Let me start with the requirements.".to_string()];
        let mut req = scribe.build_request(&ScribeInput {
            round_type: &round_type,
            board: &board,
            focus: None,
            utterances: &said,
            call_no: 0,
        });
        req.max_tokens = 16;
        let started = Instant::now();
        let res = tokio::time::timeout(Duration::from_secs(15), llm.create(&req)).await;
        let ok = matches!(res, Ok(Ok(_)));
        tracing::info!(session_id = %session, kit = %board.round.kit.as_str(), ok, ms = started.elapsed().as_millis() as u64, "scribe schema prewarm");
    }));
}
