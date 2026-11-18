//! Ledger, caps, streak, daily round and skills. Needs Postgres (`DATABASE_URL`).

mod common;

use std::path::PathBuf;

use axum::http::{Method, StatusCode};
use chrono::{NaiveDate, TimeZone, Utc};
use common::live::{self, Options, full_req, go_live, short_req};
use ir_server::api::me;
use ir_server::claude::Usage;
use ir_server::config::UsagePhase;
use ir_server::content::Catalog;
use ir_server::usage;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn guest(db: &PgPool) -> Uuid {
    sqlx::query_scalar("insert into identities (kind) values ('guest') returning id")
        .fetch_one(db)
        .await
        .unwrap()
}

async fn scored_session(db: &PgPool, identity: Uuid, day: u32, round: &str) -> Uuid {
    let at = Utc.with_ymd_and_hms(2026, 11, day, 15, 0, 0).unwrap();
    sqlx::query_scalar(
        "insert into sessions (identity_id, mode, round_id, length, level, style, voice, status, created_at, started_at) \
         values ($1, 'interview', $2, 'short', 'mid', 'neutral', 'fake', 'scored', $3, $3) returning id",
    )
    .bind(identity)
    .bind(round)
    .bind(at)
    .fetch_one(db)
    .await
    .unwrap()
}

#[tokio::test]
async fn streak_counts_consecutive_days() {
    let app = live::test_app(Options::default()).await;
    let db = &app.state.db;
    let me_id = guest(db).await;
    for day in [10, 11, 12, 14] {
        scored_session(db, me_id, day, "sde.system_design.short").await;
    }
    // A session that was not scored does not count.
    sqlx::query(
        "insert into sessions (identity_id, mode, round_id, length, level, style, voice, status, created_at) \
         values ($1, 'interview', 'x', 'short', 'mid', 'neutral', 'fake', 'abandoned', '2026-11-13T10:00:00Z')",
    )
    .bind(me_id)
    .execute(db)
    .await
    .unwrap();
    let nov = |d| NaiveDate::from_ymd_opt(2026, 11, d).unwrap();
    let s = me::streak(db, me_id, nov(14)).await.unwrap();
    assert_eq!((s.current, s.best, s.today_done), (1, 3, true));
    let s = me::streak(db, me_id, nov(13)).await.unwrap();
    assert_eq!((s.current, s.best, s.today_done), (3, 3, false));
    let s = me::streak(db, me_id, nov(16)).await.unwrap();
    assert_eq!(s.current, 0);
}

#[test]
fn daily_round_rotates_the_roles_short_rounds() {
    let content = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../content");
    let cat = Catalog::load(&content).expect("repo content loads");
    let shorts: Vec<_> = cat
        .rounds
        .values()
        .filter(|r| r.role == "sde" && r.length == "short")
        .map(|r| r.id.clone())
        .collect();
    assert!(shorts.len() >= 2);
    let day = |d| NaiveDate::from_ymd_opt(2026, 1, 1).unwrap() + chrono::Days::new(d);
    let picked: Vec<String> = (0..shorts.len() as u64)
        .map(|d| me::daily_round(&cat, day(d), "sde").unwrap().0)
        .collect();
    assert_eq!(picked, shorts, "one per day, in order");
    assert_eq!(
        me::daily_round(&cat, day(shorts.len() as u64), "sde")
            .unwrap()
            .0,
        shorts[0]
    );
    assert!(
        me::daily_round(&cat, day(0), "pm")
            .unwrap()
            .0
            .starts_with("pm.")
    );
    assert!(me::daily_round(&cat, day(0), "chef").is_none());
}

#[tokio::test]
async fn judge_budget_blocks_guests() {
    let app = live::test_app(Options {
        env: &[("USAGE_PHASE", "judging"), ("JUDGE_CAP_USD", "1.0")],
        ..Options::default()
    })
    .await;
    let cookie = app.guest().await;
    // A fake-voice round fits; a Fish round would reserve $0.63 on top of $0.50 spent.
    sqlx::query(
        "insert into usage_events (provider, kind, usage_phase, cost_usd) values ('anthropic', 'scoring', 'judging', 0.5)",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    assert_eq!(
        app.create(&cookie, short_req("fake")).await.status,
        StatusCode::OK
    );
    let res = app.create(&cookie, short_req("fish")).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.body["code"], "judge_budget_reached");
}

#[tokio::test]
async fn abandoned_rounds_do_not_count_against_a_guest() {
    let app = live::test_app(Options {
        env: &[("USAGE_PHASE", "judging")],
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let cookie = app.guest().await;
    for length in [
        short_req("fake"),
        short_req("fake"),
        short_req("fake"),
        full_req("fake"),
    ] {
        let res = app.create(&cookie, length).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
        go_live(&base, &res.body).await;
    }
    assert_eq!(
        app.create(&cookie, short_req("fake")).await.body["code"],
        "guest_daily_limit"
    );
    assert_eq!(
        app.create(&cookie, full_req("fake")).await.body["code"],
        "guest_full_used"
    );
    // The candidate left all four without ever speaking.
    sqlx::query("update sessions set status = 'abandoned', ended_at = now()")
        .execute(&app.state.db)
        .await
        .unwrap();
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(me.body["limits"]["short_left_today"], 3);
    assert_eq!(me.body["limits"]["full_left"], 1);
    assert!(me.body["limits"]["reason"].is_null());
    assert_eq!(
        app.create(&cookie, short_req("fake")).await.status,
        StatusCode::OK
    );
    assert_eq!(
        app.create(&cookie, full_req("fake")).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn after_judging_guests_get_one_quick_round() {
    let app = live::test_app(Options {
        env: &[("USAGE_PHASE", "after")],
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let cookie = app.guest().await;
    assert_eq!(
        app.create(&cookie, full_req("fake")).await.body["code"],
        "guest_full_used"
    );
    let res = app.create(&cookie, short_req("fake")).await;
    assert_eq!(res.status, StatusCode::OK);
    go_live(&base, &res.body).await;
    let res = app.create(&cookie, short_req("fake")).await;
    assert_eq!(res.body["code"], "guest_daily_limit");
    assert!(res.body["resets_at"].is_null());
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(
        me.body["limits"],
        json!({"short_left_today": 0, "full_left": 0, "resets_at": null, "reason": "guest_daily_limit"})
    );
}

#[tokio::test]
async fn signed_in_free_users_get_two_rounds() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let cookie = app.guest().await;
    // Sign-in is a later step; promote the identity by hand.
    sqlx::query("update identities set kind = 'user', google_sub = 'g-1', name = 'Sam'")
        .execute(&app.state.db)
        .await
        .unwrap();
    for _ in 0..2 {
        let res = app.create(&cookie, short_req("fake")).await;
        assert_eq!(res.status, StatusCode::OK);
        go_live(&base, &res.body).await;
    }
    let res = app.create(&cookie, short_req("fake")).await;
    assert_eq!(res.body["code"], "free_rounds_used");
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(me.body["identity"], json!({"kind": "user", "name": "Sam"}));
    assert_eq!(me.body["entitlements"]["plan"], "free");
    assert_eq!(me.body["entitlements"]["free_rounds_left"], 0);
}

#[tokio::test]
async fn model_calls_are_priced_into_the_ledger() {
    let app = live::test_app(Options::default()).await;
    let db = &app.state.db;
    let id = guest(db).await;
    let session = scored_session(db, id, 10, "sde.system_design.short").await;
    let cost = usage::record_claude(
        db,
        UsagePhase::Judging,
        Some(session),
        "scoring",
        "claude-sonnet-5-5",
        &Usage {
            input_tokens: 10_000,
            output_tokens: 2_000,
            cache_read_input_tokens: 50_000,
            cache_creation_input_tokens: 0,
        },
    )
    .await
    .unwrap();
    // 10k x $2 + 2k x $10 + 50k x $0.10 per million.
    assert!((cost - 0.045).abs() < 1e-9, "{cost}");
    let (who, phase, total): (Option<Uuid>, String, f64) = sqlx::query_as(
        "select e.identity_id, e.usage_phase, s.cost_usd::float8 from usage_events e join sessions s on s.id = e.session_id",
    )
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(who, Some(id));
    assert_eq!(phase, "judging");
    assert!((total - 0.045).abs() < 1e-9);
}

#[tokio::test]
async fn skills_follow_the_last_scored_sessions() {
    let app = live::test_app(Options::default()).await;
    let db = &app.state.db;
    let id = guest(db).await;
    for (day, score) in [(10, 2), (11, 3)] {
        let s = scored_session(db, id, day, "sde.system_design.short").await;
        sqlx::query("insert into reports (session_id, report) values ($1, $2)")
            .bind(s)
            .bind(json!({"headline": {"summary": "Clear scoping."},
                "competencies": [{"id": "scoping", "name": "Scoping", "score": score},
                                 {"id": "depth", "name": "Depth", "score": null}]}))
            .execute(db)
            .await
            .unwrap();
    }
    let skills = me::skills(db, &app.state.catalog, id, Some("sde"))
        .await
        .unwrap();
    let list = skills["competencies"].as_array().unwrap();
    assert_eq!(list.len(), 1, "null scores are not plotted: {skills}");
    assert_eq!(list[0]["id"], "scoping");
    let scores: Vec<_> = list[0]["points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["score"].clone())
        .collect();
    assert_eq!(scores, vec![json!(2.0), json!(3.0)], "oldest first");
    let none = me::skills(db, &app.state.catalog, id, Some("pm"))
        .await
        .unwrap();
    assert_eq!(none["competencies"], json!([]));
}

#[tokio::test]
async fn settings_round_trip_and_validate() {
    let app = live::test_app(Options::default()).await;
    let cookie = app.guest().await;
    let mut s = app
        .call(Method::GET, "/api/me", Some(&cookie), None)
        .await
        .body["settings"]
        .clone();
    assert_eq!(s["default_level"], "mid");
    s["voice_speed"] = json!(1.1);
    s["default_role"] = json!("pm");
    let res = app
        .call(
            Method::PUT,
            "/api/me/settings",
            Some(&cookie),
            Some(s.clone()),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(me.body["settings"], s);
    assert!(me.body["daily"]["round_id"].is_string() || me.body["daily"].is_null());
    s["voice_speed"] = json!(3);
    let res = app
        .call(Method::PUT, "/api/me/settings", Some(&cookie), Some(s))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);

    let res = app
        .call(Method::POST, "/api/me/onboarding-done", Some(&cookie), None)
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    let me = app.call(Method::GET, "/api/me", Some(&cookie), None).await;
    assert_eq!(me.body["onboarding_done"], true);

    let res = app
        .call(Method::DELETE, "/api/me", Some(&cookie), None)
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    let n: i64 = sqlx::query_scalar("select count(*) from identities")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

/// A model that is always overloaded.
struct Down;

#[async_trait::async_trait]
impl ir_server::orchestrator::LlmApi for Down {
    async fn create(
        &self,
        _req: &ir_server::claude::MessagesRequest,
    ) -> Result<ir_server::claude::MessagesResponse, ir_server::claude::ClaudeError> {
        Err(ir_server::claude::ClaudeError::Overloaded)
    }

    async fn stream(
        &self,
        _req: &ir_server::claude::MessagesRequest,
    ) -> Result<
        futures::stream::BoxStream<
            'static,
            Result<ir_server::claude::StreamEvent, ir_server::claude::ClaudeError>,
        >,
        ir_server::claude::ClaudeError,
    > {
        Err(ir_server::claude::ClaudeError::RateLimited { retry_after: None })
    }
}

#[tokio::test]
async fn failed_model_calls_are_ledgered_at_zero_cost_with_the_error_kind() {
    use ir_server::orchestrator::LlmApi;
    let app = live::test_app(Options::default()).await;
    let db = &app.state.db;
    let id = guest(db).await;
    let session = scored_session(db, id, 10, "sde.system_design.short").await;
    let llm = usage::MeteredLlm::new(std::sync::Arc::new(Down), db.clone(), UsagePhase::Build);
    let req = ir_server::claude::MessagesRequest {
        model: "claude-sonnet-5-5".into(),
        max_tokens: 100,
        messages: vec![ir_server::claude::Message::user_text("secret words")],
        ..Default::default()
    };
    usage::LLM_SESSION
        .scope(session, async {
            assert!(llm.create(&req).await.is_err());
            assert!(llm.stream(&req).await.is_err());
        })
        .await;
    let rows: Vec<(String, String, f64, serde_json::Value)> = {
        let mut rows = Vec::new();
        for _ in 0..50 {
            rows = sqlx::query_as(
                "select kind, model, cost_usd::float8, meta from usage_events \
                 where session_id = $1 and kind = 'model_error' order by meta->>'call'",
            )
            .bind(session)
            .fetch_all(db)
            .await
            .unwrap();
            if rows.len() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        rows
    };
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[0].1, "claude-sonnet-5-5");
    assert_eq!(rows[0].2, 0.0);
    assert_eq!(
        rows[0].3,
        json!({"call": "model_call", "error": "overloaded", "status": 529})
    );
    assert_eq!(
        rows[1].3,
        json!({"call": "stream", "error": "rate_limited", "status": 429})
    );
    // The error's class only: no request or error text.
    assert!(!rows.iter().any(|r| r.3.to_string().contains("secret")));
}
