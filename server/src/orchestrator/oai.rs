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
use tokio::sync::Mutex;

use super::constant_time_eq;
use super::markers::{EventKind, UserInput, parse_user_input};
use super::prompt::prepare_live_turn;
use super::speech_filter::SpeechFilter;
use super::state::{SessionState, TurnCommit, VoiceKind};
use super::tools::ToolCall;
use crate::app::AppState;
use crate::claude::{
    ContentBlock, Message, MessagesRequest, Role, StreamEvent, Usage, fallbacks_for,
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
    let Some(newest) = req.messages.iter().rposition(|m| m.role == "user") else {
        return AppError::BadRequest("no user message".into()).into_response();
    };
    let input = parse_user_input(&req.messages[newest].text());
    let fish_last = req.messages[..newest]
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .map(OaiMessage::text);
    let model_name = req
        .model
        .clone()
        .unwrap_or_else(|| "interview-rounds".into());

    let events = turn_stream(
        app,
        session,
        session_id,
        panelist_id,
        input,
        fish_last,
        model_name,
    );
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
fn retarget_for_retry(req: &mut MessagesRequest, model: &str) {
    req.model = model.to_string();
    req.thinking = None;
    req.fallbacks = fallbacks_for(model);
}

/// Model calls per turn after tool use: the model gets its "ok" results and finishes what it was saying.
const MAX_CONTINUATIONS: u8 = 2;

fn add_usage(total: &mut Usage, u: &Usage) {
    total.input_tokens += u.input_tokens;
    total.output_tokens += u.output_tokens;
    total.cache_read_input_tokens += u.cache_read_input_tokens;
    total.cache_creation_input_tokens += u.cache_creation_input_tokens;
}

/// One voice turn as an SSE stream. Runs inside the response stream, so if Fish drops the request (for example a
/// discarded speculative draft) the model call is cancelled and nothing is committed to the history.
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
        let mut chunks = Chunks::new(model_name);

        let turn_lock = session.lock().await.turn_lock.clone();
        let Ok(_turn) = tokio::time::timeout(opts.turn_wait, turn_lock.lock_owned()).await else {
            tracing::warn!(session_id = %session_id, "previous turn still running; holding");
            yield Ok(chunks.content(&opts.hold_line));
            yield Ok(chunks.finish(&Usage::default()));
            yield Ok(Chunks::done());
            return;
        };

        let (panelist, handover_line, req, draft, live) = {
            let mut st = session.lock().await;
            let panelist = st.resolve_panelist(panelist_req.as_deref());
            st.observe_fish_transcript(&panelist, fish_last.as_deref());
            let handover_line = match input {
                UserInput::Event(EventKind::Handover) => st.pending_handover.get(&panelist).cloned(),
                _ => None,
            };
            let (req, draft) = prepare_live_turn(&st, &panelist, &input, Instant::now());
            (panelist, handover_line, req, draft, st.live.clone())
        };

        // A colleague already wrote this panelist's first line: say it, no model call.
        if let Some(line) = handover_line {
            // Only the marker goes into the history; notes wait for this panelist's next real turn.
            let mut draft = draft;
            draft.messages.truncate(1);
            draft.notes_used = 0;
            draft.warned_two_minutes = false;
            let mut filter = SpeechFilter::new();
            let spoken = format!("{}{}", filter.push(&line), filter.finish());
            {
                let mut st = session.lock().await;
                st.commit_turn(
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
            tracing::info!(session_id = %session_id, panelist_id = %panelist, llm_ttft_ms = 0u64, total_ms = started.elapsed().as_millis() as u64, "handover line");
            yield Ok(chunks.content(&spoken));
            yield Ok(chunks.finish(&Usage::default()));
            yield Ok(Chunks::done());
            return;
        }

        let mut req = req;
        let mut filter = SpeechFilter::new();
        let mut spoken = String::new();
        let mut asm = Assembler::default();
        let mut extra: Vec<Message> = Vec::new();
        let mut earlier_calls: Vec<ToolCall> = Vec::new();
        let mut usage = Usage::default();
        let mut ttft_ms: Option<u64> = None;
        let mut retried = false;
        let mut continuations: u8 = 0;
        let mut last_error: Option<String> = None;

        loop {
            let first_timeout = if retried { opts.retry_first_text_timeout } else { opts.first_text_timeout };
            let deadline = tokio::time::Instant::now() + first_timeout;
            let mut text_seen = !spoken.is_empty();
            let mut stop_reason: Option<String> = None;
            let mut error: Option<String> = None;

            match tokio::time::timeout_at(deadline, app.llm.stream(&req)).await {
                Err(_) => error = Some("no response before the first-text deadline".into()),
                Ok(Err(e)) => error = Some(e.to_string()),
                Ok(Ok(mut events)) => loop {
                    let next = if text_seen {
                        tokio::time::timeout(opts.idle_timeout, events.next()).await
                    } else {
                        tokio::time::timeout_at(deadline, events.next()).await
                    };
                    match next {
                        Err(_) => {
                            error = Some(if text_seen { "stream stalled" } else { "no text before the first-text deadline" }.into());
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
                            let said = filter.push(&t);
                            if !said.is_empty() {
                                if ttft_ms.is_none() {
                                    ttft_ms = Some(started.elapsed().as_millis() as u64);
                                }
                                spoken.push_str(&said);
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

            let silent = spoken.trim().is_empty();
            match (stop_reason.as_deref(), error) {
                // The model stopped for its tool results: send "ok" for each and let it finish its turn
                // (a reply can stop mid-turn, e.g. after "Hi, I'm Daniel." and show_question).
                (Some("tool_use"), None) if continuations < MAX_CONTINUATIONS && !asm.calls.is_empty() => {
                    continuations += 1;
                    if !silent {
                        // Keeps a space between this text and the continuation's.
                        let said = filter.push(" ");
                        if !said.is_empty() {
                            spoken.push_str(&said);
                            yield Ok(chunks.content(&said));
                        }
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
                    continue;
                }
                (Some("refusal"), None) if silent && !retried => {
                    last_error = Some("refusal".into());
                }
                (Some(_), None) => break,
                (_, Some(err)) => {
                    tracing::warn!(session_id = %session_id, panelist_id = %panelist, model = %req.model, error = %err, "live model call failed");
                    last_error = Some(err);
                    if !silent || retried {
                        break;
                    }
                }
                (None, None) => break,
            }
            // Nothing was said yet: one retry on the fast model.
            retried = true;
            asm = Assembler::default();
            retarget_for_retry(&mut req, &live.fast_model);
        }

        let tail = filter.finish();
        if !tail.is_empty() {
            if ttft_ms.is_none() {
                ttft_ms = Some(started.elapsed().as_millis() as u64);
            }
            spoken.push_str(&tail);
            yield Ok(chunks.content(&tail));
        }

        let (mut reply, calls) = asm.take();
        let mut tool_calls = earlier_calls;
        let silent_failure = spoken.trim().is_empty() && last_error.is_some();
        if silent_failure {
            // Whatever the failed call left half-done is dropped.
            reply.clear();
        } else {
            tool_calls.extend(calls);
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
            let at = reply
                .iter()
                .position(|b| !matches!(b, ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. }))
                .unwrap_or(reply.len());
            reply.insert(at, ContentBlock::text(opts.hold_line.clone()));
            spoken = opts.hold_line.clone();
            ttft_ms.get_or_insert(started.elapsed().as_millis() as u64);
            yield Ok(chunks.content(&spoken));
        }

        // Commit before the final chunk, so a client that leaves right after the text still gets a history entry.
        {
            let mut st = session.lock().await;
            st.commit_turn(
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
        }
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
