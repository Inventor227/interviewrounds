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
        focus: board.focus.as_deref(),
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
        focus: None,
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
        focus: None,
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
    board.op_ids.push("sc2.1".into());
    let mut session = BoardSession::new(board);
    session.record_rejected(
        &serde_json::from_value(json!({"op_id": "sc3.2", "src": "scribe", "op": "item.label", "args": {"id": "n2", "text": "A"}}))
            .unwrap(),
        1.0,
    );
    assert_eq!(
        session.next_scribe_call(),
        4,
        "x1_ is on the board, sc2.1 committed, sc3.2 logged"
    );
    assert_eq!(session.next_scribe_call(), 5);
}

/// Real model call; needs ANTHROPIC_API_KEY and ANTHROPIC_WORKSPACE_ID (FAST_MODEL optional).
/// `cargo test --test scribe live -- --ignored --nocapture`
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
            focus: Some("n2"),
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

async fn one_call(board: &Board, said: &str, reply: Value) -> Vec<GhostOp> {
    let said = vec![said.to_string()];
    let llm = FakeLlm::new(vec![Reply::Json(reply)]);
    scribe().suggest(&llm, &input(board, &said)).await
}

fn coding_board() -> Board {
    serde_json::from_value(json!({
        "schema": "ir.board.v1",
        "round": {"id": "s1", "type": "coding", "question_id": null, "language": "python"},
        "rev": 1, "size": {"w": 64, "h": 40},
        "brief": {"question": "Two sum", "lines": []},
        "items": [], "edges": [],
        "code": {"language": "python", "lines": [{"id": "l1", "indent": 0, "text": "def f(nums):", "src": "scribe"}],
                 "approach": [], "complexity": {"time": null, "space": null}, "trace": []},
        "meeting": null, "focus": null, "ghosts": [], "op_ids": []
    }))
    .unwrap()
}

#[tokio::test]
async fn scribe_checks_complexity_against_what_was_said() {
    let b = coding_board();
    let set = |v: &str| json!({"confidence": 0.9, "ops": [{"op": "code.complexity", "args": {"slot": "time", "value": v}}]});
    assert!(
        one_call(&b, "it's pretty fast", set("O(n log n)"))
            .await
            .is_empty()
    );
    assert_eq!(
        one_call(&b, "that's n log n overall", set("O(n log n)"))
            .await
            .len(),
        1
    );
    assert_eq!(
        one_call(&b, "the sort makes it linearithmic", set("O(n log n)"))
            .await
            .len(),
        1
    );
    assert_eq!(one_call(&b, "linear time", set("O(n)")).await.len(), 1);
    assert!(one_call(&b, "linear time", set("O(n^2)")).await.is_empty());
    assert_eq!(one_call(&b, "it's quadratic", set("O(n^2)")).await.len(), 1);
    assert_eq!(one_call(&b, "constant space", set("O(1)")).await.len(), 1);
}

#[tokio::test]
async fn scribe_checks_numbers_even_single_digits() {
    let b = hld();
    let note = |t: &str| json!({"confidence": 0.9, "ops": [{"op": "item.note.add", "args": {"id": "n2", "text": t}}]});
    assert!(
        one_call(&b, "it has a TTL of ten minutes", note("TTL 5 min"))
            .await
            .is_empty()
    );
    assert_eq!(
        one_call(&b, "it has a TTL of five minutes", note("TTL 5 min"))
            .await
            .len(),
        1
    );
    assert!(
        one_call(&b, "we run a few replicas", note("3 replicas"))
            .await
            .is_empty()
    );
    assert!(
        one_call(&b, "about a thousand QPS", note("100 QPS"))
            .await
            .is_empty(),
        "100 is not 1000"
    );

    let code = coding_board();
    let line = |t: &str| {
        json!({"confidence": 0.9, "ops": [{"op": "code.insert",
        "args": {"line": {"id": "x7_1", "indent": 1, "text": t, "src": "scribe"}, "after": "l1"}}]})
    };
    assert!(
        one_call(&code, "for i in range ten", line("for i in range(5):"))
            .await
            .is_empty()
    );
    assert_eq!(
        one_call(&code, "for i in range ten", line("for i in range(10):"))
            .await
            .len(),
        1
    );
}

#[tokio::test]
async fn scribe_new_stickies_have_no_votes_or_quadrant_and_ids_need_the_prefix() {
    let mut b = hld();
    b.round.kit = ir_server::board::BoardKit::Pm;
    let ghosts = one_call(&b, "a pain point: deposits get lost", json!({"confidence": 0.9, "ops": [
        {"op": "item.create", "args": {"id": "x7_1", "kind": "sticky", "lane": "pain", "text": "Deposits get lost",
            "votes": 3, "quad": "tl", "x": 30, "y": 20}},
        {"op": "item.create", "args": {"id": "s9", "kind": "sticky", "lane": "pain", "text": "Deposits get lost",
            "votes": 0, "quad": null, "x": 40, "y": 20}}
    ]}))
    .await;
    assert_eq!(ghosts.len(), 1, "the id without the x7_ prefix is dropped");
    assert_eq!(ghosts[0].args["votes"], 0);
    assert_eq!(ghosts[0].args["quad"], Value::Null);
}

#[tokio::test]
async fn scribe_keeps_multiplicity_labels_and_uses_the_given_focus() {
    let lld: Board = serde_json::from_value(json!({
        "schema": "ir.board.v1",
        "round": {"id": "s1", "type": "lld", "question_id": null, "language": null},
        "rev": 1, "size": {"w": 64, "h": 40}, "brief": {"question": "Parking lot", "lines": []},
        "items": [
            {"id": "c1", "kind": "class", "label": "Level", "class_kind": "class", "fields": [], "methods": [], "x": 2, "y": 2, "w": 14, "h": 10},
            {"id": "c2", "kind": "class", "label": "Spot", "class_kind": "class", "fields": [], "methods": [], "x": 30, "y": 2, "w": 14, "h": 10}
        ],
        "edges": [], "code": null, "meeting": null, "focus": null, "ghosts": [], "op_ids": []
    }))
    .unwrap();
    let said = vec!["each level has many spots".to_string()];
    let llm = FakeLlm::new(vec![Reply::Json(json!({"confidence": 0.9, "ops": [
        {"op": "edge.create", "args": {"id": "x7_1", "from": "c1", "to": "c2", "dir": "->", "label": "1..*", "rel": "has_a"}}
    ]}))]);
    let inp = ScribeInput {
        round_type: "system_design",
        board: &lld,
        focus: Some("c2"),
        utterances: &said,
        call_no: 7,
    };
    assert_eq!(scribe().suggest(&llm, &inp).await.len(), 1);
    let prompt: String = llm.seen.lock().unwrap()[0]
        .system
        .iter()
        .map(|b| b.text.as_str())
        .collect();
    assert!(
        prompt.contains("Focus: c2\n"),
        "the caller's fresh focus, not the board's stored one"
    );

    let gone = ScribeInput {
        focus: Some("c9"),
        ..inp
    };
    assert!(
        scribe().prompt(&gone).contains("Focus: none\n"),
        "a focus on a missing item is dropped"
    );
}

#[tokio::test]
async fn scribe_numbers_must_be_said_even_in_long_texts() {
    let b = hld();
    let note = |t: &str| json!({"confidence": 0.9, "ops": [{"op": "item.note.add", "args": {"id": "n2", "text": t}}]});
    let text = "Cache user sessions with TTL 5 minutes";
    assert!(
        one_call(
            &b,
            "cache user sessions with a TTL of a few minutes",
            note(text)
        )
        .await
        .is_empty()
    );
    assert_eq!(
        one_call(
            &b,
            "cache user sessions with a TTL of five minutes",
            note(text)
        )
        .await
        .len(),
        1
    );
    // Complexity cue words are not numbers elsewhere.
    assert!(
        one_call(
            &b,
            "constant time lookup with a TTL of an hour",
            note("TTL 1 hour")
        )
        .await
        .is_empty()
    );
    // A bare number label is only notation on a class diagram.
    let edge = json!({"confidence": 0.9, "ops": [{"op": "edge.create",
        "args": {"id": "x7_1", "from": "n1", "to": "n2", "dir": "->", "label": "100"}}]});
    assert!(one_call(&b, "the gateway calls it", edge).await.is_empty());

    let code = coding_board();
    let line = json!({"confidence": 0.9, "ops": [{"op": "code.insert",
        "args": {"line": {"id": "x7_1", "indent": 1, "text": "for i in range(5, len(nums)):", "src": "scribe"}, "after": "l1"}}]});
    assert!(
        one_call(&code, "for i in range len nums", line)
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn scribe_quadrants_and_cleared_slots_need_to_be_asked_for() {
    let mut b = hld();
    b.round.kit = ir_server::board::BoardKit::Pm;
    b.items.push(
        serde_json::from_value(
            json!({"id": "s1", "kind": "sticky", "lane": "idea", "text": "Verified listings",
            "votes": 0, "quad": null, "x": 30, "y": 20}),
        )
        .unwrap(),
    );
    let quad = json!({"confidence": 0.9, "ops": [{"op": "sticky.set_quad", "args": {"id": "s1", "quad": "tl"}}]});
    assert!(
        one_call(&b, "verified listings would help", quad.clone())
            .await
            .is_empty()
    );
    assert_eq!(
        one_call(&b, "verified listings is high impact and low effort", quad)
            .await
            .len(),
        1
    );

    let code = coding_board();
    let clear = json!({"confidence": 0.9, "ops": [{"op": "code.complexity", "args": {"slot": "time", "value": null}}]});
    assert!(
        one_call(&code, "let me think about time", clear.clone())
            .await
            .is_empty()
    );
    assert_eq!(one_call(&code, "clear the time slot", clear).await.len(), 1);
}

#[tokio::test]
async fn scribe_retries_once_on_the_fallback_model_then_skips() {
    let board = hld();
    let said = vec!["call that the booking service".to_string()];
    let mut s = scribe();
    s.fallback_model = Some("claude-haiku-5-5".into());
    // Overloaded, then the fallback answers.
    let llm = FakeLlm::new(vec![
        Reply::Fail(ClaudeError::Overloaded),
        Reply::Json(json!({"confidence": 0.9, "ops": [
            {"op": "item.label", "args": {"id": "n2", "text": "Booking service"}}
        ]})),
    ]);
    let ghosts = s.suggest(&llm, &input(&board, &said)).await;
    assert_eq!(ghosts.len(), 1);
    let seen = llm.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].model, "fast-model");
    assert_eq!(seen[1].model, "claude-haiku-5-5");
    // Both down: one try each, then nothing (silently).
    let llm = FakeLlm::new(vec![
        Reply::Fail(ClaudeError::Overloaded),
        Reply::Fail(ClaudeError::Overloaded),
        Reply::Json(json!({"confidence": 0.9, "ops": []})),
    ]);
    assert!(s.suggest(&llm, &input(&board, &said)).await.is_empty());
    assert_eq!(llm.seen.lock().unwrap().len(), 2);
    // A bad request is not retried.
    let llm = FakeLlm::new(vec![Reply::Fail(ClaudeError::BadRequest("x".into()))]);
    assert!(s.suggest(&llm, &input(&board, &said)).await.is_empty());
    assert_eq!(llm.seen.lock().unwrap().len(), 1);
}

fn pm_board() -> Board {
    let mut b = hld();
    b.round.kit = ir_server::board::BoardKit::Pm;
    b.items.clear();
    b.focus = None;
    b
}

fn xy(g: &GhostOp) -> (f64, f64) {
    (g.args["x"].as_f64().unwrap(), g.args["y"].as_f64().unwrap())
}

/// Two Scribe calls in a row while the first one's suggestion is still pending: the second never lands on it, not
/// when the model takes the free positions it is given, and not when it ignores them.
#[tokio::test]
async fn a_second_scribe_call_never_stacks_its_suggestion_on_a_pending_one() {
    let mut session = BoardSession::new(pm_board());
    let said = |s: &str| vec![s.to_string()];
    let sticky = |id: &str, text: &str| {
        json!({"confidence": 0.9, "ops": [
            {"op": "item.create", "args": {"id": id, "kind": "sticky", "lane": "pain", "text": text,
                "votes": 0, "quad": null, "x": 2, "y": 2}}
        ]})
    };

    // Call 1: a sticky at the first free position.
    let call = session.next_scribe_call();
    let llm = FakeLlm::new(vec![Reply::Json(sticky(
        &format!("x{call}_1"),
        "Deposits get lost",
    ))]);
    let u1 = said("a pain point: deposits get lost");
    let board = session.board.clone();
    let first = scribe()
        .suggest(
            &llm,
            &ScribeInput {
                round_type: "pm_product_sense",
                board: &board,
                focus: None,
                utterances: &u1,
                call_no: call,
            },
        )
        .await;
    assert_eq!(first.len(), 1);
    assert_eq!(xy(&first[0]), (2.0, 2.0));
    session.push_ghosts(first);

    // Call 2 while it is pending: its free positions skip the pending sticky ...
    let call = session.next_scribe_call();
    let llm = FakeLlm::new(vec![Reply::Json(sticky(&format!("x{call}_1"), "Scams"))]);
    let u2 = said("another pain point: scams");
    let board = session.board.clone();
    let second = scribe()
        .suggest(
            &llm,
            &ScribeInput {
                round_type: "pm_product_sense",
                board: &board,
                focus: None,
                utterances: &u2,
                call_no: call,
            },
        )
        .await;
    let prompt: String = llm.seen.lock().unwrap()[0]
        .system
        .iter()
        .map(|b| b.text.as_str())
        .collect();
    assert!(!prompt.contains("Free positions: 2,2;"), "{prompt}");
    // ... and its sticky, placed at (2,2) anyway, moves to the first free one.
    assert_eq!(second.len(), 1);
    let (x, y) = xy(&second[0]);
    assert!(
        x >= 2.0 + 7.0 || y >= 2.0 + 7.0,
        "moved off the pending sticky: {x},{y}"
    );
    session.push_ghosts(second);
    let at: Vec<(f64, f64)> = session.ghosts().iter().map(xy).collect();
    assert_eq!(at.len(), 2);
    assert_ne!(at[0], at[1]);

    // The same when the board gains an item at that spot while the Scribe thinks: the live path re-places it.
    let mut b = pm_board();
    b.items.push(
        serde_json::from_value(
            json!({"id": "n1", "kind": "sticky", "lane": "user", "text": "Students", "votes": 0,
            "quad": null, "x": 2, "y": 2}),
        )
        .unwrap(),
    );
    let late = ir_server::scribe::unstack(
        &b,
        vec![GhostOp {
            op_id: "sc9.1".into(),
            src: ir_server::board::Src::Scribe,
            op: "item.create".into(),
            args: json!({"id": "x9_1", "kind": "sticky", "lane": "pain", "text": "Scams", "votes": 0, "quad": null, "x": 2, "y": 2}),
        }],
    );
    assert_ne!(xy(&late[0]), (2.0, 2.0));
}
