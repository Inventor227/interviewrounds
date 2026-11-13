//! Decodes the Messages API SSE stream into `StreamEvent`s.

use std::collections::{BTreeMap, VecDeque};

use bytes::Bytes;
use eventsource_stream::Eventsource;
use futures::stream::{self, BoxStream, Stream, StreamExt};
use serde_json::Value;

use super::{ClaudeError, ContentBlock, StreamEvent, Usage, scrub};

/// One content block being assembled.
enum Partial {
    Text,
    ToolUse { id: String, name: String, json: String },
    Thinking { thinking: String, signature: String },
    /// Any other block type: kept whole as it started (deltas for it are ignored).
    Other(Value),
}

/// Stateful decoder for one response: feed it each SSE event, get zero or more `StreamEvent`s back.
#[derive(Default)]
pub struct StreamDecoder {
    blocks: BTreeMap<u64, Partial>,
    usage: Usage,
    stop_reason: Option<String>,
    finished: bool,
}

impl StreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// True once `message_stop` has been seen.
    pub fn finished(&self) -> bool {
        self.finished
    }

    /// Handles one SSE event (`event:` name and `data:` payload).
    pub fn on_event(&mut self, name: &str, data: &str) -> Result<Vec<StreamEvent>, ClaudeError> {
        if data.trim().is_empty() {
            return Ok(Vec::new());
        }
        let v: Value = serde_json::from_str(data)
            .map_err(|e| ClaudeError::Network(format!("bad stream event {name}: {e}")))?;
        let kind = v.get("type").and_then(Value::as_str).unwrap_or(name);
        let mut out = Vec::new();
        match kind {
            "message_start" => {
                if let Some(u) = v.pointer("/message/usage") {
                    merge_usage(&mut self.usage, u);
                }
            }
            "content_block_start" => {
                let index = index_of(&v);
                let block = v.get("content_block").cloned().unwrap_or(Value::Null);
                let partial = match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            out.push(StreamEvent::TextDelta(text.to_string()));
                        }
                        Partial::Text
                    }
                    Some("tool_use") => Partial::ToolUse {
                        id: str_field(&block, "id"),
                        name: str_field(&block, "name"),
                        json: String::new(),
                    },
                    Some("thinking") => Partial::Thinking {
                        thinking: str_field(&block, "thinking"),
                        signature: str_field(&block, "signature"),
                    },
                    _ => Partial::Other(block),
                };
                self.blocks.insert(index, partial);
            }
            "content_block_delta" => {
                let index = index_of(&v);
                let delta = v.get("delta").cloned().unwrap_or(Value::Null);
                let dkind = delta.get("type").and_then(Value::as_str).unwrap_or("");
                match (self.blocks.get_mut(&index), dkind) {
                    (_, "text_delta") => {
                        let text = str_field(&delta, "text");
                        if !text.is_empty() {
                            out.push(StreamEvent::TextDelta(text));
                        }
                    }
                    (Some(Partial::ToolUse { json, .. }), "input_json_delta") => {
                        json.push_str(delta.get("partial_json").and_then(Value::as_str).unwrap_or(""));
                    }
                    (Some(Partial::Thinking { thinking, .. }), "thinking_delta") => {
                        thinking.push_str(delta.get("thinking").and_then(Value::as_str).unwrap_or(""));
                    }
                    (Some(Partial::Thinking { signature, .. }), "signature_delta") => {
                        signature.push_str(delta.get("signature").and_then(Value::as_str).unwrap_or(""));
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = index_of(&v);
                match self.blocks.remove(&index) {
                    Some(Partial::ToolUse { id, name, json }) => {
                        // Tool input is parsed only once the block is complete.
                        let input = if json.trim().is_empty() {
                            Value::Object(Default::default())
                        } else {
                            serde_json::from_str(&json).map_err(|e| {
                                ClaudeError::Network(format!("tool {name} input is not JSON: {e}"))
                            })?
                        };
                        out.push(StreamEvent::ToolUse { id, name, input });
                    }
                    Some(Partial::Thinking { thinking, signature }) => {
                        out.push(StreamEvent::Block(ContentBlock::Thinking { thinking, signature }));
                    }
                    Some(Partial::Other(block)) => {
                        let block = serde_json::from_value(block.clone())
                            .unwrap_or(ContentBlock::Other(block));
                        out.push(StreamEvent::Block(block));
                    }
                    Some(Partial::Text) | None => {}
                }
            }
            "message_delta" => {
                if let Some(reason) = v.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(reason.to_string());
                }
                if let Some(u) = v.get("usage") {
                    merge_usage(&mut self.usage, u);
                }
            }
            "message_stop" => {
                self.finished = true;
                out.push(StreamEvent::Stop {
                    reason: self.stop_reason.clone().unwrap_or_else(|| "end_turn".into()),
                    usage: self.usage.clone(),
                });
            }
            "error" => {
                let etype = v.pointer("/error/type").and_then(Value::as_str).unwrap_or("");
                let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("");
                return Err(match etype {
                    "overloaded_error" | "api_error" => ClaudeError::Overloaded,
                    "rate_limit_error" => ClaudeError::RateLimited { retry_after: None },
                    _ => ClaudeError::BadRequest(scrub(&format!("{etype}: {msg}"))),
                });
            }
            // ping and anything new
            _ => {}
        }
        Ok(out)
    }
}

fn index_of(v: &Value) -> u64 {
    v.get("index").and_then(Value::as_u64).unwrap_or(0)
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Later usage numbers replace earlier ones field by field (message_delta carries the final output count).
fn merge_usage(usage: &mut Usage, v: &Value) {
    let get = |k: &str| v.get(k).and_then(Value::as_u64);
    if let Some(n) = get("input_tokens") {
        usage.input_tokens = n;
    }
    if let Some(n) = get("output_tokens") {
        usage.output_tokens = n;
    }
    if let Some(n) = get("cache_read_input_tokens") {
        usage.cache_read_input_tokens = n;
    }
    if let Some(n) = get("cache_creation_input_tokens") {
        usage.cache_creation_input_tokens = n;
    }
}

/// Turns the response body into a stream of events. The stream ends after `Stop`, or with one error
/// (an `error` event, a cut connection, or the body ending before `message_stop`).
pub(crate) fn decode<S, E>(body: S) -> BoxStream<'static, Result<StreamEvent, ClaudeError>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    let events = body.eventsource().boxed();
    stream::unfold(
        (events, StreamDecoder::new(), VecDeque::new(), false),
        |(mut events, mut dec, mut queue, mut done)| async move {
            loop {
                if let Some(item) = queue.pop_front() {
                    return Some((item, (events, dec, queue, done)));
                }
                if done {
                    return None;
                }
                match events.next().await {
                    None => {
                        done = true;
                        if !dec.finished() {
                            queue.push_back(Err(ClaudeError::Network(
                                "stream ended before message_stop".into(),
                            )));
                        }
                    }
                    Some(Err(err)) => {
                        done = true;
                        queue.push_back(Err(ClaudeError::Network(scrub(&err.to_string()))));
                    }
                    Some(Ok(ev)) => match dec.on_event(&ev.event, &ev.data) {
                        Ok(items) => {
                            queue.extend(items.into_iter().map(Ok));
                            if dec.finished() {
                                done = true;
                            }
                        }
                        Err(err) => {
                            done = true;
                            queue.push_back(Err(err));
                        }
                    },
                }
            }
        },
    )
    .boxed()
}
