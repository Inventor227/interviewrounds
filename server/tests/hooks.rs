//! The hooks between the session socket, the live interviewer, the board engine, the Scribe and scoring:
//! playback confirms parked replies and only then runs their director call, board ops are applied and reach the
//! interviewer's note, the Scribe suggests ghosts after a confirmed answer, hints and socket drops are logged for
//! the report, and report progress goes out on the socket. Needs Postgres (remote.sh --pg).

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::live::{self, Next, Options, Ws, frame_of, hello, send, short_req};
use ir_server::scoring::ReportEvents;
use ir_server::ws::SocketReportEvents;
use serde_json::{Value, json};
use uuid::Uuid;

const WAIT: Duration = Duration::from_secs(4);

async fn new_session(app: &live::TestApp) -> (String, String, String) {
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fake")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    (
        cookie,
        res.body["session_id"].as_str().unwrap().to_string(),
        res.body["client_token"].as_str().unwrap().to_string(),
    )
}

/// The next frame of type `t` whose payload passes `check`.
async fn frame_where(ws: &mut Ws, t: &str, check: impl Fn(&Value) -> bool) -> Value {
    let until = tokio::time::Instant::now() + WAIT;
    loop {
        let left = until.saturating_duration_since(tokio::time::Instant::now());
        match live::next(ws, left).await {
            Some(Next::Frame(f)) if f["t"] == t && check(&f["d"]) => return f,
            Some(Next::Frame(_)) => {}
            other => panic!("no {t} frame: {other:?}"),
        }
    }
}

async fn events(app: &live::TestApp, id: &str, kind: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "select data from session_events where session_id = $1 and kind = $2 order by id",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .bind(kind)
    .fetch_all(&app.state.db)
    .await
    .unwrap()
}

#[tokio::test]
async fn playback_commits_the_parked_reply_and_only_then_runs_its_director() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app).await;
    app.llm.director.lock().unwrap().extend([
        vec![],
        vec![
            json!({"type": "tool_use", "id": "toolu_d1", "name": "next_phase",
                    "input": {"from": "requirements"}}),
        ],
    ]);

    let mut ws = hello(&base, &id, &token, 0).await;
    // The problem is on the brief card before the interviewer says a word.
    let state = frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    assert_eq!(state["d"]["brief"]["question"], "Link shortener");
    assert_eq!(
        state["d"]["brief"]["lines"],
        json!(["100M new links a month", "Reads far outnumber writes"])
    );
    assert_eq!(state["d"]["phase_index"], 0);

    // A typed event is final: its director runs at once.
    assert_eq!(
        app.turn(&token, &id, "[event: start]").await.status,
        StatusCode::OK
    );
    live::eventually("the opener's director", WAIT, || async {
        app.llm.director_calls() == 1
    })
    .await;

    // A reply to speech is parked until the browser hears it; no director call before that.
    let res = app
        .turn(&token, &id, "I would start with the requirements.")
        .await;
    assert_eq!(res.status, StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        app.llm.director_calls(),
        1,
        "nothing runs for an unplayed reply"
    );

    send(
        &mut ws,
        "voice.spoken",
        1,
        json!({"panelist_id": "p1", "text_prefix": "Hello there"}),
    )
    .await;
    // Its director moves the phase, which reaches the socket.
    frame_where(&mut ws, "round.state", |d| d["phase_index"] == 1).await;
    assert_eq!(app.llm.director_calls(), 2);
    // The repeat report does nothing.
    send(
        &mut ws,
        "voice.spoken",
        2,
        json!({"panelist_id": "p1", "text_prefix": "Hello there"}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(app.llm.director_calls(), 2);
}

#[tokio::test]
async fn board_ops_reach_the_interviewer_and_the_scribe_suggests_after_an_answer() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app).await;
    let uuid = Uuid::parse_str(&id).unwrap();
    *app.llm.scribe.lock().unwrap() = Some(
        r#"{"ops": [{"op": "item.create", "args": {"id": "{prefix}1", "kind": "component", "type": "cache",
            "label": "Redis", "x": 32, "y": 2, "w": 8, "h": 5}}], "confidence": 0.9}"#
            .into(),
    );
    let mut ws = hello(&base, &id, &token, 0).await;

    send(
        &mut ws,
        "board.op",
        1,
        json!({"op_id": "o1", "src": "hand", "op": "item.create",
               "args": {"id": "n1", "kind": "component", "type": "lb", "label": "API gateway",
                        "x": 4, "y": 18, "w": 8, "h": 5}}),
    )
    .await;
    let ack = frame_of(&mut ws, "board.ack", WAIT).await.expect("ack");
    assert_eq!(ack["d"], json!({"op_id": "o1", "rev": 1}));

    // An edge to an item that does not exist is rejected, logged as not accepted, and not acked.
    send(
        &mut ws,
        "board.op",
        2,
        json!({"op_id": "o2", "src": "hand", "op": "edge.create",
               "args": {"id": "e1", "from": "n1", "to": "n9"}}),
    )
    .await;
    let err = frame_of(&mut ws, "error", WAIT).await.expect("rejection");
    assert_eq!(err["d"]["code"], "op_rejected");
    assert_eq!(err["d"]["op_id"], "o2");
    let rows: Vec<(String, Option<bool>, Option<i64>)> = sqlx::query_as(
        "select op_id, accepted, rev from board_ops where session_id = $1 order by id",
    )
    .bind(uuid)
    .fetch_all(&app.state.db)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [
            ("o1".to_string(), Some(true), Some(1)),
            ("o2".to_string(), Some(false), None)
        ]
    );
    let (rev, summary): (i64, String) =
        sqlx::query_as("select rev, summary from boards where session_id = $1")
            .bind(uuid)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(rev, 1);
    assert!(summary.contains("API gateway"), "{summary}");

    send(&mut ws, "board.focus", 3, json!({"item_id": "n1"})).await;

    // The interviewer's next turn sees the board.
    assert_eq!(
        app.turn(&token, &id, "[event: start]").await.status,
        StatusCode::OK
    );
    let res = app
        .turn(
            &token,
            &id,
            "Then a Redis cache sits in front of the database.",
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let note: String = {
        let reqs = app.llm.requests.lock().unwrap();
        let last = reqs.last().expect("a live turn");
        serde_json::to_string(&last.messages).unwrap()
    };
    assert!(
        note.contains("Board update") && note.contains("API gateway"),
        "{note}"
    );
    assert!(
        app.llm.scribe_calls().is_empty(),
        "the Scribe waits for the answer to be final"
    );

    // Playback of the reply closes the answer: the Scribe runs with the focus and its suggestion arrives.
    send(
        &mut ws,
        "voice.spoken",
        4,
        json!({"panelist_id": "p1", "text_prefix": "Hello there"}),
    )
    .await;
    let ghosts = frame_where(&mut ws, "board.ghosts", |d| {
        d["ghosts"].as_array().is_some_and(|g| !g.is_empty())
    })
    .await;
    let ghost = ghosts["d"]["ghosts"][0].clone();
    assert_eq!(ghost["op"], "item.create");
    assert_eq!(ghost["src"], "scribe");
    assert_eq!(ghost["args"]["label"], "Redis");
    let calls = app.llm.scribe_calls();
    assert_eq!(calls.len(), 1);
    let prompt: Vec<&str> = calls[0].system.iter().map(|b| b.text.as_str()).collect();
    assert_eq!(prompt.len(), 2, "rules cached, session values per call");
    assert!(calls[0].system[0].cache_control.is_some());
    assert!(prompt[1].starts_with("This session\n"), "{}", prompt[1]);
    assert!(prompt[1].contains("Focus: n1\n"));
    assert!(prompt[1].contains("Then a Redis cache sits in front of the database."));

    // Dismissing it sends the new list and logs the op as not accepted.
    let op_id = ghost["op_id"].as_str().unwrap().to_string();
    send(&mut ws, "board.ghost_reject", 5, json!({"op_id": op_id})).await;
    frame_where(&mut ws, "board.ghosts", |d| d["ghosts"] == json!([])).await;
    let accepted: Option<bool> =
        sqlx::query_scalar("select accepted from board_ops where session_id = $1 and op_id = $2")
            .bind(uuid)
            .bind(&op_id)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(accepted, Some(false));
}

#[tokio::test]
async fn hints_and_socket_drops_are_logged_for_the_report() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app).await;
    app.llm.director.lock().unwrap().push_back(vec![json!(
        {"type": "tool_use", "id": "toolu_h1", "name": "give_hint", "input": {"level": 2}}
    )]);
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    assert_eq!(
        app.turn(&token, &id, "[event: start]").await.status,
        StatusCode::OK
    );
    live::eventually("hint logged", WAIT, || async {
        events(&app, &id, "hint").await.len() == 1
    })
    .await;
    let hint = &events(&app, &id, "hint").await[0];
    assert_eq!(hint["level"], 2);
    assert!(hint["at_ms"].is_u64());

    drop(ws);
    live::eventually("drop logged as a pause", WAIT, || async {
        events(&app, &id, "ui.event")
            .await
            .iter()
            .any(|e| e["kind"] == "pause" && e["reason"] == "disconnected")
    })
    .await;
    let _ws = hello(&base, &id, &token, 0).await;
    live::eventually("reconnect logged as a resume", WAIT, || async {
        events(&app, &id, "ui.event")
            .await
            .iter()
            .any(|e| e["kind"] == "resume" && e["reason"] == "reconnected")
    })
    .await;
}

#[tokio::test]
async fn report_progress_goes_out_on_the_socket_and_report_routes_check_the_owner() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app).await;
    let mut ws = hello(&base, &id, &token, 0).await;

    let events = SocketReportEvents(app.state.clone());
    events.progress(&id, "scoring", 30).await;
    events
        .card(
            &id,
            &json!({"one_line": "Clear scoping.", "top_strength": null, "top_fix": null}),
        )
        .await;
    events.failed(&id).await;
    let p = frame_where(&mut ws, "report.progress", |d| d["stage"] == "scoring").await;
    assert_eq!(p["d"]["pct"], 30);
    let card = frame_where(&mut ws, "report.progress", |d| d["stage"] == "card").await;
    assert_eq!(card["d"]["card"]["one_line"], "Clear scoping.");
    let failed = frame_of(&mut ws, "error", WAIT)
        .await
        .expect("report_failed");
    assert_eq!(failed["d"]["code"], "report_failed");

    // The report routes sit behind the identity layer: the owner is told the round is still running, anyone
    // else that it does not exist.
    let path = format!("/api/sessions/{id}/report");
    let res = app.call(Method::POST, &path, Some(&cookie), None).await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.body);
    let res = app.call(Method::GET, &path, Some(&cookie), None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    let other = app.guest().await;
    let res = app.call(Method::POST, &path, Some(&other), None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND, "{}", res.body);
}
