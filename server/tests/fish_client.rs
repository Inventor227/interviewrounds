//! Fish Audio agent session client against a local mock server (no real sessions).

use ir_server::fish::{CreateFishSession, FishClient, FishError};
use serde_json::json;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client(server: &MockServer) -> FishClient {
    FishClient::with_base_url("test-fish-key", &server.uri())
}

fn create_req() -> CreateFishSession {
    CreateFishSession {
        agent_id: "agent-1".into(),
        end_user_id: "guest-1".into(),
        voice_id: "voice-maya".into(),
        system_prompt: "You are Maya.".into(),
        first_message: None,
        llm_extra_body: json!({"session_id": "sess-1", "panelist_id": "p1"}),
        record_audio: true,
        asr_model: Some("deepgram:nova-3".into()),
    }
}

#[tokio::test]
async fn fish_create_session_passes_overrides() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/agent/sessions"))
        .and(header("authorization", "Bearer test-fish-key"))
        .and(body_partial_json(json!({
            "agent_id": "agent-1",
            "end_user_id": "guest-1",
            "overrides": {"voice_id": "voice-maya", "system_prompt": "You are Maya.", "asr": {"model": "deepgram:nova-3"}},
            "llm_extra_body": {"session_id": "sess-1", "panelist_id": "p1"},
            "record_audio": true
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "session_id": "sess_abc",
            "expires_at": "2026-11-13T12:00:00Z",
            "max_duration_seconds": 1800,
            "transport": "livekit",
            "livekit_url": "wss://x.livekit.cloud",
            "token": "tok-123"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let tok = client(&server)
        .create_session(&create_req())
        .await
        .expect("create");
    assert_eq!(tok.session_id, "sess_abc");
    assert_eq!(tok.token, "tok-123");
    assert_eq!(tok.livekit_url, "wss://x.livekit.cloud");
    assert_eq!(tok.expires_at.as_deref(), Some("2026-11-13T12:00:00Z"));
    // Fields the voice SDK checks reach the browser unchanged.
    let passed = serde_json::to_value(&tok).unwrap();
    assert_eq!(passed["transport"], "livekit");
    assert_eq!(passed["max_duration_seconds"], 1800);

    // first_message is left out when absent, sent when present.
    let got = server.received_requests().await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&got[0].body).unwrap();
    assert!(body["overrides"].get("first_message").is_none(), "{body}");
}

#[tokio::test]
async fn fish_create_session_sends_first_message_when_set() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({"overrides": {"first_message": "Hi there."}}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "session_id": "s", "expires_at": 1763035200, "livekit_url": "wss://l", "token": "t"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let mut req = create_req();
    req.first_message = Some("Hi there.".into());
    let tok = client(&server).create_session(&req).await.expect("create");
    assert_eq!(tok.expires_at.as_deref(), Some("1763035200"));
}

#[tokio::test]
async fn fish_errors_carry_status() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(409).set_body_json(json!({"message": "agent not published"})),
        )
        .mount(&server)
        .await;
    match client(&server).create_session(&create_req()).await {
        Err(FishError::Http { status, message }) => {
            assert_eq!(status, 409);
            assert!(message.contains("not published"), "{message}");
        }
        other => panic!("expected Http error, got {other:?}"),
    }
}

#[tokio::test]
async fn fish_end_and_get_session() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/agent/sessions/sess_abc/end"))
        .and(header("authorization", "Bearer test-fish-key"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/agent/sessions/sess_abc"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "session_id": "sess_abc",
            "duration_seconds": 41.5,
            "items": [
                {"type": "message", "role": "assistant", "text": "Hi, I'm Maya.", "created_at": "2026-11-13T10:00:00.250Z", "turn_id": "t1"},
                {"type": "message", "role": "user", "content": "Hello.", "created_at": 1794564001500i64},
                {"type": "tool_call", "name": "x", "created_at": 1794564002000i64}
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let c = client(&server);
    c.end_session("sess_abc").await.expect("end");
    let d = c.get_session("sess_abc").await.expect("get");
    assert_eq!(d.duration_seconds, Some(41.5));
    assert_eq!(d.items.len(), 3);
    assert_eq!(d.items[0].role.as_deref(), Some("assistant"));
    assert_eq!(d.items[0].text.as_deref(), Some("Hi, I'm Maya."));
    assert_eq!(d.items[0].created_at_ms, Some(1794564000250));
    assert_eq!(d.items[1].text.as_deref(), Some("Hello."));
    assert_eq!(d.items[1].created_at_ms, Some(1794564001500));
    assert_eq!(d.items[2].role, None);
}

#[test]
fn debug_output_hides_the_key() {
    let c = FishClient::with_base_url("SECRET-FISH", "http://x");
    assert!(!format!("{c:?}").contains("SECRET"));
}
