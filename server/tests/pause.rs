//! Pause and the headset coming off: a paused round whose socket drops is held until its pause budget runs out
//! (a live one still ends after the offline window), the janitor follows the same rule, a long pause releases the
//! voices, and a resume from a pause makes new ones without using up a resume. Needs Postgres (remote.sh --pg).

mod common;

use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use chrono::{DateTime, Utc};
use common::live::{self, Options, Ws, frame_of, hello, send, short_req};
use ir_server::orchestrator::Turn;
use ir_server::persist;
use ir_server::ws::{self, Release, SessionTiming};
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

async fn resume(app: &live::TestApp, cookie: &str, id: &str) -> live::Res {
    app.call(
        Method::POST,
        &format!("/api/sessions/{id}/resume"),
        Some(cookie),
        None,
    )
    .await
}

async fn end_called(app: &live::TestApp, fish_id: &str) -> bool {
    app.fish_paths("POST")
        .await
        .iter()
        .any(|p| *p == format!("/v1/agent/sessions/{fish_id}/end"))
}

async fn any_end(app: &live::TestApp) -> bool {
    app.fish_paths("POST")
        .await
        .iter()
        .any(|p| p.ends_with("/end"))
}

async fn marked_ended(app: &live::TestApp, id: &str, fish_id: &str) -> bool {
    persist::fetch_session(&app.state.db, Uuid::parse_str(id).unwrap())
        .await
        .unwrap()
        .unwrap()
        .fish_entries()
        .iter()
        .any(|e| e.fish_session_id == fish_id && e.ended_at.is_some())
}

/// The newest Fish session of the round.
async fn newest_fish(app: &live::TestApp, id: &str) -> String {
    persist::fetch_session(&app.state.db, Uuid::parse_str(id).unwrap())
        .await
        .unwrap()
        .unwrap()
        .fish_entries()
        .last()
        .unwrap()
        .fish_session_id
        .clone()
}

async fn round_ms(app: &live::TestApp, id: &str) -> u64 {
    let handle = app.state.registry.get(id).unwrap();
    let st = handle.lock().await;
    st.elapsed_ms(Instant::now())
}

/// Waits until the pause reached the database (status and snapshot).
async fn pause_saved(app: &live::TestApp, id: &str) {
    live::eventually("pause saved", WAIT, || async {
        sqlx::query_scalar::<_, bool>(
            "select status = 'paused' and coalesce((live_state->>'user_paused')::bool, false) \
               and live_state->>'paused_at' is not null from sessions where id = $1",
        )
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_one(&app.state.db)
        .await
        .unwrap()
    })
    .await;
}

/// A second process on the same database and Fish mock (a server restart).
async fn restarted(app: &live::TestApp, timing: SessionTiming) -> live::TestApp {
    let pool = ir_server::db::connect_url(&app.db_url).await.unwrap();
    let cfg = common::test_config(&app.db_url, &common::temp_dir("public"));
    let state = ir_server::AppState::new(pool, cfg)
        .with_catalog(live::fixture_catalog())
        .with_fish(ir_server::fish::FishClient::with_base_url(
            "k",
            &app.fish.uri(),
        ))
        .with_llm(app.llm.clone())
        .with_timing(timing);
    live::TestApp {
        router: ir_server::router(state.clone()),
        state,
        fish: live::fish_mock().await,
        llm: app.llm.clone(),
        db_url: app.db_url.clone(),
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

    // Fifteen minutes in with eight of round time: seven paused, under the budget, still held (wall time alone is
    // past it).
    sqlx::query(
        "update sessions set started_at = now() - interval '15 minutes', \
                live_state = jsonb_set(live_state, '{elapsed_ms}', '480000') where id = $1",
    )
    .bind(uuid)
    .execute(&app.state.db)
    .await
    .unwrap();
    persist::sweep_stale(&app.state).await.unwrap();
    assert_eq!(status(&app, &id).await, ("paused".to_string(), None));

    // Twenty minutes in with eight of round time: twelve paused, past the budget, it ends as a time limit.
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
            voice_release: Duration::from_millis(800),
            ..timing()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fish").await;
    // Under the release time nothing happens to the voice (well into it, many ticks).
    let ws = paused(&base, &id, &token, 1).await;
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert!(!any_end(&app).await, "released early");
    assert!(
        !app.state
            .hubs
            .get(&id)
            .unwrap()
            .voices_released
            .load(std::sync::atomic::Ordering::SeqCst)
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
    // The browser is told: `round.state` carries `voices_released`.
    let mut ws = ws;
    let until = tokio::time::Instant::now() + WAIT;
    loop {
        let left = until.saturating_duration_since(tokio::time::Instant::now());
        match live::next(&mut ws, left).await {
            Some(live::Next::Frame(f))
                if f["t"] == "round.state" && f["d"]["voices_released"] == true =>
            {
                break;
            }
            Some(live::Next::Frame(_)) => {}
            other => panic!("no voices_released in round.state: {other:?}"),
        }
    }
    // Released once: no second end while the pause goes on.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let ends = app
        .fish_paths("POST")
        .await
        .iter()
        .filter(|p| p.ends_with("/end"))
        .count();
    assert_eq!(ends, 1);
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

/// Short limits with room: a 1 s offline window.
fn roomy() -> SessionTiming {
    SessionTiming {
        offline_limit: Duration::from_millis(1000),
        ..timing()
    }
}

#[tokio::test]
async fn resume_after_long_paused_drop_stays_live() {
    let app = live::test_app(Options {
        timing: roomy(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fake").await;
    let ws = paused(&base, &id, &token, 1).await;
    drop(ws);
    // Gone longer than the offline window while paused: held.
    tokio::time::sleep(Duration::from_millis(1300)).await;
    let res = resume(&app, &cookie, &id).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let token = res.body["client_token"].as_str().unwrap().to_string();
    // The page loads the room before its socket opens: many ticks with no socket, still live.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(status(&app, &id).await, ("live".to_string(), None));
    let mut ws = hello(&base, &id, &token, 0).await;
    let st = frame_of(&mut ws, "round.state", WAIT)
        .await
        .expect("round.state");
    assert_eq!(st["d"]["status"], "live", "{st}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(status(&app, &id).await, ("live".to_string(), None));
}

#[tokio::test]
async fn resume_of_paused_round_after_restart_stays_live() {
    let app = live::test_app(Options {
        timing: roomy(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fake").await;
    let uuid = Uuid::parse_str(&id).unwrap();
    let ws = paused(&base, &id, &token, 1).await;
    drop(ws);
    pause_saved(&app, &id).await;
    // The server restarts; the socket went an hour ago.
    sqlx::query("update sessions set last_socket_at = now() - interval '1 hour' where id = $1")
        .bind(uuid)
        .execute(&app.state.db)
        .await
        .unwrap();
    let app2 = restarted(&app, roomy()).await;
    let base2 = app2.serve().await;
    let res = resume(&app2, &cookie, &id).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let token = res.body["client_token"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(status(&app2, &id).await, ("live".to_string(), None));
    // A further restart before the page connects: the janitor sees a fresh window too.
    let app3 = restarted(&app, roomy()).await;
    persist::sweep_stale(&app3.state).await.unwrap();
    assert_eq!(status(&app2, &id).await, ("live".to_string(), None));
    let mut ws = hello(&base2, &id, &token, 0).await;
    let st = frame_of(&mut ws, "round.state", WAIT)
        .await
        .expect("round.state");
    assert_eq!(st["d"]["status"], "live", "{st}");
}

#[tokio::test]
async fn resume_from_pause_holds_the_clock_until_back_and_logs_it() {
    let app = live::test_app(Options {
        timing: roomy(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fake").await;
    let uuid = Uuid::parse_str(&id).unwrap();
    let ws = paused(&base, &id, &token, 1).await;
    drop(ws);
    let res = resume(&app, &cookie, &id).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let token = res.body["client_token"].as_str().unwrap().to_string();
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    // Connected, but the user is not back in the room yet: the round clock does not run.
    let before = round_ms(&app, &id).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    // (Within a few ms: the stopped clock is two rounded durations.)
    let held = round_ms(&app, &id).await;
    assert!(
        held.abs_diff(before) <= 5,
        "the clock ran before the user was back: {before} -> {held}"
    );
    // The resume flow's typed turn: the clock runs and the return is logged after the pause.
    assert_eq!(
        app.turn(&token, &id, "[event: resume]").await.status,
        StatusCode::OK
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(round_ms(&app, &id).await > before);
    let kinds: Vec<(String, Value)> = sqlx::query_as(
        "select kind, data from session_events where session_id = $1 and kind in ('ui.event', 'resume') order by id",
    )
    .bind(uuid)
    .fetch_all(&app.state.db)
    .await
    .unwrap();
    let pause_at = kinds
        .iter()
        .position(|(k, d)| k == "ui.event" && d["kind"] == "pause")
        .expect("pause logged");
    assert!(
        kinds[pause_at..]
            .iter()
            .any(|(k, d)| k == "ui.event" && d["kind"] == "resume"),
        "{kinds:?}"
    );
    // The resume itself is on the timeline, not counted.
    assert!(
        kinds
            .iter()
            .any(|(k, d)| k == "resume" && d["from"] == "pause" && d["counted"] == false),
        "{kinds:?}"
    );
}

#[tokio::test]
async fn release_waits_for_a_resume_in_flight() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            voice_release: Duration::from_secs(3600),
            ..roomy()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fish").await;
    let _ws = paused(&base, &id, &token, 1).await;
    let hub = app.state.hubs.get(&id).unwrap();
    let handle = app.state.registry.get(&id).unwrap();
    let epoch = handle.lock().await.pause_epoch;
    // Fish is slow: the resume holds the Fish lock while it mints, and the 45 s release comes due meanwhile.
    let guard = hub.fish_lock.lock().await;
    let resume_call = resume(&app, &cookie, &id);
    // Generous margins so the resume queues on the lock first even on a loaded runner.
    let release = async {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        ws::release_voices(&app.state, &hub, &handle, epoch).await
    };
    let unlock = async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        drop(guard);
    };
    let (res, released, ()) = tokio::join!(resume_call, release, unlock);
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(released, Release::Stale, "the round left that pause");
    let fresh = newest_fish(&app, &id).await;
    assert_eq!(fresh, "fish-2");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!end_called(&app, &fresh).await, "the new voice was ended");
    assert!(end_called(&app, "fish-1").await, "the old voice goes");
}

#[tokio::test]
async fn release_acts_only_on_the_pause_it_saw() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            voice_release: Duration::from_secs(3600),
            ..roomy()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fish").await;
    let mut ws = paused(&base, &id, &token, 1).await;
    let hub = app.state.hubs.get(&id).unwrap();
    let handle = app.state.registry.get(&id).unwrap();
    let first = handle.lock().await.pause_epoch;
    // Back before the release ran: the round is live, its voices stay.
    send(&mut ws, "ui.event", 2, json!({"kind": "resume"})).await;
    live::eventually("live", WAIT, || async {
        handle.lock().await.status == ir_server::orchestrator::SessionStatus::Live
    })
    .await;
    assert_eq!(
        ws::release_voices(&app.state, &hub, &handle, first).await,
        Release::Stale
    );
    let now = handle.lock().await.pause_epoch;
    assert_eq!(
        ws::release_voices(&app.state, &hub, &handle, now).await,
        Release::Stale,
        "never the voices of a live round"
    );
    assert!(!any_end(&app).await);

    // Paused again: the release of this pause ends the voice and says so.
    send(
        &mut ws,
        "ui.event",
        3,
        json!({"kind": "pause", "reason": "blurred"}),
    )
    .await;
    live::eventually("paused", WAIT, || async {
        handle.lock().await.status == ir_server::orchestrator::SessionStatus::Paused
    })
    .await;
    let second = handle.lock().await.pause_epoch;
    assert_eq!(
        ws::release_voices(&app.state, &hub, &handle, second).await,
        Release::Done
    );
    assert!(marked_ended(&app, &id, "fish-1").await);
    // The user is back through `ui.event resume` (the round goes live without voices): the recovery resume is not
    // counted, and the flag clears once new voices exist.
    send(&mut ws, "ui.event", 4, json!({"kind": "resume"})).await;
    live::eventually("live", WAIT, || async {
        handle.lock().await.status == ir_server::orchestrator::SessionStatus::Live
    })
    .await;
    let res = resume(&app, &cookie, &id).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let count: i32 = sqlx::query_scalar("select resume_count from sessions where id = $1")
        .bind(Uuid::parse_str(&id).unwrap())
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(count, 0, "a resume after a release is not counted");
    assert!(
        !hub.voices_released
            .load(std::sync::atomic::Ordering::SeqCst)
    );
}

#[tokio::test]
async fn release_time_restarts_with_each_pause() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            voice_release: Duration::from_millis(900),
            ..roomy()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fish").await;
    let mut ws = paused(&base, &id, &token, 1).await;
    let t0 = tokio::time::Instant::now();
    tokio::time::sleep(Duration::from_millis(500)).await;
    // Back and paused again within one tick (a system overlay took the focus for a moment).
    send(&mut ws, "ui.event", 2, json!({"kind": "resume"})).await;
    send(
        &mut ws,
        "ui.event",
        3,
        json!({"kind": "pause", "reason": "blurred"}),
    )
    .await;
    // Past 900 ms from the first pause, under it from the second: not released.
    tokio::time::sleep_until(t0 + Duration::from_millis(1150)).await;
    assert!(!any_end(&app).await, "released on the first pause's clock");
    live::eventually("released on the second pause's clock", WAIT, || async {
        end_called(&app, "fish-1").await
    })
    .await;
}

#[tokio::test]
async fn a_short_pause_keeps_the_voice() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            voice_release: Duration::from_millis(500),
            ..roomy()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fish").await;
    let mut ws = paused(&base, &id, &token, 1).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    send(&mut ws, "ui.event", 2, json!({"kind": "resume"})).await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(!any_end(&app).await);
    assert_eq!(status(&app, &id).await.0, "live");
}

#[tokio::test]
async fn a_failed_release_is_retried() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            voice_release: Duration::from_millis(300),
            ..roomy()
        },
        ..Options::default()
    })
    .await;
    // Fish fails the first three end calls (one release's tries), then works.
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/v1/agent/sessions/fish-1/end"))
        .respond_with(wiremock::ResponseTemplate::new(500))
        .up_to_n_times(3)
        .with_priority(1)
        .mount(&app.fish)
        .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fish").await;
    let _ws = paused(&base, &id, &token, 1).await;
    live::eventually("ended on a later try", Duration::from_secs(6), || async {
        marked_ended(&app, &id, "fish-1").await
    })
    .await;
    let tries = app
        .fish_paths("POST")
        .await
        .iter()
        .filter(|p| p.ends_with("fish-1/end"))
        .count();
    assert!(tries >= 4, "{tries}");
    assert_eq!(status(&app, &id).await.0, "paused");
}

/// Paused a minute before a restart, voice still up.
async fn paused_before_restart(app: &live::TestApp) -> (String, String) {
    let base = app.serve().await;
    let (cookie, id, token) = new_session(app, "fish").await;
    let ws = paused(&base, &id, &token, 1).await;
    pause_saved(app, &id).await;
    drop(ws);
    // The driver's own save of the paused state lands first.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let a_minute_ago = (chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339();
    sqlx::query(
        "update sessions set live_state = jsonb_set(live_state, '{paused_at}', to_jsonb($2::text)) \
         where id = $1",
    )
    .bind(Uuid::parse_str(&id).unwrap())
    .bind(a_minute_ago)
    .execute(&app.state.db)
    .await
    .unwrap();
    (cookie, id)
}

/// The first process never releases (as if it went down at once).
fn no_release() -> SessionTiming {
    SessionTiming {
        voice_release: Duration::from_secs(3600),
        ..roomy()
    }
}

#[tokio::test]
async fn janitor_releases_voices_of_a_paused_round_after_restart() {
    let app = live::test_app(Options {
        timing: no_release(),
        ..Options::default()
    })
    .await;
    let (_, id) = paused_before_restart(&app).await;
    // Nobody comes back after the restart: the janitor ends the voice.
    let app2 = restarted(&app, roomy()).await;
    persist::sweep(&app2.state).await.unwrap();
    assert!(end_called(&app, "fish-1").await);
    assert!(marked_ended(&app, &id, "fish-1").await);
    assert_eq!(status(&app2, &id).await, ("paused".to_string(), None));
}

#[tokio::test]
async fn reloaded_paused_round_releases_on_the_original_pause_clock() {
    let app = live::test_app(Options {
        timing: no_release(),
        ..Options::default()
    })
    .await;
    let (_, id) = paused_before_restart(&app).await;
    // The page comes back after the restart (the round is reloaded): released at once, not 45 s after the reload.
    let app2 = restarted(&app, SessionTiming::default()).await;
    let handle = persist::load_live(&app2.state, Uuid::parse_str(&id).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        handle.lock().await.status,
        ir_server::orchestrator::SessionStatus::Paused
    );
    live::eventually("released", WAIT, || async {
        marked_ended(&app, &id, "fish-1").await
    })
    .await;
}

#[tokio::test]
async fn resume_from_pause_needs_budget_left() {
    // 32 s of pause budget, 30 s needed to resume.
    let app = live::test_app(Options {
        timing: SessionTiming {
            pause_limit: Duration::from_secs(32),
            ..roomy()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fake").await;
    // Almost all of it left: resumes.
    let ws = paused(&base, &id, &token, 1).await;
    let res = resume(&app, &cookie, &id).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let token = res.body["client_token"].as_str().unwrap().to_string();
    drop(ws);
    // Paused again until under 30 s are left: refused (the user would not be back in time).
    let _ws = paused(&base, &id, &token, 1).await;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let res = resume(&app, &cookie, &id).await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.body);
    assert_eq!(res.body["code"], "resume_expired");
}

#[tokio::test]
async fn pause_resumes_past_the_cap_use_counted_ones() {
    let app = live::test_app(Options {
        timing: roomy(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, mut token) = new_session(&app, "fake").await;
    for i in 0..11 {
        let ws = paused(&base, &id, &token, 1).await;
        let res = resume(&app, &cookie, &id).await;
        assert_eq!(res.status, StatusCode::OK, "resume {i}: {}", res.body);
        token = res.body["client_token"].as_str().unwrap().to_string();
        drop(ws);
    }
    // Ten free ones, then the eleventh used one of the 3.
    let count: i32 = sqlx::query_scalar("select resume_count from sessions where id = $1")
        .bind(Uuid::parse_str(&id).unwrap())
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn me_resumable_live_drop_ends_with_the_pause_budget() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            offline_limit: Duration::from_secs(5),
            pause_limit: Duration::from_millis(1500),
            ..timing()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    drop(ws);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    let r: &Value = &me.body["resumable"];
    assert_eq!(r["session_id"], id, "{}", me.body);
    let expires: DateTime<Utc> = r["expires_at"].as_str().unwrap().parse().unwrap();
    // The pause budget ends first: not the 5 s window.
    let left = expires - Utc::now();
    assert!(left <= chrono::Duration::milliseconds(1500), "{left:?}");
}

#[tokio::test]
async fn a_resume_that_fails_after_minting_ends_the_new_voice() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            voice_release: Duration::from_millis(300),
            ..roomy()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (cookie, id, token) = new_session(&app, "fish").await;
    let _ws = paused(&base, &id, &token, 1).await;
    live::eventually("released", WAIT, || async {
        marked_ended(&app, &id, "fish-1").await
    })
    .await;
    // The database fails the resume after the new voice exists (its timeline row cannot be written).
    sqlx::query(
        "create function fail_resume() returns trigger language plpgsql as $$ \
         begin if new.kind = 'resume' then raise exception 'no resume rows'; end if; return new; end $$",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    sqlx::query(
        "create trigger fail_resume before insert on session_events \
         for each row execute function fail_resume()",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    let res = resume(&app, &cookie, &id).await;
    assert!(res.status.is_server_error(), "{} {}", res.status, res.body);
    assert_eq!(
        newest_fish(&app, &id).await,
        "fish-2",
        "a new voice was made"
    );
    live::eventually("the new voice ended", WAIT, || async {
        marked_ended(&app, &id, "fish-2").await
    })
    .await;
    // Still released: the next resume makes voices again, uncounted.
    assert!(
        app.state
            .hubs
            .get(&id)
            .unwrap()
            .voices_released
            .load(std::sync::atomic::Ordering::SeqCst)
    );
}

#[tokio::test]
async fn join_is_refused_while_paused_with_voices_released() {
    let app = live::test_app(Options {
        timing: SessionTiming {
            voice_release: Duration::from_millis(300),
            ..roomy()
        },
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, live::full_req("fish")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let token = res.body["client_token"].as_str().unwrap().to_string();
    let _ws = paused(&base, &id, &token, 1).await;
    live::eventually("released", WAIT, || async {
        marked_ended(&app, &id, "fish-1").await
    })
    .await;
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/panelists/p2/join"),
            Some(&cookie),
            Some(json!({"opening_line": "Hi, I'm Ana."})),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.body);
    assert_eq!(app.fish_calls("POST", "/v1/agent/sessions").await.len(), 1);
}

const ALL_MODELS: [&str; 3] = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"];

async fn ui_events(app: &live::TestApp, id: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "select data from session_events where session_id = $1 and kind = 'ui.event' order by id",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .fetch_all(&app.state.db)
    .await
    .unwrap()
}

#[tokio::test]
async fn degraded_hold_is_logged_as_a_pause_and_the_clock_waits_for_a_real_reply() {
    let app = live::test_app(Options {
        timing: roomy(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (_, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    // Every model is down: three hold lines, then the round is degraded.
    *app.llm.down.lock().unwrap() = ALL_MODELS.iter().map(|m| m.to_string()).collect();
    for i in 0..3 {
        let res = app.turn(&token, &id, &format!("Point number {i}.")).await;
        assert_eq!(res.status, StatusCode::OK);
    }
    let handle = app.state.registry.get(&id).unwrap();
    assert!(handle.lock().await.degraded);
    live::eventually("degraded hold logged", WAIT, || async {
        ui_events(&app, &id)
            .await
            .iter()
            .any(|e| e["kind"] == "pause" && e["reason"] == "degraded")
    })
    .await;
    // The browser is told.
    let until = tokio::time::Instant::now() + WAIT;
    loop {
        let left = until.saturating_duration_since(tokio::time::Instant::now());
        match live::next(&mut ws, left).await {
            Some(live::Next::Frame(f)) if f["t"] == "round.state" && f["d"]["degraded"] == true => {
                break;
            }
            Some(live::Next::Frame(_)) => {}
            other => panic!("no degraded round.state: {other:?}"),
        }
    }
    // Held, also across a `ui.event resume` (the user is there; the model is not).
    let before = round_ms(&app, &id).await;
    send(&mut ws, "ui.event", 1, json!({"kind": "resume"})).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let held = round_ms(&app, &id).await;
    assert!(held.abs_diff(before) <= 5, "{before} -> {held}");
    // The model is back: a real reply, the clock runs, and the resume closes the pause span.
    app.llm.down.lock().unwrap().clear();
    let res = app.turn(&token, &id, "Point number three.").await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(!handle.lock().await.degraded);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(round_ms(&app, &id).await > before + 100);
    let events = ui_events(&app, &id).await;
    let paused = events
        .iter()
        .position(|e| e["kind"] == "pause" && e["reason"] == "degraded")
        .unwrap();
    assert!(
        events[paused..]
            .iter()
            .any(|e| e["kind"] == "resume" && e["reason"] == "model_back"),
        "{events:?}"
    );
    // No resume was logged while the clock stood still.
    assert!(
        !events[paused..]
            .iter()
            .any(|e| e["kind"] == "resume" && e["reason"] == "back"),
        "{events:?}"
    );
}

/// The report's view of held time (union of the logged holds) against the server's round clock.
async fn report_round_ms(app: &live::TestApp, id: &str) -> i64 {
    use ir_server::scoring::clock::{RoundClock, hold_spans, hold_toggle};
    let uuid = Uuid::parse_str(id).unwrap();
    let rows: Vec<(Value, DateTime<Utc>)> = sqlx::query_as(
        "select data, created_at from session_events where session_id = $1 and kind = 'ui.event' order by id",
    )
    .bind(uuid)
    .fetch_all(&app.state.db)
    .await
    .unwrap();
    let started: DateTime<Utc> =
        sqlx::query_scalar("select started_at from sessions where id = $1")
            .bind(uuid)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let toggles: Vec<(i64, bool, bool)> = rows
        .iter()
        .filter_map(|(d, at)| hold_toggle(d, at.timestamp_millis()))
        .collect();
    let now = Utc::now().timestamp_millis();
    RoundClock::new(started.timestamp_millis(), hold_spans(&toggles, now), 0).wall_to_round(now)
}

async fn degrade(app: &live::TestApp, id: &str, token: &str) {
    *app.llm.down.lock().unwrap() = ALL_MODELS.iter().map(|m| m.to_string()).collect();
    for i in 0..3 {
        let res = app.turn(token, id, &format!("Outage point {i}.")).await;
        assert_eq!(res.status, StatusCode::OK);
    }
    assert!(app.state.registry.get(id).unwrap().lock().await.degraded);
}

async fn wait_status(app: &live::TestApp, id: &str, want: ir_server::orchestrator::SessionStatus) {
    let handle = app.state.registry.get(id).unwrap();
    live::eventually("status", WAIT, || async {
        handle.lock().await.status == want
    })
    .await;
}

#[tokio::test]
async fn report_clock_matches_the_server_when_a_pause_overlaps_an_outage() {
    use ir_server::orchestrator::SessionStatus;
    let app = live::test_app(Options {
        timing: roomy(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;

    // 1. Pause during the outage, resume while still degraded, then the model comes back.
    let (_, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    degrade(&app, &id, &token).await;
    send(
        &mut ws,
        "ui.event",
        1,
        json!({"kind": "pause", "reason": "headset_removed"}),
    )
    .await;
    wait_status(&app, &id, SessionStatus::Paused).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    send(&mut ws, "ui.event", 2, json!({"kind": "resume"})).await;
    wait_status(&app, &id, SessionStatus::Live).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    app.llm.down.lock().unwrap().clear();
    assert_eq!(
        app.turn(&token, &id, "Back to the design.").await.status,
        StatusCode::OK
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let server = round_ms(&app, &id).await as i64;
    let report = report_round_ms(&app, &id).await;
    assert!(
        (server - report).abs() < 250,
        "server {server} ms, report {report} ms"
    );
    drop(ws);

    // 2. The model comes back while the user is still paused; then the user resumes.
    let (_, id, token) = new_session(&app, "fake").await;
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", WAIT).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    degrade(&app, &id, &token).await;
    send(
        &mut ws,
        "ui.event",
        1,
        json!({"kind": "pause", "reason": "headset_removed"}),
    )
    .await;
    wait_status(&app, &id, SessionStatus::Paused).await;
    app.llm.down.lock().unwrap().clear();
    // A turn that was already in flight gets through while the user is away (the gate refuses new turns while
    // paused): the round leaves the outage with the user still paused.
    let handle = app.state.registry.get(&id).unwrap();
    let change = handle
        .lock()
        .await
        .note_live_turn(false, false, std::time::Instant::now());
    assert_eq!(change, Some(false));
    ws::degraded_changed(&app.state, &id, &handle, false).await;
    assert!(!handle.lock().await.degraded);
    tokio::time::sleep(Duration::from_millis(600)).await;
    send(&mut ws, "ui.event", 2, json!({"kind": "resume"})).await;
    wait_status(&app, &id, SessionStatus::Live).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let server = round_ms(&app, &id).await as i64;
    let report = report_round_ms(&app, &id).await;
    assert!(
        (server - report).abs() < 250,
        "server {server} ms, report {report} ms"
    );
    let events = ui_events(&app, &id).await;
    assert!(
        events
            .iter()
            .any(|e| e["kind"] == "resume" && e["reason"] == "model_back"),
        "model_back is logged even while paused: {events:?}"
    );
}
