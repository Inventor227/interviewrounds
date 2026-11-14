//! Claude client against a local mock server. The live smoke test is `#[ignore]`d and needs
//! `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID` in the environment.

use std::time::{Duration, Instant};

use futures::StreamExt;
use ir_server::claude::{
    API_VERSION, ClaudeClient, ClaudeError, ContentBlock, Message, MessagesRequest, OutputConfig,
    StreamEvent, SystemBlock, fallbacks_for, thinking_for,
};
use serde_json::json;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn request(model: &str) -> MessagesRequest {
    MessagesRequest {
        model: model.to_string(),
        max_tokens: 64,
        system: vec![SystemBlock::cached("You are a test.")],
        messages: vec![Message::user_text("Hi")],
        ..MessagesRequest::default()
    }
}

fn client(server: &MockServer) -> ClaudeClient {
    ClaudeClient::with_base_url("test-key", "test-workspace", &server.uri())
}

fn sse(events: &[(&str, serde_json::Value)]) -> String {
    events
        .iter()
        .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
        .collect()
}

#[tokio::test]
async fn sends_workspace_and_version_headers() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("x-api-key", "test-key"))
        .and(header("anthropic-workspace-id", "test-workspace"))
        .and(header("anthropic-version", API_VERSION))
        .and(body_partial_json(json!({
            "model": "claude-haiku-5-5",
            "system": [{"type": "text", "text": "You are a test.", "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": [{"type": "text", "text": "Hi"}]}]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-5-5",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 2}
        })))
        .expect(1)
        .mount(&server)
        .await;

    assert_eq!(API_VERSION, "2026-10-21");
    let res = client(&server)
        .create(&request("claude-haiku-5-5"))
        .await
        .expect("create");
    assert_eq!(res.text(), "ok");
    assert_eq!(res.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(res.usage.input_tokens, 10);
}

#[tokio::test]
async fn request_never_carries_sampling_params_and_adds_fallback_beta() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("anthropic-beta", "server-side-fallback-2026-07-01"))
        .and(body_partial_json(json!({"fallbacks": "default", "output_config": {"effort": "low"}})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
            "content": [], "stop_reason": "max_tokens", "usage": {"input_tokens": 1, "output_tokens": 0}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut req = request("claude-opus-5-5");
    req.fallbacks = fallbacks_for(&req.model);
    req.thinking = thinking_for(&req.model);
    req.output_config = Some(OutputConfig::effort("low"));
    let body = serde_json::to_value(&req).unwrap();
    for banned in [
        "temperature",
        "top_p",
        "top_k",
        "thinking",
        "tools",
        "stream",
    ] {
        assert!(
            body.get(banned).is_none(),
            "{banned} must not be sent: {body}"
        );
    }
    client(&server).create(&req).await.expect("create");
}

#[test]
fn thinking_config_follows_the_model_family() {
    assert_eq!(
        serde_json::to_value(thinking_for("claude-opus-5-5")).unwrap(),
        json!(null)
    );
    assert_eq!(
        serde_json::to_value(thinking_for("claude-sonnet-5-5")).unwrap(),
        json!({"type": "between_tools"})
    );
    assert_eq!(
        serde_json::to_value(thinking_for("claude-haiku-5-5")).unwrap(),
        json!({"type": "disabled"})
    );
    assert_eq!(fallbacks_for("claude-haiku-5-5"), None);
    assert_eq!(fallbacks_for("claude-sonnet-5-5"), Some(json!("default")));
}

#[tokio::test]
async fn stream_yields_text_then_tool_use_then_stop() {
    let body = sse(&[
        (
            "message_start",
            json!({"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5", "content": [], "usage": {"input_tokens": 42, "cache_read_input_tokens": 30, "output_tokens": 1}}}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ),
        ("ping", json!({"type": "ping"})),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Okay. "}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Next question."}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "show_question", "input": {}}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"question\": \"Des"}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "ign a cache\", \"lines\": [\"1M users\"]}"}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 1}),
        ),
        (
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 25}}),
        ),
        ("message_stop", json!({"type": "message_stop"})),
    ]);
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(body_partial_json(json!({"stream": true})))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(body),
        )
        .expect(1)
        .mount(&server)
        .await;

    let mut req = request("claude-haiku-5-5");
    req.stream = true;
    let events: Vec<StreamEvent> = client(&server)
        .stream(&req)
        .await
        .expect("open stream")
        .map(|e| e.expect("event"))
        .collect()
        .await;

    assert_eq!(
        events,
        vec![
            StreamEvent::TextDelta("Okay. ".into()),
            StreamEvent::TextDelta("Next question.".into()),
            StreamEvent::ToolUse {
                id: "toolu_1".into(),
                name: "show_question".into(),
                input: json!({"question": "Design a cache", "lines": ["1M users"]}),
            },
            StreamEvent::Stop {
                reason: "tool_use".into(),
                usage: ir_server::claude::Usage {
                    input_tokens: 42,
                    output_tokens: 25,
                    cache_read_input_tokens: 30,
                    cache_creation_input_tokens: 0,
                },
            },
        ]
    );
}

#[tokio::test]
async fn stream_keeps_thinking_blocks_for_replay() {
    let body = sse(&[
        (
            "message_start",
            json!({"type": "message_start", "message": {"id": "m", "model": "claude-opus-5-5", "usage": {"input_tokens": 5}}}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig=="}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": "Hi."}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 1}),
        ),
        (
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}}),
        ),
        ("message_stop", json!({"type": "message_stop"})),
    ]);
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;
    let events: Vec<StreamEvent> = client(&server)
        .stream(&request("claude-opus-5-5"))
        .await
        .unwrap()
        .map(|e| e.unwrap())
        .collect()
        .await;
    assert_eq!(
        events[0],
        StreamEvent::Block(ContentBlock::Thinking {
            thinking: "hmm".into(),
            signature: "sig==".into()
        })
    );
    assert_eq!(events[1], StreamEvent::TextDelta("Hi.".into()));
    assert!(matches!(&events[2], StreamEvent::Stop { reason, .. } if reason == "end_turn"));
}

#[tokio::test]
async fn stream_error_event_and_early_end_are_errors() {
    let body = sse(&[
        (
            "message_start",
            json!({"type": "message_start", "message": {"id": "m", "usage": {"input_tokens": 5}}}),
        ),
        (
            "error",
            json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        ),
    ]);
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;
    let events: Vec<_> = client(&server)
        .stream(&request("claude-haiku-5-5"))
        .await
        .unwrap()
        .collect()
        .await;
    assert!(
        matches!(events.last(), Some(Err(ClaudeError::Overloaded))),
        "{events:?}"
    );

    let server = MockServer::start().await;
    let cut = sse(&[(
        "content_block_start",
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "Hal"}}),
    )]);
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(cut))
        .mount(&server)
        .await;
    let events: Vec<_> = client(&server)
        .stream(&request("claude-haiku-5-5"))
        .await
        .unwrap()
        .collect()
        .await;
    assert!(matches!(&events[0], Ok(StreamEvent::TextDelta(t)) if t == "Hal"));
    assert!(
        matches!(events.last(), Some(Err(ClaudeError::Network(_)))),
        "{events:?}"
    );
}

#[tokio::test]
async fn maps_429_to_rate_limited() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "7")
                .set_body_json(json!({"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}})),
        )
        .mount(&server)
        .await;
    let c = client(&server);
    let err = c.create(&request("claude-haiku-5-5")).await.unwrap_err();
    assert_eq!(
        err,
        ClaudeError::RateLimited {
            retry_after: Some(Duration::from_secs(7))
        }
    );
    let err = c.stream(&request("claude-haiku-5-5")).await.err().unwrap();
    assert!(matches!(err, ClaudeError::RateLimited { .. }));
}

#[tokio::test]
async fn maps_other_statuses_and_refusal() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(body_partial_json(json!({"model": "overloaded"})))
        .respond_with(ResponseTemplate::new(529).set_body_json(
            json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(json!({"model": "bad"})))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "type": "error",
            "error": {"type": "invalid_request_error", "message": "bad thing with sk-ant-abc123"}
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(json!({"model": "refuses"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "m", "type": "message", "role": "assistant", "model": "refuses",
            "content": [], "stop_reason": "refusal", "usage": {"input_tokens": 1, "output_tokens": 0}
        })))
        .mount(&server)
        .await;

    let c = client(&server);
    assert_eq!(
        c.create(&request("overloaded")).await.unwrap_err(),
        ClaudeError::Overloaded
    );
    match c.create(&request("bad")).await.unwrap_err() {
        ClaudeError::BadRequest(msg) => {
            assert!(msg.contains("bad thing"), "{msg}");
            assert!(!msg.contains("sk-ant-abc123"), "secret leaked: {msg}");
        }
        other => panic!("expected BadRequest, got {other:?}"),
    }
    assert_eq!(
        c.create(&request("refuses")).await.unwrap_err(),
        ClaudeError::Refusal
    );
}

#[tokio::test]
async fn unreachable_server_is_a_network_error() {
    let c = ClaudeClient::with_base_url("k", "w", "http://127.0.0.1:1");
    assert!(matches!(
        c.create(&request("claude-haiku-5-5")).await,
        Err(ClaudeError::Network(_))
    ));
}

#[tokio::test]
async fn prewarm_sends_max_tokens_zero() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(body_partial_json(json!({"max_tokens": 0})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "m", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
            "content": [], "stop_reason": "max_tokens", "usage": {"input_tokens": 1, "output_tokens": 0}
        })))
        .expect(1)
        .mount(&server)
        .await;
    let mut req = request("claude-haiku-5-5");
    req.stream = true;
    client(&server).prewarm(&req);
    let deadline = Instant::now() + Duration::from_secs(5);
    while server
        .received_requests()
        .await
        .unwrap_or_default()
        .is_empty()
        && Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let got = server.received_requests().await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&got[0].body).unwrap();
    assert_eq!(body["max_tokens"], 0);
    assert!(
        body.get("stream").is_none(),
        "prewarm is not streamed: {body}"
    );
}

#[test]
fn debug_output_hides_the_key() {
    let c = ClaudeClient::with_base_url("SECRET-KEY", "SECRET-WS", "http://x");
    let shown = format!("{c:?}");
    assert!(!shown.contains("SECRET"), "{shown}");
}

/// One real call per model, with the model API key in the environment: `cargo test --test claude_client -- --ignored`.
#[tokio::test]
#[ignore = "calls the real API"]
async fn live_smoke_three_models() {
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY");
    let ws = std::env::var("ANTHROPIC_WORKSPACE_ID").expect("ANTHROPIC_WORKSPACE_ID");
    let c = ClaudeClient::with_base_url(&key, &ws, ir_server::claude::DEFAULT_BASE_URL);
    for model in ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] {
        let req = MessagesRequest {
            model: model.into(),
            max_tokens: 16,
            system: vec![SystemBlock::cached("You answer in one word.")],
            // A mid-conversation system message, as the live interviewer uses every turn.
            messages: vec![
                Message::user_text("Say ok."),
                Message::system_text("Reply with the single word ok."),
            ],
            thinking: thinking_for(model),
            output_config: Some(OutputConfig::effort("low")),
            fallbacks: fallbacks_for(model),
            ..MessagesRequest::default()
        };
        let t = Instant::now();
        let res = c.create(&req).await;
        println!(
            "{model} create: {:?} in {} ms",
            res.as_ref()
                .map(|r| (r.model.clone(), r.stop_reason.clone(), r.text())),
            t.elapsed().as_millis()
        );
        res.expect("create 200");

        let mut sreq = req.clone();
        sreq.stream = true;
        let t = Instant::now();
        let mut s = c.stream(&sreq).await.expect("stream 200");
        let mut first = None;
        let mut stop = None;
        while let Some(ev) = s.next().await {
            match ev.expect("stream event") {
                StreamEvent::TextDelta(_) if first.is_none() => {
                    first = Some(t.elapsed().as_millis())
                }
                StreamEvent::Stop { reason, .. } => stop = Some(reason),
                _ => {}
            }
        }
        println!(
            "{model} stream: first text {first:?} ms, stop {stop:?}, total {} ms",
            t.elapsed().as_millis()
        );
        assert!(stop.is_some(), "{model} stream ended without stop");
    }
}

#[tokio::test]
async fn transient_timeouts_are_retryable_and_other_4xx_are_final() {
    let server = MockServer::start().await;
    for (model, status) in [
        ("timeout", 408u16),
        ("conflict", 409),
        ("gone", 404),
        ("large", 413),
    ] {
        Mock::given(method("POST"))
            .and(body_partial_json(json!({"model": model})))
            .respond_with(ResponseTemplate::new(status).set_body_json(
                json!({"type": "error", "error": {"type": "some_error", "message": "x"}}),
            ))
            .mount(&server)
            .await;
    }
    let c = client(&server);
    let e = c.create(&request("timeout")).await.unwrap_err();
    assert_eq!(e, ClaudeError::ServerError { status: 408 });
    assert!(e.is_unavailable());
    for model in ["conflict", "gone", "large"] {
        let e = c.create(&request(model)).await.unwrap_err();
        assert!(matches!(e, ClaudeError::BadRequest(_)), "{model}: {e:?}");
        assert!(!e.is_unavailable(), "{model}");
    }

    // A stream that times out mid-way is retryable too.
    let body = sse(&[
        (
            "message_start",
            json!({"type": "message_start", "message": {"id": "m", "usage": {"input_tokens": 5}}}),
        ),
        (
            "error",
            json!({"type": "error", "error": {"type": "timeout_error", "message": "Timed out"}}),
        ),
    ]);
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;
    let events: Vec<_> = client(&server)
        .stream(&request("claude-haiku-5-5"))
        .await
        .unwrap()
        .collect()
        .await;
    match events.last() {
        Some(Err(e)) => {
            assert_eq!(*e, ClaudeError::ServerError { status: 504 });
            assert!(e.is_unavailable());
        }
        other => panic!("{other:?}"),
    }
}
