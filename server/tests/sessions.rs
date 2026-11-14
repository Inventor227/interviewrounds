//! Sessions API: guest identity, create (caps, fake and Fish voices), resume, swap hand-over, end.
//! Needs Postgres (`DATABASE_URL`); Fish is a mock server and the model a fake.

mod common;

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode, header};
use chrono::{DateTime, Utc};
use common::live::{self, Options, full_req, go_live, short_req};
use ir_server::claude::{Message, Role};
use ir_server::identity::sha256;
use ir_server::orchestrator::Turn;
use ir_server::persist;
use ir_server::usage::next_midnight;
use serde_json::{Value, json};
use uuid::Uuid;

async fn count(app: &live::TestApp, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn guest_cookie_created_once() {
    let app = live::test_app(Options::default()).await;

    let first = app.call(Method::GET, "/api/me", None, None).await;
    assert_eq!(first.status, StatusCode::OK);
    let set = first.headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_string();
    for part in [
        "ir_id=",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Max-Age=31536000",
    ] {
        assert!(set.contains(part), "{set}");
    }
    let cookie = set.split(';').next().unwrap().to_string();
    assert_eq!(first.body["identity"]["kind"], "guest");
    for key in [
        "sign_in_available",
        "settings",
        "onboarding_done",
        "streak",
        "daily",
        "limits",
        "entitlements",
    ] {
        assert!(
            first.body.get(key).is_some(),
            "missing {key}: {}",
            first.body
        );
    }
    assert_eq!(first.body["entitlements"]["plan"], "guest");

    let second = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(second.status, StatusCode::OK);
    assert!(
        second.headers.get(header::SET_COOKIE).is_none(),
        "cookie set twice"
    );
    assert_eq!(count(&app, "select count(*) from identities").await, 1);

    // Only the hash is stored.
    let value = cookie.trim_start_matches("ir_id=");
    let stored: Vec<u8> = sqlx::query_scalar("select cookie_hash from identities")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(stored, sha256(value));

    // An unknown (well formed) cookie gets a fresh guest with a value the server picked.
    let forged = "ir_id=00000000000000000000000000000000";
    let third = app.call(Method::GET, "/api/me", Some(forged), None).await;
    let new = third.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(
        !new.contains("ir_id=00000000000000000000000000000000;"),
        "{new}"
    );
}

#[tokio::test]
async fn create_session_fake_returns_no_fish_token() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fake")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let b = &res.body;

    let id = b["session_id"].as_str().unwrap();
    let token = b["client_token"].as_str().unwrap();
    assert_eq!(token.len(), 64, "32 random bytes as hex");
    assert_eq!(b["ws_url"], format!("/ws/session/{id}"));
    assert_eq!(b["panel"].as_array().unwrap().len(), 1);
    assert_eq!(b["panel"][0]["voice"], json!({"transport": "fake"}));
    assert_eq!(b["panel"][0]["persona_id"], "persona.daniel");
    assert_eq!(b["floor"], "p1");
    assert_eq!(b["panel_mode"], "swap");
    assert_eq!(b["round"]["id"], "sde.system_design.short");
    assert!(
        b["round"]["phases"][0].get("goal").is_none(),
        "prompt fields leak"
    );
    assert_eq!(b["timing"]["silence_wait_seconds"], 40);
    assert_eq!(b["timing"]["hard_stop_minutes"], 9.0);
    assert!(b["limits"].get("reason").is_some());
    assert!(
        app.fish_paths("POST").await.is_empty(),
        "no Fish call for the fake voice"
    );
    // The prompt cache is prewarmed once, and the prewarm is priced into the ledger (2000 cache-write tokens at
    // $2.50 per million on the default live model).
    live::eventually("prewarm recorded", Duration::from_secs(3), || async {
        count(
            &app,
            "select count(*) from usage_events where kind = 'prewarm'",
        )
        .await
            == 1
    })
    .await;
    assert_eq!(app.llm.prewarms.load(Ordering::SeqCst), 1);
    let prewarm: f64 =
        sqlx::query_scalar("select cost_usd::float8 from usage_events where kind = 'prewarm'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert!((prewarm - 0.005).abs() < 1e-9, "{prewarm}");

    // Stored: created, token hashed, state snapshot for reloads.
    let uuid = Uuid::parse_str(id).unwrap();
    let row = persist::fetch_session(&app.state.db, uuid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, "created");
    assert_eq!(row.voice, "fake");
    assert!(row.live_state.is_some());
    let rec = persist::check_token(&app.state.db, uuid, token)
        .await
        .unwrap();
    assert!(rec.is_some());
    assert!(
        persist::check_token(&app.state.db, uuid, "nope")
            .await
            .unwrap()
            .is_none()
    );
    assert!(app.state.registry.get(id).is_some());

    // The client token drives the custom LLM endpoint on the fake path, and the turn lands in the ledger.
    app.set_status(id, ir_server::orchestrator::SessionStatus::Live)
        .await;
    let body = json!({"model": "x", "stream": true,
        "messages": [{"role": "user", "content": "[event: start]"}],
        "fishaudio_extra_body": {"session_id": id, "panelist_id": "p1"}});
    let req = |bearer: &str| {
        axum::http::Request::post("/v1/chat/completions")
            .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap()
    };
    use tower::ServiceExt;
    let ok = app.router.clone().oneshot(req(token)).await.unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    let text = String::from_utf8(common::body_bytes(ok).await).unwrap();
    assert!(text.contains("Hello there."), "{text}");
    let bad = app
        .router
        .clone()
        .oneshot(req(&"a".repeat(64)))
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    live::eventually("model usage recorded", Duration::from_secs(3), || async {
        count(
            &app,
            "select count(*) from usage_events where provider = 'anthropic' and kind = 'live_turn'",
        )
        .await
            == 1
    })
    .await;
    let cost: f64 =
        sqlx::query_scalar("select cost_usd::float8 from usage_events where kind = 'live_turn'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    // 1000 in x $2 + 100 out x $10 per million on the default live model.
    assert!((cost - 0.003).abs() < 1e-9, "{cost}");
}

#[tokio::test]
async fn create_session_fish_mints_the_floor_only() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, full_req("fish")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let panel = res.body["panel"].as_array().unwrap();
    assert_eq!(panel.len(), 2);
    // The whole Fish response is passed through.
    assert_eq!(
        panel[0]["voice"],
        json!({"transport": "fish", "fish": {"session_id": "fish-1", "token": "tok-1",
            "livekit_url": "wss://x.livekit.cloud", "expires_at": "2026-11-13T12:00:00Z",
            "max_duration_seconds": 1800, "transport": "livekit"}})
    );
    assert_eq!(panel[1]["voice"], json!({"transport": "fish_pending"}));

    let minted = app.fish_calls("POST", "/v1/agent/sessions").await;
    assert_eq!(minted.len(), 1);
    let id = res.body["session_id"].as_str().unwrap();
    assert_eq!(
        minted[0]["llm_extra_body"],
        json!({"session_id": id, "panelist_id": "p1"})
    );
    assert_eq!(minted[0]["overrides"]["voice_id"], "voice-daniel");
    assert_eq!(minted[0]["agent_id"], "test-agent");

    let reserved: f64 = sqlx::query_scalar("select fish_reserved_usd::float8 from sessions")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    // Swap mode: one voice at a time, hard stop 33 minutes at $0.07.
    assert!((reserved - 33.0 * 0.07).abs() < 1e-6, "{reserved}");
}

#[tokio::test]
async fn create_session_respects_guest_daily_limit() {
    let app = live::test_app(Options {
        env: &[("USAGE_PHASE", "judging")],
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let cookie = app.guest().await;
    for i in 0..3 {
        let res = app.create(&cookie, short_req("fake")).await;
        assert_eq!(res.status, StatusCode::OK, "round {i}: {}", res.body);
        go_live(&base, &res.body).await;
    }
    let res = app.create(&cookie, short_req("fake")).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{}", res.body);
    assert_eq!(res.body["code"], "guest_daily_limit");
    let resets: DateTime<Utc> = res.body["resets_at"].as_str().unwrap().parse().unwrap();
    assert_eq!(resets, next_midnight(Utc::now()));
    assert!(!res.body["message"].as_str().unwrap().contains('\u{2014}'));

    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(me.body["limits"]["short_left_today"], 0);
    assert_eq!(me.body["limits"]["full_left"], 1);
    assert_eq!(me.body["limits"]["reason"], "guest_daily_limit");

    // The full round is separate: one per device.
    let res = app.create(&cookie, full_req("fake")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    go_live(&base, &res.body).await;
    let res = app.create(&cookie, full_req("fake")).await;
    assert_eq!(res.body["code"], "guest_full_used");

    // Another device is not affected.
    let other = app.guest().await;
    assert_eq!(
        app.create(&other, short_req("fake")).await.status,
        StatusCode::OK
    );
}

async fn status_of(app: &live::TestApp, id: &str) -> (String, Option<String>) {
    sqlx::query_as("select status, ended_reason from sessions where id = $1")
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn only_rounds_that_started_count_and_a_new_one_replaces_an_unstarted_one() {
    let app = live::test_app(Options {
        env: &[("USAGE_PHASE", "judging")],
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let cookie = app.guest().await;
    // Sessions made on the mic tap and never entered: none counts, and each new one replaces the last.
    let mut made = Vec::new();
    for i in 0..5 {
        let res = app.create(&cookie, short_req("fake")).await;
        assert_eq!(res.status, StatusCode::OK, "tap {i}: {}", res.body);
        made.push(res.body);
    }
    for b in &made[..4] {
        let (status, reason) = status_of(&app, b["session_id"].as_str().unwrap()).await;
        assert_eq!(status, "abandoned");
        assert_eq!(reason.as_deref(), Some("user_ended"));
    }
    let last = made.last().unwrap();
    assert_eq!(
        status_of(&app, last["session_id"].as_str().unwrap())
            .await
            .0,
        "created"
    );
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(me.body["limits"]["short_left_today"], 3, "{}", me.body);

    // A round counts once it goes live: three live rounds use up the day.
    go_live(&base, last).await;
    for _ in 0..2 {
        let res = app.create(&cookie, short_req("fake")).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
        go_live(&base, &res.body).await;
    }
    let res = app.create(&cookie, short_req("fake")).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{}", res.body);
    assert_eq!(res.body["code"], "guest_daily_limit");
    // A live round is never replaced by a new create.
    assert_eq!(
        status_of(&app, last["session_id"].as_str().unwrap())
            .await
            .0,
        "live"
    );
}

#[tokio::test]
async fn build_budget_blocks_fish_not_fake() {
    let app = live::test_app(Options::default()).await;
    // $13.90 already spent on Fish in the build; a short round reserves 9 min x $0.07 = $0.63.
    sqlx::query(
        "insert into usage_events (provider, kind, usage_phase, minutes, cost_usd) \
         values ('fish', 'voice', 'build', 198.6, 13.90)",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fish")).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{}", res.body);
    assert_eq!(res.body["code"], "build_budget_reached");
    assert!(
        app.fish_paths("POST").await.is_empty(),
        "no Fish session minted"
    );

    let res = app.create(&cookie, short_req("fake")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(me.body["limits"]["reason"], "build_budget_reached");
}

#[tokio::test]
async fn reservations_count_against_the_build_budget() {
    // Spend outside the ledger leaves room for exactly one short Fish round ($0.63 each).
    let app = live::test_app(Options {
        env: &[("FISH_BUILD_SPENT_USD", "13.0")],
        ..Options::default()
    })
    .await;
    let cookie = app.guest().await;
    assert_eq!(
        app.create(&cookie, short_req("fish")).await.status,
        StatusCode::OK
    );
    let res = app.create(&cookie, short_req("fish")).await;
    assert_eq!(res.body["code"], "build_budget_reached", "{}", res.body);
}

fn add_turns(st: &mut ir_server::orchestrator::SessionState) {
    st.turns.push(Turn {
        speaker: "candidate".into(),
        text: "I would start with the write path.".into(),
        at_ms: 1000,
        interrupted: false,
        heard: None,
    });
    st.turns.push(Turn {
        speaker: "p1".into(),
        text: "Go on.".into(),
        at_ms: 2000,
        interrupted: false,
        heard: None,
    });
    st.history
        .push(Message::user_text("I would start with the write path."));
    st.history.push(Message::assistant_text("Go on."));
    st.phase_idx = 1;
}

#[tokio::test]
async fn resume_keeps_state_and_mints_new_tokens() {
    // A long tick: the driver saves once at start and then stays out of the way.
    let timing = ir_server::ws::SessionTiming {
        tick: Duration::from_secs(3600),
        ..Default::default()
    };
    let app = live::test_app(Options {
        timing: timing.clone(),
        ..Options::default()
    })
    .await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fish")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let uuid = Uuid::parse_str(&id).unwrap();
    let old_token = res.body["client_token"].as_str().unwrap().to_string();
    let old_fish = res.body["panel"][0]["voice"]["fish"]["session_id"].clone();

    // Some progress: turns, a later phase, and a board op.
    {
        let handle = app.state.registry.get(&id).unwrap();
        let mut st = handle.lock().await;
        st.status = ir_server::orchestrator::SessionStatus::Live;
        add_turns(&mut st);
        persist::save_live(
            &app.state.db,
            uuid,
            &persist::snapshot(&st, Instant::now()),
            0,
        )
        .await
        .unwrap();
    }
    sqlx::query("update sessions set status = 'live', started_at = now(), last_socket_at = now() where id = $1")
        .bind(uuid)
        .execute(&app.state.db)
        .await
        .unwrap();
    sqlx::query("insert into board_ops (session_id, op_id, src, op, args) values ($1, 'op-1', 'hand', 'item.create', '{}')")
        .bind(uuid)
        .execute(&app.state.db)
        .await
        .unwrap();

    // The server restarts: a new process with the same database and nothing in memory.
    let restarted = {
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
        (ir_server::router(state.clone()), state)
    };
    let app2 = live::TestApp {
        router: restarted.0,
        state: restarted.1,
        fish: live::fish_mock().await,
        llm: app.llm.clone(),
        db_url: app.db_url.clone(),
    };
    // (Fish calls of the restarted server still go to the first mock.)
    let res = app2
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/resume"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(res.body["session_id"], id.as_str());
    let new_token = res.body["client_token"].as_str().unwrap();
    assert_ne!(new_token, old_token);
    let new_fish = &res.body["panel"][0]["voice"]["fish"]["session_id"];
    assert_eq!(res.body["panel"][0]["voice"]["transport"], "fish");
    assert_ne!(new_fish, &old_fish);
    assert!(res.body.get("timing").is_some());

    // Tokens: only the new one works.
    assert!(
        persist::check_token(&app.state.db, uuid, new_token)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        persist::check_token(&app.state.db, uuid, &old_token)
            .await
            .unwrap()
            .is_none()
    );

    // State came back from the database, with the resume note queued for the next turn.
    let handle = app2.state.registry.get(&id).expect("reloaded");
    {
        let st = handle.lock().await;
        assert_eq!(st.turns.len(), 2);
        assert_eq!(st.turns[0].text, "I would start with the write path.");
        assert_eq!(st.history.len(), 2);
        assert_eq!(st.history[1].role, Role::Assistant);
        assert_eq!(st.phase_idx, 1);
        assert!(
            st.pending_notes
                .iter()
                .any(|n| n.contains("dropped connection"))
        );
    }
    assert_eq!(count(&app, "select count(*) from board_ops").await, 1);
    // The old Fish session was ended so it stops billing.
    live::eventually("old Fish session ended", Duration::from_secs(3), || async {
        app.fish_paths("POST")
            .await
            .iter()
            .any(|p| p.ends_with(&format!("{}/end", old_fish.as_str().unwrap())))
    })
    .await;
    let row = persist::fetch_session(&app.state.db, uuid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, "live");
    assert_eq!(row.fish_entries().len(), 2);
    // Marked ended once Fish confirmed the end.
    live::eventually("old entry marked ended", Duration::from_secs(3), || async {
        persist::fetch_session(&app.state.db, uuid)
            .await
            .unwrap()
            .unwrap()
            .fish_entries()[0]
            .ended_at
            .is_some()
    })
    .await;

    // Someone else's session looks like it does not exist.
    let stranger = app2.guest().await;
    let res = app2
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/resume"),
            Some(&stranger),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn swap_join_appends_the_opening_line_and_moves_the_floor() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, full_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let line = "Hi, I'm Ana. Let's talk about what fails first.";
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/panelists/p2/join"),
            Some(&cookie),
            Some(json!({"opening_line": line})),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(res.body["voice"]["transport"], "fish");
    assert_eq!(res.body["voice"]["fish"]["session_id"], "fish-2");

    let minted = app.fish_calls("POST", "/v1/agent/sessions").await;
    assert_eq!(minted.len(), 2);
    assert_eq!(minted[1]["overrides"]["first_message"], line);
    assert_eq!(minted[1]["overrides"]["voice_id"], "voice-ana");
    assert_eq!(minted[1]["llm_extra_body"]["panelist_id"], "p2");

    let handle = app.state.registry.get(&id).unwrap();
    let st = handle.lock().await;
    assert_eq!(st.floor, "p2");
    let last = st.history.last().unwrap();
    assert_eq!(last.role, Role::Assistant);
    assert_eq!(last.text(), line);
    assert_eq!(st.history[st.history.len() - 2].text(), "[event: handover]");
    assert_eq!(st.turns.last().unwrap().speaker, "p2");
    assert_eq!(st.last_agent_text.get("p2").map(String::as_str), Some(line));
    drop(st);

    live::eventually(
        "p1's Fish session ended",
        Duration::from_secs(3),
        || async {
            app.fish_paths("POST")
                .await
                .iter()
                .any(|p| p.ends_with("fish-1/end"))
        },
    )
    .await;
}

#[tokio::test]
async fn end_and_status() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();

    let bad = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/end"),
            Some(&cookie),
            Some(json!({"reason": "bored"})),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/end"),
            Some(&cookie),
            Some(json!({"reason": "user_ended"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    let st = app
        .call(
            Method::GET,
            &format!("/api/sessions/{id}"),
            Some(&cookie),
            None,
        )
        .await;
    // Nothing was said, so there is nothing to score.
    assert_eq!(
        st.body,
        json!({"status": "abandoned", "report_ready": false})
    );
    assert!(app.state.registry.get(&id).is_none());

    // Fish minutes are settled from Fish's own duration (120 s mock) and the reservation is released.
    live::eventually("Fish minutes recorded", Duration::from_secs(5), || async {
        count(
            &app,
            "select count(*) from usage_events where provider = 'fish'",
        )
        .await
            == 1
    })
    .await;
    let (minutes, cost): (f64, f64) = sqlx::query_as(
        "select minutes::float8, cost_usd::float8 from usage_events where provider = 'fish'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert!(
        (minutes - 2.0).abs() < 1e-9 && (cost - 0.14).abs() < 1e-9,
        "{minutes} {cost}"
    );
    assert!(
        app.fish_paths("POST")
            .await
            .iter()
            .any(|p| p.ends_with("fish-1/end"))
    );
    let settled: bool = sqlx::query_scalar("select fish_usage_recorded from sessions")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert!(settled);

    // Ended sessions cannot resume.
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/resume"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn content_catalog_is_public_and_stripped() {
    let app = live::test_app(Options::default()).await;
    let res = app
        .call(Method::GET, "/api/content/catalog", None, None)
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.headers.get(header::SET_COOKIE).is_none());
    let rounds = res.body["rounds"].as_array().unwrap();
    assert!(
        rounds
            .iter()
            .all(|r| r.get("rubric_id").is_none() && r.get("question_pool").is_none())
    );
    assert_eq!(res.body["roles"][0]["id"], "sde");
    let personas = res.body["personas"].as_array().unwrap();
    assert!(
        personas
            .iter()
            .all(|p| p.get("behaviour").is_none() && p.get("voice_id").is_none())
    );
    let _: &Value = &res.body["meeting_templates"];
}

#[tokio::test]
async fn fake_voice_needs_the_dev_key() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    for key in [None, Some("wrong-key")] {
        let extra: Vec<(&str, &str)> = key.map(|k| ("x-dev-key", k)).into_iter().collect();
        let res = app
            .call_with(
                Method::POST,
                "/api/sessions",
                Some(&cookie),
                Some(short_req("fake")),
                &extra,
            )
            .await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{}", res.body);
        assert_eq!(res.body["code"], "dev_only");
    }
    assert_eq!(count(&app, "select count(*) from sessions").await, 0);
    assert_eq!(
        app.create(&cookie, short_req("fake")).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn llm_turns_only_while_live_and_fake_turns_are_capped() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fake")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let token = res.body["client_token"].as_str().unwrap().to_string();

    // Created (no socket yet) and paused rounds serve no turns, whoever asks.
    for bearer in [token.as_str(), "test-llm-secret"] {
        let res = app.turn(bearer, &id, "[event: start]").await;
        assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.body);
        assert_eq!(res.body["code"], "session_not_live");
    }
    app.set_status(&id, ir_server::orchestrator::SessionStatus::Paused)
        .await;
    assert_eq!(
        app.turn(&token, &id, "Hello").await.status,
        StatusCode::CONFLICT
    );

    app.set_status(&id, ir_server::orchestrator::SessionStatus::Live)
        .await;
    assert_eq!(
        app.turn(&token, &id, "[event: start]").await.status,
        StatusCode::OK
    );

    // The client-token path: 2,000 characters per turn ...
    let long = "a".repeat(2001);
    let res = app.turn(&token, &id, &long).await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(res.body["code"], "turn_too_long");
    assert_eq!(
        app.turn(&token, &id, &"a".repeat(2000)).await.status,
        StatusCode::OK
    );
    // ... and 150 turns per session.
    {
        let handle = app.state.registry.get(&id).unwrap();
        let mut st = handle.lock().await;
        while st.turns.iter().filter(|t| t.speaker == "candidate").count() < 150 {
            st.turns.push(Turn {
                speaker: "candidate".into(),
                text: "ok".into(),
                at_ms: 0,
                interrupted: false,
                heard: None,
            });
        }
    }
    let res = app.turn(&token, &id, "One more.").await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.body["code"], "turn_limit");
    // The Fish path (shared secret) is not capped this way.
    assert_eq!(
        app.turn("test-llm-secret", &id, "One more.").await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_cut_turn_is_still_priced() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fake")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let token = res.body["client_token"].as_str().unwrap().to_string();
    app.set_status(&id, ir_server::orchestrator::SessionStatus::Live)
        .await;
    app.llm.hang.store(true, Ordering::SeqCst);

    use futures::StreamExt;
    use tower::ServiceExt;
    let body = json!({"model": "x", "stream": true,
        "messages": [{"role": "user", "content": "Let me think about the cache."}],
        "fishaudio_extra_body": {"session_id": id, "panelist_id": "p1"}});
    let req = axum::http::Request::post("/v1/chat/completions")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut chunks = res.into_body().into_data_stream();
    let first = tokio::time::timeout(Duration::from_secs(3), chunks.next()).await;
    assert!(matches!(first, Ok(Some(Ok(_)))), "the first words arrive");
    // The caller hangs up mid-reply (a barge-in): the call is cut before its usage arrived.
    drop(chunks);
    live::eventually("cut turn recorded", Duration::from_secs(3), || async {
        count(
            &app,
            "select count(*) from usage_events where kind = 'live_turn_cut'",
        )
        .await
            == 1
    })
    .await;
    let (session, cost): (Option<Uuid>, f64) = sqlx::query_as(
        "select session_id, cost_usd::float8 from usage_events where kind = 'live_turn_cut'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(
        session.map(|s| s.to_string()),
        Some(id),
        "charged to its session"
    );
    assert!(cost > 0.0);
}

#[tokio::test]
async fn model_daily_cap_blocks_new_sessions() {
    let app = live::test_app(Options {
        env: &[("MODEL_DAILY_CAP_USD", "1.0")],
        ..Options::default()
    })
    .await;
    let cookie = app.guest().await;
    sqlx::query(
        "insert into usage_events (provider, kind, usage_phase, cost_usd) values ('anthropic', 'live_turn', 'build', 0.6)",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    assert_eq!(
        app.create(&cookie, short_req("fish")).await.status,
        StatusCode::OK
    );
    // Yesterday's spend does not count.
    sqlx::query(
        "insert into usage_events (provider, kind, usage_phase, cost_usd, created_at) \
         values ('anthropic', 'live_turn', 'build', 5.0, now() - interval '1 day')",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    assert_eq!(
        app.create(&cookie, short_req("fake")).await.status,
        StatusCode::OK
    );
    sqlx::query(
        "insert into usage_events (provider, kind, usage_phase, cost_usd) values ('anthropic', 'live_turn', 'build', 0.4)",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    for voice in ["fish", "fake"] {
        let res = app.create(&cookie, short_req(voice)).await;
        assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{}", res.body);
        assert_eq!(res.body["code"], "model_budget_reached");
    }
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(me.body["limits"]["reason"], "model_budget_reached");
}

/// A second process on the same database and Fish mock (a server restart).
async fn restarted(app: &live::TestApp, timing: ir_server::ws::SessionTiming) -> live::TestApp {
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
async fn resume_only_within_the_window_and_three_times() {
    let timing = ir_server::ws::SessionTiming {
        tick: Duration::from_secs(3600),
        ..Default::default()
    };
    let app = live::test_app(Options {
        timing: timing.clone(),
        ..Options::default()
    })
    .await;
    let cookie = app.guest().await;
    let make = || async {
        let res = app.create(&cookie, short_req("fish")).await;
        let id = res.body["session_id"].as_str().unwrap().to_string();
        let uuid = Uuid::parse_str(&id).unwrap();
        (id, uuid)
    };

    // Dropped 2 minutes ago: three resumes, then no more.
    let (id, uuid) = make().await;
    sqlx::query(
        "update sessions set status = 'live', started_at = now() - interval '5 minutes', \
                 last_socket_at = now() - interval '2 minutes' where id = $1",
    )
    .bind(uuid)
    .execute(&app.state.db)
    .await
    .unwrap();
    let app2 = restarted(&app, timing.clone()).await;
    for i in 0..3 {
        let res = app2
            .call(
                Method::POST,
                &format!("/api/sessions/{id}/resume"),
                Some(&cookie),
                None,
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "resume {i}: {}", res.body);
    }
    let res = app2
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/resume"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.body["code"], "resume_limit");
    // The note is queued once, however many resumes.
    let handle = app2.state.registry.get(&id).unwrap();
    let notes = handle
        .lock()
        .await
        .pending_notes
        .iter()
        .filter(|n| n.contains("dropped connection"))
        .count();
    assert_eq!(notes, 1);

    // Dropped 4 minutes ago: too late, and the startup sweep ends it.
    let (late, late_uuid) = make().await;
    sqlx::query(
        "update sessions set status = 'live', started_at = now() - interval '6 minutes', \
                 last_socket_at = now() - interval '4 minutes' where id = $1",
    )
    .bind(late_uuid)
    .execute(&app.state.db)
    .await
    .unwrap();
    let app3 = restarted(&app, timing).await;
    let res = app3
        .call(
            Method::POST,
            &format!("/api/sessions/{late}/resume"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.body);
    assert_eq!(res.body["code"], "resume_expired");
    persist::sweep(&app3.state).await.unwrap();
    let (status, reason): (String, Option<String>) =
        sqlx::query_as("select status, ended_reason from sessions where id = $1")
            .bind(late_uuid)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(
        (status.as_str(), reason.as_deref()),
        ("abandoned", Some("disconnected"))
    );
}

#[tokio::test]
async fn join_twice_returns_the_same_voice() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, full_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let path = format!("/api/sessions/{id}/panelists/p2/join");
    let body = json!({"opening_line": "Hi, I'm Ana."});
    let first = app
        .call(Method::POST, &path, Some(&cookie), Some(body.clone()))
        .await;
    let second = app
        .call(Method::POST, &path, Some(&cookie), Some(body))
        .await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.body, second.body, "the same voice again");
    assert_eq!(
        app.fish_calls("POST", "/v1/agent/sessions").await.len(),
        2,
        "floor + one for p2"
    );
    let handle = app.state.registry.get(&id).unwrap();
    let lines = handle
        .lock()
        .await
        .history
        .iter()
        .filter(|m| m.text() == "Hi, I'm Ana.")
        .count();
    assert_eq!(lines, 1, "the opening line enters the history once");
    let uuid = Uuid::parse_str(&id).unwrap();
    live::eventually(
        "one live voice at a time",
        Duration::from_secs(3),
        || async {
            let row = persist::fetch_session(&app.state.db, uuid)
                .await
                .unwrap()
                .unwrap();
            row.fish_entries()
                .iter()
                .filter(|e| e.ended_at.is_none())
                .count()
                == 1
        },
    )
    .await;
}

#[tokio::test]
async fn a_deferred_swap_join_is_silent_and_its_handover_marker_records_the_line_once() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, full_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    app.set_status(&id, ir_server::orchestrator::SessionStatus::Live)
        .await;
    // The director hands over: the floor moves and the line is prepared (the browser hears of it while p1 still
    // says its hand-off sentence).
    let line = "Hi, I'm Ana. Let's talk about what fails first.";
    let handle = app.state.registry.get(&id).unwrap();
    {
        let mut st = handle.lock().await;
        let events = st.apply_tool_calls(&[ir_server::orchestrator::tools::ToolCall {
            id: "toolu_h".into(),
            name: "hand_over".into(),
            input: json!({"to": "p2", "line": line}),
            panelist_id: "p1".into(),
        }]);
        assert_eq!(events.len(), 1);
    }
    let said = |st: &ir_server::orchestrator::SessionState| {
        st.history.iter().filter(|m| m.text() == line).count()
    };

    // Joined ahead of time, twice (a retry after a failed connect): one silent voice, nothing said or recorded.
    let path = format!("/api/sessions/{id}/panelists/p2/join");
    let body = json!({"deferred": true, "from": "p1", "opening_line": "Not this line."});
    let first = app
        .call(Method::POST, &path, Some(&cookie), Some(body.clone()))
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    let second = app
        .call(Method::POST, &path, Some(&cookie), Some(body))
        .await;
    assert_eq!(first.body, second.body, "the same voice again");
    let minted = app.fish_calls("POST", "/v1/agent/sessions").await;
    assert_eq!(minted.len(), 2, "floor + one for p2");
    assert!(
        minted[1]["overrides"]
            .get("first_message")
            .is_none_or(Value::is_null),
        "the new voice joins silent: {}",
        minted[1]
    );
    assert_eq!(minted[1]["llm_extra_body"]["panelist_id"], "p2");
    {
        let st = handle.lock().await;
        assert_eq!(said(&st), 0, "nothing is recorded at the join");
        assert_eq!(st.floor, "p2");
        assert_eq!(
            st.pending_handover.get("p2").map(String::as_str),
            Some(line)
        );
    }
    // p1 is still finishing its sentence: its voice is not ended by the join.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !app.fish_paths("POST")
            .await
            .iter()
            .any(|p| p.ends_with("fish-1/end")),
        "the outgoing voice keeps speaking"
    );

    // Once p1 is quiet the browser sends p2 the hand-over marker: the prepared line, word for word, no model call,
    // recorded once; a second marker does not say it again.
    let turn = |text: &str| {
        let body = json!({"model": "x", "stream": true,
            "messages": [{"role": "user", "content": text}],
            "fishaudio_extra_body": {"session_id": id, "panelist_id": "p2"}});
        axum::http::Request::post("/v1/chat/completions")
            .header(header::AUTHORIZATION, "Bearer test-llm-secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap()
    };
    use tower::ServiceExt;
    let model_calls = app.llm.requests.lock().unwrap().len();
    let res = app
        .router
        .clone()
        .oneshot(turn("[event: handover]"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let text = String::from_utf8(common::body_bytes(res).await).unwrap();
    assert!(
        text.contains("Let's talk about what fails first."),
        "{text}"
    );
    assert_eq!(app.llm.requests.lock().unwrap().len(), model_calls);
    {
        let st = handle.lock().await;
        assert_eq!(said(&st), 1, "the line is in the shared history once");
        assert!(!st.pending_handover.contains_key("p2"));
        assert_eq!(st.floor, "p2");
        assert_eq!(st.turns.last().unwrap().speaker, "p2");
    }
    let res = app
        .router
        .clone()
        .oneshot(turn("[event: handover]"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let _ = common::body_bytes(res).await;
    let st = handle.lock().await;
    assert_eq!(said(&st), 1, "never twice");
    drop(st);

    // The next hand-over's join ends the earlier voice that was kept.
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/panelists/p1/join"),
            Some(&cookie),
            Some(json!({"deferred": true, "from": "p2"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    live::eventually("p1's first voice ended", Duration::from_secs(3), || async {
        app.fish_paths("POST")
            .await
            .iter()
            .any(|p| p.ends_with("fish-1/end"))
    })
    .await;
    assert!(
        !app.fish_paths("POST")
            .await
            .iter()
            .any(|p| p.ends_with("fish-2/end")),
        "p2's voice is the outgoing one now"
    );
}

#[tokio::test]
async fn the_server_ends_the_outgoing_voice_when_the_browser_has_not_after_the_switch() {
    let app = live::test_app(Options {
        timing: ir_server::ws::SessionTiming {
            outgoing_voice_grace: Duration::from_millis(400),
            ..Default::default()
        },
        ..Options::default()
    })
    .await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, full_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    app.set_status(&id, ir_server::orchestrator::SessionStatus::Live)
        .await;
    let handle = app.state.registry.get(&id).unwrap();
    handle
        .lock()
        .await
        .apply_tool_calls(&[ir_server::orchestrator::tools::ToolCall {
            id: "toolu_h".into(),
            name: "hand_over".into(),
            input: json!({"to": "p2", "line": "Hi, I'm Ana."}),
            panelist_id: "p1".into(),
        }]);
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/panelists/p2/join"),
            Some(&cookie),
            Some(json!({"deferred": true, "from": "p1"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let ended = |fid: &'static str| {
        let app = &app;
        async move {
            app.fish_paths("POST")
                .await
                .iter()
                .any(|p| p.ends_with(&format!("{fid}/end")))
        }
    };
    // The browser switches (the new voice's marker) but never ends the old voice (the tab died).
    let body = json!({"model": "x", "stream": true,
        "messages": [{"role": "user", "content": "[event: handover]"}],
        "fishaudio_extra_body": {"session_id": id, "panelist_id": "p2"}});
    let req = axum::http::Request::post("/v1/chat/completions")
        .header(header::AUTHORIZATION, "Bearer test-llm-secret")
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    use tower::ServiceExt;
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let _ = common::body_bytes(res).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!ended("fish-1").await, "not before the grace");
    live::eventually(
        "the outgoing voice ended by the server",
        Duration::from_secs(3),
        || ended("fish-1"),
    )
    .await;
    assert!(!ended("fish-2").await, "the new floor keeps its voice");
    let uuid = Uuid::parse_str(&id).unwrap();
    let open = || async {
        let row = persist::fetch_session(&app.state.db, uuid)
            .await
            .unwrap()
            .unwrap();
        row.fish_entries()
            .into_iter()
            .filter(|e| e.ended_at.is_none())
            .map(|e| e.panelist_id)
            .collect::<Vec<_>>()
    };
    live::eventually(
        "only the new floor's voice left open",
        Duration::from_secs(3),
        || async { open().await == ["p2"] },
    )
    .await;
}

#[tokio::test]
async fn the_server_also_ends_the_outgoing_voice_after_a_hand_over_with_no_prepared_line() {
    let app = live::test_app(Options {
        timing: ir_server::ws::SessionTiming {
            outgoing_voice_grace: Duration::from_millis(300),
            ..Default::default()
        },
        ..Options::default()
    })
    .await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, full_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    app.set_status(&id, ir_server::orchestrator::SessionStatus::Live)
        .await;
    // A hand-over with no line (the app's own, for words addressed to p2): the marker gets a model turn.
    app.state
        .registry
        .get(&id)
        .unwrap()
        .lock()
        .await
        .apply_tool_calls(&[ir_server::orchestrator::tools::ToolCall {
            id: "toolu_h".into(),
            name: "hand_over".into(),
            input: json!({"to": "p2", "line": ""}),
            panelist_id: "p1".into(),
        }]);
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/panelists/p2/join"),
            Some(&cookie),
            Some(json!({"deferred": true, "from": "p1"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let body = json!({"model": "x", "stream": true,
        "messages": [{"role": "user", "content": "[event: handover]"}],
        "fishaudio_extra_body": {"session_id": id, "panelist_id": "p2"}});
    let req = axum::http::Request::post("/v1/chat/completions")
        .header(header::AUTHORIZATION, "Bearer test-llm-secret")
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    use tower::ServiceExt;
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let text = String::from_utf8(common::body_bytes(res).await).unwrap();
    assert!(text.contains("Hello there."), "a model turn: {text}");
    live::eventually(
        "the outgoing voice ended by the server",
        Duration::from_secs(3),
        || async {
            app.fish_paths("POST")
                .await
                .iter()
                .any(|p| p.ends_with("fish-1/end"))
        },
    )
    .await;
    assert!(
        !app.fish_paths("POST")
            .await
            .iter()
            .any(|p| p.ends_with("fish-2/end"))
    );
}

#[tokio::test]
async fn the_server_never_ends_a_voice_made_after_the_speakers_own() {
    // A queued second hand-over: the next panelist's voice is joined while the first new panelist says its line,
    // and its entry is saved before the line's turn. The server ends only the voices older than the speaker's.
    let app = live::test_app(Options {
        timing: ir_server::ws::SessionTiming {
            outgoing_voice_grace: Duration::from_millis(300),
            ..Default::default()
        },
        ..Options::default()
    })
    .await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, full_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    app.set_status(&id, ir_server::orchestrator::SessionStatus::Live)
        .await;
    let handle = app.state.registry.get(&id).unwrap();
    handle
        .lock()
        .await
        .apply_tool_calls(&[ir_server::orchestrator::tools::ToolCall {
            id: "toolu_h".into(),
            name: "hand_over".into(),
            input: json!({"to": "p2", "line": "Hi, I'm Ana."}),
            panelist_id: "p1".into(),
        }]);
    let join = |pid: &'static str, from: &'static str| {
        let app = &app;
        let path = format!("/api/sessions/{id}/panelists/{pid}/join");
        let cookie = cookie.clone();
        async move {
            app.call(
                Method::POST,
                &path,
                Some(&cookie),
                Some(json!({"deferred": true, "from": from})),
            )
            .await
        }
    };
    // p2 joins (fish-2); then the next hand-over back to p1 joins a new voice for p1 (fish-3) before p2's line.
    assert_eq!(join("p2", "p1").await.status, StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(join("p1", "p2").await.status, StatusCode::OK);
    let body = json!({"model": "x", "stream": true,
        "messages": [{"role": "user", "content": "[event: handover]"}],
        "fishaudio_extra_body": {"session_id": id, "panelist_id": "p2"}});
    let req = axum::http::Request::post("/v1/chat/completions")
        .header(header::AUTHORIZATION, "Bearer test-llm-secret")
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    use tower::ServiceExt;
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let text = String::from_utf8(common::body_bytes(res).await).unwrap();
    assert!(text.contains("Hi, I'm Ana."), "{text}");
    // Well past the grace: p1's new voice (fish-3) and p2's (fish-2) are still open.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let ended = app.fish_paths("POST").await;
    assert!(
        !ended.iter().any(|p| p.ends_with("fish-3/end")),
        "{ended:?}"
    );
    assert!(
        !ended.iter().any(|p| p.ends_with("fish-2/end")),
        "{ended:?}"
    );
    let uuid = Uuid::parse_str(&id).unwrap();
    let row = persist::fetch_session(&app.state.db, uuid)
        .await
        .unwrap()
        .unwrap();
    let mut open: Vec<String> = row
        .fish_entries()
        .into_iter()
        .filter(|e| e.ended_at.is_none())
        .map(|e| e.fish_session_id)
        .collect();
    open.sort();
    assert_eq!(open, ["fish-2", "fish-3"]);
}

#[tokio::test]
async fn concurrent_creates_take_the_last_slot_once() {
    let app = live::test_app(Options {
        env: &[("USAGE_PHASE", "judging")],
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let cookie = app.guest().await;
    for _ in 0..2 {
        let res = app.create(&cookie, short_req("fish")).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
        go_live(&base, &res.body).await;
    }
    // Unstarted sessions do not count, so all four are made; under the create lock each one replaces the ones
    // before it, so only one is left waiting to start.
    let results =
        futures::future::join_all((0..4).map(|_| app.create(&cookie, short_req("fish")))).await;
    let ok: Vec<&Value> = results
        .iter()
        .filter(|r| r.status == StatusCode::OK)
        .map(|r| &r.body)
        .collect();
    assert!(!ok.is_empty());
    live::eventually(
        "one unstarted session left",
        Duration::from_secs(3),
        || async {
            count(
                &app,
                "select count(*) from sessions where status = 'created'",
            )
            .await
                == 1
        },
    )
    .await;
    let waiting: Uuid = sqlx::query_scalar("select id from sessions where status = 'created'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let body = ok
        .iter()
        .find(|b| b["session_id"] == waiting.to_string())
        .expect("the one left was handed out");
    // It takes the last slot once it starts.
    go_live(&base, body).await;
    let res = app.create(&cookie, short_req("fish")).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{}", res.body);
    assert_eq!(res.body["code"], "guest_daily_limit");
}

#[tokio::test]
async fn deleting_me_settles_fish_first() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fish")).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = app
        .call(Method::DELETE, "/api/me", Some(&cookie), None)
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(count(&app, "select count(*) from sessions").await, 0);
    // The minutes stay in the ledger without the identity.
    let (n, who): (i64, Option<Uuid>) = sqlx::query_as(
        "select count(*), max(identity_id::text)::uuid from usage_events where provider = 'fish'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!((n, who), (1, None));
    assert!(
        app.fish_paths("POST")
            .await
            .iter()
            .any(|p| p.ends_with("fish-1/end"))
    );
}

#[tokio::test]
async fn an_unended_fish_session_is_not_billed_yet() {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let uuid = Uuid::parse_str(&id).unwrap();
    // Fish refuses to end fish-1 while `fail` is set.
    let fail = Arc::new(AtomicBool::new(true));
    let switch = fail.clone();
    Mock::given(method("POST"))
        .and(path("/v1/agent/sessions/fish-1/end"))
        .respond_with(move |_: &wiremock::Request| {
            ResponseTemplate::new(if switch.load(Ordering::SeqCst) {
                500
            } else {
                204
            })
        })
        .with_priority(1)
        .mount(&app.fish)
        .await;
    persist::end_session(&app.state, uuid, "user_ended")
        .await
        .unwrap();
    assert!(persist::settle_fish(&app.state, uuid).await.is_err());
    let row = persist::fetch_session(&app.state.db, uuid)
        .await
        .unwrap()
        .unwrap();
    assert!(
        row.fish_entries()[0].ended_at.is_none(),
        "still open, so not settled"
    );
    let settled: bool = sqlx::query_scalar("select fish_usage_recorded from sessions")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert!(!settled);
    assert_eq!(
        count(
            &app,
            "select count(*) from usage_events where provider = 'fish'"
        )
        .await,
        0
    );
    // Once Fish answers again, the retry ends and bills it.
    fail.store(false, Ordering::SeqCst);
    persist::settle_fish(&app.state, uuid).await.unwrap();
    assert_eq!(
        count(
            &app,
            "select count(*) from usage_events where provider = 'fish'"
        )
        .await,
        1
    );
}

#[tokio::test]
async fn identity_routes_need_a_known_cookie_except_the_first_visit() {
    let app = live::test_app(Options::default()).await;
    let res = app
        .call(
            Method::GET,
            &format!("/api/sessions/{}", Uuid::new_v4()),
            None,
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let res = app
        .call(
            Method::GET,
            "/api/me/history",
            Some("ir_id=0123456789abcdef0123456789abcdef"),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        count(&app, "select count(*) from identities").await,
        0,
        "no guest minted"
    );
}

/// Mounts a Fish mock that wins over the defaults: `POST {path}` answers `status` (after `delay`), with unique
/// session ids `{prefix}-N` on a 200.
async fn override_fish(
    app: &live::TestApp,
    path_str: &str,
    status: u16,
    delay: Duration,
    prefix: &'static str,
) {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};
    let n = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path(path_str))
        .respond_with(move |_: &wiremock::Request| {
            let i = n.fetch_add(1, Ordering::SeqCst) + 1;
            ResponseTemplate::new(status)
                .set_delay(delay)
                .set_body_json(json!({"session_id": format!("{prefix}-{i}"), "token": "t",
                    "livekit_url": "wss://x", "expires_at": "2026-11-13T12:00:00Z"}))
        })
        .with_priority(1)
        .mount(&app.fish)
        .await;
}

async fn fish_ended(app: &live::TestApp, fish_id: &str) -> bool {
    app.fish_paths("POST")
        .await
        .iter()
        .any(|p| p.ends_with(&format!("{fish_id}/end")))
}

#[tokio::test]
async fn a_resume_racing_the_end_leaves_no_fish_session_running() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    // From here on, minting takes 800 ms.
    override_fish(
        &app,
        "/v1/agent/sessions",
        200,
        Duration::from_millis(800),
        "slow",
    )
    .await;
    let resume_path = format!("/api/sessions/{id}/resume");
    let resume = app.call(Method::POST, &resume_path, Some(&cookie), None);
    let end = async {
        // End once the slow mint has reached Fish, so the end lands inside it.
        live::eventually("the resume is minting", Duration::from_secs(5), || async {
            app.fish_calls("POST", "/v1/agent/sessions").await.len() == 2
        })
        .await;
        app.call(
            Method::POST,
            &format!("/api/sessions/{id}/end"),
            Some(&cookie),
            Some(json!({"reason": "user_ended"})),
        )
        .await
    };
    let (resumed, ended) = tokio::join!(resume, end);
    assert_eq!(ended.status, StatusCode::ACCEPTED);
    // The round ended while the new voice was being minted: the resume is refused and that voice ended at once.
    assert_eq!(resumed.status, StatusCode::CONFLICT, "{}", resumed.body);
    assert!(
        fish_ended(&app, "slow-1").await,
        "the voice minted after the end was ended: {} {:?}",
        resumed.body,
        app.fish_paths("POST").await
    );
    // The original voice is ended and billed by settlement; nothing is left open.
    live::eventually("settled", Duration::from_secs(5), || async {
        count(
            &app,
            "select count(*) from usage_events where provider = 'fish'",
        )
        .await
            == 1
    })
    .await;
    assert!(fish_ended(&app, "fish-1").await);
    let row = persist::fetch_session(&app.state.db, Uuid::parse_str(&id).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert!(
        row.fish_entries().iter().all(|e| e.ended_at.is_some()),
        "{:?}",
        row.fish_entries()
    );
}

#[tokio::test]
async fn an_old_voice_that_will_not_end_stays_open_for_settlement() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, full_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let uuid = Uuid::parse_str(&id).unwrap();
    // Fish refuses to end the floor's first voice.
    override_fish(
        &app,
        "/v1/agent/sessions/fish-1/end",
        500,
        Duration::ZERO,
        "x",
    )
    .await;
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/panelists/p2/join"),
            Some(&cookie),
            Some(json!({})),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let row = persist::fetch_session(&app.state.db, uuid)
        .await
        .unwrap()
        .unwrap();
    let first = row
        .fish_entries()
        .into_iter()
        .find(|e| e.fish_session_id == "fish-1")
        .unwrap();
    assert!(
        first.ended_at.is_none(),
        "not marked ended without Fish's confirmation"
    );
    // The end and its settlement keep it open (and unbilled) while Fish still refuses.
    persist::end_session(&app.state, uuid, "user_ended")
        .await
        .unwrap();
    assert!(persist::settle_fish(&app.state, uuid).await.is_err());
    assert_eq!(
        count(
            &app,
            "select count(*) from usage_events where provider = 'fish'"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn the_sweep_skips_a_stuck_session_and_gives_up_after_enough_tries() {
    let app = live::test_app(Options::default()).await;
    let mut ids = Vec::new();
    for _ in 0..2 {
        // Two devices (one device's new session would replace its unstarted one).
        let cookie = app.guest().await;
        let res = app.create(&cookie, short_req("fish")).await;
        ids.push(Uuid::parse_str(res.body["session_id"].as_str().unwrap()).unwrap());
    }
    // Both ended a while ago and not settled yet; Fish will never end the first one's voice (fish-1).
    sqlx::query(
        "update sessions set status = 'abandoned', ended_at = now() - interval '2 minutes'",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    override_fish(
        &app,
        "/v1/agent/sessions/fish-1/end",
        500,
        Duration::ZERO,
        "x",
    )
    .await;
    persist::sweep(&app.state).await.unwrap();
    let settled = |id: Uuid| {
        let db = app.state.db.clone();
        async move {
            sqlx::query_as::<_, (bool, i32)>(
                "select fish_usage_recorded, fish_settle_attempts from sessions where id = $1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    assert_eq!(
        settled(ids[0]).await,
        (false, 1),
        "the stuck one is retried later"
    );
    assert!(settled(ids[1]).await.0, "the next one was not held up");

    // After enough tries the reservation is recorded as the estimate and the session is settled.
    sqlx::query("update sessions set fish_settle_attempts = $2 where id = $1")
        .bind(ids[0])
        .bind(persist::MAX_SETTLE_ATTEMPTS - 1)
        .execute(&app.state.db)
        .await
        .unwrap();
    persist::sweep(&app.state).await.unwrap();
    assert!(settled(ids[0]).await.0);
    let (cost, reserved): (f64, f64) = sqlx::query_as(
        "select e.cost_usd::float8, s.fish_reserved_usd::float8 from usage_events e join sessions s on s.id = e.session_id \
         where e.session_id = $1 and e.provider = 'fish'",
    )
    .bind(ids[0])
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert!(cost >= reserved - 1e-9, "{cost} < {reserved}");
}

#[tokio::test]
async fn fish_saying_gone_counts_as_ended() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fish")).await;
    let uuid = Uuid::parse_str(res.body["session_id"].as_str().unwrap()).unwrap();
    override_fish(
        &app,
        "/v1/agent/sessions/fish-1/end",
        410,
        Duration::ZERO,
        "x",
    )
    .await;
    persist::end_session(&app.state, uuid, "user_ended")
        .await
        .unwrap();
    persist::settle_fish(&app.state, uuid).await.unwrap();
    live::eventually("billed", Duration::from_secs(3), || async {
        count(
            &app,
            "select count(*) from usage_events where provider = 'fish'",
        )
        .await
            == 1
    })
    .await;
}

#[tokio::test]
async fn a_failed_resume_mint_keeps_the_old_token_and_does_not_count() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let res = app.create(&cookie, short_req("fish")).await;
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let uuid = Uuid::parse_str(&id).unwrap();
    let token = res.body["client_token"].as_str().unwrap().to_string();
    override_fish(&app, "/v1/agent/sessions", 500, Duration::ZERO, "x").await;
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/resume"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "{}", res.body);
    assert!(
        persist::check_token(&app.state.db, uuid, &token)
            .await
            .unwrap()
            .is_some(),
        "old token still works"
    );
    let used: i32 = sqlx::query_scalar("select resume_count from sessions where id = $1")
        .bind(uuid)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(used, 0);
    assert!(
        !fish_ended(&app, "fish-1").await,
        "the old voice was not ended"
    );
}

#[tokio::test]
async fn a_session_whose_hello_is_landing_is_never_replaced() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let first = app.create(&cookie, short_req("fake")).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    let id = first.body["session_id"].as_str().unwrap().to_string();
    // The hello has flipped the round live in memory; its database write has not landed yet.
    app.state
        .registry
        .get(&id)
        .expect("in memory")
        .lock()
        .await
        .status = ir_server::orchestrator::SessionStatus::Live;
    let second = app.create(&cookie, short_req("fake")).await;
    assert_eq!(second.status, StatusCode::OK, "{}", second.body);
    let (status, reason) = status_of(&app, &id).await;
    assert_eq!(status, "created", "not ended");
    assert_eq!(reason, None);
    assert!(app.state.registry.get(&id).is_some(), "still in memory");
}
