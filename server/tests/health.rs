mod common;

use std::time::Duration;

use axum::http::{StatusCode, header};
use ir_server::{AppState, router};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;

#[tokio::test]
async fn health_returns_ok_and_db_up() {
    let app = common::app().await;
    let res = common::get(app, "/healthz").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        common::body_json(res).await,
        json!({"ok": true, "db": true})
    );
}

#[tokio::test]
async fn health_reports_db_down_with_503() {
    // Nothing listens on port 1, so the pool can never hand out a connection.
    let url = "postgres://nobody:nothing@127.0.0.1:1/none";
    let pool = PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(500))
        .connect_lazy(url)
        .unwrap();
    let cfg = common::test_config(url, &common::temp_dir("public"));
    let app = router(AppState::new(pool, cfg));

    let res = common::get(app, "/healthz").await;
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        common::body_json(res).await,
        json!({"ok": false, "db": false})
    );
}

#[tokio::test]
async fn responses_carry_security_headers() {
    let app = common::app().await;
    let res = common::get(app, "/healthz").await;
    let h = res.headers();
    assert_eq!(
        h.get("permissions-policy").unwrap().to_str().unwrap(),
        "microphone=(self), xr-spatial-tracking=(self), camera=(), geolocation=()"
    );
    assert_eq!(h.get(header::X_CONTENT_TYPE_OPTIONS).unwrap(), "nosniff");
    assert!(h.get(header::STRICT_TRANSPORT_SECURITY).is_some());
    let csp = h
        .get(header::CONTENT_SECURITY_POLICY)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(
        csp.contains("connect-src 'self' wss://rounds.example.test"),
        "{csp}"
    );
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert_eq!(h.get(header::CACHE_CONTROL).unwrap(), "no-store");
}

#[tokio::test]
async fn web_app_routes_fall_back_to_index_html() {
    let public = common::temp_dir("public");
    std::fs::write(
        public.join("index.html"),
        "<!doctype html><title>IR</title>",
    )
    .unwrap();
    std::fs::create_dir_all(public.join("assets")).unwrap();
    std::fs::write(public.join("assets/app-abc123.js"), "console.log(1)").unwrap();
    let app = common::app_with_public(&public).await;

    let res = common::get(app.clone(), "/report/123").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-cache"
    );
    assert!(
        String::from_utf8(common::body_bytes(res).await)
            .unwrap()
            .contains("<title>IR</title>")
    );

    let res = common::get(app.clone(), "/assets/app-abc123.js").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=31536000, immutable"
    );

    let res = common::get(app, "/api/does-not-exist").await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let body = common::body_json(res).await;
    assert_eq!(body["status"], 404);
    assert_eq!(body["code"], "not_found");
}
