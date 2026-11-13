//! Device check routes: results store, read back, echo voice session. Needs Postgres (remote.sh --pg).

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::live::{self, Options};
use ir_server::api::diag::{
    ECHO_PASSAGE, ECHO_PER_IDENTITY_PER_HOUR, MAX_BYTES, PER_IDENTITY_PER_HOUR,
};
use serde_json::json;
use tower::ServiceExt;

const KEY: (&str, &str) = ("x-dev-key", "test-dev-key");

#[tokio::test]
async fn results_are_stored_per_identity_and_read_back_with_the_dev_key() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let payload = json!({"version": 1, "fps": {"p50": 13.9}, "note": "seated at a desk"});
    let res = app
        .call(Method::POST, "/api/diag", Some(&me), Some(payload.clone()))
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.body);
    assert!(res.body["id"].as_i64().is_some());

    // Without the dev key the results are not there at all.
    let res = app.call(Method::GET, "/api/diag/latest", None, None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    let res = app
        .call_with(
            Method::GET,
            "/api/diag/latest",
            None,
            None,
            &[("x-dev-key", "wrong")],
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);

    let second = json!({"version": 1, "note": "second run"});
    app.call(Method::POST, "/api/diag", Some(&me), Some(second.clone()))
        .await;
    let res = app
        .call_with(Method::GET, "/api/diag/latest?limit=1", None, None, &[KEY])
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let items = res.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["payload"], second);
    let res = app
        .call_with(Method::GET, "/api/diag/latest", None, None, &[KEY])
        .await;
    let items = res.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[1]["payload"], payload);
}

#[tokio::test]
async fn results_need_an_identity_and_a_json_object() {
    let app = live::test_app(Options::default()).await;
    let res = app
        .call(Method::POST, "/api/diag", None, Some(json!({"a": 1})))
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);

    let me = app.guest().await;
    let res = app
        .call(Method::POST, "/api/diag", Some(&me), Some(json!([1, 2])))
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);

    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/diag")
        .header(header::COOKIE, &me)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{not json"))
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn results_over_64_kb_are_refused() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let big = json!({"note": "x".repeat(MAX_BYTES)});
    let res = app
        .call(Method::POST, "/api/diag", Some(&me), Some(big))
        .await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
    let count: i64 = sqlx::query_scalar("select count(*) from diag_results")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn results_are_rate_limited_per_identity() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    for i in 0..PER_IDENTITY_PER_HOUR {
        let res = app
            .call(Method::POST, "/api/diag", Some(&me), Some(json!({"i": i})))
            .await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.body);
    }
    let res = app
        .call(
            Method::POST,
            "/api/diag",
            Some(&me),
            Some(json!({"i": "over"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.body["code"], "diag_limit");
    // Someone else is not affected.
    let other = app.guest().await;
    let res = app
        .call(
            Method::POST,
            "/api/diag",
            Some(&other),
            Some(json!({"i": 0})),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
}

#[tokio::test]
async fn results_with_a_nul_character_are_refused_and_old_results_are_dropped() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let res = app
        .call(
            Method::POST,
            "/api/diag",
            Some(&me),
            Some(json!({"note": "a\u{0}b"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.body);
    let id: uuid::Uuid = sqlx::query_scalar("select id from identities limit 1")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    sqlx::query(
        "insert into diag_results (identity_id, payload, created_at) values ($1, '{}', now() - interval '31 days')",
    )
    .bind(id)
    .execute(&app.state.db)
    .await
    .unwrap();
    let res = app
        .call(Method::POST, "/api/diag", Some(&me), Some(json!({"ok": 1})))
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    let left: i64 = sqlx::query_scalar("select count(*) from diag_results")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(left, 1);
}

async fn echo(app: &live::TestApp, cookie: Option<&str>, key: bool) -> live::Res {
    let keys: &[(&str, &str)] = if key { &[KEY] } else { &[] };
    app.call_with(Method::POST, "/api/diag/echo", cookie, None, keys)
        .await
}

#[tokio::test]
async fn echo_session_needs_an_identity_and_the_dev_key_and_reads_the_passage_without_an_app_session()
 {
    let app = live::test_app(Options::default()).await;
    assert_eq!(
        echo(&app, None, true).await.status,
        StatusCode::UNAUTHORIZED
    );
    let me = app.guest().await;
    assert_eq!(
        echo(&app, Some(&me), false).await.status,
        StatusCode::NOT_FOUND
    );
    assert!(
        app.fish_calls("POST", "/v1/agent/sessions")
            .await
            .is_empty()
    );

    let res = echo(&app, Some(&me), true).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(res.body["voice"]["transport"], "fish");
    assert_eq!(res.body["voice"]["fish"]["token"], "tok-1");
    assert_eq!(
        res.body["voice"]["fish"]["livekit_url"],
        "wss://x.livekit.cloud"
    );
    assert_eq!(res.body["passage"], ECHO_PASSAGE);

    let calls = app.fish_calls("POST", "/v1/agent/sessions").await;
    assert_eq!(calls.len(), 1);
    let sent = &calls[0];
    assert_eq!(sent["overrides"]["first_message"], ECHO_PASSAGE);
    assert_eq!(sent["overrides"]["voice_id"], "voice-ana");
    // No app session id: anything the agent hears never reaches a round.
    assert!(sent["llm_extra_body"].get("session_id").is_none());
    assert_eq!(sent["llm_extra_body"]["diag"], "echo");
    assert_eq!(sent["record_audio"], false);

    // Charged to the ledger at its two minute worst case.
    let (minutes, cost, phase, fish_id): (f64, f64, String, String) = sqlx::query_as(
        "select minutes::float8, cost_usd::float8, usage_phase, meta->>'fish_session_id' from usage_events \
         where kind = 'diag_echo' and provider = 'fish'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(minutes, 2.0);
    assert!((cost - 0.14).abs() < 1e-9);
    assert_eq!(phase, "build");
    assert_eq!(fish_id, "fish-1");
}

#[tokio::test]
async fn echo_session_is_limited_per_identity() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    for _ in 0..ECHO_PER_IDENTITY_PER_HOUR {
        let res = echo(&app, Some(&me), true).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    }
    let res = echo(&app, Some(&me), true).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.body["code"], "echo_limit");
    assert_eq!(
        app.fish_calls("POST", "/v1/agent/sessions").await.len() as i64,
        ECHO_PER_IDENTITY_PER_HOUR
    );
}

#[tokio::test]
async fn echo_session_respects_the_fish_build_cap_including_earlier_echo_runs() {
    let app = live::test_app(Options {
        env: &[
            ("FISH_BUILD_SPENT_USD", "13.75"),
            ("FISH_BUILD_CAP_USD", "14"),
        ],
        ..Options::default()
    })
    .await;
    let me = app.guest().await;
    // 13.75 + 0.14 fits; the second run would pass the cap only because the first is in the ledger.
    assert_eq!(echo(&app, Some(&me), true).await.status, StatusCode::OK);
    let res = echo(&app, Some(&me), true).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{}", res.body);
    assert_eq!(res.body["code"], "fish_cap");
    assert_eq!(app.fish_calls("POST", "/v1/agent/sessions").await.len(), 1);
}
