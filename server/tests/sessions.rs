//! Sessions API: guest identity, create (caps, fake and Fish voices), resume, swap hand-over, end.
//! Needs Postgres (remote.sh --pg); Fish is a mock server and the model a fake.

mod common;

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode, header};
use chrono::{DateTime, Utc};
use common::live::{self, Options, full_req, short_req};
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
    assert_eq!(app.llm.prewarms.load(Ordering::SeqCst), 1);

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
    let cost: f64 = sqlx::query_scalar(
        "select cost_usd::float8 from usage_events where provider = 'anthropic'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    // 1000 in x $4 + 100 out x $20 per million on the default model.
    assert!((cost - 0.006).abs() < 1e-9, "{cost}");
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
    let cookie = app.guest().await;
    for i in 0..3 {
        let res = app.create(&cookie, short_req("fake")).await;
        assert_eq!(res.status, StatusCode::OK, "round {i}: {}", res.body);
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
    let res = app.create(&cookie, full_req("fake")).await;
    assert_eq!(res.body["code"], "guest_full_used");

    // Another device is not affected.
    let other = app.guest().await;
    assert_eq!(
        app.create(&other, short_req("fake")).await.status,
        StatusCode::OK
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
    sqlx::query("update sessions set status = 'live', started_at = now() where id = $1")
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
                .any(|n| n.contains("connection dropped"))
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
    assert!(row.fish_entries()[0].ended_at.is_some());

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
