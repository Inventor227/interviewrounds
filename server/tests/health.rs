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

#[tokio::test]
async fn missing_assets_are_404_not_the_web_app() {
    let public = common::temp_dir("public");
    std::fs::write(
        public.join("index.html"),
        "<!doctype html><title>IR</title>",
    )
    .unwrap();
    std::fs::create_dir_all(public.join("assets")).unwrap();
    std::fs::write(public.join("assets/app-abc123.js"), "console.log(1)").unwrap();
    let app = common::app_with_public(&public).await;

    let res = common::get(app.clone(), "/assets/app-old999.js").await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_ne!(
        res.headers()
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap().to_string()),
        Some("public, max-age=31536000, immutable".to_string())
    );
    let body = common::body_bytes(res).await;
    assert!(!String::from_utf8_lossy(&body).contains("<title>IR</title>"));

    let res = common::get(app, "/assets/app-abc123.js").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=31536000, immutable"
    );
}

#[tokio::test]
async fn only_the_transcoder_worker_may_eval() {
    let public = common::temp_dir("public");
    std::fs::write(
        public.join("index.html"),
        "<!doctype html><title>IR</title>",
    )
    .unwrap();
    std::fs::create_dir_all(public.join("vendor/basis")).unwrap();
    std::fs::write(public.join("vendor/basis/ktx2_worker.js"), "self.x = 1").unwrap();
    std::fs::write(public.join("vendor/basis/basis_transcoder.js"), "var BASIS").unwrap();
    let app = common::app_with_public(&public).await;
    let csp = |res: &axum::response::Response| {
        res.headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    };

    let res = common::get(app.clone(), ir_server::app::KTX2_WORKER_PATH).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(csp(&res), ir_server::app::KTX2_WORKER_CSP);
    assert!(csp(&res).contains("'unsafe-eval'"));

    // The page and every other file keep the strict policy.
    for path in ["/", "/round/x", "/vendor/basis/basis_transcoder.js"] {
        let res = common::get(app.clone(), path).await;
        assert_eq!(res.status(), StatusCode::OK, "{path}");
        let c = csp(&res);
        assert!(!c.contains("'unsafe-eval'"), "{path}: {c}");
        assert!(c.contains("script-src 'self' 'wasm-unsafe-eval'"), "{path}: {c}");
    }
}

#[tokio::test]
async fn a_panicking_handler_answers_500_and_the_server_keeps_serving() {
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;

    async fn boom() -> &'static str {
        panic!("user text broke a parser")
    }
    let app: Router = Router::new()
        .route("/boom", get(boom))
        .route("/ok", get(|| async { "ok" }))
        .layer(ir_server::app::catch_panic());
    let res = app
        .clone()
        .oneshot(
            axum::http::Request::get("/boom")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = axum::body::to_bytes(res.into_body(), 4096).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["code"], "server_error");
    assert!(
        !v.to_string().contains("parser"),
        "the panic text stays in the log"
    );
    let res = app
        .oneshot(axum::http::Request::get("/ok").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}
