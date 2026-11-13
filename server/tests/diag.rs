//! Device check routes: results store, read back, echo voice session. Needs Postgres (remote.sh --pg).

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::live::{self, Options};
use ir_server::api::diag::{ECHO_PASSAGE, MAX_BYTES, PER_IDENTITY_PER_HOUR};
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
async fn echo_session_needs_the_dev_key_and_reads_the_passage_without_an_app_session() {
    let app = live::test_app(Options::default()).await;
    let res = app.call(Method::POST, "/api/diag/echo", None, None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert!(
        app.fish_calls("POST", "/v1/agent/sessions")
            .await
            .is_empty()
    );

    let res = app
        .call_with(Method::POST, "/api/diag/echo", None, None, &[KEY])
        .await;
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
}

#[tokio::test]
async fn echo_session_respects_the_fish_build_cap() {
    let app = live::test_app(Options {
        env: &[
            ("FISH_BUILD_SPENT_USD", "13.95"),
            ("FISH_BUILD_CAP_USD", "14"),
        ],
        ..Options::default()
    })
    .await;
    let res = app
        .call_with(Method::POST, "/api/diag/echo", None, None, &[KEY])
        .await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{}", res.body);
    assert_eq!(res.body["code"], "fish_cap");
    assert!(
        app.fish_calls("POST", "/v1/agent/sessions")
            .await
            .is_empty()
    );
}
