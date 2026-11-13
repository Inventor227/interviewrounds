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
    ServerEvent, SessionSettings, SessionState, Style, VoiceKind,
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
    /// Opens the stream, then sends these events after a delay (a slow model).
    Delay(Duration, Vec<StreamEvent>),
}

#[derive(Default)]
struct ScriptedLlm {
    scripts: Mutex<VecDeque<Script>>,
    requests: Mutex<Vec<MessagesRequest>>,
    /// Non-streamed (director) replies, and the requests they answered.
    creates: Mutex<VecDeque<MessagesResponse>>,
    created: Mutex<Vec<MessagesRequest>>,
    /// The next this many creates fail as overloaded.
    failing_creates: Mutex<usize>,
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
        {
            let mut failing = self.failing_creates.lock().unwrap();
            if *failing > 0 {
                *failing -= 1;
                return Err(ClaudeError::Overloaded);
            }
        }
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
            Some(Script::Delay(d, events)) => Ok(stream::once(tokio::time::sleep(d))
                .filter_map(|_| async { None::<Result<StreamEvent, ClaudeError>> })
                .chain(stream::iter(events.into_iter().map(Ok)))
                .boxed()),
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
        fallback_model: "claude-haiku-5-5".into(),
        model: "claude-opus-5-5".into(),
        fast_model: "claude-haiku-5-5".into(),
        effort: "low".into(),
        max_tokens: 300,
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
    // The speaker prompt is cached; the live call never carries tools, only the speak-only note after it.
    assert!(req.system[0].cache_control.is_some());
    assert_eq!(
        req.system.last().unwrap().text,
        ir_server::orchestrator::director::SPEAK_ONLY_NOTE
    );
    assert!(req.tools.is_empty());
    assert!(req.tool_choice.is_none());

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
    assert!(note.contains("transition line"), "{note}");
    assert!(
        !note.contains("next_phase"),
        "the live note never names a tool: {note}"
    );

    let late = st.started_at + Duration::from_secs(8 * 60 + 5);
    let note = last_system_note(&build_live_request(
        &st,
        "p1",
        &UserInput::Event(EventKind::TimeCheck),
        late,
    ));
    assert!(note.contains("Close now in one line"), "{note}");
    assert!(!note.contains("end_round"), "{note}");
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
    // Haiku runs the retry with thinking off (allowed at effort high or below): faster, and no thinking block.
    assert_eq!(retry.thinking, Some(ir_server::claude::Thinking::Disabled));
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
        println!("{model} brief: {:?}, phase {}", st.brief, st.phase_idx);
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
    // Only the candidate's words are recorded; the reply waits.
    {
        let st = state.registry.get("s1").unwrap();
        let st = st.lock().await;
        assert!(
            st.history.iter().all(|m| m.role == Role::User),
            "{:?}",
            st.history
        );
    }

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
    // The draft's words were recorded when it started; the still-unanswered message is revised in place.
    assert_eq!(user_texts(&st.history), vec!["I'd put a cache in front."]);
    assert!(st.provisional.is_empty());
    let candidate: Vec<&str> = st
        .turns
        .iter()
        .filter(|t| t.speaker == "candidate")
        .map(|t| t.text.as_str())
        .collect();
    assert_eq!(candidate, vec!["I'd put a cache in front."]);
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
async fn one_turn_deadline_covers_the_call_and_any_retry() {
    let llm = ScriptedLlm::new(vec![Script::Hang, Script::Hang]);
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
    // The hang ran into the deadline; no retry was started without room for it.
    assert_eq!(llm.calls(), 1);
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
    // Only the candidate's words are recorded; the reply waits.
    {
        let st = state.registry.get("s1").unwrap();
        let st = st.lock().await;
        assert!(
            st.history.iter().all(|m| m.role == Role::User),
            "{:?}",
            st.history
        );
    }
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
    let st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
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
    // Only the candidate's words are recorded; the reply waits.
    {
        let st = state.registry.get("s1").unwrap();
        let st = st.lock().await;
        assert!(
            st.history.iter().all(|m| m.role == Role::User),
            "{:?}",
            st.history
        );
    }

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
    // The model never saw the dropped draft, and the repeated words are revised in place, not doubled.
    assert_eq!(
        user_texts(&llm.request(1).messages),
        vec!["So first, are the seats assigned?"]
    );
    assert!(
        llm.request(1)
            .messages
            .iter()
            .all(|m| m.text() != "Go ahead.")
    );

    // The browser reports playback: the reply is committed at once.
    {
        let st = state.registry.get("s1").unwrap();
        let mut st = st.lock().await;
        assert!(st.history.iter().all(|m| m.role == Role::User));
        st.confirm_spoken("p1", "Assigned");
        assert!(st.provisional.is_empty());
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
        vec!["So first, are the seats assigned?", "Got it."]
    );
    assert_eq!(st.provisional.len(), 1, "the newest reply waits in turn");
    let speakers: Vec<&str> = st.turns.iter().map(|t| t.speaker.as_str()).collect();
    assert_eq!(speakers, vec!["candidate", "p1", "candidate"]);
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
    let st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
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

#[tokio::test]
async fn playback_reported_while_the_reply_streams_commits_it_when_done() {
    let mut st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    // The voice starts speaking from the first words, before the stream ends and the reply is parked.
    assert!(st.confirm_spoken("p1", "Okay. Let's").is_empty());
    let draft = ir_server::orchestrator::prompt::draft_turn(
        &st,
        "p1",
        &UserInput::Speech("That covers it.".into()),
        Instant::now(),
    );
    let id = st.new_turn_id();
    st.park(ir_server::orchestrator::Provisional {
        id,
        panelist_id: "p1".into(),
        input: UserInput::Speech("That covers it.".into()),
        draft: Some(draft),
        reply: vec![ContentBlock::text("Okay. Let's move on.")],
        spoken: "Okay. Let's move on.".into(),
        tool_calls: Vec::new(),
        parked_at: Instant::now(),
        director: None,
    });
    assert!(st.provisional.is_empty());
    assert_eq!(user_texts(&st.history), vec!["That covers it."]);
    assert!(st.recent_commits.contains(&id));
}

// ---------- fix round 1: per-panelist parking, confirmation, flush ----------

#[tokio::test]
async fn two_panelists_keep_their_own_parked_replies() {
    let llm = ScriptedLlm::new(vec![
        reply("Okay. Why sections?"),
        reply("Say a section's node dies at peak. What happens?"),
        reply("Got it."),
    ]);
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    state
        .registry
        .insert(new_state("s1", "sde.system_design.full", VoiceKind::Fish));

    // Daniel (p1) answers the candidate; the reply waits for playback.
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "I'd shard by section."}]),
        ),
    )
    .await;
    // Ana's (p2) own Fish session knows nothing of Daniel's line: her request must not drop it.
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p2",
            json!([{"role": "user", "content": "[event: handover]"}]),
        ),
    )
    .await;
    {
        let st = state.registry.get("s1").unwrap();
        let st = st.lock().await;
        assert_eq!(st.provisional.len(), 1);
        assert_eq!(st.provisional[0].panelist_id, "p1");
        assert!(
            st.turns
                .iter()
                .any(|t| t.speaker == "candidate" && t.text == "I'd shard by section.")
        );
    }
    // Daniel's next request shows his line was played: it is committed now, after Ana's turn.
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "I'd shard by section."},
                {"role": "assistant", "content": "Okay. Why sections?"},
                {"role": "user", "content": "Load spreads out."}
            ]),
        ),
    )
    .await;
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert!(
        st.turns
            .iter()
            .any(|t| t.speaker == "p1" && t.text == "Okay. Why sections?")
    );
    assert!(st.turns.iter().any(|t| t.speaker == "p2"));
    let candidate: Vec<&str> = st
        .turns
        .iter()
        .filter(|t| t.speaker == "candidate")
        .map(|t| t.text.as_str())
        .collect();
    assert_eq!(
        candidate,
        vec!["I'd shard by section.", "Load spreads out."]
    );
    // History stays well formed: no system note right after an assistant turn.
    for w in st.history.windows(2) {
        assert!(
            !(w[0].role == Role::Assistant && w[1].role == Role::System),
            "{:?}",
            st.history
        );
    }
}

#[tokio::test]
async fn confirm_runs_director_actions_once() {
    let llm = ScriptedLlm::with_creates(
        vec![reply("Okay. Let's move on to the design."), reply("Go on.")],
        vec![
            director_reply(json!([
                {"type": "tool_use", "id": "toolu_d1", "name": "next_phase", "input": {}}
            ])),
            director_reply(json!([])),
        ],
    );
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    let st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    state.registry.insert(st);

    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "That's the API."}]),
        ),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let handle = state.registry.get("s1").unwrap();
    let mut events = handle.lock().await.events.subscribe();
    let jobs = {
        let mut st = handle.lock().await;
        assert_eq!(st.phase_idx, 0, "nothing runs before playback");
        assert!(
            st.director_jobs.is_empty(),
            "no director call for an unplayed reply"
        );
        // voice.spoken from the browser: the line started playing, so its director call goes out now.
        ir_server::orchestrator::confirm_spoken(&mut st, "p1", "Okay. Let's move");
        st.take_director_jobs()
    };
    assert_eq!(jobs.len(), 1);
    ir_server::orchestrator::oai::spawn_directors(&state, &handle, "s1", jobs);
    let ev = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .expect("director actions")
        .unwrap();
    assert!(
        matches!(ev, ServerEvent::RoundState(ref r) if r.phase_index == 1),
        "{ev:?}"
    );
    {
        let mut st = handle.lock().await;
        assert_eq!(st.phase_idx, 1);
        // A repeat report changes nothing and sends nothing.
        assert!(
            ir_server::orchestrator::confirm_spoken(&mut st, "p1", "Okay. Let's move on")
                .is_empty()
        );
        assert!(st.take_director_jobs().is_empty());
        assert_eq!(st.phase_idx, 1);
    }
    // Fish's next request also shows the line: nothing is applied twice.
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "That's the API."},
                {"role": "assistant", "content": "Okay. Let's move on to the design."},
                {"role": "user", "content": "Sure."}
            ]),
        ),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let st = handle.lock().await;
    assert_eq!(st.phase_idx, 1);
    let p1_lines = st.turns.iter().filter(|t| t.speaker == "p1").count();
    assert_eq!(p1_lines, 1, "the confirmed line is recorded once");
}

#[tokio::test]
async fn end_of_session_flush_records_the_last_exchange() {
    let llm = ScriptedLlm::with_creates(
        vec![reply("That's time. Thanks for designing this with me.")],
        vec![director_reply(json!([
            {"type": "tool_use", "id": "toolu_e", "name": "end_round",
             "input": {"closing_line": "That's time. Thanks for designing this with me."}}
        ]))],
    );
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    let st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    let mut events = st.events.subscribe();
    state.registry.insert(st);

    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "And that's my design."}]),
        ),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The browser reports the closing line playing, then the session ends: the exchange and the close are kept.
    let handle = state.registry.get("s1").unwrap();
    let jobs = {
        let mut st = handle.lock().await;
        st.confirm_spoken("p1", "That's time.");
        st.take_director_jobs()
    };
    ir_server::orchestrator::oai::spawn_directors(&state, &handle, "s1", jobs);
    tokio::time::timeout(Duration::from_secs(2), async {
        while handle.lock().await.closing_line.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the close runs once the line is played");
    let (_h, flushed) = state.registry.end_session("s1").await.expect("session");
    assert!(flushed.is_empty(), "the close ran once, at confirmation");
    assert!(state.registry.get("s1").is_none());
    let st = handle.lock().await;
    assert_eq!(
        st.closing_line.as_deref(),
        Some("That's time. Thanks for designing this with me.")
    );
    let last: Vec<(&str, &str)> = st
        .turns
        .iter()
        .map(|t| (t.speaker.as_str(), t.text.as_str()))
        .collect();
    assert_eq!(
        last,
        vec![
            ("candidate", "And that's my design."),
            ("p1", "That's time. Thanks for designing this with me.")
        ]
    );
    assert!(matches!(
        events.try_recv(),
        Ok(ServerEvent::RoundEnding { .. })
    ));
}

#[tokio::test]
async fn flush_without_playback_keeps_the_candidates_words_and_drops_the_reply() {
    let llm = ScriptedLlm::new(vec![reply("Okay. And the cache?")]);
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "Writes go to Postgres."}]),
        ),
    )
    .await;
    let handle = state.registry.get("s1").unwrap();
    let flushed = handle.lock().await.flush_provisional();
    assert!(flushed.is_empty());
    let st = handle.lock().await;
    assert!(st.provisional.is_empty());
    assert_eq!(user_texts(&st.history), vec!["Writes go to Postgres."]);
    assert!(st.turns.iter().all(|t| t.speaker != "p1"));
}

#[test]
fn the_most_urgent_waiting_event_is_kept() {
    assert_eq!(
        parse_user_turn(&["[event: ending]", "[event: time_check]"]),
        Some(UserInput::Event(EventKind::Ending))
    );
    assert_eq!(
        parse_user_turn(&["[event: silence_check]", "So", "[event: long_answer]"]),
        Some(UserInput::SpeechWithEvent(
            "So".into(),
            EventKind::LongAnswer
        ))
    );
}

// ---------- fix round 2: revised transcripts, dropped replies after a browser confirm ----------

#[tokio::test]
async fn revised_interim_transcripts_are_recorded_once() {
    let llm = ScriptedLlm::new(vec![reply("Mm-hm."), reply("Go on."), reply("Assigned.")]);
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    // Speculative requests on interim transcripts; the second one revises an earlier word.
    for text in [
        "So fast",
        "So first, are",
        "So first, are the seats assigned?",
    ] {
        post_chat(
            &app,
            SECRET,
            chat_body("s1", "p1", json!([{"role": "user", "content": text}])),
        )
        .await;
    }
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert_eq!(
        user_texts(&st.history),
        vec!["So first, are the seats assigned?"]
    );
    let candidate: Vec<&str> = st
        .turns
        .iter()
        .filter(|t| t.speaker == "candidate")
        .map(|t| t.text.as_str())
        .collect();
    assert_eq!(candidate, vec!["So first, are the seats assigned?"]);
    // The model saw the latest transcript once, never the earlier versions.
    assert_eq!(
        user_texts(&llm.request(2).messages),
        vec!["So first, are the seats assigned?"]
    );
}

#[tokio::test]
async fn words_are_not_repeated_when_fish_drops_a_confirmed_reply() {
    let llm = ScriptedLlm::new(vec![reply("Okay. Why sections?"), reply("Got it.")]);
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "I'd shard by section."}]),
        ),
    )
    .await;
    // The browser saw the reply start, then the candidate cut in after one word and Fish dropped the reply.
    state
        .registry
        .get("s1")
        .unwrap()
        .lock()
        .await
        .confirm_spoken("p1", "Okay.");
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "I'd shard by section."},
                {"role": "user", "content": "Because load spreads."}
            ]),
        ),
    )
    .await;
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    assert_eq!(
        user_texts(&st.history),
        vec!["I'd shard by section.", "Because load spreads."]
    );
    let log: Vec<(&str, &str)> = st
        .turns
        .iter()
        .map(|t| (t.speaker.as_str(), t.text.as_str()))
        .collect();
    assert_eq!(
        log,
        vec![
            ("candidate", "I'd shard by section."),
            ("p1", "Okay. Why sections?"),
            ("candidate", "Because load spreads."),
        ]
    );
}

#[test]
fn an_early_report_survives_parking_another_reply() {
    let mut st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    // The browser reports A1 while it streams; meanwhile the hold line for this panelist is parked.
    assert!(st.confirm_spoken("p1", "So walk me").is_empty());
    let id = st.new_turn_id();
    st.park(ir_server::orchestrator::Provisional {
        id,
        panelist_id: "p1".into(),
        input: UserInput::Speech("Hello?".into()),
        draft: None,
        reply: vec![ContentBlock::text("Sorry, give me a second.")],
        spoken: "Sorry, give me a second.".into(),
        tool_calls: Vec::new(),
        parked_at: Instant::now(),
        director: None,
    });
    assert_eq!(st.provisional.len(), 1, "the hold line waits");
    assert!(
        st.early_confirm.contains_key("p1"),
        "the report waits for A1"
    );
}

// ---------- fix round 3: one rule for recording an utterance ----------

/// Every candidate word in the user messages and in the turn log, in order.
fn candidate_words(st: &SessionState) -> (Vec<String>, Vec<String>) {
    let split = |t: &str| {
        t.split_whitespace()
            .filter(|w| !w.starts_with('[') && !w.ends_with(']'))
            .map(|w| {
                w.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
                    .to_lowercase()
            })
            .collect::<Vec<_>>()
    };
    let history = st
        .history
        .iter()
        .filter(|m| m.role == Role::User)
        .flat_map(|m| split(&m.text()))
        .collect();
    let turns = st
        .turns
        .iter()
        .filter(|t| t.speaker == "candidate")
        .flat_map(|t| split(&t.text))
        .collect();
    (history, turns)
}

#[tokio::test]
async fn an_utterance_is_recorded_once_through_drops_revisions_and_a_played_reply() {
    let llm = ScriptedLlm::new(vec![
        reply("Mm-hm."),
        reply("Okay. Why sections?"),
        reply("Go on."),
        reply("Okay. And writes?"),
        reply("Got it."),
    ]);
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let send = |messages: Value| {
        let app = app.clone();
        async move {
            post_chat(&app, SECRET, chat_body("s1", "p1", messages)).await;
        }
    };

    // 1. An interim transcript; its draft reply is never played.
    send(json!([{"role": "user", "content": "I'd shard by sexton"}])).await;
    // 2. The revised utterance; the browser reports its reply playing...
    send(json!([{"role": "user", "content": "I'd shard by section. Because load"}])).await;
    state
        .registry
        .get("s1")
        .unwrap()
        .lock()
        .await
        .confirm_spoken("p1", "Okay.");
    // 3. ...but the candidate cut in after a word and Fish dropped the reply: it resends the whole utterance.
    send(json!([{"role": "user", "content": "I'd shard by section. Because load spreads."}])).await;
    // 4. The next speculative request in the same answer.
    send(json!([{"role": "user", "content": "I'd shard by section. Because load spreads. So reads scale."}]))
        .await;
    // 5. That reply was played (Fish's transcript has it), and the candidate goes on.
    send(json!([
        {"role": "user", "content": "I'd shard by section. Because load spreads. So reads scale."},
        {"role": "assistant", "content": "Okay. And writes?"},
        {"role": "user", "content": "Writes too."}
    ]))
    .await;

    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    let expected: Vec<String> =
        "i'd shard by section because load spreads so reads scale writes too"
            .split(' ')
            .map(str::to_string)
            .collect();
    let (history, turns) = candidate_words(&st);
    assert_eq!(history, expected, "history: {:?}", user_texts(&st.history));
    assert_eq!(turns, expected, "turns: {:?}", st.turns);
    let agent: Vec<&str> = st
        .turns
        .iter()
        .filter(|t| t.speaker == "p1")
        .map(|t| t.text.as_str())
        .collect();
    assert_eq!(agent, vec!["Okay. Why sections?", "Okay. And writes?"]);
    // History stays well formed.
    for w in st.history.windows(2) {
        assert!(!(w[0].role == Role::Assistant && w[1].role == Role::System));
    }
}

#[tokio::test]
async fn a_new_utterance_never_overwrites_an_earlier_one() {
    let llm = ScriptedLlm::new(vec![reply("Okay."), reply("Right.")]);
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "Yes, that works."}]),
        ),
    )
    .await;
    // The reply was played but no confirmation arrived, and Fish's next request starts a different utterance.
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "Then the cache."}]),
        ),
    )
    .await;
    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    let (history, _) = candidate_words(&st);
    assert_eq!(
        history,
        vec!["yes", "that", "works", "then", "the", "cache"]
    );
}

// ---------- fix round 4: the turn log freezes on its own ----------

#[tokio::test]
async fn words_before_a_typed_event_are_logged_once_when_fish_resends_it() {
    let llm = ScriptedLlm::new(vec![
        reply("Let me pause you there."),
        reply("Let me stop you there. Why Redis?"),
    ]);
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    // The app sends the event while the candidate talks; the draft reply is never played.
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "So the cache holds every seat"},
                {"role": "user", "content": "[event: long_answer]"}
            ]),
        ),
    )
    .await;
    // Fish resends the event with more of the same answer.
    post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "So the cache holds every seat and expires them."},
                {"role": "user", "content": "[event: long_answer]"}
            ]),
        ),
    )
    .await;

    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    let expected: Vec<String> = "so the cache holds every seat and expires them"
        .split(' ')
        .map(str::to_string)
        .collect();
    let (history, turns) = candidate_words(&st);
    assert_eq!(history, expected, "history: {:?}", user_texts(&st.history));
    assert_eq!(turns, expected, "turns: {:?}", st.turns);
    let app_lines = st.turns.iter().filter(|t| t.speaker == "app").count();
    assert_eq!(app_lines, 1, "turns: {:?}", st.turns);
}

#[tokio::test]
async fn words_stay_in_the_turn_log_when_another_panelists_reply_is_committed_late() {
    let llm = ScriptedLlm::new(vec![
        reply("Okay. Why sections?"),
        reply("Thanks, Ana. I'll take it from here."),
        reply("Mm-hm."),
        reply("Got it."),
    ]);
    let (app, state) = test_app_with(llm.clone(), |o| o.confirm_speech_turns = true);
    state
        .registry
        .insert(new_state("s1", "sde.system_design.full", VoiceKind::Fish));
    let send = |panelist: &'static str, messages: Value| {
        let app = app.clone();
        async move {
            post_chat(&app, SECRET, chat_body("s1", panelist, messages)).await;
        }
    };

    // Ana (p2) answers the candidate; her reply waits for playback.
    send("p2", json!([{"role": "user", "content": "Hello there."}])).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    // Daniel (p1) takes over, and the candidate starts an answer to him.
    send(
        "p1",
        json!([{"role": "user", "content": "[event: handover]"}]),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    send(
        "p1",
        json!([{"role": "user", "content": "I'd shard by section."}]),
    )
    .await;
    // Ana's playback report arrives late: her reply goes into the turn log at the time she spoke, before the
    // candidate's current line, and into the history after the candidate's current message.
    state
        .registry
        .get("s1")
        .unwrap()
        .lock()
        .await
        .confirm_spoken("p2", "Okay. Why sections?");
    // Daniel's draft was not played; Fish resends the answer with more words.
    send(
        "p1",
        json!([{"role": "user", "content": "I'd shard by section. Because load spreads."}]),
    )
    .await;

    let st = state.registry.get("s1").unwrap();
    let st = st.lock().await;
    let expected: Vec<String> = "hello there i'd shard by section because load spreads"
        .split(' ')
        .map(str::to_string)
        .collect();
    let (history, turns) = candidate_words(&st);
    assert_eq!(history, expected, "history: {:?}", user_texts(&st.history));
    assert_eq!(turns, expected, "turns: {:?}", st.turns);
    assert!(
        st.turns
            .iter()
            .any(|t| t.speaker == "p2" && t.text == "Okay. Why sections?")
    );
}

#[test]
fn next_phase_names_the_phase_it_leaves_and_hints_are_reported() {
    use ir_server::orchestrator::tools::ToolCall;
    let mut st = new_state("s-phase", "sde.system_design.short", VoiceKind::Fake);
    let call = |name: &str, input: Value| ToolCall {
        id: "toolu_t".into(),
        name: name.into(),
        input,
        panelist_id: "p1".into(),
    };
    let ev = st.apply_tool_calls(&[call("next_phase", json!({"from": "requirements"}))]);
    assert_eq!(st.phase_idx, 1);
    assert!(matches!(&ev[..], [ServerEvent::RoundState(s)] if s.phase_index == 1));
    // A late repeat naming the phase already left does nothing.
    let ev = st.apply_tool_calls(&[call("next_phase", json!({"from": "requirements"}))]);
    assert!(ev.is_empty(), "{ev:?}");
    assert_eq!(st.phase_idx, 1);
    // Without a phase id it still moves on.
    st.apply_tool_calls(&[call("next_phase", json!({}))]);
    assert_eq!(st.phase_idx, 2);

    let ev = st.apply_tool_calls(&[call("give_hint", json!({"level": 2}))]);
    assert!(
        matches!(&ev[..], [ServerEvent::Hint { level: 2, panelist_id, .. }, ServerEvent::RoundState(_)] if panelist_id == "p1"),
        "{ev:?}"
    );
    assert_eq!((st.hints_given, st.hint_max_level), (1, 2));
}

#[test]
fn the_round_starts_with_the_question_card_on_the_brief() {
    let st = new_state("s-brief", "sde.system_design.short", VoiceKind::Fake);
    let brief = ir_server::orchestrator::initial_brief(&st.question).expect("a question card");
    assert_eq!(brief.question, "Link shortener");
    assert_eq!(
        brief.lines,
        ["100M new links a month", "Reads far outnumber writes"]
    );
    assert!(ir_server::orchestrator::initial_brief(&Value::Null).is_none());
}

#[test]
fn the_live_prompt_never_describes_tools_and_the_director_keeps_them() {
    const TOOLS: [&str; 6] = [
        "show_question",
        "next_phase",
        "point_at",
        "give_hint",
        "hand_over",
        "end_round",
    ];
    let content = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../content");
    let catalog = Catalog::load(&content).expect("content loads");
    let mut checked = 0;
    for (id, round) in &catalog.rounds {
        if round.round_type == "meeting" {
            continue;
        }
        let st = SessionState::new(
            NewSession {
                id: format!("s-{id}"),
                identity_id: "guest-1".into(),
                mode: Mode::Interview,
                round_id: id.clone(),
                settings: SessionSettings {
                    level: Level::Mid,
                    style: Style::Neutral,
                    voice: VoiceKind::Fake,
                },
                panel: Vec::new(),
                question_id: None,
                meeting: None,
            },
            &catalog,
            live(),
            Instant::now(),
        )
        .expect("state builds");
        for p in &st.panel {
            let live_text: String = p.system.iter().map(|b| b.text.as_str()).collect();
            for t in TOOLS {
                assert!(
                    !live_text.contains(t),
                    "{id} {}: live prompt names {t}",
                    p.panelist_id
                );
            }
            assert!(!live_text.contains("[[tool:"), "{id}: a marker is left");
            assert!(
                p.director_system.contains("end_round") || p.director_system.contains("hand_over"),
                "{id} {}: the director lost the tool rules",
                p.panelist_id
            );
            assert!(
                !p.director_system.contains("[[tool:"),
                "{id}: a marker is left"
            );
        }
        checked += 1;
    }
    assert!(checked >= 10, "{checked} rounds checked");
    // The live request adds only the speak-only note, which names no tool either.
    for t in TOOLS {
        assert!(!ir_server::orchestrator::director::SPEAK_ONLY_NOTE.contains(t));
    }
    let text = "Open.[[tool:  Call show_question.]] Then stop.\n[[tool: - point_at: pulses an item.]]\nEnd.";
    assert_eq!(
        ir_server::orchestrator::prompt::live_view(text),
        "Open. Then stop.\nEnd."
    );
    assert_eq!(
        ir_server::orchestrator::prompt::director_view(text),
        "Open. Call show_question. Then stop.\n- point_at: pulses an item.\nEnd."
    );
    // A span whose filled placeholder runs over several lines.
    let text = "Script.\n[[tool: Brief card lines (for show_question): first\nsecond]]\nEnd.";
    assert_eq!(
        ir_server::orchestrator::prompt::live_view(text),
        "Script.\nEnd."
    );
    assert_eq!(
        ir_server::orchestrator::prompt::director_view(text),
        "Script.\nBrief card lines (for show_question): first\nsecond\nEnd."
    );
}

fn no_empty_text(messages: &[Message]) -> bool {
    messages.iter().all(|m| {
        !m.content.is_empty()
            && m.content
                .iter()
                .all(|b| !matches!(b, ContentBlock::Text { text, .. } if text.trim().is_empty()))
    })
}

#[tokio::test]
async fn a_reply_that_opens_with_a_tool_name_never_leaves_an_empty_block() {
    let llm = ScriptedLlm::new(vec![
        reply("end_round: That's time. Thanks for designing this with me."),
        // The retry on the fast model does the same.
        reply("show_question: Link shortener"),
        reply("Okay. Where would you start?"),
        reply("next_phase"),
        // A retry after a cut speaks normally.
        reply("Right. And the scale?"),
    ]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    // Nothing is spoken before the tool name: on the start marker the written opener is said and recorded instead.
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
    let opener = state
        .registry
        .get("s1")
        .unwrap()
        .lock()
        .await
        .templated_opener("p1");
    assert_eq!(res.text(), opener);
    {
        let handle = state.registry.get("s1").unwrap();
        let st = handle.lock().await;
        assert!(no_empty_text(&st.history), "{:?}", st.history);
        assert_eq!(st.history.last().unwrap().text(), opener);
    }
    // The next turn goes through, with a clean history.
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "[event: start]"},
                {"role": "assistant", "content": opener},
                {"role": "user", "content": "Hi, I'd start with the requirements."}
            ]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Okay. Where would you start?");
    assert!(no_empty_text(&llm.request(2).messages));
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "[event: start]"},
                {"role": "assistant", "content": opener},
                {"role": "user", "content": "Hi, I'd start with the requirements."},
                {"role": "assistant", "content": "Okay. Where would you start?"},
                {"role": "user", "content": "With the reads."}
            ]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Right. And the scale?");
    let handle = state.registry.get("s1").unwrap();
    assert!(no_empty_text(&handle.lock().await.history));
}

/// Every system note follows a user message and is last or right before an assistant turn (the API's rule).
fn notes_well_placed(messages: &[Message]) -> bool {
    messages.iter().enumerate().all(|(i, m)| {
        m.role != Role::System
            || (i > 0
                && messages[i - 1].role == Role::User
                && messages
                    .get(i + 1)
                    .is_none_or(|n| n.role == Role::Assistant))
    })
}

#[test]
fn live_and_director_requests_never_carry_empty_text() {
    use ir_server::orchestrator::TurnCommit;
    let mut st = new_state("s1", "sde.system_design.short", VoiceKind::Fish);
    let now = Instant::now();
    let commit = |st: &mut SessionState, said: &str, reply: &str| {
        let draft = ir_server::orchestrator::prompt::draft_turn(
            st,
            "p1",
            &UserInput::Speech(said.into()),
            now,
        );
        st.commit_turn(
            TurnCommit {
                draft,
                reply: vec![ContentBlock::text(reply)],
                spoken: reply.into(),
                tool_calls: Vec::new(),
                handover_line_used: false,
            },
            now,
        );
    };
    // A bad entry in the real shape (user, note, assistant): a reply with an empty text block. Then a good turn.
    commit(&mut st, "Hi.", "");
    commit(&mut st, "So, the cache.", "Okay. Why a cache?");
    assert!(
        !no_empty_text(&st.history),
        "the history does hold the bad entry"
    );
    let input = UserInput::Speech("And the queue.".into());
    let req = build_live_request(&st, "p1", &input, now);
    assert!(no_empty_text(&req.messages), "{:?}", req.messages);
    assert!(notes_well_placed(&req.messages), "{:?}", req.messages);
    let draft = ir_server::orchestrator::prompt::draft_turn(&st, "p1", &input, now);
    let dreq = ir_server::orchestrator::director::build_request(
        &st,
        "p1",
        &draft,
        "Okay.",
        "claude-sonnet-5-5",
    );
    assert!(no_empty_text(&dreq.messages), "{:?}", dreq.messages);
    assert!(notes_well_placed(&dreq.messages), "{:?}", dreq.messages);

    // An all-whitespace user message takes its note with it.
    let mut msgs = vec![
        Message::user_text("Hi."),
        Message::system_text("note 1"),
        Message::assistant_text("Hello."),
        Message::user_text("  "),
        Message::system_text("note 2"),
        Message::assistant_text("Go on."),
    ];
    ir_server::orchestrator::prompt::strip_empty_text(&mut msgs);
    assert!(notes_well_placed(&msgs), "{msgs:?}");
    assert!(!msgs.iter().any(|m| m.text() == "note 2"));
}

#[tokio::test]
async fn a_dropped_turn_never_records_tool_text() {
    // The first attempt opens with a tool name and is retried; the retry speaks, then Fish drops the request.
    let llm = ScriptedLlm::new(vec![
        reply("end_round: That's time. Thanks for designing this with me."),
        Script::ThenHang(vec![StreamEvent::TextDelta("Right. And the".into())]),
        // A single attempt cut at a tool name after some speech, then dropped.
        Script::ThenHang(vec![StreamEvent::TextDelta(
            "Okay. next_phase and on".into(),
        )]),
    ]);
    let (app, state) = test_app(llm.clone());
    state
        .registry
        .insert(new_state("s1", "sde.system_design.short", VoiceKind::Fish));
    let first = post_chat_and_drop(
        &app,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Hi."}])),
    )
    .await;
    assert!(first.contains("Right. And the"), "{first}");
    {
        let handle = state.registry.get("s1").unwrap();
        let st = handle.lock().await;
        let parked: Vec<String> = st
            .provisional
            .iter()
            .map(|p| {
                p.reply
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::Text { text, .. } => Some(text.clone()),
                        _ => None,
                    })
                    .collect::<String>()
            })
            .collect();
        assert_eq!(parked, ["Right. And the"], "only the retry's words");
    }
    post_chat_and_drop(
        &app,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Go on."}])),
    )
    .await;
    let handle = state.registry.get("s1").unwrap();
    let st = handle.lock().await;
    let all: String = st
        .provisional
        .iter()
        .chain(std::iter::empty())
        .flat_map(|p| p.reply.iter())
        .filter_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" | ");
    assert!(
        !all.contains("end_round") && !all.contains("next_phase"),
        "{all}"
    );
    let history: String = st
        .history
        .iter()
        .map(Message::text)
        .collect::<Vec<_>>()
        .join(" | ");
    assert!(
        !history.contains("end_round") && !history.contains("next_phase"),
        "{history}"
    );
}

#[test]
fn a_cut_reply_keeps_only_what_was_spoken() {
    use ir_server::orchestrator::oai::keep_spoken_text;
    let thinking =
        ContentBlock::Other(json!({"type": "thinking", "thinking": "", "signature": "x"}));
    // Nothing spoken before the tool name: no text block is left at all.
    let mut reply = vec![
        thinking.clone(),
        ContentBlock::text("end_round: That's time."),
    ];
    keep_spoken_text(&mut reply, "");
    assert_eq!(reply, vec![thinking.clone()]);
    // Something spoken: one block with exactly that.
    let mut reply = vec![
        thinking.clone(),
        ContentBlock::text("Okay. next_phase"),
        ContentBlock::text(" and more"),
    ];
    keep_spoken_text(&mut reply, "Okay. ");
    assert_eq!(reply, vec![thinking, ContentBlock::text("Okay.")]);
}

// ---------- overload fallback (R62) ----------

/// The settings prod runs: live and fast model are both Sonnet; the fallback is Haiku.
fn prod_live() -> LiveSettings {
    LiveSettings {
        model: "claude-sonnet-5-5".into(),
        fast_model: "claude-sonnet-5-5".into(),
        fallback_model: "claude-haiku-5-5".into(),
        effort: "low".into(),
        max_tokens: 300,
    }
}

fn prod_state(id: &str) -> SessionState {
    let mut st = new_state(id, "sde.system_design.short", VoiceKind::Fish);
    st.live = prod_live();
    st
}

#[tokio::test]
async fn overload_with_prod_settings_retries_on_the_fallback_model() {
    let llm = ScriptedLlm::new(vec![Script::Fail(ClaudeError::Overloaded), reply("Okay.")]);
    let (app, state) = test_app(llm.clone());
    state.registry.insert(prod_state("s1"));
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Hi."}])),
    )
    .await;
    assert_eq!(res.text(), "Okay.", "a real reply, not the hold line");
    assert_eq!(llm.request(0).model, "claude-sonnet-5-5");
    let retry = llm.request(1);
    assert_eq!(
        retry.model, "claude-haiku-5-5",
        "never the model that failed"
    );
    assert_eq!(retry.thinking, Some(ir_server::claude::Thinking::Disabled));
    assert_eq!(retry.fallbacks, None);
    // A model that stalls before its first text is unavailable too.
    let llm = ScriptedLlm::new(vec![Script::Hang, reply("Okay.")]);
    let (app, state) = test_app(llm.clone());
    state.registry.insert(prod_state("s2"));
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s2", "p1", json!([{"role": "user", "content": "Hi."}])),
    )
    .await;
    assert_eq!(res.text(), "Okay.");
    assert_eq!(llm.request(1).model, "claude-haiku-5-5");
}

#[tokio::test]
async fn three_failed_turns_hold_the_clock_until_a_turn_gets_through() {
    let mut scripts = Vec::new();
    // Three attempts per turn while the models only refuse.
    for _ in 0..9 {
        scripts.push(Script::Fail(ClaudeError::Overloaded));
    }
    scripts.push(reply("Back again. Where were we?"));
    let llm = ScriptedLlm::new(scripts);
    let (app, state) = test_app(llm.clone());
    state.registry.insert(prod_state("s1"));
    let handle = state.registry.get("s1").unwrap();
    let ask = |n: usize| {
        let mut msgs = Vec::new();
        for i in 0..n {
            msgs.push(json!({"role": "user", "content": format!("Point {i}.")}));
            msgs.push(json!({"role": "assistant", "content": "Sorry, give me a second."}));
        }
        msgs.push(json!({"role": "user", "content": format!("Point {n}.")}));
        chat_body("s1", "p1", json!(msgs))
    };
    for n in 0..3 {
        let res = post_chat(&app, SECRET, ask(n)).await;
        assert_eq!(res.text(), "Sorry, give me a second.");
        let st = handle.lock().await;
        assert_eq!(st.degraded, n == 2, "turn {n}");
    }
    // Degraded: round.state says so, and the round clock stands still.
    let (before, flag) = {
        let st = handle.lock().await;
        let now = Instant::now();
        (st.elapsed_ms(now), st.round_state(now).degraded)
    };
    assert!(flag);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let held = handle.lock().await.elapsed_ms(Instant::now());
    assert!(held.abs_diff(before) <= 5, "{before} -> {held}");
    // A turn gets through: not degraded, the clock runs again.
    let res = post_chat(&app, SECRET, ask(3)).await;
    assert_eq!(res.text(), "Back again. Where were we?");
    {
        let st = handle.lock().await;
        assert!(!st.degraded);
        assert_eq!(st.failed_turns, 0);
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(handle.lock().await.elapsed_ms(Instant::now()) > before + 100);
}

#[tokio::test]
async fn director_retries_once_on_the_fallback_model() {
    let llm = ScriptedLlm::with_creates(
        vec![reply("Okay. Let's move on to the design.")],
        vec![director_reply(json!([
            {"type": "tool_use", "id": "toolu_d1", "name": "next_phase", "input": {}}
        ]))],
    );
    *llm.failing_creates.lock().unwrap() = 1;
    let (app, state) = test_app(llm.clone());
    let st = prod_state("s1");
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
    let ev = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .expect("director event")
        .unwrap();
    assert!(
        matches!(ev, ServerEvent::RoundState(ref r) if r.phase_index == 1),
        "{ev:?}"
    );
    let created = llm.created.lock().unwrap().clone();
    assert_eq!(created.len(), 2);
    assert_eq!(created[0].model, "claude-sonnet-5-5");
    assert_eq!(created[1].model, "claude-haiku-5-5");
    assert_eq!(
        created[1].thinking,
        Some(ir_server::claude::Thinking::Disabled)
    );
    assert_eq!(created[1].fallbacks, None);
}

fn has_thinking(req: &MessagesRequest) -> bool {
    req.messages.iter().any(|m| {
        m.content.iter().any(|b| {
            matches!(
                b,
                ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. }
            )
        })
    })
}

#[tokio::test]
async fn a_fallback_reply_with_thinking_never_reaches_the_history_or_the_director() {
    let thinking_reply = Script::Reply(vec![
        StreamEvent::Block(ContentBlock::Thinking {
            thinking: String::new(),
            signature: "haiku-sig".into(),
        }),
        StreamEvent::TextDelta("Okay. Go on.".into()),
        stop("end_turn"),
    ]);
    let llm = ScriptedLlm::with_creates(
        vec![
            Script::Fail(ClaudeError::Overloaded),
            thinking_reply,
            reply("Right. And the database?"),
        ],
        vec![director_reply(json!([])), director_reply(json!([]))],
    );
    let (app, state) = test_app(llm.clone());
    state.registry.insert(prod_state("s1"));
    let first = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([{"role": "user", "content": "We start with the API."}]),
        ),
    )
    .await;
    assert_eq!(first.text(), "Okay. Go on.");
    assert_eq!(llm.request(1).model, "claude-haiku-5-5");
    {
        let handle = state.registry.get("s1").unwrap();
        let st = handle.lock().await;
        assert!(
            st.history.iter().all(|m| m
                .content
                .iter()
                .all(|b| !matches!(b, ContentBlock::Thinking { .. }))),
            "the history stays text only"
        );
    }
    let second = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "We start with the API."},
                {"role": "assistant", "content": "Okay. Go on."},
                {"role": "user", "content": "Then a Postgres table per tenant."}
            ]),
        ),
    )
    .await;
    assert_eq!(second.text(), "Right. And the database?");
    assert!(!has_thinking(&llm.request(2)), "the next live request");
    // Both director calls (the fallback turn's and the next one's) carry no thinking block.
    for _ in 0..100 {
        if llm.created.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let created = llm.created.lock().unwrap().clone();
    assert!(created.len() >= 2, "{}", created.len());
    assert!(created.iter().all(|r| !has_thinking(r)));
}

#[tokio::test]
async fn start_marker_gets_a_reply_when_both_models_fail_once() {
    let llm = ScriptedLlm::new(vec![
        Script::Fail(ClaudeError::Overloaded),
        Script::Fail(ClaudeError::Overloaded),
        reply("Hi, I'm Daniel. Where would you start?"),
    ]);
    let (app, state) = test_app(llm.clone());
    state.registry.insert(prod_state("s1"));
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
    assert_eq!(res.text(), "Hi, I'm Daniel. Where would you start?");
    let models: Vec<String> = (0..3).map(|i| llm.request(i).model).collect();
    assert_eq!(
        models,
        ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]
    );
    // A failure that is not a refusal (a bad request) gets no third attempt.
    let llm = ScriptedLlm::new(vec![
        Script::Fail(ClaudeError::Overloaded),
        Script::Fail(ClaudeError::BadRequest("400 invalid".into())),
        reply("Never asked."),
    ]);
    let (app, state) = test_app(llm.clone());
    state.registry.insert(prod_state("s2"));
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s2", "p1", json!([{"role": "user", "content": "Hi."}])),
    )
    .await;
    assert_eq!(res.text(), "Sorry, give me a second.");
    assert_eq!(llm.calls(), 2);
}

#[tokio::test(start_paused = true)]
async fn slow_fallback_gets_the_rest_of_the_turn() {
    // Sonnet refuses; Haiku's stream opens and its first text comes 5 s later, past the old 3.5 s retry window
    // (and the test's 300 ms one) but inside the 8.5 s turn.
    let llm = ScriptedLlm::new(vec![
        Script::Fail(ClaudeError::Overloaded),
        Script::Delay(
            Duration::from_secs(5),
            vec![
                StreamEvent::TextDelta("Okay, slow but here.".into()),
                stop("end_turn"),
            ],
        ),
    ]);
    let (app, state) = test_app(llm.clone());
    state.registry.insert(prod_state("s1"));
    let res = post_chat(
        &app,
        SECRET,
        chat_body("s1", "p1", json!([{"role": "user", "content": "Hi."}])),
    )
    .await;
    assert_eq!(res.text(), "Okay, slow but here.");
    assert_eq!(llm.request(1).model, "claude-haiku-5-5");
}

#[tokio::test]
async fn start_marker_says_a_written_opener_when_every_attempt_fails() {
    let llm = ScriptedLlm::new(vec![
        Script::Fail(ClaudeError::Overloaded),
        Script::Fail(ClaudeError::Overloaded),
        Script::Fail(ClaudeError::Overloaded),
        reply("Good. What comes first?"),
    ]);
    let (app, state) = test_app(llm.clone());
    state.registry.insert(prod_state("s1"));
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
    let opener = res.text();
    let handle = state.registry.get("s1").unwrap();
    let (name, title) = {
        let st = handle.lock().await;
        (
            st.panelist("p1").unwrap().persona.display_name.clone(),
            st.round.title.to_lowercase(),
        )
    };
    assert!(
        opener.starts_with(&format!("Hi, I'm {name}, and this is your")),
        "{opener}"
    );
    assert!(opener.contains(&title), "{opener}");
    assert!(opener.contains("on your card"), "{opener}");
    assert!(
        !opener.contains('\u{2014}') && !opener.contains('\u{2013}'),
        "no dashes: {opener}"
    );
    assert_eq!(
        opener.matches(". ").count() + 1,
        2,
        "two sentences: {opener}"
    );
    // Recorded as the opener: the next request's history starts with it.
    let res = post_chat(
        &app,
        SECRET,
        chat_body(
            "s1",
            "p1",
            json!([
                {"role": "user", "content": "[event: start]"},
                {"role": "assistant", "content": opener},
                {"role": "user", "content": "I'd start with the requirements."}
            ]),
        ),
    )
    .await;
    assert_eq!(res.text(), "Good. What comes first?");
    let next = llm.request(3);
    assert!(
        next.messages
            .iter()
            .any(|m| m.role == Role::Assistant && m.text() == opener),
        "the opener is in the history"
    );
}
