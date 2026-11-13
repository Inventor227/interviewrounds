//! Postgres pool and migrations.

use std::time::Duration;

use anyhow::Context;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use crate::config::Config;

/// Connects to Postgres and runs every pending migration in `server/migrations`.
pub async fn connect(cfg: &Config) -> anyhow::Result<PgPool> {
    connect_url(&cfg.database_url).await
}

/// Same as [`connect`], from a bare URL (used by tests and tools).
pub async fn connect_url(database_url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(database_url)
        .await
        .context("connecting to Postgres (check DATABASE_URL)")?;
    sqlx::migrate!()
        .run(&pool)
        .await
        .context("running database migrations")?;
    Ok(pool)
}

/// Runs `select 1` with a short timeout. True when the database answered.
pub async fn ping(pool: &PgPool) -> bool {
    let probe = sqlx::query_scalar::<_, i32>("select 1").fetch_one(pool);
    matches!(
        tokio::time::timeout(Duration::from_secs(2), probe).await,
        Ok(Ok(1))
    )
}
