//! A scored round for the share and retry tests: a real session row of the guest, ended, with its spoken lines
//! and the example report (`content/fixtures/report.example.json`) stored as its report.

use std::path::Path;

use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use super::live::TestApp;

/// One spoken line: `user` or `agent` (with its panelist), round time in ms.
pub struct Said {
    pub speaker: &'static str,
    pub panelist: Option<&'static str>,
    pub text: &'static str,
    pub ms: i64,
}

const fn agent(panelist: &'static str, text: &'static str, ms: i64) -> Said {
    Said {
        speaker: "agent",
        panelist: Some(panelist),
        text,
        ms,
    }
}

const fn user(text: &'static str, ms: i64) -> Said {
    Said {
        speaker: "user",
        panelist: None,
        text,
        ms,
    }
}

/// The weakest moment of the example report, asked by the lead (`p1`).
pub const LEAD_ASKS: [Said; 5] = [
    agent(
        "p1",
        "Hi, I'm Daniel. Eight minutes of system design.",
        1_000,
    ),
    user(
        "Let me scope it first. UNIQUE CANDIDATE LINE about reads.",
        8_000,
    ),
    agent("p1", "What breaks first at 10x traffic?", 352_000),
    user("I'd just add more caching there.", 360_000),
    agent("p1", "Okay. That's our time.", 380_000),
];

/// The same, with the second panelist (`p2`) asking the weakest question.
pub const SECOND_ASKS: [Said; 5] = [
    agent(
        "p1",
        "Hi, I'm Daniel. Thirty minutes of system design.",
        1_000,
    ),
    user("Let me scope it first.", 8_000),
    agent("p2", "What breaks first at 10x traffic?", 352_000),
    user("I'd just add more caching there.", 360_000),
    agent("p2", "Okay. Thanks.", 380_000),
];

/// The example report for a session, without retries and without a live link.
pub fn example_report(session_id: &str) -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../content/fixtures/report.example.json");
    let mut r: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    r["session"]["id"] = json!(session_id);
    r["weakest_moment"]
        .as_object_mut()
        .unwrap()
        .remove("retries");
    r["share"] = json!({"public_slug": null, "include_quotes": false});
    r
}

/// Creates a round for `cookie` (`req`, fake voice), ends it, stores `lines` and the report `report(id)` makes, and
/// marks it started and scored. The session id.
pub async fn scored(
    app: &TestApp,
    cookie: &str,
    req: Value,
    lines: &[Said],
    report: impl FnOnce(&str) -> Value,
) -> String {
    let created = app.create(cookie, req).await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.body);
    let id = created.body["session_id"].as_str().unwrap().to_string();
    let end = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/end"),
            Some(cookie),
            Some(json!({"reason": "user_ended"})),
        )
        .await;
    assert_eq!(end.status, StatusCode::ACCEPTED, "{}", end.body);
    let uuid = Uuid::parse_str(&id).unwrap();
    let db = &app.state.db;
    for (i, l) in lines.iter().enumerate() {
        sqlx::query(
            "insert into turns (session_id, seq, speaker, panelist_id, kind, text, started_ms) \
             values ($1, $2, $3, $4, 'speech', $5, $6)",
        )
        .bind(uuid)
        .bind(i as i32 + 1)
        .bind(l.speaker)
        .bind(l.panelist)
        .bind(l.text)
        .bind(l.ms)
        .execute(db)
        .await
        .unwrap();
    }
    sqlx::query(
        "update sessions set status = 'scored', started_at = now() - interval '10 minutes', \
           ended_at = now(), scored_at = now() where id = $1",
    )
    .bind(uuid)
    .execute(db)
    .await
    .unwrap();
    sqlx::query("insert into reports (session_id, report, model) values ($1, $2, 'test')")
        .bind(uuid)
        .bind(report(&id))
        .execute(db)
        .await
        .unwrap();
    id
}

/// A GET with the raw body (HTML pages, SSE).
pub async fn get_raw(app: &TestApp, uri: &str) -> (StatusCode, HeaderMap, String) {
    let res = app
        .router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = String::from_utf8(super::body_bytes(res).await).unwrap();
    (status, headers, body)
}

/// A turn on the custom LLM endpoint (fake voice: the session's client token as bearer): the streamed text.
pub async fn turn_text(
    app: &TestApp,
    token: &str,
    session_id: &str,
    text: &str,
) -> (StatusCode, String) {
    let body = json!({"model": "x", "stream": true,
        "messages": [{"role": "user", "content": text}],
        "fishaudio_extra_body": {"session_id": session_id, "panelist_id": "p1"}});
    let req = Request::post("/v1/chat/completions")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let raw = String::from_utf8(super::body_bytes(res).await).unwrap();
    let mut said = String::new();
    for line in raw.lines() {
        let Some(payload) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if payload == "[DONE]" {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(payload)
            && let Some(t) = v["choices"][0]["delta"]["content"].as_str()
        {
            said.push_str(t);
        }
    }
    (status, said)
}
