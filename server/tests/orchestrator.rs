//! Orchestrator and the Fish custom LLM endpoint, with Claude replaced by a scripted fake.
//! No database or network needed: the pool is lazy and never used by these routes.

mod common;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use futures::StreamExt;
use futures::stream::{self, BoxStream};
use ir_server::claude::{
    ClaudeError, ContentBlock, Message, MessagesRequest, MessagesResponse, Role, StreamEvent, Usage,
};
use ir_server::content::Catalog;
use ir_server::orchestrator::markers::{EventKind, UserInput, parse_user_input, parse_user_turn};
use ir_server::orchestrator::prompt::build_live_request;
use ir_server::orchestrator::speech_filter::SpeechFilter;
use ir_server::orchestrator::{
    Level, LiveSettings, LlmApi, MemorySessionAuth, Mode, NewSession, OrchestratorOptions,
    ServerEvent, SessionSettings, SessionState, Style, ToolsMode, VoiceKind,
};
use ir_server::{AppState, router};
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

// ---------- fakes and helpers ----------

enum Script {
    Reply(Vec<StreamEvent>),
    /// Streams these events, then never ends.
    ThenHang(Vec<StreamEvent>),
    Fail(ClaudeError),
    Hang,
}

#[derive(Default)]
struct ScriptedLlm {
    scripts: Mutex<VecDeque<Script>>,
    requests: Mutex<Vec<MessagesRequest>>,
    /// Non-streamed (director) replies, and the requests they answered.
    creates: Mutex<VecDeque<MessagesResponse>>,
    created: Mutex<Vec<MessagesRequest>>,
}

impl ScriptedLlm {
    fn new(scripts: Vec<Script>) -> Arc<Self> {
        Arc::new(ScriptedLlm {
            scripts: Mutex::new(scripts.into()),
            ..ScriptedLlm::default()
        })
    }
    fn with_creates(scripts: Vec<Script>, creates: Vec<MessagesResponse>) -> Arc<Self> {
        Arc::new(ScriptedLlm {
            scripts: Mutex::new(scripts.into()),
            creates: Mutex::new(creates.into()),
            ..ScriptedLlm::default()
        })
    }
    fn calls(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
    fn request(&self, i: usize) -> MessagesRequest {
        self.requests.lock().unwrap()[i].clone()
    }
}

#[async_trait]
impl LlmApi for ScriptedLlm {
    async fn create(&self, req: &MessagesRequest) -> Result<MessagesResponse, ClaudeError> {
        self.created.lock().unwrap().push(req.clone());
        self.creates
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| ClaudeError::BadRequest("create is not scripted".into()))
    }

    async fn stream(
        &self,
        req: &MessagesRequest,
    ) -> Result<BoxStream<'static, Result<StreamEvent, ClaudeError>>, ClaudeError> {
        self.requests.lock().unwrap().push(req.clone());
        match self.scripts.lock().unwrap().pop_front() {
            Some(Script::Reply(events)) => Ok(stream::iter(events.into_iter().map(Ok)).boxed()),
            Some(Script::Fail(err)) => Err(err),
            Some(Script::Hang) => Ok(stream::pending().boxed()),
            Some(Script::ThenHang(events)) => Ok(stream::iter(events.into_iter().map(Ok))
                .chain(stream::pending())
                .boxed()),
            None => Err(ClaudeError::BadRequest("no script left".into())),
        }
    }
}

fn stop(reason: &str) -> StreamEvent {
    StreamEvent::Stop {
        reason: reason.into(),
        usage: Usage::default(),
    }
}

fn reply(text: &str) -> Script {
    Script::Reply(vec![StreamEvent::TextDelta(text.into()), stop("end_turn")])
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/content")
}

fn catalog() -> Catalog {
    Catalog::load(&fixtures()).expect("fixture catalog loads")
}

fn live() -> LiveSettings {
    LiveSettings {
        model: "claude-opus-5-5".into(),
        fast_model: "claude-haiku-5-5".into(),
        effort: "low".into(),
        max_tokens: 300,
        tools: ToolsMode::Inline,
    }
}

fn new_state(id: &str, round_id: &str, voice: VoiceKind) -> SessionState {
    SessionState::new(
        NewSession {
            id: id.into(),
            identity_id: "guest-1".into(),
            mode: Mode::Interview,
            round_id: round_id.into(),
            settings: SessionSettings {
                level: Level::Mid,
                style: Style::Neutral,
                voice,
            },
            panel: Vec::new(),
            question_id: None,
            meeting: None,
        },
        &catalog(),
        live(),
        Instant::now(),
    )
    .expect("state builds")
}

const SECRET: &str = "test-llm-secret";

fn test_app(llm: Arc<ScriptedLlm>) -> (Router, AppState) {
    test_app_with(llm, |_| {})
}

fn test_app_with(
    llm: Arc<ScriptedLlm>,
    tune: impl FnOnce(&mut OrchestratorOptions),
) -> (Router, AppState) {
    let url = "postgres://nobody:nothing@127.0.0.1:1/none";
    let pool = PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(200))
        .connect_lazy(url)
        .unwrap();
    let cfg = common::test_config(url, &common::temp_dir("public"));
    // Most tests check the commit itself, so replies to speech are committed at once unless a test opts in.
    let mut opts = OrchestratorOptions {
        first_text_timeout: Duration::from_millis(300),
        retry_first_text_timeout: Duration::from_millis(300),
        confirm_speech_turns: false,
        ..OrchestratorOptions::default()
    };
    tune(&mut opts);
    let state = AppState::new(pool, cfg)
        .with_llm(llm)
        .with_orchestrator_options(opts);
    (router(state.clone()), state)
}

fn chat_body(session: &str, panelist: &str, messages: Value) -> Value {
    json!({
        "model": "ir-live",
        "stream": true,
        "stream_options": {"include_usage": true},
        "messages": messages,
        "session_id": "fish-sess-1",
        "user_id": "guest-1",
        "fishaudio_extra_body": {"session_id": session, "panelist_id": panelist}
    })
}

struct Sse {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    chunks: Vec<Value>,
    done: bool,
}

impl Sse {
    fn text(&self) -> String {
        self.chunks
            .iter()
            .filter_map(|c| {
                c.pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
            })
            .collect()
    }
}

async fn post_chat(app: &Router, bearer: &str, body: Value) -> Sse {
    let req = Request::post("/v1/chat/completions")
        .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT_ENCODING, "gzip, br")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    // Error bodies may be compressed (the request accepts gzip and br); only the stream is read.
    let raw = if status == StatusCode::OK {
        String::from_utf8(common::body_bytes(res).await).unwrap()
    } else {
        String::new()
    };
    let mut chunks = Vec::new();
    let mut done = false;
    for line in raw.lines() {
        if let Some(data) = line.strip_prefix("data: ") {
            if data == "[DONE]" {
                done = true;
            } else {
                chunks.push(serde_json::from_str(data).expect("chunk is JSON"));
            }
        }
    }
    Sse {
        status,
        headers,
        chunks,
        done,
    }
}

fn last_system_note(req: &MessagesRequest) -> String {
    let last = req.messages.last().expect("messages");
    assert_eq!(
        last.role,
        Role::System,
        "last message must be the system note"
    );
    last.text()
}

// ---------- markers and speech filter ----------

#[test]
fn parses_event_markers() {
    assert_eq!(
        parse_user_input("[event: time_check]"),
        UserInput::Event(EventKind::TimeCheck)
    );
    assert_eq!(
        parse_user_input("  [event: silence_check] "),
        UserInput::Event(EventKind::SilenceCheck)
    );
    for (text, kind) in [
        ("[event: start]", EventKind::Start),
        ("[event: handover]", EventKind::Handover),
        ("[event: resume]", EventKind::Resume),
        ("[event: ending]", EventKind::Ending),
    ] {
        assert_eq!(parse_user_input(text), UserInput::Event(kind));
        assert_eq!(kind.marker(), text);
    }
    assert_eq!(
        parse_user_input("I'd use a cache"),
        UserInput::Speech("I'd use a cache".into())
    );
}

#[test]
fn speech_filter_strips_markdown_across_chunks() {
    let mut f = SpeechFilter::new();
    let mut out = String::new();
    for chunk in ["**Ok", "ay.** Next"] {
        out.push_str(&f.push(chunk));
    }
    out.push_str(&f.finish());
    assert_eq!(out, "Okay. Next");
}

#[test]
fn speech_filter_strips_bullets_brackets_emoji_and_urls() {
    let mut f = SpeechFilter::new();
    let mut out = String::new();
    for chunk in [
        "- First",
        " point.\n- Second [aside] point (smiles) \u{1F600}",
        " see https://exa",
        "mple.com/x now.\n## Heading `code`\n1. Step one, 3.5 seconds.",
    ] {
        out.push_str(&f.push(chunk));
    }
    out.push_str(&f.finish());
    assert_eq!(
        out,
        "First point. Second point see now. Heading code Step one, 3.5 seconds."
    );

    let mut f = SpeechFilter::new();
    let mut out = f.push("What about htt");
    out.push_str(&f.finish());
    assert_eq!(out, "What about htt");
}

// ---------- content ----------

#[test]
fn catalog_loads_fixture_content() {
    let c = catalog();
    assert!(c.rounds.contains_key("sde.system_design.short"));
    assert_eq!(c.personas["persona.daniel"].display_name, "Daniel");
    assert!(c.rubrics.contains_key("rubric.system_design"));
    assert!(c.banks.contains_key("bank.system_design"));
    assert!(c.templates.contains_key("exec_update"));
    let rules = c.prompt("house-rules").expect("house rules");
    assert!(!rules.contains("<!--"), "comments are stripped");
    assert!(
        c.prompt("house-rules.turn-note")
            .unwrap()
            .contains("{phase.id}")
    );
}

// ---------- prompt ----------

#[test]
fn system_prompt_is_rendered_from_content() {
    let st = new_state("s1", "sde.system_design.full", VoiceKind::Fish);
    let req = build_live_request(
        &st,
        "p1",
        &UserInput::Event(EventKind::Start),
        Instant::now(),
    );
    assert_eq!(req.model, "claude-opus-5-5");
    assert_eq!(req.max_tokens, 300);
    assert_eq!(
        req.output_config.as_ref().unwrap().effort.as_deref(),
        Some("low")
    );
    assert_eq!(req.fallbacks, Some(json!("default")));
    assert!(req.stream);
    let system: String = req.system.iter().map(|b| b.text.as_str()).collect();
    for want in [
        "You are Daniel, Staff Engineer",
        "mid software engineer",
        "Neutral, professional tone.",
        "You lead with Ana",
        "Link shortener",
        "Hi, I'm Daniel.",
        "Failure modes and trade-offs",
    ] {
        assert!(
            system.contains(want),
            "system prompt lacks {want:?}:\n{system}"
        );
    }
    for placeholder in [
        "{persona.",
        "{question.",
        "{panel.",
        "{round_script}",
        "{level_rules}",
    ] {
        assert!(
            !system.contains(placeholder),
            "unfilled {placeholder}:\n{system}"
        );
    }
    assert!(req.system.last().unwrap().cache_control.is_some());
    let names: Vec<&str> = req.tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "show_question",
            "next_phase",
            "hand_over",
            "point_at",
            "give_hint",
            "end_round"
        ]
    );
    assert!(req.tools.iter().all(|t| t.strict == Some(true)));

    let second = build_live_request(
        &st,
        "p2",
        &UserInput::Event(EventKind::Handover),
        Instant::now(),
    );
    let system2: String = second.system.iter().map(|b| b.text.as_str()).collect();
    assert!(system2.contains("You are Ana"), "{system2}");
    assert!(
        system2.contains("second on a panel led by Daniel"),
        "{system2}"
    );
}

#[tokio::test]
async fn system_prefix_is_stable_across_turns() {
    let llm = ScriptedLlm::new(vec![reply("Hi, I'm Daniel."), reply("Okay. What scale?")]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));

    let r1 = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "system", "content": "Fish prompt"},
                {"role": "user", "content": "[event: start]"}
            ]),
        ),
    )
    .await;
    assert_eq!(r1.status, StatusCode::OK);
    let r2 = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "system", "content": "Fish prompt"},
                {"role": "user", "content": "[event: start]"},
                {"role": "assistant", "content": "Hi, I'm Daniel."},
                {"role": "user", "content": "Hello, I'm ready."}
            ]),
        ),
    )
    .await;
    assert_eq!(r2.text(), "Okay. What scale?");

    let (a, b) = (llm.request(0), llm.request(1));
    assert_eq!(
        serde_json::to_string(&a.system).unwrap(),
        serde_json::to_string(&b.system).unwrap()
    );
    assert_eq!(
        serde_json::to_string(&a.tools).unwrap(),
        serde_json::to_string(&b.tools).unwrap()
    );
    // Append-only: the second request starts with the first one's messages, unchanged apart from the moving
    // cache breakpoint, followed by the first reply.
    let strip = |m: &Message| {
        let mut m = m.clone();
        m.content.iter_mut().for_each(|c| c.set_cache_control(None));
        m
    };
    let a_msgs: Vec<Message> = a.messages.iter().map(strip).collect();
    let b_msgs: Vec<Message> = b.messages.iter().map(strip).collect();
    assert_eq!(&b_msgs[..a_msgs.len()], &a_msgs[..]);
    assert_eq!(
        b_msgs[a_msgs.len()],
        Message::assistant_text("Hi, I'm Daniel.")
    );
    assert_eq!(b.messages[b.messages.len() - 2].role, Role::User);
    assert_eq!(b.messages[b.messages.len() - 2].text(), "Hello, I'm ready.");
    // One breakpoint on the newest user turn only (plus the system one): never more than 4 in total.
    let marked = b
        .messages
        .iter()
        .flat_map(|m| m.content.iter())
        .filter(|c| {
            matches!(
                c,
                ContentBlock::Text {
                    cache_control: Some(_),
                    ..
                } | ContentBlock::ToolResult {
                    cache_control: Some(_),
                    ..
                }
            )
        })
        .count();
    assert_eq!(marked, 1);
}

#[test]
fn turn_appends_system_note_with_phase_and_board() {
    let mut st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    st.board_text = "[Board update 3] HLD sheet\nn1 Client -> n4 Cache\nn4 Cache (new)".into();
    let input = UserInput::Speech("I'd put a cache in front".into());
    let req = build_live_request(&st, "p1", &input, Instant::now());
    let n = req.messages.len();
    assert_eq!(req.messages[n - 2].role, Role::User);
    assert_eq!(req.messages[n - 2].text(), "I'd put a cache in front");
    let note = last_system_note(&req);
    assert!(note.to_lowercase().contains("phase:"), "{note}");
    assert!(note.contains("requirements"), "{note}");
    assert!(note.contains("n4 Cache"), "{note}");
    assert!(!note.contains('{'), "unfilled placeholder in {note}");
    // The board never enters the cached system prefix.
    assert!(req.system.iter().all(|b| !b.text.contains("n4 Cache")));
}

#[test]
fn silence_check_event_prompts_checkin() {
    let st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    let req = build_live_request(
        &st,
        "p1",
        &UserInput::Event(EventKind::SilenceCheck),
        Instant::now(),
    );
    let n = req.messages.len();
    assert_eq!(req.messages[n - 2].text(), "[event: silence_check]");
    let note = last_system_note(&req);
    assert!(note.contains("check in once"), "{note}");
    assert!(note.contains("40 seconds"), "{note}");
}

#[test]
fn time_check_after_a_boundary_asks_for_next_phase() {
    let st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    // Requirements is 2 minutes; 3 minutes in, its boundary has passed.
    let now = st.started_at + Duration::from_secs(180);
    let req = build_live_request(&st, "p1", &UserInput::Event(EventKind::TimeCheck), now);
    let note = last_system_note(&req);
    assert!(note.contains("requirements phase is over"), "{note}");
    assert!(note.contains("next_phase"), "{note}");

    let late = st.started_at + Duration::from_secs(8 * 60 + 5);
    let note = last_system_note(&build_live_request(
        &st,
        "p1",
        &UserInput::Event(EventKind::TimeCheck),
        late,
    ));
    assert!(note.contains("end_round"), "{note}");
}

// ---------- endpoint ----------

#[tokio::test]
async fn sse_output_is_openai_shaped() {
    let llm = ScriptedLlm::new(vec![Script::Reply(vec![
        StreamEvent::TextDelta("**Okay.**".into()),
        StreamEvent::TextDelta(" Next question.".into()),
        stop("end_turn"),
    ])]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": [{"type": "text", "text": "I'd use a cache"}]}
            ]),
        ),
    )
    .await;

    assert_eq!(res.status, StatusCode::OK);
    assert!(
        res.headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    assert!(
        res.headers.get(header::CONTENT_ENCODING).is_none(),
        "SSE must not be compressed"
    );
    let first = &res.chunks[0];
    assert_eq!(first["object"], "chat.completion.chunk");
    assert_eq!(first["choices"][0]["delta"]["role"], "assistant");
    assert!(
        first["choices"][0]["delta"]["content"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    let last = res.chunks.last().unwrap();
    assert_eq!(last["choices"][0]["finish_reason"], "stop");
    assert!(res.done, "stream ends with [DONE]");
    assert_eq!(res.text(), "Okay. Next question.");

    // The candidate's words and the raw reply are both in the history.
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    let n = st.history.len();
    assert_eq!(
        st.history[n - 1],
        Message::assistant_text("**Okay.** Next question.")
    );
    assert_eq!(st.history[n - 3].text(), "I'd use a cache");
    assert_eq!(st.last_agent_text["p1"], "Okay. Next question.");
}

#[tokio::test]
async fn rejects_wrong_bearer() {
    let llm = ScriptedLlm::new(vec![reply("never")]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let body = chat_body("s1", "p1", json!([{"role": "user", "content": "hi"}]));
    let res = post_chat(&app, "wrong-secret", body.clone()).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let req = Request::post("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(req).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(llm.calls(), 0);
}

#[tokio::test]
async fn fake_voice_client_token_is_accepted_only_for_its_fake_session() {
    let llm = ScriptedLlm::new(vec![reply("Hi."), reply("never")]);
    let (app, state) = test_app(llm.clone());
    let auth = Arc::new(MemorySessionAuth::default());
    auth.insert("fake1", "client-token-1");
    auth.insert("fish1", "client-token-2");
    let state = state.with_session_auth(auth);
    let app2 = router(state.clone());
    state.registry.insert(new_state(
        "fake1",
        "sde.system_design.short",
        VoiceKind::Fake,
    ));
    state.registry.insert(new_state(
        "fish1",
        "sde.system_design.short",
        VoiceKind::Fish,
    ));
    let msgs = json!([{"role": "user", "content": "[event: start]"}]);

    let ok = post_chat(
        &app2,
        "client-token-1",
        chat_body("fake1", "p1", msgs.clone()),
    )
    .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.text(), "Hi.");
    let wrong_session = post_chat(
        &app2,
        "client-token-1",
        chat_body("fish1", "p1", msgs.clone()),
    )
    .await;
    assert_eq!(wrong_session.status, StatusCode::UNAUTHORIZED);
    let fish_voice = post_chat(
        &app2,
        "client-token-2",
        chat_body("fish1", "p1", msgs.clone()),
    )
    .await;
    assert_eq!(
        fish_voice.status,
        StatusCode::UNAUTHORIZED,
        "client tokens only work for fake voice"
    );
    drop(app);
    assert_eq!(llm.calls(), 1);
}

#[tokio::test]
async fn unknown_session_is_404() {
    let llm = ScriptedLlm::new(vec![]);
    let (app, _state) = test_app(llm.clone());
    let res = post_chat(
        &app,
        SECRET,
        chat_body("nope", "p1", json!([{"role": "user", "content": "hi"}])),
    )
    .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn interrupted_reply_is_noted_append_only() {
    let full = "Tell me how you'd shard the database and what key you'd pick.";
    let llm = ScriptedLlm::new(vec![reply(full), reply("Okay. Why user id?")]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));

    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "I'd split the data."}
            ]),
        ),
    )
    .await;
    let before = state
        .registry
        .get("s1")
        .unwrap()
        .lock()
        .await
        .history
        .clone();

    // Fish's transcript keeps only the words actually spoken before the candidate cut in.
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "I'd split the data."},
                {"role": "assistant", "content": "Tell me how you'd"},
                {"role": "user", "content": "By user id."}
            ]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Okay. Why user id?");

    let req = llm.request(1);
    let strip = |m: &Message| {
        let mut m = m.clone();
        m.content.iter_mut().for_each(|c| c.set_cache_control(None));
        m
    };
    // Earlier messages are untouched; the full assistant line is still there.
    let sent: Vec<Message> = req.messages[..before.len()].iter().map(strip).collect();
    assert_eq!(sent, before);
    assert_eq!(before.last().unwrap(), &Message::assistant_text(full));
    let note = last_system_note(&req);
    assert!(note.contains("heard only"), "{note}");
    assert!(note.contains("\"Tell me how you'd\""), "{note}");

    // The note is kept in the history (append-only), and not repeated on the next turn.
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert!(
        st.history[before.len()..]
            .iter()
            .any(|m| m.role == Role::System && m.text().contains("heard only"))
    );
    assert!(
        st.turns.iter().any(|t| t.interrupted),
        "turn log marks the cut"
    );
}

#[tokio::test]
async fn handover_event_returns_prepared_line_without_llm() {
    let llm = ScriptedLlm::new(vec![]);
    let (app, state) = test_app(llm.clone());
    let mut st = new_state("s1", "sde.system_design.full", VoiceKind::Fish);
    let line = "Say the cache loses a node at peak. What happens to reads?";
    st.pending_handover.insert("p2".into(), line.into());
    state.registry.insert(st);

    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p2",
            json!([
                {"role": "user", "content": "[event: handover]"}
            ]),
        ),
    )
    .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.text(), line);
    assert_eq!(
        res.chunks.last().unwrap()["choices"][0]["finish_reason"],
        "stop"
    );
    assert_eq!(llm.calls(), 0);

    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert_eq!(st.floor, "p2");
    assert!(st.pending_handover.is_empty());
    let n = st.history.len();
    assert_eq!(st.history[n - 2].text(), "[event: handover]");
    assert_eq!(st.history[n - 1], Message::assistant_text(line));
    assert_eq!(st.last_agent_text["p2"], line);
}

#[tokio::test]
async fn tool_calls_apply_and_results_lead_the_next_turn() {
    let llm = ScriptedLlm::new(vec![
        Script::Reply(vec![
            StreamEvent::TextDelta("Ana, you had some questions here?".into()),
            StreamEvent::ToolUse {
                id: "toolu_1".into(),
                name: "show_question".into(),
                input: json!({"question": "Link shortener", "lines": ["100M links a month"]}),
            },
            StreamEvent::ToolUse {
                id: "toolu_2".into(),
                name: "hand_over".into(),
                input: json!({"to": "p2", "line": "What happens when one link goes viral?"}),
            },
            stop("tool_use"),
        ]),
        // The continuation after the "ok" results says nothing more.
        Script::Reply(vec![stop("end_turn")]),
        reply("Okay."),
    ]);
    let (app, state) = test_app(llm.clone());
    let session = state
        .registry
        .insert(new_state("s1", "sde.system_design.full", VoiceKind::Fish));
    let mut events = session.lock().await.events.subscribe();

    let r1 = post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Ready."}])),
    )
    .await;
    assert_eq!(r1.text(), "Ana, you had some questions here?");
    assert_eq!(llm.calls(), 2, "one continuation after the tool calls");

    let mut got = Vec::new();
    while let Ok(ev) = events.try_recv() {
        got.push(ev);
    }
    assert!(got.iter().any(|e| matches!(e, ServerEvent::RoundState(s) if s.brief.question == "Link shortener" && s.brief.lines == ["100M links a month"])), "{got:?}");
    assert!(
        got.contains(&ServerEvent::HandOver {
            from: "p1".into(),
            to: "p2".into(),
            opening_line: "What happens when one link goes viral?".into()
        }),
        "{got:?}"
    );
    let wire = serde_json::to_value(
        got.iter()
            .find(|e| matches!(e, ServerEvent::HandOver { .. }))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(wire["t"], "panel.hand_over");
    assert_eq!(
        wire["d"]["opening_line"],
        "What happens when one link goes viral?"
    );
    {
        let st = session.lock().await;
        assert_eq!(st.floor, "p2");
        assert_eq!(
            st.pending_handover["p2"],
            "What happens when one link goes viral?"
        );
    }

    // The empty continuation is not kept, so the next turn's user message starts with an "ok" result for each
    // tool call (never two user messages in a row).
    post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Sure."}])),
    )
    .await;
    let req = llm.request(2);
    for pair in req.messages.windows(2) {
        assert!(
            !(pair[0].role == Role::User && pair[1].role == Role::User),
            "two user messages in a row"
        );
    }
    let user = &req.messages[req.messages.len() - 2];
    assert_eq!(user.role, Role::User);
    let ids: Vec<&str> = user
        .content
        .iter()
        .filter_map(|c| match c {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } => {
                assert_eq!(content, "ok");
                Some(tool_use_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(ids, ["toolu_1", "toolu_2"]);
    assert!(
        matches!(user.content.last(), Some(ContentBlock::Text { text, .. }) if text == "Sure.")
    );
}

#[tokio::test]
async fn tool_only_reply_continues_until_there_is_speech() {
    let llm = ScriptedLlm::new(vec![
        Script::Reply(vec![
            StreamEvent::ToolUse {
                id: "toolu_9".into(),
                name: "next_phase".into(),
                input: json!({}),
            },
            stop("tool_use"),
        ]),
        reply("Let's move on to the design."),
    ]);
    let (app, state) = test_app(llm.clone());
    let session =
        state
            .registry
            .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "[event: time_check]"}]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Let's move on to the design.");
    assert_eq!(llm.calls(), 2);
    let second = llm.request(1);
    let n = second.messages.len();
    assert!(
        matches!(&second.messages[n - 2].content[..], [ContentBlock::ToolUse { id, .. }] if id == "toolu_9")
    );
    assert!(
        matches!(&second.messages[n - 1].content[..], [ContentBlock::ToolResult { tool_use_id, .. }] if tool_use_id == "toolu_9")
    );
    let st = session.lock().await;
    assert_eq!(st.phase_idx, 1);
    assert!(st.pending_tool_results.is_empty());
}

#[tokio::test]
async fn text_then_tool_use_continues_and_joins_the_speech() {
    let llm = ScriptedLlm::new(vec![
        Script::Reply(vec![
            StreamEvent::TextDelta("Hi, I'm Daniel.".into()),
            StreamEvent::ToolUse {
                id: "toolu_1".into(),
                name: "show_question".into(),
                input: json!({"question": "Link shortener", "lines": []}),
            },
            stop("tool_use"),
        ]),
        reply("Design a link shortener."),
    ]);
    let (app, state) = test_app(llm.clone());
    let session =
        state
            .registry
            .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "[event: start]"}]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Hi, I'm Daniel. Design a link shortener.");
    let st = session.lock().await;
    let roles: Vec<Role> = st.history.iter().map(|m| m.role).collect();
    assert_eq!(
        roles,
        [
            Role::User,
            Role::System,
            Role::Assistant,
            Role::User,
            Role::Assistant
        ]
    );
    assert_eq!(
        st.history[4],
        Message::assistant_text("Design a link shortener.")
    );
    assert!(st.pending_tool_results.is_empty());
    assert_eq!(
        st.last_agent_text["p1"],
        "Hi, I'm Daniel. Design a link shortener."
    );
    assert_eq!(st.brief.as_ref().unwrap().question, "Link shortener");
}

#[tokio::test]
async fn failed_call_retries_once_on_the_fast_model() {
    let llm = ScriptedLlm::new(vec![Script::Fail(ClaudeError::Overloaded), reply("Okay.")]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Hi."}])),
    )
    .await;
    assert_eq!(res.text(), "Okay.");
    assert_eq!(llm.request(0).model, "claude-opus-5-5");
    let retry = llm.request(1);
    assert_eq!(retry.model, "claude-haiku-5-5");
    // Adaptive (omitted) on the retry: thinking off over another model's history made the fast model think aloud.
    assert_eq!(retry.thinking, None);
    assert_eq!(
        retry.output_config.as_ref().unwrap().effort.as_deref(),
        Some("low")
    );
    assert_eq!(retry.fallbacks, None);
}

#[tokio::test]
async fn slow_first_token_retries_then_hold_line_when_all_fail() {
    let llm = ScriptedLlm::new(vec![Script::Hang, reply("Okay.")]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let t = Instant::now();
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Hi."}])),
    )
    .await;
    assert_eq!(res.text(), "Okay.");
    assert!(t.elapsed() < Duration::from_secs(3));

    let llm = ScriptedLlm::new(vec![Script::Fail(ClaudeError::Overloaded), Script::Hang]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s2", "sde.system_design.short", VoiceKind::Fish));
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s2", "p1", json!([{"role": "user", "content": "Hi."}])),
    )
    .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.text(), "Sorry, give me a second.");
    assert_eq!(
        res.chunks.last().unwrap()["choices"][0]["finish_reason"],
        "stop"
    );
    assert_eq!(llm.calls(), 2);
    let st = state.registry.get("s2").unwrap();
    let st = st.lock().await;
    assert_eq!(
        st.history.last().unwrap(),
        &Message::assistant_text("Sorry, give me a second.")
    );
}

/// Real API, real request shape (fixture content): two turns per model through the endpoint, checking that the
/// tools, the system note and the cache breakpoints are accepted and that the turn produces speech.
/// `remote.sh ... --env-file .secrets/llm-anthropic.env -- cargo test --test orchestrator live_ -- --ignored --nocapture`
#[tokio::test]
#[ignore = "calls the real API"]
async fn live_turns_through_the_endpoint() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY");
    let ws = std::env::var("ANTHROPIC_WORKSPACE_ID").expect("ANTHROPIC_WORKSPACE_ID");
    let client = ir_server::claude::ClaudeClient::with_base_url(
        &key,
        &ws,
        ir_server::claude::DEFAULT_BASE_URL,
    );
    for model in ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] {
        let url = "postgres://nobody:nothing@127.0.0.1:1/none";
        let pool = PgPoolOptions::new().connect_lazy(url).unwrap();
        let cfg = common::test_config(url, &common::temp_dir("public"));
        let state = AppState::new(pool, cfg).with_llm(Arc::new(client.clone()));
        let app = router(state.clone());
        let mut st = new_state("live", "sde.system_design.short", VoiceKind::Fish);
        st.live.model = model.into();
        st.board_text =
            "[Board update 1] HLD sheet\nn1 Client -> n2 API\nn2 API -> n3 Store".into();
        state.registry.insert(st);

        let mut fish = vec![json!({"role": "system", "content": "Fish prompt"})];
        for said in [
            "[event: start]",
            "Okay. Who uses it, and how many links a day?",
        ] {
            fish.push(json!({"role": "user", "content": said}));
            let t = Instant::now();
            let res = post_chat(&app, SECRET, chat_body("live", "p1", json!(fish))).await;
            let text = res.text();
            println!(
                "{model} | {said:?} -> {} ms | {text:?}",
                t.elapsed().as_millis()
            );
            assert_eq!(res.status, StatusCode::OK);
            assert_ne!(
                text, "Sorry, give me a second.",
                "{model}: the live call failed"
            );
            assert!(
                !text.contains('*') && !text.contains('['),
                "{model}: unfiltered text {text:?}"
            );
            fish.push(json!({"role": "assistant", "content": text}));
        }
        let st = state.registry.get("live").unwrap();
        let st = st.lock().await;
        println!(
            "{model} brief: {:?}, phase {}, pending tools {:?}",
            st.brief, st.phase_idx, st.pending_tool_results
        );
    }
}

// ---------- review fixes: dropped turns, turn deadline, long answers, empty replies ----------

/// Sends one request and reads only the first SSE frame, then drops the response (Fish cancelling mid-stream).
async fn post_chat_and_drop(app: &Router, body: Value) -> String {
    use http_body_util::BodyExt;
    let req = Request::post("/v1/chat/completions")
        .header(header::AUTHORIZATION, format!("Bearer {SECRET}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = res.into_body();
    let frame = body.frame().await.expect("a frame").expect("frame ok");
    let text = String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap();
    drop(body);
    // The parked turn is written by a spawned task; give it a moment.
    tokio::time::sleep(Duration::from_millis(50)).await;
    text
}

fn user_texts(history: &[Message]) -> Vec<String> {
    history
        .iter()
        .filter(|m| m.role == Role::User)
        .map(Message::text)
        .collect()
}

#[tokio::test]
async fn dropped_turn_after_speech_is_kept_when_fish_played_it() {
    let llm = ScriptedLlm::new(vec![
        Script::ThenHang(vec![StreamEvent::TextDelta(
            "Okay. So walk me through".into(),
        )]),
        reply("Got it. And the write path?"),
    ]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));

    let first = post_chat_and_drop(
        &app,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "I'd put a cache in front."}]),
        ),
    )
    .await;
    assert!(first.contains("Okay. So walk me through"), "{first}");
    assert!(
        state
            .registry
            .get("s1")
            .unwrap()
            .lock()
            .await
            .history
            .is_empty()
    );

    // Fish played part of the line, then the candidate spoke again.
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "I'd put a cache in front."},
                {"role": "assistant", "content": "Okay. So"},
                {"role": "user", "content": "Reads go to the cache first."}
            ]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Got it. And the write path?");
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert_eq!(
        user_texts(&st.history),
        vec!["I'd put a cache in front.", "Reads go to the cache first."]
    );
    assert!(
        st.history
            .iter()
            .any(|m| m.role == Role::Assistant && m.text() == "Okay. So walk me through")
    );
    let cut = st
        .turns
        .iter()
        .find(|t| t.speaker == "p1")
        .expect("the parked turn is logged");
    assert!(cut.interrupted);
    assert_eq!(cut.heard.as_deref(), Some("Okay. So"));
    // The second request saw the first turn in its history.
    assert!(
        user_texts(&llm.request(1).messages).contains(&"I'd put a cache in front.".to_string())
    );
}

#[tokio::test]
async fn dropped_draft_that_was_never_played_is_forgotten() {
    let llm = ScriptedLlm::new(vec![
        Script::ThenHang(vec![StreamEvent::TextDelta("Okay. And".into())]),
        reply("Okay. Why a cache?"),
    ]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));

    post_chat_and_drop(
        &app,
        chat_body("s1", "p1", json!([{"role": "user", "content": "I'd put"}])),
    )
    .await;
    // A speculative draft: Fish threw it away and sends the finished utterance instead.
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "I'd put a cache in front."}]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Okay. Why a cache?");
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert_eq!(user_texts(&st.history), vec!["I'd put a cache in front."]);
    assert!(st.provisional.is_empty());
}

#[tokio::test]
async fn hold_line_while_a_turn_runs_is_kept_once_fish_plays_it() {
    let llm = ScriptedLlm::new(vec![reply("Okay. Go on.")]);
    let (app, state) = test_app_with(llm.clone(), |o| o.turn_wait = Duration::from_millis(100));
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let lock = state
        .registry
        .get("s1")
        .unwrap()
        .lock()
        .await
        .turn_lock
        .clone();
    let busy = lock.lock_owned().await;
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Hello?"}])),
    )
    .await;
    assert_eq!(res.text(), "Sorry, give me a second.");
    assert_eq!(llm.calls(), 0);
    drop(busy);

    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "Hello?"},
                {"role": "assistant", "content": "Sorry, give me a second."},
                {"role": "user", "content": "Sure."}
            ]),
        ),
    )
    .await;
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert_eq!(user_texts(&st.history), vec!["Hello?", "Sure."]);
    assert_eq!(
        st.history
            .iter()
            .filter(|m| m.role == Role::Assistant)
            .map(Message::text)
            .collect::<Vec<_>>(),
        vec!["Sorry, give me a second.", "Okay. Go on."]
    );
}

#[tokio::test]
async fn one_turn_deadline_covers_continuations_and_retries() {
    let llm = ScriptedLlm::new(vec![
        Script::Reply(vec![
            StreamEvent::ToolUse {
                id: "toolu_1".into(),
                name: "next_phase".into(),
                input: json!({}),
            },
            stop("tool_use"),
        ]),
        Script::Hang,
        Script::Hang,
    ]);
    let (app, state) = test_app_with(llm.clone(), |o| {
        o.first_text_timeout = Duration::from_secs(5);
        o.retry_first_text_timeout = Duration::from_secs(5);
        o.turn_deadline = Duration::from_millis(800);
    });
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let t = Instant::now();
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Hi."}])),
    )
    .await;
    assert_eq!(res.text(), "Sorry, give me a second.");
    assert!(
        t.elapsed() < Duration::from_millis(1500),
        "{:?}",
        t.elapsed()
    );
    // The tool call and the hang ran inside the deadline; no retry was started without room for it.
    assert_eq!(llm.calls(), 2);
}

#[test]
fn long_answer_is_an_event_with_a_cut_in_note() {
    assert_eq!(
        parse_user_input("[event: long_answer]"),
        UserInput::Event(EventKind::LongAnswer)
    );
    assert_eq!(EventKind::LongAnswer.marker(), "[event: long_answer]");
    let st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    let req = build_live_request(
        &st,
        "p1",
        &UserInput::Event(EventKind::LongAnswer),
        Instant::now(),
    );
    let note = last_system_note(&req);
    assert!(note.contains("Let me pause you there"), "{note}");
    // Typed next to the candidate's speech, it joins the same turn.
    assert_eq!(
        parse_user_turn(&["So the cache holds", "[event: long_answer]", "every seat."]),
        Some(UserInput::SpeechWithEvent(
            "So the cache holds every seat.".into(),
            EventKind::LongAnswer
        ))
    );
    assert_eq!(parse_user_turn::<&str>(&[]), None);
}

#[tokio::test]
async fn long_answer_marker_is_not_logged_as_candidate_speech() {
    let llm = ScriptedLlm::new(vec![reply("Let me pause you there. Why Redis?")]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "So the cache holds every seat and"},
                {"role": "user", "content": "[event: long_answer]"}
            ]),
        ),
    )
    .await;
    let req = llm.request(0);
    let note = last_system_note(&req);
    assert!(note.contains("Let me pause you there"), "{note}");
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    let speakers: Vec<(&str, &str)> = st
        .turns
        .iter()
        .map(|t| (t.speaker.as_str(), t.text.as_str()))
        .collect();
    assert_eq!(
        speakers[..2],
        [
            ("candidate", "So the cache holds every seat and"),
            ("app", "[event: long_answer]")
        ]
    );
}

#[tokio::test]
async fn request_ending_with_our_reply_is_not_answered_again() {
    let llm = ScriptedLlm::new(vec![reply("Should not be called.")]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "Hi."},
                {"role": "assistant", "content": "Hello."}
            ]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Sorry, give me a second.");
    assert_eq!(llm.calls(), 0);
    assert!(
        state
            .registry
            .get("s1")
            .unwrap()
            .lock()
            .await
            .history
            .is_empty()
    );
}

#[tokio::test]
async fn silent_stop_gets_the_retry_before_the_hold_line() {
    let llm = ScriptedLlm::new(vec![Script::Reply(vec![stop("end_turn")]), reply("Hi.")]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Hello."}])),
    )
    .await;
    assert_eq!(res.text(), "Hi.");
    assert_eq!(llm.calls(), 2);
    assert_eq!(llm.request(1).model, "claude-haiku-5-5");
}

#[tokio::test]
async fn empty_handover_line_falls_back_to_the_model() {
    let llm = ScriptedLlm::new(vec![reply("Say a node dies. What happens?")]);
    let (app, state) = test_app(llm.clone());
    let mut st = new_state("s1", "sde.system_design.full", VoiceKind::Fish);
    st.pending_handover.insert("p2".into(), "(nods)".into());
    state.registry.insert(st);
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p2",
            json!([{"role": "user", "content": "[event: handover]"}]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Say a node dies. What happens?");
    assert_eq!(llm.calls(), 1);
}

// ---------- director mode ----------

fn director_reply(calls: Value) -> MessagesResponse {
    serde_json::from_value(json!({
        "id": "msg_d",
        "model": "claude-haiku-5-5",
        "content": calls,
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 10, "output_tokens": 5}
    }))
    .unwrap()
}

#[tokio::test]
async fn director_mode_speaks_without_tools_then_applies_the_directors_calls() {
    let llm = ScriptedLlm::with_creates(
        vec![reply("Okay. Let's move on to the design.")],
        vec![director_reply(json!([
            {"type": "tool_use", "id": "toolu_d1", "name": "next_phase", "input": {}}
        ]))],
    );
    let (app, state) = test_app(llm.clone());
    let mut st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    st.live.tools = ToolsMode::Director;
    let mut events = st.events.subscribe();
    state.registry.insert(st);

    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "The API is two calls."}]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Okay. Let's move on to the design.");

    // The live call carried no tools and told the speaker the app runs them.
    let live = llm.request(0);
    assert!(live.tools.is_empty());
    assert_eq!(live.tool_choice, None);
    assert_eq!(
        live.system.last().unwrap().text,
        ir_server::orchestrator::director::SPEAK_ONLY_NOTE
    );

    // The director ran on the fast model with the tools, saw the spoken line, and its call was applied.
    let ev = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .expect("director event")
        .unwrap();
    assert!(
        matches!(ev, ServerEvent::RoundState(ref r) if r.phase_index == 1),
        "{ev:?}"
    );
    let created = llm.created.lock().unwrap().clone();
    assert_eq!(created.len(), 1);
    let d = &created[0];
    assert_eq!(d.model, "claude-haiku-5-5");
    assert_eq!(d.tools.len(), 6);
    let last = d.messages.last().unwrap();
    assert_eq!(last.role, Role::User);
    assert!(last.text().contains("Okay. Let's move on to the design."));
    assert!(last.text().contains("The API is two calls."));

    // The live history holds speech only: no tool calls, no owed results.
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert_eq!(st.phase_idx, 1);
    assert!(st.pending_tool_results.is_empty());
    assert!(st.history.iter().all(|m| {
        m.content
            .iter()
            .all(|b| !matches!(b, ContentBlock::ToolUse { .. }))
    }));
}

// ---------- dev voice spike page ----------

#[tokio::test]
async fn dev_voice_spike_page_needs_the_dev_key() {
    let (app, _state) = test_app(ScriptedLlm::new(vec![]));
    let get = |uri: &str| Request::get(uri.to_string()).body(Body::empty()).unwrap();
    let res = app.clone().oneshot(get("/dev/voice-spike")).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = app
        .clone()
        .oneshot(get("/dev/voice-spike?key=wrong"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = app
        .clone()
        .oneshot(get("/dev/voice-spike?key=test-dev-key"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let csp = res.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .to_string();
    assert!(csp.contains("https://esm.sh"), "{csp}");
    let html = String::from_utf8(common::body_bytes(res).await).unwrap();
    assert!(html.contains("/dev/voice-spike.js"));
    // The state and session APIs refuse without the key.
    let res = app
        .clone()
        .oneshot(get("/dev/voice-spike/state?session_id=spike-x"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

// ---------- speculative replies ----------

#[tokio::test]
async fn speculative_replies_wait_for_the_voice_platform() {
    let llm = ScriptedLlm::new(vec![
        reply("Go ahead."),
        reply("Assigned seating."),
        reply("Okay. Next?"),
    ]);
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));

    // A draft on an interim transcript: answered, but not recorded.
    let r1 = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "So first,"}]),
        ),
    )
    .await;
    assert_eq!(r1.text(), "Go ahead.");
    assert!(
        state
            .registry
            .get("s1")
            .unwrap()
            .lock()
            .await
            .history
            .is_empty()
    );

    // The finished utterance: Fish never played "Go ahead.", so that draft is dropped.
    let r2 = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "So first, are the seats assigned?"}]),
        ),
    )
    .await;
    assert_eq!(r2.text(), "Assigned seating.");
    // The model never saw the dropped draft.
    assert_eq!(
        user_texts(&llm.request(1).messages),
        vec!["So first, are the seats assigned?"]
    );

    // The browser reports playback: the reply is committed at once.
    {
        let st = state.registry.get("s1").unwrap();
        let mut st = st.lock().await;
        assert!(st.history.is_empty());
        assert!(st.confirm_spoken("p1", "Assigned", Instant::now()));
        assert_eq!(
            user_texts(&st.history),
            vec!["So first, are the seats assigned?"]
        );
        assert!(st.provisional.is_empty());
    }

    // The next request also carries it; nothing is recorded twice.
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "So first, are the seats assigned?"},
                {"role": "assistant", "content": "Assigned seating."},
                {"role": "user", "content": "Got it."}
            ]),
        ),
    )
    .await;
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert_eq!(
        user_texts(&st.history),
        vec!["So first, are the seats assigned?"]
    );
    assert_eq!(st.provisional.len(), 1, "the newest reply waits in turn");
    let speakers: Vec<&str> = st.turns.iter().map(|t| t.speaker.as_str()).collect();
    assert_eq!(speakers, vec!["candidate", "p1"]);
}

#[tokio::test]
async fn director_calls_of_an_unplayed_reply_are_dropped() {
    let llm = ScriptedLlm::with_creates(
        vec![reply("Let's move on."), reply("Okay.")],
        vec![
            director_reply(json!([
                {"type": "tool_use", "id": "toolu_d1", "name": "next_phase", "input": {}}
            ])),
            director_reply(json!([])),
        ],
    );
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    let mut st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    st.live.tools = ToolsMode::Director;
    state.registry.insert(st);

    post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "And"}])),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The director answered while the reply was parked: nothing applied yet.
    assert_eq!(state.registry.get("s1").unwrap().lock().await.phase_idx, 0);
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "And that is the API."}]),
        ),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert_eq!(
        st.phase_idx, 0,
        "the unplayed transition never moved the phase"
    );
}
