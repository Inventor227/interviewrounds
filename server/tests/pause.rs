//! Pause and the headset coming off: a paused round whose socket drops is held until its pause budget runs out
//! (a live one still ends after the offline window), the janitor follows the same rule, a long pause releases the
//! voices, and a resume from a pause makes new ones without using up a resume. Needs Postgres (remote.sh --pg).

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use chrono::{DateTime, Utc};
use common::live::{self, Options, Ws, frame_of, hello, send, short_req};
use ir_server::orchestrator::Turn;
use ir_server::persist;
use ir_server::ws::SessionTiming;
use serde_json::{Value, json};
use uuid::Uuid;

const WAIT: Duration = Duration::from_secs(3);

/// Short limits: a 400 ms offline window (the 3 minutes), a 10 minute pause budget unless a test shortens it.
fn timing() -> SessionTiming {
    SessionTiming {
        tick: Duration::from_millis(50),
        offline_limit: Duration::from_millis(400),
        hello_timeout: Duration::from_secs(2),
        closing_grace: Duration::from_millis(100),
        scoring_hold: Duration::from_millis(300),
        ..SessionTiming::default()
    }
}

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

async fn status(app: &live::TestApp, id: &str) -> (String, Option<String>) {
    sqlx::query_as("select status, ended_reason from sessions where id = $1")
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

/// Connects, then pauses the round (the headset came off) and waits until the server says paused.
async fn paused(base: &str, id: &str, token: &str, seq: u64) -> Ws {
    let mut ws = hello(base, id, token, 0).await;
    frame_of(&mut ws, "round.state", WAIT)
        .await
        .expect("round.state");
    send(
        &mut ws,
        "ui.event",
        seq,
        json!({"kind": "pause", "reason": "headset_removed"}),
    )
    .await;
    let until = tokio::time::Instant::now() + WAIT;
    loop {
        let left = until.saturating_duration_since(tokio::time::Instant::now());
        match live::next(&mut ws, left).await {
            Some(live::Next::Frame(f))
                if f["t"] == "round.state" && f["d"]["status"] == "paused" =>
            {
                break;
            }
            Some(live::Next::Frame(_)) => {}
            other => panic!("not paused: {other:?}"),
        }
    }
    ws
}

fn said_something(app: &live::TestApp, id: &str) -> impl std::future::Future<Output = ()> {
    let handle = app.state.registry.get(id).unwrap();
    async move {
        handle.lock().await.turns.push(Turn {
            speaker: "candidate".into(),
            text: "We shard by user id.".into(),
            at_ms: 500,
            interrupted: false,
            heard: None,
        });
    }
}

#[tokio::test]
async fn paused_socket_drop_holds_past_3_minutes() {
    let app = live::test_app(Options {
        timing: timing(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let ws = paused(&base, &id, &token, 1).await;
    drop(ws);
    // Three times the offline window: still held.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(status(&app, &id).await, ("paused".to_string(), None));
    assert!(app.state.registry.get(&id).is_some());
}

#[tokio::test]
async fn live_socket_drop_still_ends_at_3_minutes() {
    let app = live::test_app(Options {
        timing: timing(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    said_something(&app, &id).await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    drop(ws);
    live::eventually("ended after the offline window", WAIT, || async {
        status(&app, &id).await == ("scoring".to_string(), Some("disconnected".to_string()))
    })
    .await;
}

#[tokio::test]
async fn pause_budget_exhausted_ends_time_limit() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            pause_limit: Duration::from_millis(1200),
            ..timing()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    said_something(&app, &id).await;
    let ws = paused(&base, &id, &token, 1).await;
    drop(ws);
    // Past the offline window it is still held ...
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(status(&app, &id).await.0, "paused");
    // ... until the pause budget runs out: then it ends as a time limit, and is scored (they spoke).
    live::eventually("ended by the pause budget", WAIT, || async {
        status(&app, &id).await == ("scoring".to_string(), Some("time_limit".to_string()))
    })
    .await;
}

#[tokio::test]
async fn sweep_respects_pause_hold() {
    let app = live::test_app(Options {
        timing: timing(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let ws = paused(&base, &id, &token, 1).await;
    drop(ws);
    // Let the paused state reach the database, then forget the session as a restart would.
    live::eventually("paused saved", WAIT, || async {
        sqlx::query_scalar::<_, Option<f64>>(
            "select (live_state->>'elapsed_ms')::float8 from sessions where id = $1",
        )
        .bind(Uuid::parse_str(&id).unwrap())
        .fetch_one(&app.state.db)
        .await
        .unwrap()
        .is_some()
    })
    .await;
    app.state.registry.remove(&id);
    app.state.hubs.remove(&id);
    let uuid = Uuid::parse_str(&id).unwrap();
    // The socket went an hour ago, the round started two minutes ago: the pause budget is not used up.
    sqlx::query(
        "update sessions set last_socket_at = now() - interval '1 hour', \
                             started_at = now() - interval '2 minutes' where id = $1",
    )
    .bind(uuid)
    .execute(&app.state.db)
    .await
    .unwrap();
    persist::sweep_stale(&app.state).await.unwrap();
    assert_eq!(status(&app, &id).await, ("paused".to_string(), None));

    // Twenty minutes in, almost all of it paused: past the budget, it ends as a time limit.
    sqlx::query("update sessions set started_at = now() - interval '20 minutes' where id = $1")
        .bind(uuid)
        .execute(&app.state.db)
        .await
        .unwrap();
    persist::sweep_stale(&app.state).await.unwrap();
    let (st, reason) = status(&app, &id).await;
    assert_ne!(st, "paused");
    assert_eq!(reason.as_deref(), Some("time_limit"));
}

#[tokio::test]
async fn voices_released_after_45s_paused() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            voice_release: Duration::from_millis(300),
            ..timing()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fish").await;
    // Under the release time nothing happens to the voice.
    let ws = paused(&base, &id, &token, 1).await;
    assert!(
        app.fish_paths("POST")
            .await
            .iter()
            .all(|p| !p.ends_with("/end"))
    );
    // Past it, the Fish session is ended and marked so.
    live::eventually("voice released", WAIT, || async {
        app.fish_paths("POST")
            .await
            .iter()
            .any(|p| p == "/v1/agent/sessions/fish-1/end")
    })
    .await;
    let uuid = Uuid::parse_str(&id).unwrap();
    live::eventually("marked ended", WAIT, || async {
        let row = persist::fetch_session(&app.state.db, uuid)
            .await
            .unwrap()
            .unwrap();
        row.fish_entries().iter().all(|e| e.ended_at.is_some())
    })
    .await;
    assert_eq!(
        status(&app, &id).await.0,
        "paused",
        "the round itself is held"
    );
    drop(ws);

    // The round ends: the ledger bills the released voice at Fish's own duration (the fake reports 120 s).
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/end"),
            Some(&cookie),
            Some(json!({"reason": "user_ended"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED, "{}", res.body);
    live::eventually("Fish settled", WAIT, || async {
        sqlx::query_scalar::<_, bool>("select fish_usage_recorded from sessions where id = $1")
            .bind(uuid)
            .fetch_one(&app.state.db)
            .await
            .unwrap()
    })
    .await;
    let minutes: f64 = sqlx::query_scalar(
        "select coalesce(sum(minutes), 0)::float8 from usage_events where session_id = $1 and provider = 'fish'",
    )
    .bind(uuid)
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert!((minutes - 2.0).abs() < 1e-9, "{minutes}");
}

#[tokio::test]
async fn resume_after_release_mints_voices_without_counting() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            voice_release: Duration::from_millis(300),
            ..timing()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, mut token) = new_session(&app, "fish").await;
    let uuid = Uuid::parse_str(&id).unwrap();
    // Four pause and resume cycles, more than the 3 resumes a round gets after drops.
    for cycle in 0..4 {
        let ws = paused(&base, &id, &token, 1).await;
        if cycle == 0 {
            live::eventually("voice released", WAIT, || async {
                app.fish_paths("POST")
                    .await
                    .iter()
                    .any(|p| p.ends_with("/end"))
            })
            .await;
        }
        // The socket is still connected: a resume from a pause works anyway.
        let res = app
            .call(
                Method::POST,
                &format!("/api/sessions/{id}/resume"),
                Some(&cookie),
                None,
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "cycle {cycle}: {}", res.body);
        assert_eq!(res.body["panel"][0]["voice"]["transport"], "fish");
        token = res.body["client_token"].as_str().unwrap().to_string();
        drop(ws);
    }
    let (count, st): (i32, String) =
        sqlx::query_as("select resume_count, status from sessions where id = $1")
            .bind(uuid)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(count, 0, "resumes from a pause are not counted");
    assert_eq!(st, "live");
    // New voices were made (one per resume) on top of the first.
    let mints = app.fish_calls("POST", "/v1/agent/sessions").await.len();
    assert_eq!(mints, 5, "the first voice and one per resume");
}

#[tokio::test]
async fn me_resumable_expires_at_for_paused_round() {
    let app = live::test_app(Options {
        timing: timing(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fake").await;
    let ws = paused(&base, &id, &token, 1).await;
    drop(ws);
    tokio::time::sleep(Duration::from_millis(600)).await;
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    let r: &Value = &me.body["resumable"];
    assert_eq!(r["session_id"], id, "{}", me.body);
    let expires: DateTime<Utc> = r["expires_at"].as_str().unwrap().parse().unwrap();
    // The pause budget (10 minutes, almost all left), not the 400 ms offline window.
    let left = expires - Utc::now();
    assert!(
        left > chrono::Duration::seconds(500) && left <= chrono::Duration::seconds(600),
        "{left:?}"
    );
}
