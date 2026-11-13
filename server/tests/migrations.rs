mod common;

use ir_server::db;
use sqlx::PgPool;
use uuid::Uuid;

async fn pool() -> PgPool {
    db::connect_url(&common::database_url())
        .await
        .expect("connect + migrate")
}

async fn new_guest(pool: &PgPool) -> Uuid {
    sqlx::query_scalar("insert into identities (kind) values ('guest') returning id")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn new_session(pool: &PgPool, identity: Uuid) -> Uuid {
    sqlx::query_scalar(
        "insert into sessions (identity_id, mode, round_id, length, level, style, voice)
         values ($1, 'interview', 'swe-coding-short', 'short', 'mid', 'neutral', 'fake')
         returning id",
    )
    .bind(identity)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn migration_creates_all_tables() {
    let pool = pool().await;
    let tables: Vec<String> = sqlx::query_scalar(
        "select table_name::text from information_schema.tables where table_schema = current_schema()",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let expected = [
        "identities",
        "settings",
        "sessions",
        "turns",
        "marks",
        "head_batches",
        "board_ops",
        "boards",
        "board_images",
        "reports",
        "meeting_plans",
        "usage_events",
        "shares",
        "entitlements",
    ];
    let missing: Vec<_> = expected
        .iter()
        .filter(|t| !tables.iter().any(|x| x == *t))
        .collect();
    assert!(missing.is_empty(), "missing tables: {missing:?}");
}

#[tokio::test]
async fn session_status_accepts_protocol_values_only() {
    let pool = pool().await;
    let session = new_session(&pool, new_guest(&pool).await).await;
    for status in [
        "created",
        "live",
        "paused",
        "scoring",
        "scored",
        "failed",
        "abandoned",
    ] {
        sqlx::query("update sessions set status = $1 where id = $2")
            .bind(status)
            .bind(session)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("{status} rejected: {e}"));
    }
    let bad = sqlx::query("update sessions set status = 'running' where id = $1")
        .bind(session)
        .execute(&pool)
        .await;
    assert!(bad.is_err(), "unknown status was accepted");
}

#[tokio::test]
async fn board_ops_and_marks_are_unique_per_session() {
    let pool = pool().await;
    let identity = new_guest(&pool).await;
    let a = new_session(&pool, identity).await;
    let b = new_session(&pool, identity).await;

    let insert_op = "insert into board_ops (session_id, op_id, rev_base, src, op, at_ms)
                     values ($1, 'op-1', 0, 'hand', 'add_card', 10)";
    sqlx::query(insert_op).bind(a).execute(&pool).await.unwrap();
    assert!(
        sqlx::query(insert_op).bind(a).execute(&pool).await.is_err(),
        "duplicate op_id accepted"
    );
    sqlx::query(insert_op)
        .bind(b)
        .execute(&pool)
        .await
        .expect("same op_id in another session");

    // Server-originated ops (interviewer or Scribe) carry no rev_base or at_ms.
    sqlx::query(
        "insert into board_ops (session_id, op_id, src, op, accepted, t_ms)
         values ($1, 'srv-1', 'interviewer', 'add_card', true, 42)",
    )
    .bind(a)
    .execute(&pool)
    .await
    .expect("server op without rev_base and at_ms");

    // Upsert rule: a rejected op_id may be sent again and is re-evaluated;
    // an accepted one is left alone.
    sqlx::query(
        "insert into board_ops (session_id, op_id, rev_base, src, op, at_ms, accepted)
         values ($1, 'op-2', 0, 'hand', 'add_card', 20, false)",
    )
    .bind(a)
    .execute(&pool)
    .await
    .unwrap();
    let upsert = "insert into board_ops (session_id, op_id, rev_base, src, op, at_ms, accepted)
                  values ($1, $2, 1, 'hand', 'add_card', 30, true)
                  on conflict (session_id, op_id) do update
                  set rev_base = excluded.rev_base, at_ms = excluded.at_ms,
                      accepted = excluded.accepted
                  where board_ops.accepted = false";
    for op_id in ["op-2", "srv-1"] {
        sqlx::query(upsert)
            .bind(a)
            .bind(op_id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("upsert {op_id}: {e}"));
    }
    let rows: Vec<(String, Option<i64>, Option<bool>)> = sqlx::query_as(
        "select op_id, rev_base, accepted from board_ops
         where session_id = $1 and op_id in ('op-2', 'srv-1') order by op_id",
    )
    .bind(a)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("op-2".to_string(), Some(1), Some(true)),
            ("srv-1".to_string(), None, Some(true)),
        ],
        "rejected op re-evaluated, accepted op untouched"
    );

    let insert_mark = "insert into marks (session_id, segment_id, first_at_ms, final_at_ms, text)
                       values ($1, 'seg-1', 100, 900, 'hello')";
    sqlx::query(insert_mark)
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        sqlx::query(insert_mark)
            .bind(a)
            .execute(&pool)
            .await
            .is_err(),
        "duplicate segment accepted"
    );
    sqlx::query(insert_mark)
        .bind(b)
        .execute(&pool)
        .await
        .expect("same segment in another session");
}

#[tokio::test]
async fn deleting_an_identity_removes_its_sessions() {
    let pool = pool().await;
    let identity = new_guest(&pool).await;
    let session = new_session(&pool, identity).await;
    sqlx::query("insert into turns (session_id, seq, speaker, text) values ($1, 1, 'user', 'hi')")
        .bind(session)
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("delete from identities where id = $1")
        .bind(identity)
        .execute(&pool)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("select count(*) from turns where session_id = $1")
        .bind(session)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
