//! The Scribe: utterance to at most three suggested board ops, checked against the board and the words said.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::stream::BoxStream;
use ir_server::board::{Board, BoardSession, GhostOp};
use ir_server::claude::{
    ClaudeClient, ClaudeError, ContentBlock, DEFAULT_BASE_URL, MessagesRequest, MessagesResponse,
    StreamEvent, Usage,
};
use ir_server::content::Catalog;
use ir_server::orchestrator::LlmApi;
use ir_server::scribe::{Scribe, ScribeInput};
use serde_json::{Value, json};

enum Reply {
    Json(Value),
    Text(String),
    Fail(ClaudeError),
    Slow(Duration, Value),
}

#[derive(Default)]
struct FakeLlm {
    replies: Mutex<VecDeque<Reply>>,
    seen: Mutex<Vec<MessagesRequest>>,
}

impl FakeLlm {
    fn new(replies: Vec<Reply>) -> Self {
        FakeLlm {
            replies: Mutex::new(replies.into()),
            seen: Mutex::default(),
        }
    }
}

fn response(text: String) -> MessagesResponse {
    MessagesResponse {
        id: "msg_1".into(),
        model: "fake".into(),
        content: vec![ContentBlock::text(text)],
        stop_reason: Some("end_turn".into()),
        usage: Usage::default(),
    }
}

#[async_trait]
impl LlmApi for FakeLlm {
    async fn create(&self, req: &MessagesRequest) -> Result<MessagesResponse, ClaudeError> {
        self.seen.lock().unwrap().push(req.clone());
        let next = self.replies.lock().unwrap().pop_front();
        match next {
            Some(Reply::Json(v)) => Ok(response(v.to_string())),
            Some(Reply::Text(t)) => Ok(response(t)),
            Some(Reply::Fail(e)) => Err(e),
            Some(Reply::Slow(d, v)) => {
                tokio::time::sleep(d).await;
                Ok(response(v.to_string()))
            }
            None => Err(ClaudeError::BadRequest("not scripted".into())),
        }
    }

    async fn stream(
        &self,
        _req: &MessagesRequest,
    ) -> Result<BoxStream<'static, Result<StreamEvent, ClaudeError>>, ClaudeError> {
        Err(ClaudeError::BadRequest("the Scribe never streams".into()))
    }
}

fn content_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../content")
}

fn scribe() -> Scribe {
    let cat = Catalog::load(&content_dir()).expect("content loads");
    Scribe::from_catalog(&cat, "fast-model").expect("scribe prompt present")
}

fn hld() -> Board {
    serde_json::from_value(json!({
        "schema": "ir.board.v1",
        "round": {"id": "s1", "type": "hld", "question_id": null, "language": null},
        "rev": 2, "size": {"w": 64, "h": 40},
        "brief": {"question": "Design a ticketing system", "lines": []},
        "items": [
            {"id": "n1", "kind": "component", "type": "api_gateway", "label": "API", "x": 2, "y": 2, "w": 8, "h": 5},
            {"id": "n2", "kind": "component", "type": "blank", "label": null, "x": 20, "y": 2, "w": 8, "h": 5}
        ],
        "edges": [],
        "code": null, "meeting": null, "focus": "n2", "ghosts": [], "op_ids": ["o1", "o2"]
    }))
    .unwrap()
}

fn input<'a>(board: &'a Board, utterances: &'a [String]) -> ScribeInput<'a> {
    ScribeInput {
        round_type: "system_design",
        board,
        utterances,
        call_no: 7,
    }
}

fn ops(ghosts: &[GhostOp]) -> Vec<(&str, &str)> {
    ghosts
        .iter()
        .map(|g| (g.op.as_str(), g.op_id.as_str()))
        .collect()
}

#[tokio::test]
async fn scribe_drops_ops_beyond_three() {
    let board = hld();
    let said = vec![
        "call that the booking service, it's stateless, it talks to Postgres and Redis".to_string(),
    ];
    let llm = FakeLlm::new(vec![Reply::Json(json!({"confidence": 0.9, "ops": [
        {"op": "item.label", "args": {"id": "n2", "text": "Booking service"}},
        {"op": "item.note.add", "args": {"id": "n2", "text": "stateless"}},
        {"op": "item.create", "args": {"id": "x7_1", "kind": "component", "type": "db", "label": "Postgres", "x": 32, "y": 2, "w": 8, "h": 5}},
        {"op": "item.create", "args": {"id": "x7_2", "kind": "component", "type": "cache", "label": "Redis", "x": 44, "y": 2, "w": 8, "h": 5}},
        {"op": "edge.create", "args": {"id": "x7_3", "from": "n2", "to": "x7_1", "dir": "->", "label": null, "rel": null}}
    ]}))]);
    let ghosts = scribe().suggest(&llm, &input(&board, &said)).await;
    assert_eq!(
        ops(&ghosts),
        [
            ("item.label", "sc7.1"),
            ("item.note.add", "sc7.2"),
            ("item.create", "sc7.3")
        ]
    );
    assert!(
        ghosts
            .iter()
            .all(|g| g.src == ir_server::board::Src::Scribe)
    );
}

#[tokio::test]
async fn scribe_rejects_unknown_item_ids() {
    let board = hld();
    let said = vec!["the API talks to a Postgres database".to_string()];
    let llm = FakeLlm::new(vec![Reply::Json(json!({"confidence": 0.8, "ops": [
        {"op": "item.label", "args": {"id": "n9", "text": "Postgres"}},
        {"op": "item.create", "args": {"id": "x7_1", "kind": "component", "type": "db", "label": "Postgres", "x": 32, "y": 2, "w": 8, "h": 5}},
        {"op": "edge.create", "args": {"id": "x7_2", "from": "n1", "to": "x7_1", "dir": "->", "label": null, "rel": null}},
        {"op": "edge.create", "args": {"id": "x7_3", "from": "n1", "to": "n42", "dir": "->", "label": null, "rel": null}}
    ]}))]);
    let ghosts = scribe().suggest(&llm, &input(&board, &said)).await;
    // n9 and n42 do not exist; the edge to the db created in the same answer is fine.
    assert_eq!(
        ops(&ghosts),
        [("item.create", "sc7.2"), ("edge.create", "sc7.3")]
    );
    assert_eq!(ghosts[1].args["to"], "x7_1");
}

#[tokio::test]
async fn scribe_drops_text_the_candidate_did_not_say() {
    let board = hld();
    let said = vec!["that one is the booking service".to_string()];
    let llm = FakeLlm::new(vec![Reply::Json(json!({"confidence": 0.9, "ops": [
        {"op": "item.label", "args": {"id": "n2", "text": "Booking service"}},
        {"op": "item.note.add", "args": {"id": "n2", "text": "idempotent retries"}},
        {"op": "item.set_type", "args": {"id": "n2", "type": "service"}},
        {"op": "item.create", "args": {"id": "x7_1", "kind": "component", "type": "queue", "label": "Kafka", "x": 32, "y": 2, "w": 8, "h": 5}}
    ]}))]);
    let ghosts = scribe().suggest(&llm, &input(&board, &said)).await;
    assert_eq!(
        ops(&ghosts),
        [("item.label", "sc7.1"), ("item.set_type", "sc7.3")]
    );
}

#[tokio::test]
async fn scribe_accepts_speech_recognition_variants_and_type_words() {
    let board = hld();
    let said = vec!["put a cash in front of it, a Redis cash".to_string()];
    let llm = FakeLlm::new(vec![Reply::Json(json!({"confidence": 0.7, "ops": [
        {"op": "item.create", "args": {"id": "x7_1", "kind": "component", "type": "cache", "label": "Redis cache", "x": 32, "y": 2, "w": 8, "h": 5}}
    ]}))]);
    let ghosts = scribe().suggest(&llm, &input(&board, &said)).await;
    assert_eq!(ghosts.len(), 1);
}

#[tokio::test]
async fn scribe_returns_nothing_on_timeout_error_or_garbage() {
    let board = hld();
    let said = vec!["call that the booking service".to_string()];
    let label = json!({"confidence": 0.9, "ops": [{"op": "item.label", "args": {"id": "n2", "text": "Booking service"}}]});
    let s = scribe().with_timeout(Duration::from_millis(100));

    let slow = FakeLlm::new(vec![Reply::Slow(Duration::from_secs(5), label.clone())]);
    let started = Instant::now();
    assert!(s.suggest(&slow, &input(&board, &said)).await.is_empty());
    assert!(started.elapsed() < Duration::from_secs(2));

    let failing = FakeLlm::new(vec![Reply::Fail(ClaudeError::Overloaded)]);
    assert!(s.suggest(&failing, &input(&board, &said)).await.is_empty());

    let garbage = FakeLlm::new(vec![Reply::Text("not json".into())]);
    assert!(s.suggest(&garbage, &input(&board, &said)).await.is_empty());

    let low = FakeLlm::new(vec![Reply::Json(
        json!({"confidence": 0.2, "ops": label["ops"]}),
    )]);
    assert!(
        s.suggest(&low, &input(&board, &said)).await.is_empty(),
        "very low confidence returns nothing"
    );
}

#[tokio::test]
async fn scribe_refuses_ops_outside_its_list() {
    let board = hld();
    let said = vec!["delete that and undo the last thing".to_string()];
    let llm = FakeLlm::new(vec![Reply::Json(json!({"confidence": 0.9, "ops": [
        {"op": "item.delete", "args": {"id": "n2"}},
        {"op": "undo", "args": {"target_op_id": "o2"}},
        {"op": "item.create", "args": {"id": "x7_1", "kind": "ink", "points": [[1, 1], [2, 2]], "recognized": null}}
    ]}))]);
    assert!(
        scribe()
            .suggest(&llm, &input(&board, &said))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn scribe_request_uses_fast_model_structured_output_and_the_prompt() {
    let mut board = hld();
    board.round.kit = ir_server::board::BoardKit::Pm;
    board.items.clear();
    board.focus = None;
    let said = vec![
        "first thing".to_string(),
        "north star is weekly listening minutes".to_string(),
    ];
    let llm = FakeLlm::new(vec![Reply::Json(json!({"confidence": 0.9, "ops": [
        {"op": "item.create", "args": {"id": "x7_1", "kind": "metric", "role": "north_star", "label": "Weekly listening minutes", "x": 2, "y": 2}}
    ]}))]);
    let inp = ScribeInput {
        round_type: "pm_execution",
        board: &board,
        utterances: &said,
        call_no: 7,
    };
    let ghosts = scribe().suggest(&llm, &inp).await;
    assert_eq!(ghosts.len(), 1);

    let req = llm.seen.lock().unwrap()[0].clone();
    assert_eq!(req.model, "fast-model");
    let body = serde_json::to_value(&req).unwrap();
    assert!(body.get("temperature").is_none());
    let format = &body["output_config"]["format"];
    assert_eq!(format["type"], "json_schema");
    assert_eq!(format["schema"]["additionalProperties"], false);
    let names: Vec<String> = format["schema"]["properties"]["ops"]["items"]["anyOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["properties"]["op"]["const"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        names,
        [
            "item.create",
            "item.label",
            "item.set_type",
            "edge.create",
            "edge.label",
            "sticky.set_quad"
        ]
    );
    assert!(!names.iter().any(|n| n == "undo" || n == "item.delete"));

    let prompt: String = req.system.iter().map(|b| b.text.as_str()).collect();
    assert!(prompt.contains("Round kit: pm\n"));
    assert!(prompt.contains("Round type: pm_execution\n"));
    assert!(prompt.contains("New ids start with: x7_\n"));
    assert!(prompt.contains("Focus: none\n"));
    assert!(prompt.contains("first thing\nnorth star is weekly listening minutes"));
    assert!(prompt.contains("Free positions: 2,2; "));
    assert!(!prompt.contains("{board_text}") && !prompt.contains("{utterances}"));
}

#[tokio::test]
async fn scribe_code_lines_are_marked_as_scribe() {
    let board: Board = serde_json::from_value(json!({
        "schema": "ir.board.v1",
        "round": {"id": "s1", "type": "coding", "question_id": null, "language": "python"},
        "rev": 1, "size": {"w": 64, "h": 40},
        "brief": {"question": "Two sum", "lines": []},
        "items": [], "edges": [],
        "code": {"language": "python", "lines": [{"id": "l1", "indent": 0, "text": "def two_sum(nums, target):", "src": "scribe"}],
                 "approach": [], "complexity": {"time": null, "space": null}, "trace": []},
        "meeting": null, "focus": null, "ghosts": [], "op_ids": ["o1"]
    }))
    .unwrap();
    let said = vec!["then seen equals an empty dictionary, and that's linear time".to_string()];
    let llm = FakeLlm::new(vec![Reply::Json(json!({"confidence": 0.9, "ops": [
        {"op": "code.insert", "args": {"line": {"id": "x7_1", "indent": 1, "text": "seen = {}", "src": "hand"}, "after": "l1"}},
        {"op": "code.complexity", "args": {"slot": "time", "value": "O(n)"}},
        {"op": "code.insert", "args": {"line": {"id": "x7_2", "indent": 1, "text": "return sorted(nums)", "src": "scribe"}, "after": "x7_1"}}
    ]}))]);
    let s = scribe();
    let inp = ScribeInput {
        round_type: "coding",
        board: &board,
        utterances: &said,
        call_no: 7,
    };
    let ghosts = s.suggest(&llm, &inp).await;
    assert_eq!(
        ops(&ghosts),
        [("code.insert", "sc7.1"), ("code.complexity", "sc7.2")]
    );
    assert_eq!(ghosts[0].args["line"]["src"], "scribe");

    // Ghosts go to the session and are applied when accepted.
    let mut session = BoardSession::new(board);
    session.set_ghosts(ghosts.clone());
    let accept = ir_server::board::BoardOp::from_ghost(&ghosts[0]);
    assert!(matches!(
        session.apply_client_op_at(accept, 3.0),
        ir_server::board::ApplyOutcome::Accepted { .. }
    ));
    assert_eq!(session.ghosts().len(), 1);
}

#[test]
fn scribe_call_numbers_never_reuse_a_prefix() {
    let mut board = hld();
    board.items.push(
        serde_json::from_value(json!({"id": "x1_1", "kind": "component", "type": "db", "label": null, "x": 1, "y": 30, "w": 8, "h": 5}))
            .unwrap(),
    );
    let mut session = BoardSession::new(board);
    assert_eq!(session.next_scribe_call(), 2, "x1_ is in use on the board");
    assert_eq!(session.next_scribe_call(), 3);
}

/// Real model call. Run with the key:
/// remote.sh <worktree> rust --env-file .secrets/llm-anthropic.env -- 'cd server && cargo test --test scribe live -- --ignored --nocapture'
#[tokio::test]
#[ignore]
async fn live_scribe_turns_an_utterance_into_ghosts() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("ir_server=debug"))
        .with_test_writer()
        .try_init();
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY");
    let ws = std::env::var("ANTHROPIC_WORKSPACE_ID").expect("ANTHROPIC_WORKSPACE_ID");
    let model = std::env::var("FAST_MODEL").unwrap_or_else(|_| "claude-opus-5-5".into());
    let client = ClaudeClient::with_base_url(&key, &ws, DEFAULT_BASE_URL);
    let cat = Catalog::load(&content_dir()).unwrap();
    let s = Scribe::from_catalog(&cat, &model).unwrap();
    let board = hld();
    let cases = [
        "so the API talks to a Postgres database where we keep the seats",
        "call that the booking service, it's stateless",
        "hmm, let me think about how many requests per second we expect",
    ];
    for (i, said) in cases.iter().enumerate() {
        let said = vec![said.to_string()];
        let inp = ScribeInput {
            round_type: "system_design",
            board: &board,
            utterances: &said,
            call_no: i as u64 + 1,
        };
        let started = Instant::now();
        let ghosts = s
            .with_timeout(Duration::from_secs(20))
            .suggest(&client, &inp)
            .await;
        let ms = started.elapsed().as_millis();
        println!("[{model}] {ms} ms  \"{}\"", said[0]);
        for g in &ghosts {
            println!("    {} {} {}", g.op_id, g.op, g.args);
        }
        if ghosts.is_empty() {
            // Show what the model said (or the error), to tell "no ops" from a failed call.
            match ir_server::orchestrator::LlmApi::create(&client, &s.build_request(&inp)).await {
                Ok(r) => println!("    raw ({:?}): {}", r.stop_reason, r.text()),
                Err(e) => println!("    error: {e}"),
            }
        }
        if i == 2 {
            assert!(ghosts.is_empty(), "thinking out loud gives no ops");
        } else {
            assert!(!ghosts.is_empty(), "a board-worthy line gives ops");
        }
    }
}
