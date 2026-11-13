//! Shared helpers for integration tests. Tests that touch Postgres need `DATABASE_URL`
//! (run them through `plan/ops-tools/remote.sh <worktree> rust --pg -- cargo test`).
#![allow(dead_code)]

pub mod live;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, Response};
use http_body_util::BodyExt;
use ir_server::{AppState, Config, db, router};
use tower::ServiceExt;

pub fn database_url() -> String {
    std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set for database tests (use remote.sh with --pg)")
}

pub fn test_config(database_url: &str, public_dir: &Path) -> Config {
    test_config_with(database_url, public_dir, &[])
}

/// The test config with some variables overridden or added.
pub fn test_config_with(database_url: &str, public_dir: &Path, extra: &[(&str, &str)]) -> Config {
    let mut env: HashMap<&str, String> = [
        ("DATABASE_URL", database_url.to_string()),
        ("APP_ORIGIN", "https://rounds.example.test".to_string()),
        ("PUBLIC_DIR", public_dir.display().to_string()),
        ("ANTHROPIC_API_KEY", "test-anthropic-key".to_string()),
        ("ANTHROPIC_WORKSPACE_ID", "test-workspace".to_string()),
        ("FISH_AUDIO_API_KEY", "test-fish-key".to_string()),
        ("FISH_AGENT_ID", "test-agent".to_string()),
        ("FISH_LLM_SECRET", "test-llm-secret".to_string()),
        ("DEV_KEY", "test-dev-key".to_string()),
    ]
    .into_iter()
    .collect();
    for (k, v) in extra {
        env.insert(k, v.to_string());
    }
    Config::from_lookup(|k| env.get(k).cloned()).expect("test config")
}

/// A fresh, empty directory under the system temp dir.
pub fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ir-test-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// Router backed by the test database (migrations applied) and the given public dir.
pub async fn app_with_public(public_dir: &Path) -> Router {
    let url = database_url();
    let pool = db::connect_url(&url)
        .await
        .expect("connect + migrate test database");
    router(AppState::new(pool, test_config(&url, public_dir)))
}

pub async fn app() -> Router {
    app_with_public(&temp_dir("public")).await
}

pub async fn get(app: Router, path: &str) -> Response<Body> {
    app.oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .expect("router never fails")
}

pub async fn body_bytes(res: Response<Body>) -> Vec<u8> {
    res.into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes()
        .to_vec()
}

pub async fn body_json(res: Response<Body>) -> serde_json::Value {
    serde_json::from_slice(&body_bytes(res).await).expect("json body")
}

/// A new empty database next to the test one (migrated), so spend totals and counts are per test.
pub async fn fresh_database() -> String {
    use sqlx::Connection;
    let base = database_url();
    let name = format!("t_{}", uuid::Uuid::new_v4().simple());
    let mut conn = sqlx::PgConnection::connect(&base)
        .await
        .expect("connect to the test server");
    // The name is a fresh uuid in hex: nothing from outside reaches the SQL.
    sqlx::query(sqlx::AssertSqlSafe(format!("create database {name}")))
        .execute(&mut conn)
        .await
        .expect("create database");
    let (prefix, _) = base.rsplit_once('/').expect("database url has a path");
    format!("{prefix}/{name}")
}
