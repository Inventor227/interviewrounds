//! `POST /v1/chat/completions`: the custom LLM endpoint Fish calls on every voice turn (and the browser calls
//! directly on the fake-voice path). OpenAI chat format in, `chat.completion.chunk` SSE out.
//!
//! Fish sends its whole transcript; we use only the newest user message (and Fish's copy of our last line, to
//! see whether the candidate cut in). The real prompt is rebuilt from the session state. Text is streamed to
//! Fish as soon as Claude produces it, through the speech filter.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_stream::stream;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::constant_time_eq;
use super::director;
use super::markers::{EventKind, UserInput, parse_user_turn};
use super::prompt::{TurnDraft, draft_turn, request_for_draft};
use super::speech_filter::SpeechFilter;
use super::state::{DirectorJob, Provisional, SessionState, ToolsMode, TurnCommit, VoiceKind};
use super::tools::ToolCall;
use crate::app::AppState;
use crate::claude::{
    ContentBlock, Message, MessagesRequest, Role, StreamEvent, Usage, fallbacks_for, thinking_for,
};
use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub struct OaiChatRequest {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub messages: Vec<OaiMessage>,
    #[serde(default)]
    pub stream: Option<bool>,
    /// Fish's own session id (not ours).
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    /// Our `llm_extra_body` from session creation: `{session_id, panelist_id}`.
    #[serde(default)]
    pub fishaudio_extra_body: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct OaiMessage {
    pub role: String,
    #[serde(default)]
    pub content: Value,
}

impl OaiMessage {
    /// Plain text of a string or a list of `{type: "text", text}` parts.
    pub fn text(&self) -> String {
        match &self.content {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        }
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

pub async fn chat_completions(
    State(app): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<OaiChatRequest>,
) -> Response {
    let extra = req.fishaudio_extra_body.as_ref();
    let field = |k: &str| {
        extra
            .and_then(|e| e.get(k))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let session_id = field("session_id").unwrap_or_default();
    let panelist_id = field("panelist_id");
    let session = app.registry.get(&session_id);

    let authorized = match bearer(&headers) {
        None => false,
        Some(token)
            if constant_time_eq(token.as_bytes(), app.config.fish_llm_secret.as_bytes()) =>
        {
            true
        }
        // The session's own client token, only on the fake-voice path.
        Some(token) => match &session {
            Some(s) => {
                let fake = s.lock().await.settings.voice == VoiceKind::Fake;
                fake && app.session_auth.client_token_ok(&session_id, token).await
            }
            None => false,
        },
    };
    if !authorized {
        return AppError::Unauthorized.into_response();
    }
    let Some(session) = session else {
        return AppError::NotFound.into_response();
    };
    if !req.messages.iter().any(|m| m.role == "user") {
        return AppError::BadRequest("no user message".into()).into_response();
    }
    // Everything the candidate (or the app) said since our last reply. Fish may hold more than one user message
    // there: speech we never answered, or a typed event next to the speech.
    let last_assistant = req.messages.iter().rposition(|m| m.role == "assistant");
    let after = last_assistant.map(|i| i + 1).unwrap_or(0);
    let parts: Vec<String> = req.messages[after..]
        .iter()
        .filter(|m| m.role == "user")
        .map(OaiMessage::text)
        .collect();
    let fish_last = last_assistant.map(|i| req.messages[i].text());
    tracing::info!(
        session_id = %session_id,
        fish_session_id = req.session_id.as_deref().unwrap_or(""),
        panelist_id = panelist_id.as_deref().unwrap_or(""),
        messages = req.messages.len(),
        new_user_messages = parts.len(),
        fish_last_chars = fish_last.as_ref().map(|t| t.len()).unwrap_or(0),
        "voice request"
    );
    let model_name = req
        .model
        .clone()
        .unwrap_or_else(|| "interview-rounds".into());

    let Some(input) = parse_user_turn(&parts) else {
        // The list ends with our own reply: there is nothing new to answer, and an older user message must never
        // be answered (or recorded) twice. Fish still needs a non-empty reply.
        tracing::warn!(session_id = %session_id, "request without a new user message; holding");
        let hold = app.orchestrator.hold_line.clone();
        let events = stream! {
            let mut chunks = Chunks::new(model_name);
            yield Ok::<_, Infallible>(chunks.content(&hold));
            yield Ok(chunks.finish(&Usage::default()));
            yield Ok(Chunks::done());
        };
        return sse(events);
    };

    let events = turn_stream(
        app,
        session,
        session_id,
        panelist_id,
        input,
        fish_last,
        model_name,
    );
    sse(events)
}

fn sse(events: impl Stream<Item = Result<Event, Infallible>> + Send + 'static) -> Response {
    let mut res = Sse::new(events)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
        .into_response();
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    res
}

/// Builds `chat.completion.chunk` events for one reply.
struct Chunks {
    id: String,
    created: i64,
    model: String,
    first: bool,
}

impl Chunks {
    fn new(model: String) -> Self {
        Chunks {
            id: format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
            created: chrono::Utc::now().timestamp(),
            model,
            first: true,
        }
    }

    fn event(&self, delta: Value, finish: Option<&str>, usage: Option<Value>) -> Event {
        let mut chunk = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        });
        if let Some(u) = usage {
            chunk["usage"] = u;
        }
        Event::default().data(chunk.to_string())
    }

    fn content(&mut self, text: &str) -> Event {
        let delta = if self.first {
            self.first = false;
            json!({"role": "assistant", "content": text})
        } else {
            json!({"content": text})
        };
        self.event(delta, None, None)
    }

    fn finish(&self, usage: &Usage) -> Event {
        let usage = json!({
            "prompt_tokens": usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
            "completion_tokens": usage.output_tokens,
            "total_tokens": usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
        });
        self.event(json!({}), Some("stop"), Some(usage))
    }

    fn done() -> Event {
        Event::default().data("[DONE]")
    }
}

/// Collects the assistant content of one model call, in order, for the append-only history.
#[derive(Default)]
struct Assembler {
    blocks: Vec<ContentBlock>,
    calls: Vec<ToolCall>,
}

impl Assembler {
    fn text(&mut self, t: &str) {
        if let Some(ContentBlock::Text { text, .. }) = self.blocks.last_mut() {
            text.push_str(t);
        } else {
            self.blocks.push(ContentBlock::text(t));
        }
    }

    fn tool(&mut self, panelist_id: &str, id: String, name: String, input: Value) {
        self.blocks.push(ContentBlock::ToolUse {
            id: id.clone(),
            name: name.clone(),
            input: input.clone(),
        });
        self.calls.push(ToolCall {
            id,
            name,
            input,
            panelist_id: panelist_id.to_string(),
        });
    }

    fn block(&mut self, block: ContentBlock) {
        // After a server-side fallback, model-internal blocks from before the switch are not sent back.
        let is_fallback = matches!(&block, ContentBlock::Other(v) if v.get("type").and_then(Value::as_str) == Some("fallback"));
        if is_fallback {
            self.blocks
                .retain(|b| matches!(b, ContentBlock::Text { .. }) || matches!(b, ContentBlock::Other(v) if v.get("type").and_then(Value::as_str) == Some("fallback")));
            self.calls.clear();
        }
        self.blocks.push(block);
    }

    fn tool_ids(&self) -> Vec<String> {
        self.calls.iter().map(|c| c.id.clone()).collect()
    }

    fn take(&mut self) -> (Vec<ContentBlock>, Vec<ToolCall>) {
        (
            std::mem::take(&mut self.blocks),
            std::mem::take(&mut self.calls),
        )
    }
}

/// The one retry after a silent failure. Thinking is left adaptive (omitted) at the same low effort: with thinking
/// turned off over a history written by another model, a fast model was seen speaking its reasoning aloud.
/// Sonnet 5.5 is the exception: its `between_tools` (thinking off) is safe over its own or another model's history and
/// keeps the retry fast.
fn retarget_for_retry(req: &mut MessagesRequest, model: &str) {
    req.model = model.to_string();
    req.thinking = if model.starts_with("claude-sonnet-5-5") {
        thinking_for(model)
    } else {
        None
    };
    req.fallbacks = fallbacks_for(model);
}

/// Model calls per turn after tool use (inline tools only): the model gets its "ok" results and finishes what it
/// was saying.
const MAX_CONTINUATIONS: u8 = 2;

/// A retry is only worth starting with at least this much of the turn deadline left.
const MIN_RETRY_WINDOW: Duration = Duration::from_millis(1500);

/// The director gets this long; it runs while the line is being spoken.
const DIRECTOR_TIMEOUT: Duration = Duration::from_secs(8);

fn add_usage(total: &mut Usage, u: &Usage) {
    total.input_tokens += u.input_tokens;
    total.output_tokens += u.output_tokens;
    total.cache_read_input_tokens += u.cache_read_input_tokens;
    total.cache_creation_input_tokens += u.cache_creation_input_tokens;
}

fn is_thinking(b: &ContentBlock) -> bool {
    matches!(
        b,
        ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. }
    )
}

/// Keeps a turn that was cut off after some text was streamed. When the response is dropped before the commit
/// (Fish cancelled it: a barge-in, its own timeout, or a speculative draft it threw away), the turn is parked as
/// provisional instead of lost. The next request shows whether Fish played it: if its transcript has our line (or
/// the start of it), the turn is committed then; if not, it was a discarded draft and is forgotten. Holding the
/// turn lock until the turn is parked keeps the next request from reading the state too early.
struct TurnGuard {
    session: Arc<Mutex<SessionState>>,
    turn: Option<OwnedMutexGuard<()>>,
    session_id: String,
    panelist: String,
    input: UserInput,
    draft: Option<TurnDraft>,
    /// What was streamed to the voice so far.
    spoken: String,
    /// The assistant text so far, unfiltered.
    said: String,
    done: bool,
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        if self.done || self.spoken.trim().is_empty() {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let session = self.session.clone();
        let turn = self.turn.take();
        let mut provisional = Provisional {
            id: 0,
            panelist_id: self.panelist.clone(),
            input: self.input.clone(),
            draft: self.draft.take(),
            extra: Vec::new(),
            reply: vec![ContentBlock::text(self.said.trim().to_string())],
            spoken: self.spoken.trim().to_string(),
            tool_calls: Vec::new(),
            parked_at: Instant::now(),
            director: None,
        };
        tracing::info!(session_id = %self.session_id, panelist_id = %self.panelist, spoken_chars = provisional.spoken.len(), "turn cut off after speech; parked");
        handle.spawn(async move {
            let _turn = turn;
            let mut st = session.lock().await;
            provisional.id = st.new_turn_id();
            st.park(provisional);
        });
    }
}

/// One voice turn as an SSE stream. Runs inside the response stream, so if Fish drops the request the model call is
/// cancelled; what was already streamed is parked (see `TurnGuard`). Every call shares one deadline
/// (`turn_deadline`, under Fish's 10 s cap); when it passes with nothing said, the hold line is spoken.
fn turn_stream(
    app: AppState,
    session: Arc<Mutex<SessionState>>,
    session_id: String,
    panelist_req: Option<String>,
    input: UserInput,
    fish_last: Option<String>,
    model_name: String,
) -> impl Stream<Item = Result<Event, Infallible>> + Send + 'static {
    stream! {
        let started = Instant::now();
        let opts = app.orchestrator.clone();
        let turn_deadline = tokio::time::Instant::now() + opts.turn_deadline;
        let mut chunks = Chunks::new(model_name);

        let turn_lock = session.lock().await.turn_lock.clone();
        let wait = opts.turn_wait.min(opts.turn_deadline);
        let Ok(turn) = tokio::time::timeout(wait, turn_lock.lock_owned()).await else {
            tracing::warn!(session_id = %session_id, "previous turn still running; holding");
            // The candidate hears the hold line, so the turn is kept (parked until the next request confirms it).
            // The candidate's words are recorded now, like every turn.
            let jobs = {
                let mut st = session.lock().await;
                let panelist_id = st.resolve_panelist(panelist_req.as_deref());
                let now = Instant::now();
                st.resolve_provisional(&panelist_id, fish_last.as_deref());
                st.observe_fish_transcript(&panelist_id, fish_last.as_deref());
                st.sync_unanswered(&panelist_id, fish_last.as_deref());
                let mut draft = draft_turn(&st, &panelist_id, &input, now);
                st.record_user(&mut draft, now);
                let draft = Some(draft);
                let input = input.clone();
                let id = st.new_turn_id();
                st.park(Provisional {
                    id,
                    panelist_id,
                    input,
                    draft,
                    extra: Vec::new(),
                    reply: vec![ContentBlock::text(opts.hold_line.clone())],
                    spoken: opts.hold_line.clone(),
                    tool_calls: Vec::new(),
                    parked_at: now,
                    director: None,
                });
                st.take_director_jobs()
            };
            spawn_directors(&app, &session, &session_id, jobs);
            yield Ok(chunks.content(&opts.hold_line));
            yield Ok(chunks.finish(&Usage::default()));
            yield Ok(Chunks::done());
            return;
        };

        let empty_reply = {
            let mut st = session.lock().await;
            let empty = st.dev_empty_replies > 0;
            st.dev_empty_replies = st.dev_empty_replies.saturating_sub(1);
            empty
        };
        if empty_reply {
            tracing::info!(session_id = %session_id, "dev: empty reply sent");
            drop(turn);
            yield Ok(chunks.finish(&Usage::default()));
            yield Ok(Chunks::done());
            return;
        }

        // Meetings: the state update runner (it judges each confirmed user turn), and a decision turn waits briefly
        // for an update still running so the decision follows the newest state.
        let decision_wait = {
            let mut st = session.lock().await;
            crate::meeting::live::ensure_runner(
                &mut st,
                &session,
                app.llm.clone(),
                app.catalog.clone(),
                app.task_scope.as_ref(),
            );
            let panelist = st.resolve_panelist(panelist_req.as_deref());
            crate::meeting::live::decision_wait_needed(&st, &panelist, Instant::now())
        };
        if decision_wait {
            crate::meeting::live::wait_settled(&session, crate::meeting::live::DECISION_WAIT).await;
        }

        // The panelist first: only its own parked replies are settled against its own Fish transcript.
        let (panelist, handover_line, input, draft, live, jobs) = {
            let mut st = session.lock().await;
            let panelist = st.resolve_panelist(panelist_req.as_deref());
            st.resolve_provisional(&panelist, fish_last.as_deref());
            st.observe_fish_transcript(&panelist, fish_last.as_deref());
            st.sync_meeting_phase(Instant::now());
            // A line written in advance is spoken word for word: a hand-over, or a meeting's opening line.
            let handover_line = match input {
                UserInput::Event(EventKind::Handover | EventKind::Start) => st.pending_handover.get(&panelist).cloned(),
                _ => None,
            };
            // Fish sends the whole utterance again on each request; `record_user` revises or extends what is
            // recorded instead of adding it twice.
            st.sync_unanswered(&panelist, fish_last.as_deref());
            let draft = draft_turn(&st, &panelist, &input, Instant::now());
            let jobs = st.take_director_jobs();
            (panelist, handover_line, input.clone(), draft, st.live.clone(), jobs)
        };
        spawn_directors(&app, &session, &session_id, jobs);
        let mut guard = TurnGuard {
            session: session.clone(),
            turn: Some(turn),
            session_id: session_id.clone(),
            panelist: panelist.clone(),
            input: input.clone(),
            draft: None,
            spoken: String::new(),
            said: String::new(),
            done: false,
        };

        // A colleague already wrote this panelist's first line: say it, no model call. A line that filters to
        // nothing falls through to the model.
        if let Some(line) = handover_line {
            let mut filter = SpeechFilter::new();
            let spoken = format!("{}{}", filter.push(&line), filter.finish());
            if !spoken.trim().is_empty() {
                // Only the marker goes into the history; notes wait for this panelist's next real turn.
                let mut draft = draft.clone();
                draft.messages.truncate(1);
                draft.notes_used = 0;
                draft.warned_two_minutes = false;
                {
                    let mut st = session.lock().await;
                    let id = st.new_turn_id();
                    st.commit_now(
                        id,
                        TurnCommit {
                            draft,
                            extra: Vec::new(),
                            reply: vec![ContentBlock::text(line.clone())],
                            spoken: spoken.clone(),
                            tool_calls: Vec::new(),
                            handover_line_used: true,
                        },
                        Instant::now(),
                    );
                }
                guard.done = true;
                tracing::info!(session_id = %session_id, panelist_id = %panelist, llm_ttft_ms = 0u64, total_ms = started.elapsed().as_millis() as u64, "handover line");
                yield Ok(chunks.content(&spoken));
                yield Ok(chunks.finish(&Usage::default()));
                yield Ok(Chunks::done());
                return;
            }
            tracing::warn!(session_id = %session_id, panelist_id = %panelist, "hand-over line was empty after filtering; asking the model");
        }

        // The user turn is recorded now, whatever happens to the reply; the request is the history plus the note.
        let mut draft = draft;
        let mut req = {
            let mut st = session.lock().await;
            st.record_user(&mut draft, Instant::now());
            request_for_draft(&st, &panelist, &draft)
        };
        guard.draft = Some(draft.clone());
        let mut filter = SpeechFilter::new();
        let mut asm = Assembler::default();
        let mut extra: Vec<Message> = Vec::new();
        let mut earlier_calls: Vec<ToolCall> = Vec::new();
        let mut usage = Usage::default();
        let mut ttft_ms: Option<u64> = None;
        let mut retried = false;
        let mut continuations: u8 = 0;
        let mut last_error: Option<String> = None;

        loop {
            let per_call = if retried { opts.retry_first_text_timeout } else { opts.first_text_timeout };
            let deadline = (tokio::time::Instant::now() + per_call).min(turn_deadline);
            let mut text_seen = !guard.spoken.is_empty();
            let mut stop_reason: Option<String> = None;
            let mut error: Option<String> = None;

            match tokio::time::timeout_at(deadline, app.llm.stream(&req)).await {
                Err(_) => error = Some("no response before the first-text deadline".into()),
                Ok(Err(e)) => error = Some(e.to_string()),
                Ok(Ok(mut events)) => loop {
                    let next = if text_seen {
                        let idle = (tokio::time::Instant::now() + opts.idle_timeout).min(turn_deadline);
                        tokio::time::timeout_at(idle, events.next()).await
                    } else {
                        tokio::time::timeout_at(deadline, events.next()).await
                    };
                    match next {
                        Err(_) => {
                            error = Some(if text_seen { "stream stalled or turn deadline" } else { "no text before the first-text deadline" }.into());
                            break;
                        }
                        Ok(None) => {
                            error = Some("stream ended without a stop".into());
                            break;
                        }
                        Ok(Some(Err(e))) => {
                            error = Some(e.to_string());
                            break;
                        }
                        Ok(Some(Ok(StreamEvent::TextDelta(t)))) => {
                            text_seen = true;
                            asm.text(&t);
                            guard.said.push_str(&t);
                            let said = filter.push(&t);
                            if !said.is_empty() {
                                if ttft_ms.is_none() {
                                    ttft_ms = Some(started.elapsed().as_millis() as u64);
                                }
                                guard.spoken.push_str(&said);
                                yield Ok(chunks.content(&said));
                            }
                        }
                        Ok(Some(Ok(StreamEvent::ToolUse { id, name, input }))) => {
                            asm.tool(&panelist, id, name, input);
                        }
                        Ok(Some(Ok(StreamEvent::Block(block)))) => asm.block(block),
                        Ok(Some(Ok(StreamEvent::Stop { reason, usage: u }))) => {
                            add_usage(&mut usage, &u);
                            stop_reason = Some(reason);
                            break;
                        }
                    }
                },
            }

            let silent = guard.spoken.trim().is_empty();
            match (stop_reason.as_deref(), error) {
                // Inline tools: the model stopped for its tool results; send "ok" for each and let it finish its
                // turn (a reply can stop mid-turn, e.g. after "Hi, I'm Daniel." and show_question).
                (Some("tool_use"), None) if continuations < MAX_CONTINUATIONS && !asm.calls.is_empty() => {
                    continuations += 1;
                    if !silent {
                        // Keeps a space between this text and the continuation's.
                        let said = filter.push(" ");
                        if !said.is_empty() {
                            guard.spoken.push_str(&said);
                            yield Ok(chunks.content(&said));
                        }
                        guard.said.push(' ');
                    }
                    let ids = asm.tool_ids();
                    let (blocks, calls) = asm.take();
                    let assistant = Message { role: Role::Assistant, content: blocks };
                    let results = Message {
                        role: Role::User,
                        content: ids.iter().map(ContentBlock::tool_result_ok).collect(),
                    };
                    req.messages.push(assistant.clone());
                    req.messages.push(results.clone());
                    extra.push(assistant);
                    extra.push(results);
                    earlier_calls.extend(calls);
                    if tokio::time::Instant::now() >= turn_deadline {
                        last_error = Some("turn deadline before the continuation".into());
                        break;
                    }
                    continue;
                }
                (Some("refusal"), None) if silent => {
                    last_error = Some("refusal".into());
                }
                // Stopped with nothing to say and nothing to do (thinking used the budget, or all of it was
                // filtered): a failure like any other, so the retry gets its chance.
                (Some(reason), None) if silent && asm.calls.is_empty() && earlier_calls.is_empty() => {
                    tracing::warn!(session_id = %session_id, panelist_id = %panelist, model = %req.model, stop = reason, "live model stopped without speech");
                    last_error = Some(format!("stopped ({reason}) without speech"));
                }
                (Some(_), None) => break,
                (_, Some(err)) => {
                    tracing::warn!(session_id = %session_id, panelist_id = %panelist, model = %req.model, error = %err, "live model call failed");
                    last_error = Some(err);
                    if !silent {
                        break;
                    }
                }
                (None, None) => break,
            }
            // Nothing was said yet: one retry on the fast model, if the turn deadline leaves room for it.
            let left = turn_deadline.saturating_duration_since(tokio::time::Instant::now());
            if retried || left < MIN_RETRY_WINDOW {
                break;
            }
            retried = true;
            asm = Assembler::default();
            retarget_for_retry(&mut req, &live.fast_model);
        }

        let tail = filter.finish();
        if !tail.is_empty() {
            if ttft_ms.is_none() {
                ttft_ms = Some(started.elapsed().as_millis() as u64);
            }
            guard.spoken.push_str(&tail);
            yield Ok(chunks.content(&tail));
        }
        let mut spoken = guard.spoken.clone();

        let (mut reply, calls) = asm.take();
        if filter.cut_tool_text() {
            tracing::warn!(session_id = %session_id, panelist_id = %panelist, "tool text cut from the reply");
            // A tool written out as text never enters the history: the model would see its own text-form call on
            // every later turn. The recorded text is what was spoken.
            let mut first = true;
            reply.retain_mut(|b| match b {
                ContentBlock::Text { text, .. } => {
                    let keep = first;
                    first = false;
                    *text = spoken.trim().to_string();
                    keep
                }
                _ => true,
            });
        }
        let mut tool_calls = earlier_calls;
        let silent_failure = spoken.trim().is_empty() && last_error.is_some();
        if silent_failure {
            // Whatever the failed call left half-done is dropped.
            reply.clear();
        } else {
            tool_calls.extend(calls);
        }
        // A reply made only of thinking is no reply.
        if reply.iter().all(is_thinking) {
            reply.clear();
        }
        // The last call after tool results said nothing: end on the tool call itself and owe its results to the
        // next user message, so the history never has two user messages in a row.
        if reply.is_empty() && extra.last().is_some_and(|m| m.role == Role::User) {
            extra.pop();
            if let Some(assistant) = extra.pop() {
                reply = assistant.content;
            }
        }
        if spoken.trim().is_empty() {
            // Fish counts an empty reply as a failure: say the hold line instead.
            let at = reply.iter().position(|b| !is_thinking(b)).unwrap_or(reply.len());
            reply.insert(at, ContentBlock::text(opts.hold_line.clone()));
            spoken = opts.hold_line.clone();
            ttft_ms.get_or_insert(started.elapsed().as_millis() as u64);
            // Kept by the guard too, in case the request is dropped right after this chunk.
            guard.spoken = spoken.clone();
            guard.said = spoken.clone();
            yield Ok(chunks.content(&spoken));
        }

        // Record the turn before the final chunk, so a client that leaves right after the text still has it. A turn
        // that answers speech may be a speculative draft the voice platform never plays, so it is parked until the
        // platform confirms it; a typed app event is final and is committed now. The director request is built from
        // the same state (history before this turn) and runs on its own.
        // A parked reply carries its director request: the director runs once the reply is confirmed as played
        // (the browser reports playback as the first words play, so this costs no time for played lines and saves
        // the call for drafts the voice platform throws away).
        let speech = input.speech().is_some();
        let jobs = {
            let mut st = session.lock().await;
            let id = st.new_turn_id();
            let director_req = (live.tools == ToolsMode::Director && !silent_failure)
                .then(|| director::build_request(&st, &panelist, &draft, &spoken, &live.fast_model));
            if speech && opts.confirm_speech_turns {
                st.park(Provisional {
                    id,
                    panelist_id: panelist.clone(),
                    input: input.clone(),
                    draft: Some(draft),
                    extra,
                    reply,
                    spoken: spoken.clone(),
                    tool_calls,
                    parked_at: Instant::now(),
                    director: director_req,
                });
            } else {
                st.commit_now(
                    id,
                    TurnCommit {
                        draft,
                        extra,
                        reply,
                        spoken: spoken.clone(),
                        tool_calls,
                        handover_line_used: false,
                    },
                    Instant::now(),
                );
                if let Some(req) = director_req {
                    st.director_jobs.push(DirectorJob { turn_id: id, panelist_id: panelist.clone(), req });
                }
            }
            st.take_director_jobs()
        };
        guard.done = true;
        drop(guard);
        spawn_directors(&app, &session, &session_id, jobs);
        tracing::info!(
            session_id = %session_id,
            panelist_id = %panelist,
            model = %req.model,
            llm_ttft_ms = ttft_ms.unwrap_or_default(),
            total_ms = started.elapsed().as_millis() as u64,
            retried,
            continuations,
            failed = silent_failure,
            input_tokens = usage.input_tokens,
            cache_read_input_tokens = usage.cache_read_input_tokens,
            cache_creation_input_tokens = usage.cache_creation_input_tokens,
            output_tokens = usage.output_tokens,
            "live turn"
        );
        yield Ok(chunks.finish(&usage));
        yield Ok(Chunks::done());
    }
}

/// Sends the director calls of committed replies (`SessionState::take_director_jobs`), each in its own task. Their
/// model usage is charged to the session.
pub fn spawn_directors(
    app: &AppState,
    session: &Arc<Mutex<SessionState>>,
    session_id: &str,
    jobs: Vec<DirectorJob>,
) {
    for job in jobs {
        let fut = run_director(
            app.clone(),
            session.clone(),
            session_id.to_string(),
            job.panelist_id,
            job.turn_id,
            job.req,
        );
        match uuid::Uuid::parse_str(session_id) {
            Ok(id) => {
                tokio::spawn(crate::usage::LLM_SESSION.scope(id, fut));
            }
            Err(_) => {
                tokio::spawn(fut);
            }
        }
    }
}

/// Runs the director for one spoken line and applies the tool calls it makes (they reach the browser as socket
/// events). Its calls are not part of the model history: the live model only ever sees speech.
async fn run_director(
    app: AppState,
    session: Arc<Mutex<SessionState>>,
    session_id: String,
    panelist: String,
    turn_id: u64,
    req: MessagesRequest,
) {
    let started = Instant::now();
    let res = tokio::time::timeout(DIRECTOR_TIMEOUT, app.llm.create(&req)).await;
    let ms = started.elapsed().as_millis() as u64;
    let resp = match res {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            tracing::warn!(session_id = %session_id, panelist_id = %panelist, director_ms = ms, error = %e, "director call failed");
            return;
        }
        Err(_) => {
            tracing::warn!(session_id = %session_id, panelist_id = %panelist, director_ms = ms, "director timed out");
            return;
        }
    };
    let calls: Vec<ToolCall> = resp
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, name, input } => Some(ToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
                panelist_id: panelist.clone(),
            }),
            _ => None,
        })
        .collect();
    let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
    // Only played lines reach the director; the count shows what it costs per session.
    let director_calls = {
        let mut st = session.lock().await;
        st.director_calls += 1;
        st.director_calls
    };
    tracing::info!(
        session_id = %session_id,
        panelist_id = %panelist,
        model = %req.model,
        turn_id,
        director_ms = ms,
        director_calls,
        tools = ?names,
        cache_read_input_tokens = resp.usage.cache_read_input_tokens,
        input_tokens = resp.usage.input_tokens,
        "director"
    );
    session.lock().await.director_done(turn_id, calls);
}
