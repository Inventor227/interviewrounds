//! A full app for session tests: a fresh database, fixture content, a mock Fish API, a fake model and helpers
//! for REST calls and sockets.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use futures::stream::{self, BoxStream};
use futures::{SinkExt, StreamExt};
use ir_server::claude::{ClaudeError, MessagesRequest, MessagesResponse, StreamEvent, Usage};
use ir_server::content::Catalog;
use ir_server::fish::FishClient;
use ir_server::orchestrator::LlmApi;
use ir_server::ws::SessionTiming;
use ir_server::{AppState, db, router};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request as MockRequest, ResponseTemplate};

/// Model fake: answers prewarms (`max_tokens: 0`) with cache-write usage, and every streamed turn with one
/// line; with `hang` set, a turn says one word and then never finishes. Director calls (requests with tools) get
/// the next scripted list of content blocks (none when the script is empty); Scribe calls (structured output) get
/// `scribe`, with `{prefix}` replaced by the call's new-id prefix.
#[derive(Default)]
pub struct FakeLlm {
    pub prewarms: AtomicUsize,
    pub hang: std::sync::atomic::AtomicBool,
    pub requests: Mutex<Vec<MessagesRequest>>,
    pub director: Mutex<std::collections::VecDeque<Vec<Value>>>,
    pub scribe: Mutex<Option<String>>,
    /// Director and Scribe requests, in order (prewarms left out).
    pub creates: Mutex<Vec<MessagesRequest>>,
}

impl FakeLlm {
    pub fn director_calls(&self) -> usize {
        self.creates
            .lock()
            .unwrap()
            .iter()
            .filter(|r| !r.tools.is_empty())
            .count()
    }

    pub fn scribe_calls(&self) -> Vec<MessagesRequest> {
        self.creates
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.output_config.as_ref().is_some_and(|o| o.format.is_some()))
            .cloned()
            .collect()
    }
}

fn created(model: &str, content: Value) -> MessagesResponse {
    serde_json::from_value(json!({
        "id": "msg_fake", "model": model, "content": content, "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0,
                  "cache_creation_input_tokens": 0}
    }))
    .unwrap()
}

#[async_trait]
impl LlmApi for FakeLlm {
    async fn create(&self, req: &MessagesRequest) -> Result<MessagesResponse, ClaudeError> {
        if req.max_tokens == 0 {
            self.prewarms.fetch_add(1, Ordering::SeqCst);
            return Ok(serde_json::from_value(json!({
                "id": "msg_prewarm", "model": req.model, "content": [], "stop_reason": "max_tokens",
                "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0,
                          "cache_creation_input_tokens": 2000}
            }))
            .unwrap());
        }
        let scribe = req
            .output_config
            .as_ref()
            .is_some_and(|o| o.format.is_some());
        if scribe && req.max_tokens <= 16 {
            // The Scribe's schema prewarm.
            return Ok(created(&req.model, json!([])));
        }
        self.creates.lock().unwrap().push(req.clone());
        if scribe {
            let prompt: String = req.system.iter().map(|b| b.text.as_str()).collect();
            let prefix = prompt
                .lines()
                .find_map(|l| l.strip_prefix("New ids start with: "))
                .unwrap_or("x0_")
                .to_string();
            let text = self
                .scribe
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| r#"{"ops": [], "confidence": 0}"#.into())
                .replace("{prefix}", &prefix);
            return Ok(created(&req.model, json!([{"type": "text", "text": text}])));
        }
        if !req.tools.is_empty() {
            let blocks = self
                .director
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_default();
            return Ok(created(&req.model, Value::Array(blocks)));
        }
        Err(ClaudeError::BadRequest("not scripted".into()))
    }

    async fn stream(
        &self,
        req: &MessagesRequest,
    ) -> Result<BoxStream<'static, Result<StreamEvent, ClaudeError>>, ClaudeError> {
        self.requests.lock().unwrap().push(req.clone());
        if self.hang.load(Ordering::SeqCst) {
            let first = stream::iter(vec![Ok(StreamEvent::TextDelta("Well, ".into()))]);
            return Ok(first.chain(stream::pending()).boxed());
        }
        let events = vec![
            Ok(StreamEvent::TextDelta("Hello there.".into())),
            Ok(StreamEvent::Stop {
                reason: "end_turn".into(),
                usage: Usage {
                    input_tokens: 1000,
                    output_tokens: 100,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
            }),
        ];
        Ok(stream::iter(events).boxed())
    }
}

pub fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/content")
}

pub fn fixture_catalog() -> Catalog {
    Catalog::load(&fixtures()).expect("fixture catalog")
}

pub struct TestApp {
    pub router: Router,
    pub state: AppState,
    pub fish: MockServer,
    pub llm: Arc<FakeLlm>,
    pub db_url: String,
}

pub struct Options<'a> {
    pub env: &'a [(&'a str, &'a str)],
    pub timing: SessionTiming,
    pub catalog: Catalog,
}

impl Default for Options<'_> {
    fn default() -> Self {
        Options {
            env: &[],
            timing: SessionTiming::default(),
            catalog: fixture_catalog(),
        }
    }
}

/// Mock Fish API: unique session ids, 204 on end, 120 s duration on lookup.
pub async fn fish_mock() -> MockServer {
    let server = MockServer::start().await;
    let n = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/v1/agent/sessions"))
        .respond_with(move |_: &MockRequest| {
            let i = n.fetch_add(1, Ordering::SeqCst) + 1;
            ResponseTemplate::new(200).set_body_json(json!({
                "session_id": format!("fish-{i}"),
                "token": format!("tok-{i}"),
                "livekit_url": "wss://x.livekit.cloud",
                "expires_at": "2026-11-13T12:00:00Z",
                "max_duration_seconds": 1800,
                "transport": "livekit"
            }))
        })
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path_regex(r"^/v1/agent/sessions/[^/]+/end$"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/v1/agent/sessions/[^/]+$"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"items": [], "duration_seconds": 120})),
        )
        .mount(&server)
        .await;
    server
}

pub async fn test_app(opts: Options<'_>) -> TestApp {
    let db_url = super::fresh_database().await;
    let pool = db::connect_url(&db_url).await.expect("connect + migrate");
    let cfg = super::test_config_with(&db_url, &super::temp_dir("public"), opts.env);
    let fish = fish_mock().await;
    let llm = Arc::new(FakeLlm::default());
    let state = AppState::new(pool, cfg)
        .with_catalog(opts.catalog)
        .with_fish(FishClient::with_base_url("test-fish-key", &fish.uri()))
        .with_llm(llm.clone())
        .with_timing(opts.timing);
    TestApp {
        router: router(state.clone()),
        state,
        fish,
        llm,
        db_url,
    }
}

pub struct Res {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
}

impl TestApp {
    pub async fn call(
        &self,
        m: Method,
        uri: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> Res {
        self.call_with(m, uri, cookie, body, &[]).await
    }

    pub async fn call_with(
        &self,
        m: Method,
        uri: &str,
        cookie: Option<&str>,
        body: Option<Value>,
        extra: &[(&str, &str)],
    ) -> Res {
        let mut req = Request::builder().method(m).uri(uri);
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = super::body_bytes(res).await;
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Res {
            status,
            headers,
            body,
        }
    }

    /// A new guest: its cookie header value.
    pub async fn guest(&self) -> String {
        let res = self.call(Method::GET, "/api/me", None, None).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
        let set = res.headers[header::SET_COOKIE].to_str().unwrap();
        set.split(';').next().unwrap().to_string()
    }

    /// Creates a session; the fake voice is sent with the dev key (it is a development path).
    pub async fn create(&self, cookie: &str, body: Value) -> Res {
        let key: &[(&str, &str)] = if body["voice"] == "fake" {
            &[("x-dev-key", "test-dev-key")]
        } else {
            &[]
        };
        self.call_with(Method::POST, "/api/sessions", Some(cookie), Some(body), key)
            .await
    }

    /// A turn on the custom LLM endpoint with this bearer.
    pub async fn turn(&self, bearer: &str, session_id: &str, text: &str) -> Res {
        let body = json!({"model": "x", "stream": true,
            "messages": [{"role": "user", "content": text}],
            "fishaudio_extra_body": {"session_id": session_id, "panelist_id": "p1"}});
        self.call_with(
            Method::POST,
            "/v1/chat/completions",
            None,
            Some(body),
            &[("authorization", &format!("Bearer {bearer}"))],
        )
        .await
    }

    pub async fn set_status(
        &self,
        session_id: &str,
        status: ir_server::orchestrator::SessionStatus,
    ) {
        let handle = self.state.registry.get(session_id).expect("in memory");
        handle.lock().await.status = status;
    }

    /// Fish API requests the server made, by method and path suffix.
    pub async fn fish_calls(&self, m: &str, ends_with: &str) -> Vec<Value> {
        self.fish
            .received_requests()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.method.as_str() == m && r.url.path().ends_with(ends_with))
            .map(|r| serde_json::from_slice(&r.body).unwrap_or(Value::Null))
            .collect()
    }

    pub async fn fish_paths(&self, m: &str) -> Vec<String> {
        self.fish
            .received_requests()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.method.as_str() == m)
            .map(|r| r.url.path().to_string())
            .collect()
    }

    /// Serves the router on a local port (sockets need a real connection).
    pub async fn serve(&self) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = self.router.clone();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("ws://{addr}")
    }
}

/// Opens the round's socket and waits until the round has started (the first hello starts it; only started
/// rounds count toward limits).
pub async fn go_live(base: &str, created: &Value) {
    let id = created["session_id"].as_str().expect("session_id");
    let token = created["client_token"].as_str().expect("client_token");
    let mut ws = hello(base, id, token, 0).await;
    let state = frame_of(&mut ws, "round.state", Duration::from_secs(3))
        .await
        .expect("round.state");
    assert_eq!(state["d"]["status"], "live");
}

pub fn short_req(voice: &str) -> Value {
    json!({"mode": "interview", "round_id": "sde.system_design.short", "length": "short",
           "level": "mid", "style": "neutral", "voice": voice})
}

pub fn full_req(voice: &str) -> Value {
    json!({"mode": "interview", "round_id": "sde.system_design.full", "length": "full",
           "level": "mid", "style": "neutral", "voice": voice})
}

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub async fn connect(base: &str, session_id: &str) -> Ws {
    let (ws, _) = tokio_tungstenite::connect_async(format!("{base}/ws/session/{session_id}"))
        .await
        .expect("socket connects");
    ws
}

pub async fn send(ws: &mut Ws, t: &str, seq: u64, d: Value) {
    ws.send(WsMsg::Text(
        json!({"t": t, "seq": seq, "d": d}).to_string().into(),
    ))
    .await
    .unwrap();
}

pub async fn hello(base: &str, session_id: &str, token: &str, last_seq: u64) -> Ws {
    let mut ws = connect(base, session_id).await;
    send(
        &mut ws,
        "hello",
        0,
        json!({"client_token": token, "last_seq": last_seq}),
    )
    .await;
    ws
}

/// What came next on the socket: a frame, or the close code.
#[derive(Debug)]
pub enum Next {
    Frame(Value),
    Closed(Option<u16>),
}

pub async fn next(ws: &mut Ws, wait: Duration) -> Option<Next> {
    loop {
        let msg = match tokio::time::timeout(wait, ws.next()).await {
            Err(_) => return None,
            Ok(None) => return Some(Next::Closed(None)),
            Ok(Some(Err(_))) => return Some(Next::Closed(None)),
            Ok(Some(Ok(m))) => m,
        };
        match msg {
            WsMsg::Text(t) => return Some(Next::Frame(serde_json::from_str(t.as_str()).unwrap())),
            WsMsg::Close(frame) => return Some(Next::Closed(frame.map(|f| u16::from(f.code)))),
            _ => continue,
        }
    }
}

/// The next frame of type `t` (others are skipped), within `wait`.
pub async fn frame_of(ws: &mut Ws, t: &str, wait: Duration) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match next(ws, left).await? {
            Next::Frame(f) if f["t"] == t => return Some(f),
            Next::Frame(_) => continue,
            Next::Closed(_) => return None,
        }
    }
}

/// Reads until the socket closes; the close code.
pub async fn close_code(ws: &mut Ws, wait: Duration) -> Option<u16> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match next(ws, left).await? {
            Next::Frame(_) => continue,
            Next::Closed(code) => return code,
        }
    }
}

/// Waits until `check` holds (polling), or panics with `what`.
pub async fn eventually<F, Fut>(what: &str, wait: Duration, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + wait;
    while tokio::time::Instant::now() < deadline {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}
