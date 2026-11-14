//! The session socket: hello and close codes, acks and dedupe per client token, replay by server seq, the round
//! clock and time checks, and ending a round whose browser is gone. Needs Postgres (remote.sh --pg).

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::live::{self, Next, Options, frame_of, hello, send, short_req};
use ir_server::orchestrator::Turn;
use ir_server::ws::SessionTiming;
use serde_json::{Value, json};
use uuid::Uuid;

const WAIT: Duration = Duration::from_secs(3);

async fn new_session(app: &live::TestApp, voice: &str) -> (String, String, String) {
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req(voice)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    (
        cookie,
        res.body["session_id"].as_str().unwrap().to_string(),
        res.body["client_token"].as_str().unwrap().to_string(),
    )
}

fn op(op_id: &str) -> Value {
    json!({"op_id": op_id, "rev_base": 0, "src": "hand", "op": "item.create",
           "args": {"id": op_id, "kind": "component", "type": "service", "label": "API",
                    "x": 4, "y": 18, "w": 8, "h": 5}, "at_ms": 1200})
}

#[tokio::test]
async fn ws_rejects_bad_hellos_with_close_codes() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;

    let mut ws = hello(&base, &Uuid::new_v4().to_string(), &token, 0).await;
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(4404));
    let mut ws = hello(&base, "not-a-uuid", &token, 0).await;
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(4404));
    let mut ws = hello(&base, &id, &"0".repeat(64), 0).await;
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(4401));
    // The first frame must be hello.
    let mut ws = live::connect(&base, &id).await;
    send(&mut ws, "ping", 0, json!({})).await;
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(4401));
}

#[tokio::test]
async fn ws_acks_and_persists_board_op() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let uuid = Uuid::parse_str(&id).unwrap();

    let mut ws = hello(&base, &id, &token, 0).await;
    // A snapshot right after hello; the round has started.
    let state = frame_of(&mut ws, "round.state", WAIT)
        .await
        .expect("round.state");
    assert_eq!(state["seq"], 0);
    assert_eq!(state["d"]["status"], "live");
    assert_eq!(state["d"]["time_check_due"], false);
    assert_eq!(state["d"]["phases"][1]["uses_whiteboard"], true);
    let (status, started): (String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("select status, started_at from sessions where id = $1")
            .bind(uuid)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(status, "live");
    assert!(started.is_some());

    send(&mut ws, "board.op", 1, op("op-a")).await;
    let ack = frame_of(&mut ws, "board.ack", WAIT)
        .await
        .expect("board.ack");
    assert_eq!(ack["d"], json!({"op_id": "op-a", "rev": 1}));
    assert!(
        ack["seq"].as_u64().unwrap() >= 1,
        "acks are numbered: {ack}"
    );
    assert_eq!(ack["ack"], 1);

    let row: (String, Option<bool>, Option<i64>, Option<i64>, Value) = sqlx::query_as(
        "select src, accepted, rev, t_ms, args from board_ops where session_id = $1 and op_id = 'op-a'",
    )
    .bind(uuid)
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(row.0, "hand");
    assert_eq!(row.1, Some(true), "applied by the board engine");
    assert_eq!(row.2, Some(1));
    assert!(row.3.is_some());
    assert_eq!(row.4["label"], "API");

    // The same frame again (same seq) and the same op under a new seq: neither is stored or acked twice.
    send(&mut ws, "board.op", 1, op("op-a")).await;
    send(&mut ws, "board.op", 2, op("op-a")).await;
    send(&mut ws, "board.op", 3, op("op-b")).await;
    let ack = frame_of(&mut ws, "board.ack", WAIT)
        .await
        .expect("second ack");
    assert_eq!(ack["d"], json!({"op_id": "op-b", "rev": 2}));
    assert_eq!(ack["ack"], 3);
    let n: i64 = sqlx::query_scalar("select count(*) from board_ops where session_id = $1")
        .bind(uuid)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(n, 2);

    // Other frames are stored too; an op without op_id is answered and not stored.
    send(
        &mut ws,
        "transcript.mark",
        4,
        json!({"segment_id": "s1", "panelist_id": "p1",
        "first_at_ms": 100, "final_at_ms": 900, "text": "hello"}),
    )
    .await;
    send(
        &mut ws,
        "head.samples",
        5,
        json!({"samples": [
        {"t_ms": 0, "yaw": 1.0, "pitch": 0.0, "speaking": true, "target": "p1"},
        {"t_ms": 200, "yaw": 2.0, "pitch": 0.0, "speaking": true, "target": "p1"}]}),
    )
    .await;
    send(
        &mut ws,
        "voice.state",
        6,
        json!({"panelist_id": "p1", "mode": "speaking", "at_ms": 5000,
        "latency": {"user_final_at_ms": 3000, "thinking_at_ms": 3400, "first_text_at_ms": 4300}}),
    )
    .await;
    send(
        &mut ws,
        "board.op",
        7,
        json!({"src": "hand", "op": "item.create"}),
    )
    .await;
    let err = frame_of(&mut ws, "error", WAIT).await.expect("error frame");
    assert_eq!(err["d"]["code"], "op_rejected");
    send(&mut ws, "ping", 0, json!({})).await;
    let pong = frame_of(&mut ws, "pong", WAIT).await.expect("pong");
    assert_eq!(pong["seq"], 0);
    assert_eq!(pong["ack"], 7);
    let counts: (i64, i64, i64) = sqlx::query_as(
        "select (select count(*) from marks), (select count(*) from head_batches), \
                (select count(*) from session_events where kind = 'voice.state' and data ? 'latency')",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(counts, (1, 1, 1));
    // The processed record is kept per token.
    live::eventually("client seq saved", WAIT, || async {
        let seq: i64 = sqlx::query_scalar("select last_client_seq from session_tokens")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
        seq == 7
    })
    .await;
}

#[tokio::test]
async fn ws_resume_replays_from_last_seq() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fake").await;

    let mut ws = hello(&base, &id, &token, 0).await;
    send(&mut ws, "board.op", 1, op("op-1")).await;
    let a1 = frame_of(&mut ws, "board.ack", WAIT).await.unwrap();
    send(&mut ws, "board.op", 2, op("op-2")).await;
    let a2 = frame_of(&mut ws, "board.ack", WAIT).await.unwrap();
    let (s1, s2) = (a1["seq"].as_u64().unwrap(), a2["seq"].as_u64().unwrap());
    assert!(s2 > s1);
    drop(ws);

    // Same token, saw up to s1: the server replays from s1 + 1 and remembers what it processed.
    let mut ws = hello(&base, &id, &token, s1).await;
    let replay = frame_of(&mut ws, "board.ack", WAIT)
        .await
        .expect("replayed ack");
    assert_eq!(replay["seq"].as_u64().unwrap(), s2);
    assert_eq!(replay["d"]["op_id"], "op-2");
    assert_eq!(replay["ack"], 2);
    // The client replays its unacked frame; it is a duplicate for this token.
    send(&mut ws, "board.op", 2, op("op-2")).await;
    send(&mut ws, "ping", 0, json!({})).await;
    loop {
        match live::next(&mut ws, WAIT).await.expect("frames") {
            Next::Frame(f) if f["t"] == "pong" => break,
            Next::Frame(f) => assert_ne!(f["t"], "board.ack", "duplicate acked again: {f}"),
            Next::Closed(c) => panic!("closed {c:?}"),
        }
    }

    // A reloaded page resumes: the old token is closed with 4401, the new one starts its count at 1 and gets
    // the whole buffer replayed.
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/resume"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let new_token = res.body["client_token"].as_str().unwrap().to_string();
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(4401));

    let mut ws = hello(&base, &id, &new_token, 0).await;
    let first = frame_of(&mut ws, "board.ack", WAIT).await.unwrap();
    assert_eq!(first["seq"].as_u64().unwrap(), s1);
    assert_eq!(first["ack"], 0, "a fresh record for the new token");
    let second = frame_of(&mut ws, "board.ack", WAIT).await.unwrap();
    assert_eq!(second["seq"].as_u64().unwrap(), s2);
    send(&mut ws, "board.op", 1, op("op-3")).await;
    let a3 = frame_of(&mut ws, "board.ack", WAIT).await.unwrap();
    assert_eq!(a3["d"], json!({"op_id": "op-3", "rev": 3}));
    assert_eq!(a3["ack"], 1);
    assert!(a3["seq"].as_u64().unwrap() > s2);

    // The old token cannot come back.
    let mut old = hello(&base, &id, &token, 0).await;
    assert_eq!(live::close_code(&mut old, WAIT).await, Some(4401));
}

fn quick() -> SessionTiming {
    SessionTiming {
        tick: Duration::from_millis(50),
        offline_limit: Duration::from_millis(400),
        start_limit: Duration::from_secs(600),
        hello_timeout: Duration::from_secs(2),
        closing_grace: Duration::from_millis(100),
        ending_limit: Duration::from_secs(20),
        pause_limit: Duration::from_secs(600),
        scoring_hold: Duration::from_millis(300),
        read_timeout: Duration::from_secs(45),
        janitor: Duration::from_secs(60),
        voice_release: Duration::from_secs(45),
        outgoing_voice_grace: Duration::from_secs(15),
    }
}

#[tokio::test]
async fn abandoned_after_3_minutes_offline() {
    // The 3 minute limit, shortened.
    let app = live::test_app(Options {
        timing: quick(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;

    // A round where the candidate never spoke: abandoned.
    let (_, quiet, quiet_token) = new_session(&app, "fake").await;
    // A round with an answer: scored as far as it went.
    let (_, spoke, spoke_token) = new_session(&app, "fish").await;
    {
        let handle = app.state.registry.get(&spoke).unwrap();
        handle.lock().await.turns.push(Turn {
            speaker: "candidate".into(),
            text: "We shard by user id.".into(),
            at_ms: 500,
            interrupted: false,
            heard: None,
        });
    }
    for (id, token) in [(&quiet, &quiet_token), (&spoke, &spoke_token)] {
        let mut ws = hello(&base, id, token, 0).await;
        frame_of(&mut ws, "round.state", WAIT)
            .await
            .expect("connected");
        drop(ws);
    }
    // Still within the window right after the drop.
    let status = |id: String| {
        let db = app.state.db.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>)>(
                "select status, ended_reason from sessions where id = $1",
            )
            .bind(Uuid::parse_str(&id).unwrap())
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    assert_eq!(status(quiet.clone()).await.0, "live");

    live::eventually("both rounds ended", Duration::from_secs(5), || async {
        status(quiet.clone()).await.0 != "live" && status(spoke.clone()).await.0 != "live"
    })
    .await;
    assert_eq!(
        status(quiet.clone()).await,
        ("abandoned".into(), Some("disconnected".into()))
    );
    assert_eq!(
        status(spoke.clone()).await,
        ("scoring".into(), Some("disconnected".into()))
    );
    // The turn made it to the database, and the ended session refuses sockets with 4409.
    let n: i64 =
        sqlx::query_scalar("select count(*) from turns where session_id = $1 and speaker = 'user'")
            .bind(Uuid::parse_str(&spoke).unwrap())
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(n, 1);
    let mut ws = hello(&base, &spoke, &spoke_token, 0).await;
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(4409));
    assert!(app.state.registry.get(&spoke).is_none());
    // Its Fish minutes were settled.
    live::eventually("Fish settled", WAIT, || async {
        let n: i64 =
            sqlx::query_scalar("select count(*) from usage_events where provider = 'fish'")
                .fetch_one(&app.state.db)
                .await
                .unwrap();
        n == 1
    })
    .await;
}

#[tokio::test]
async fn ui_end_lets_the_interviewer_close_then_the_socket_waits_for_the_report() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            scoring_hold: Duration::from_secs(30),
            ..quick()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    // One answer, so the round goes to scoring.
    assert_eq!(
        app.turn(&token, &id, "I would cache the reads.")
            .await
            .status,
        StatusCode::OK
    );
    send(
        &mut ws,
        "ui.event",
        1,
        json!({"kind": "end", "reason": "headset_removed"}),
    )
    .await;

    // Still open: the goodbye turn is served.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        app.state.registry.get(&id).is_some(),
        "not ended before the closing line"
    );
    let res = app.turn(&token, &id, "[event: ending]").await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);

    // After the closing line the round ends with the reason the browser gave.
    let ended = frame_of(&mut ws, "round.ended", WAIT)
        .await
        .expect("round.ended");
    assert_eq!(ended["d"], json!({"reason": "headset_removed"}));
    let reason: Option<String> =
        sqlx::query_scalar("select ended_reason from sessions where id = $1")
            .bind(Uuid::parse_str(&id).unwrap())
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(reason.as_deref(), Some("headset_removed"));

    // The socket stays for the report; a reconnect during scoring is let in and replayed.
    drop(ws);
    let mut ws = hello(&base, &id, &token, 0).await;
    let replayed = frame_of(&mut ws, "round.ended", WAIT)
        .await
        .expect("replayed");
    assert_eq!(replayed["d"]["reason"], "headset_removed");
    assert!(
        ir_server::ws::send_to_session(
            &app.state,
            &id,
            "report.progress",
            json!({"stage": "scoring", "pct": 50})
        )
        .await
    );
    let progress = frame_of(&mut ws, "report.progress", WAIT)
        .await
        .expect("progress");
    assert_eq!(progress["d"]["pct"], 50);
    ir_server::ws::send_to_session(&app.state, &id, "report.ready", json!({"session_id": id}))
        .await;
    let ready = frame_of(&mut ws, "report.ready", WAIT)
        .await
        .expect("ready");
    assert!(ready["seq"].as_u64().unwrap() > 0);
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(4409));
    // The hub is gone: nobody to send to, and new sockets get 4409.
    live::eventually("hub closed", WAIT, || async {
        app.state.hubs.get(&id).is_none()
    })
    .await;
    let mut ws = hello(&base, &id, &token, 0).await;
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(4409));
}

#[tokio::test]
async fn ui_end_without_a_closing_line_ends_after_the_limit_and_post_end_wins() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            ending_limit: Duration::from_millis(400),
            ..quick()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let status = |id: String| {
        let db = app.state.db.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>)>(
                "select status, ended_reason from sessions where id = $1",
            )
            .bind(Uuid::parse_str(&id).unwrap())
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    // No goodbye arrives: ends after the limit with the ui.event's reason.
    let (_, a, token_a) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &a, &token_a, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    send(&mut ws, "ui.event", 1, json!({"kind": "end"})).await;
    let ended = frame_of(&mut ws, "round.ended", WAIT)
        .await
        .expect("round.ended");
    assert_eq!(ended["d"]["reason"], "user_ended");
    assert_eq!(status(a).await.1.as_deref(), Some("user_ended"));

    // POST /end during the goodbye ends it at once with its own reason.
    let (cookie, b, token_b) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &b, &token_b, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    send(&mut ws, "ui.event", 1, json!({"kind": "end"})).await;
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{b}/end"),
            Some(&cookie),
            Some(json!({"reason": "completed"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(status(b).await.1.as_deref(), Some("completed"));
}

#[tokio::test]
async fn a_frame_that_fails_to_save_is_not_acked_and_comes_back() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    sqlx::query("alter table marks rename to marks_away")
        .execute(&app.state.db)
        .await
        .unwrap();
    let mark = json!({"segment_id": "s1", "panelist_id": "p1", "first_at_ms": 1, "final_at_ms": 2, "text": "hi"});
    send(&mut ws, "transcript.mark", 1, mark.clone()).await;
    // Telemetry right behind it must not move the ack past the failed frame.
    send(
        &mut ws,
        "head.samples",
        2,
        json!({"samples": [{"t_ms": 0, "yaw": 0, "pitch": 0, "speaking": false, "target": "p1"}]}),
    )
    .await;
    let err = frame_of(&mut ws, "error", WAIT).await.expect("error frame");
    assert_eq!(err["d"]["code"], "server_error");
    assert_eq!(err["ack"], 0);
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(1011));
    let heads: i64 = sqlx::query_scalar("select count(*) from head_batches")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(heads, 0, "nothing after the failed frame was processed");

    // The client reconnects and replays it; now it is stored and acked.
    sqlx::query("alter table marks_away rename to marks")
        .execute(&app.state.db)
        .await
        .unwrap();
    let mut ws = hello(&base, &id, &token, 0).await;
    let snap = frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    assert_eq!(snap["ack"], 0);
    send(&mut ws, "transcript.mark", 1, mark).await;
    send(&mut ws, "ping", 0, json!({})).await;
    let pong = frame_of(&mut ws, "pong", WAIT).await.unwrap();
    assert_eq!(pong["ack"], 1);
    let marks: i64 = sqlx::query_scalar("select count(*) from marks")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(marks, 1);
}

#[tokio::test]
async fn a_long_pause_hits_the_wall_clock_ceiling() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            pause_limit: Duration::from_millis(500),
            ..quick()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fish").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    // Paused with the socket open (headset off): the round clock stops, the wall clock does not.
    send(&mut ws, "ui.event", 1, json!({"kind": "pause"})).await;
    let ended = frame_of(&mut ws, "round.ended", Duration::from_secs(4))
        .await
        .expect("ended by the ceiling");
    assert_eq!(ended["d"]["reason"], "time_limit");
    // Its Fish session is ended and billed.
    live::eventually("Fish settled", WAIT, || async {
        let n: i64 =
            sqlx::query_scalar("select count(*) from usage_events where provider = 'fish'")
                .fetch_one(&app.state.db)
                .await
                .unwrap();
        n == 1
    })
    .await;
    assert!(
        app.fish_paths("POST")
            .await
            .iter()
            .any(|p| p.ends_with("fish-1/end"))
    );
}

#[tokio::test]
async fn pause_stops_the_clock_and_time_check_is_flagged_once() {
    let mut catalog = live::fixture_catalog();
    // A first phase of 0.6 s.
    catalog
        .rounds
        .get_mut("sde.system_design.short")
        .unwrap()
        .phases[0]
        .minutes = 0.01;
    let app = live::test_app(Options {
        timing: quick(),
        catalog,
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;

    let mut flagged = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        if let Some(Next::Frame(f)) = live::next(&mut ws, Duration::from_millis(200)).await
            && f["t"] == "round.state"
        {
            assert_eq!(f["seq"], 0, "round.state is a snapshot");
            if f["d"]["time_check_due"] == true {
                flagged.push(f["d"]["phase_index"].clone());
            }
        }
    }
    assert_eq!(flagged, vec![json!(0)], "one time check for the boundary");

    // After [event: time_check] arrives, nothing is owed (a reconnect does not ask again).
    {
        let handle = app.state.registry.get(&id).unwrap();
        let mut st = handle.lock().await;
        let at_ms = st.elapsed_ms(std::time::Instant::now());
        st.turns.push(Turn {
            speaker: "app".into(),
            text: "[event: time_check]".into(),
            at_ms,
            interrupted: false,
            heard: None,
        });
    }
    drop(ws);
    let mut ws = hello(&base, &id, &token, 0).await;
    let snap = frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    assert_eq!(snap["d"]["time_check_due"], false);

    // Pause: the clock stops.
    send(&mut ws, "ui.event", 1, json!({"kind": "pause"})).await;
    let mut paused = None;
    while paused.is_none() {
        let f = frame_of(&mut ws, "round.state", WAIT).await.unwrap();
        if f["d"]["status"] == "paused" {
            paused = Some(f);
        }
    }
    let handle = app.state.registry.get(&id).unwrap();
    let before = handle.lock().await.elapsed_ms(std::time::Instant::now());
    tokio::time::sleep(Duration::from_millis(400)).await;
    let after = handle.lock().await.elapsed_ms(std::time::Instant::now());
    // Two durations are truncated to milliseconds separately, so a stopped clock can read 1 ms apart.
    assert!(after.abs_diff(before) <= 1, "{before} -> {after}");
    let db_status: String = sqlx::query_scalar("select status from sessions where id = $1")
        .bind(Uuid::parse_str(&id).unwrap())
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(db_status, "paused");
    send(&mut ws, "ui.event", 2, json!({"kind": "resume"})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(handle.lock().await.elapsed_ms(std::time::Instant::now()) > after);
}

#[tokio::test]
async fn me_offers_resume_after_a_drop() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fake").await;
    let me = |c: String| {
        let app = &app;
        async move { app.call(Method::GET, "/api/me", Some(&c), None).await.body }
    };
    // Not started yet: nothing to resume.
    assert!(me(cookie.clone()).await["resumable"].is_null());
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    // Connected: nothing to resume either.
    assert!(me(cookie.clone()).await["resumable"].is_null());
    drop(ws);
    let mut offer = Value::Null;
    for _ in 0..40 {
        offer = me(cookie.clone()).await["resumable"].clone();
        if !offer.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(offer["session_id"], id.as_str());
    assert_eq!(offer["round_title"], "System design");
    let expires: chrono::DateTime<chrono::Utc> =
        offer["expires_at"].as_str().unwrap().parse().unwrap();
    let left = expires - chrono::Utc::now();
    assert!(
        left > chrono::Duration::seconds(170) && left <= chrono::Duration::seconds(180),
        "{left}"
    );
}

#[tokio::test]
async fn voice_spoken_is_taken_and_acked() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    send(
        &mut ws,
        "voice.spoken",
        1,
        json!({"panelist_id": "p1", "text_prefix": "Hi, I'm Daniel. Let's"}),
    )
    .await;
    send(&mut ws, "ping", 0, json!({})).await;
    let pong = frame_of(&mut ws, "pong", WAIT).await.unwrap();
    assert_eq!(pong["ack"], 1);
}

#[tokio::test]
async fn board_focus_keeps_the_latest_item() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    let stored = || async {
        sqlx::query_scalar::<_, Option<String>>("select board_focus from sessions where id = $1")
            .bind(Uuid::parse_str(&id).unwrap())
            .fetch_one(&app.state.db)
            .await
            .unwrap()
    };
    for (seq, item) in [(1, json!("c1")), (2, json!("c2"))] {
        send(&mut ws, "board.focus", seq, json!({"item_id": item})).await;
    }
    send(&mut ws, "ping", 0, json!({})).await;
    assert_eq!(frame_of(&mut ws, "pong", WAIT).await.unwrap()["ack"], 2);
    assert_eq!(stored().await.as_deref(), Some("c2"));
    assert_eq!(
        app.state.hubs.get(&id).unwrap().focus().as_deref(),
        Some("c2")
    );
    send(&mut ws, "board.focus", 3, json!({"item_id": null})).await;
    send(&mut ws, "ping", 0, json!({})).await;
    assert_eq!(frame_of(&mut ws, "pong", WAIT).await.unwrap()["ack"], 3);
    assert_eq!(stored().await, None);
}

#[tokio::test]
async fn a_silent_client_is_closed_even_while_the_server_talks() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            read_timeout: Duration::from_millis(500),
            ..quick()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;

    // A client that pings stays connected well past the timeout, with round.state flowing every 50 ms.
    let mut ws = hello(&base, &id, &token, 0).await;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    while tokio::time::Instant::now() < deadline {
        send(&mut ws, "ping", 0, json!({})).await;
        frame_of(&mut ws, "pong", WAIT).await.expect("still open");
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    // A silent one is closed with 1001, although the server keeps sending to it.
    let started = std::time::Instant::now();
    let mut seen = 0;
    let code = loop {
        match live::next(&mut ws, WAIT).await.expect("closed in time") {
            Next::Frame(_) => seen += 1,
            Next::Closed(code) => break code,
        }
    };
    assert_eq!(code, Some(1001));
    assert!(seen > 3, "the server was sending meanwhile ({seen} frames)");
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn a_replay_burst_after_hello_is_not_refused() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    // 300 queued frames arrive at once after a reconnect: well above 60 a second, inside the opening burst.
    for seq in 1..=300u64 {
        send(
            &mut ws,
            "transcript.mark",
            seq,
            json!({"segment_id": format!("s{seq}"), "panelist_id": "p1",
            "first_at_ms": 1, "final_at_ms": 2, "text": "x"}),
        )
        .await;
    }
    send(&mut ws, "ping", 0, json!({})).await;
    let pong = frame_of(&mut ws, "pong", Duration::from_secs(10))
        .await
        .expect("not closed");
    assert_eq!(pong["ack"], 300);
    // Sending them all again (duplicates) costs nothing either.
    for seq in 1..=300u64 {
        send(
            &mut ws,
            "transcript.mark",
            seq,
            json!({"segment_id": format!("s{seq}")}),
        )
        .await;
    }
    send(&mut ws, "ping", 0, json!({})).await;
    assert!(
        frame_of(&mut ws, "pong", Duration::from_secs(10))
            .await
            .is_some()
    );
}

#[tokio::test]
async fn an_abandoned_round_closes_without_the_report_hold() {
    // The default 120 s hold applies only when a report is coming.
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/end"),
            Some(&cookie),
            Some(json!({"reason": "user_ended"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    frame_of(&mut ws, "round.ended", WAIT)
        .await
        .expect("round.ended");
    assert_eq!(live::close_code(&mut ws, WAIT).await, Some(4409));
}
