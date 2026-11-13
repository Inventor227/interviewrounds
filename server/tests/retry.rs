//! Retries: `POST /api/sessions/{id}/retry` (a two minute re-ask of the weakest moment), its scoring into the
//! parent report, and its place in the guest limits. Needs Postgres (remote.sh --pg); the model is a fake.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::live::{
    self, Options, eventually, fixture_catalog, frame_of, full_req, go_live, hello, short_req,
};
use common::scored::{LEAD_ASKS, SECOND_ASKS, example_report, scored, turn_text};
use ir_server::orchestrator::tools::ToolCall;
use ir_server::scoring::{ReportSchema, ScoringDeps, score_session};
use ir_server::ws::SessionTiming;
use serde_json::{Value, json};
use uuid::Uuid;

const DEV: &[(&str, &str)] = &[("x-dev-key", "test-dev-key")];

async fn retry(app: &live::TestApp, cookie: &str, id: &str) -> live::Res {
    app.call_with(
        Method::POST,
        &format!("/api/sessions/{id}/retry"),
        Some(cookie),
        None,
        DEV,
    )
    .await
}

fn schema() -> ReportSchema {
    ReportSchema::load(Path::new("../content")).expect("report schema loads")
}

#[tokio::test]
async fn retry_requires_retry_prompt() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let other = app.guest().await;
    let id = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;

    // Not the caller's.
    assert_eq!(retry(&app, &other, &id).await.status, StatusCode::NOT_FOUND);

    // A report whose weakest moment has no retry prompt, and one with no weakest moment at all.
    for strip in ["retry", "weakest_moment"] {
        let bare = scored(&app, &me, short_req("fake"), &LEAD_ASKS, |id| {
            let mut r = example_report(id);
            match strip {
                "retry" => {
                    r["weakest_moment"].as_object_mut().unwrap().remove("retry");
                }
                _ => r["weakest_moment"] = Value::Null,
            }
            r
        })
        .await;
        let res = retry(&app, &me, &bare).await;
        assert_eq!(res.status, StatusCode::CONFLICT, "{strip}: {}", res.body);
        assert_eq!(res.body["code"], "no_retry");
    }

    // A meeting has no retry.
    let meeting = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;
    sqlx::query("update sessions set mode = 'meeting' where id = $1::uuid")
        .bind(&meeting)
        .execute(&app.state.db)
        .await
        .unwrap();
    let res = retry(&app, &me, &meeting).await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.body);
    assert_eq!(res.body["code"], "no_retry");

    // Nor does a retry, even once it is scored.
    let child = retry(&app, &me, &id).await;
    assert_eq!(child.status, StatusCode::OK, "{}", child.body);
    let child = child.body["session_id"].as_str().unwrap().to_string();
    sqlx::query("update sessions set status = 'scored', started_at = now() where id = $1::uuid")
        .bind(&child)
        .execute(&app.state.db)
        .await
        .unwrap();
    let res = retry(&app, &me, &child).await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.body);
    assert_eq!(res.body["code"], "no_retry");

    // A round that has not been scored.
    let open = app.create(&me, short_req("fake")).await;
    let res = retry(&app, &me, open.body["session_id"].as_str().unwrap()).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.body["code"], "no_retry");

    // The text voice stays a development path.
    let res = app
        .call(
            Method::POST,
            &format!("/api/sessions/{id}/retry"),
            Some(&me),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.body["code"], "dev_only");
}

#[tokio::test]
async fn retry_links_to_parent() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let me = app.guest().await;
    let parent = scored(&app, &me, full_req("fake"), &SECOND_ASKS, example_report).await;

    let res = retry(&app, &me, &parent).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let child = res.body["session_id"].as_str().unwrap().to_string();
    assert_ne!(child, parent);
    let round = &res.body["round"];
    assert_eq!(round["id"], "sde.system_design.full");
    assert_eq!(round["round_type"], "system_design");
    assert_eq!(round["length"], "short");
    assert_eq!(round["target_minutes"], 2.0);
    assert_eq!(round["board_kit"], Value::Null);
    assert_eq!(round["hands"], "none");
    let phases: Vec<(String, f64)> = round["phases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["id"].as_str().unwrap().to_string(),
                p["minutes"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        phases,
        vec![("retry".to_string(), 1.5), ("close".to_string(), 0.5)]
    );
    // One panelist: the one who asked the weakest question.
    let panel = res.body["panel"].as_array().unwrap();
    assert_eq!(panel.len(), 1);
    assert_eq!(panel[0]["persona_id"], "persona.ana");
    assert_eq!(res.body["timing"]["target_minutes"], 2.0);
    assert_eq!(res.body["timing"]["hard_stop_minutes"], 2.5);
    // Short waits for a two minute retry: a check-in after 20 s of quiet, a long-answer cut-in by 90 s (Ana's own
    // 60 s stays).
    assert_eq!(res.body["timing"]["silence_wait_seconds"], 20);
    assert_eq!(res.body["timing"]["interrupt_after_seconds"], 60);

    let (link, length, spec): (Option<Uuid>, String, Value) =
        sqlx::query_as("select parent_session_id, length, retry from sessions where id = $1::uuid")
            .bind(&child)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(link.map(|u| u.to_string()), Some(parent.clone()));
    assert_eq!(length, "retry");
    assert_eq!(spec["question"], "What breaks first at 10x traffic?");
    assert_eq!(spec["persona_id"], "persona.ana");
    assert_eq!(spec["competency_id"], "tradeoffs");
    assert_eq!(spec["before_score"], 2.0);
    assert_eq!(spec["answer_excerpt"], "I'd just add more caching there.");

    // The retry's own script, with the question in it.
    {
        let handle = app.state.registry.get(&child).expect("in memory");
        let st = handle.lock().await;
        let system = &st.panel[0].system[0].text;
        assert!(
            system.contains("Round script: a two minute retry of one answer"),
            "{system}"
        );
        assert!(system.contains("Let's try that again. What breaks first at 10x traffic?"));
        assert!(!system.contains("Round script: system design"));
        // The brief card holds the clean re-ask, the same line the interviewer opens with.
        assert_eq!(
            st.brief.as_ref().unwrap().question,
            "Let's try that again. What breaks first at 10x traffic?"
        );
        assert_eq!(
            st.timed_close,
            Some((120_000, ir_server::retry::CLOSING_LINE.to_string()))
        );
    }

    // A restart rebuilds the same retry from what it re-asks.
    app.state.registry.remove(&child);
    let reloaded = ir_server::persist::load_live(&app.state, Uuid::parse_str(&child).unwrap())
        .await
        .unwrap()
        .expect("reloaded");
    {
        let st = reloaded.lock().await;
        assert!(
            st.panel[0].system[0]
                .text
                .contains("Round script: a two minute retry of one answer")
        );
        assert_eq!(st.panel[0].persona.id, "persona.ana");
        assert_eq!(st.round.target_minutes, 2.0);
        assert!(st.timed_close.is_some());
        assert_eq!(
            st.pending_handover.get("p1").map(String::as_str),
            Some("Let's try that again. What breaks first at 10x traffic?")
        );
    }

    // The opening line restates the question, word for word, with no model call.
    go_live(&base, &res.body).await;
    let token = res.body["client_token"].as_str().unwrap();
    let (status, said) = turn_text(&app, token, &child, "[event: start]").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        said,
        "Let's try that again. What breaks first at 10x traffic?"
    );
    assert!(
        app.llm.requests.lock().unwrap().is_empty(),
        "no live model call for the opener"
    );
}

#[tokio::test]
async fn retry_score_appends_to_parent_report() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let me = app.guest().await;
    let parent = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;
    *app.llm.scribe.lock().unwrap() = Some(
        r#"{"after_score": 3, "note": "You named the write path as the first bottleneck this time — and what sharding costs."}"#
            .into(),
    );

    let res = retry(&app, &me, &parent).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let child = res.body["session_id"].as_str().unwrap().to_string();
    let token = res.body["client_token"].as_str().unwrap().to_string();
    go_live(&base, &res.body).await;
    turn_text(&app, &token, &child, "[event: start]").await;
    let answer = "At ten times the writes hit the key value store first, so I'd shard it by the short code \
                  and watch p99 write latency per shard.";
    let (status, _) = turn_text(&app, &token, &child, answer).await;
    assert_eq!(status, StatusCode::OK);
    let end = app
        .call(
            Method::POST,
            &format!("/api/sessions/{child}/end"),
            Some(&me),
            Some(json!({"reason": "user_ended"})),
        )
        .await;
    assert_eq!(end.status, StatusCode::ACCEPTED);

    // Not scored yet: no report, and the status says so.
    let r = app
        .call(
            Method::GET,
            &format!("/api/sessions/{child}/report"),
            Some(&me),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let st = app
        .call(
            Method::GET,
            &format!("/api/sessions/{child}"),
            Some(&me),
            None,
        )
        .await;
    assert_eq!(st.body, json!({"status": "scoring", "report_ready": false}));

    let mut deps = ScoringDeps::new(
        app.state.db.clone(),
        app.state.llm.clone(),
        Arc::new(fixture_catalog()),
        Arc::new(schema()),
        "claude-opus-5-5",
    );
    deps.fast_model = "claude-sonnet-5-5".into();
    let child_id = Uuid::parse_str(&child).unwrap();
    score_session(&deps, child_id).await.expect("retry scored");

    // One fast call with the compact before and after rubric.
    let calls: Vec<_> = app
        .llm
        .creates
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.output_config.as_ref().is_some_and(|o| o.format.is_some()))
        .cloned()
        .collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].model, "claude-sonnet-5-5");
    let asked = calls[0].messages[0].text();
    for want in [
        "Depth and trade-offs",
        "What breaks first at 10x traffic?",
        "I'd just add more caching there.",
        "2 of 4",
        "shard it by the short code",
    ] {
        assert!(asked.contains(want), "missing {want:?} in {asked}");
    }

    let r = app
        .call(
            Method::GET,
            &format!("/api/sessions/{parent}/report"),
            Some(&me),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let retries = r.body["weakest_moment"]["retries"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(retries.len(), 1);
    assert_eq!(retries[0]["session_id"], child.as_str());
    assert_eq!(retries[0]["before_score"], 2.0);
    assert_eq!(retries[0]["after_score"], 3.0);
    let note = retries[0]["note"].as_str().unwrap();
    assert!(note.starts_with("You named the write path"), "{note}");
    assert!(!note.contains('\u{2014}'), "no em dash in the note: {note}");
    assert!(chrono::DateTime::parse_from_rfc3339(retries[0]["at"].as_str().unwrap()).is_ok());
    assert!(
        schema().errors(&r.body).is_empty(),
        "{:?}",
        schema().errors(&r.body)
    );

    // The retry answers with its parent's report now, and says it is ready.
    let c = app
        .call(
            Method::GET,
            &format!("/api/sessions/{child}/report"),
            Some(&me),
            None,
        )
        .await;
    assert_eq!(c.status, StatusCode::OK);
    assert_eq!(c.body["session"]["id"], parent.as_str());
    assert_eq!(c.body["weakest_moment"]["retries"], json!(retries));
    let st = app
        .call(
            Method::GET,
            &format!("/api/sessions/{child}"),
            Some(&me),
            None,
        )
        .await;
    assert_eq!(st.body, json!({"status": "scored", "report_ready": true}));

    // The call is in the ledger, on the retry session.
    let db = app.state.db.clone();
    let ledger = |db: sqlx::PgPool| async move {
        sqlx::query_as::<_, (String, Option<String>, f64)>(
            "select kind, model, cost_usd::float8 from usage_events \
             where session_id = $1 and kind not in ('prewarm', 'live_turn', 'live_turn_cut') order by id",
        )
        .bind(child_id)
        .fetch_all(&db)
        .await
        .unwrap()
    };
    let rows = ledger(db.clone()).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].0, "retry_scoring");
    assert_eq!(rows[0].1.as_deref(), Some("claude-sonnet-5-5"));
    assert!(rows[0].2 > 0.0, "{rows:?}");

    // Scoring the same retry again adds nothing.
    sqlx::query("update sessions set status = 'scoring' where id = $1")
        .bind(child_id)
        .execute(&app.state.db)
        .await
        .unwrap();
    score_session(&deps, child_id).await.unwrap();
    let r = app
        .call(
            Method::GET,
            &format!("/api/sessions/{parent}/report"),
            Some(&me),
            None,
        )
        .await;
    assert_eq!(
        r.body["weakest_moment"]["retries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // Two attempts per re-score at most: a third run makes no call and leaves the retry failed.
    sqlx::query("update sessions set status = 'scoring' where id = $1")
        .bind(child_id)
        .execute(&app.state.db)
        .await
        .unwrap();
    let calls = app.llm.creates.lock().unwrap().len();
    assert!(score_session(&deps, child_id).await.is_err());
    assert_eq!(
        app.llm.creates.lock().unwrap().len(),
        calls,
        "no call past the budget"
    );
    let st = app
        .call(
            Method::GET,
            &format!("/api/sessions/{child}"),
            Some(&me),
            None,
        )
        .await;
    assert_eq!(st.body["status"], "failed");
    // "Try again" gives it two fresh attempts.
    let again = app
        .call(
            Method::POST,
            &format!("/api/sessions/{child}/report"),
            Some(&me),
            None,
        )
        .await;
    assert_eq!(again.status, StatusCode::ACCEPTED, "{}", again.body);
    score_session(&deps, child_id)
        .await
        .expect("scored after a re-score");
    assert_eq!(
        ledger(db.clone())
            .await
            .iter()
            .filter(|r| r.0 == "retry_scoring")
            .count(),
        3
    );
}

fn goodbye_timing() -> SessionTiming {
    SessionTiming {
        tick: Duration::from_millis(100),
        // Long enough to send one more app event between round.ending and round.ended.
        closing_grace: Duration::from_millis(1500),
        ..SessionTiming::default()
    }
}

/// A retry of a fresh scored round, live on a socket, past its opener and one answer. From then on the model never
/// answers and the director never calls a tool. Returns the retry id, its client token and the socket.
async fn live_retry(app: &live::TestApp, base: &str) -> (String, String, live::Ws) {
    let me = app.guest().await;
    let parent = scored(app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;
    let res = retry(app, &me, &parent).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let child = res.body["session_id"].as_str().unwrap().to_string();
    let token = res.body["client_token"].as_str().unwrap().to_string();
    let mut ws = hello(base, &child, &token, 0).await;
    let first = frame_of(&mut ws, "round.state", Duration::from_secs(3))
        .await
        .unwrap();
    assert_eq!(first["d"]["status"], "live");
    turn_text(app, &token, &child, "[event: start]").await;
    turn_text(
        app,
        &token,
        &child,
        "I'd shard the store by key and watch p99 per shard.",
    )
    .await;
    app.llm.hang.store(true, Ordering::SeqCst);
    (child, token, ws)
}

/// Moves a live round's clock on.
async fn jump(app: &live::TestApp, session_id: &str, secs: u64) {
    let handle = app.state.registry.get(session_id).expect("in memory");
    handle.lock().await.started_at -= Duration::from_secs(secs);
}

async fn turns(app: &live::TestApp, session_id: &str) -> usize {
    let handle = app.state.registry.get(session_id).expect("in memory");
    handle.lock().await.turns.len()
}

async fn ended_as(app: &live::TestApp, session_id: &str) -> (String, Option<String>) {
    sqlx::query_as("select status, ended_reason from sessions where id = $1::uuid")
        .bind(session_id)
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn retry_says_goodbye_at_120_s_with_no_model() {
    let app = live::test_app(Options {
        timing: goodbye_timing(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (child, token, mut ws) = live_retry(&app, &base).await;
    let streamed = app.llm.requests.lock().unwrap().len();

    // 90 s: the answer phase is over. Nobody moves the phase (no next_phase).
    jump(&app, &child, 91).await;
    let at_90 = time_check(&mut ws).await;
    assert_eq!(at_90["d"]["phase_id"], "retry");

    // 120 s: the app asks for its goodbye.
    jump(&app, &child, 30).await;
    let at_120 = time_check(&mut ws).await;
    assert_eq!(at_120["d"]["phase_id"], "close");
    let (status, said) = turn_text(&app, &token, &child, "[event: time_check]").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(said, ir_server::retry::CLOSING_LINE);
    let ending = frame_of(&mut ws, "round.ending", Duration::from_secs(3))
        .await
        .expect("round.ending");
    assert_eq!(ending["d"]["closing_line"], ir_server::retry::CLOSING_LINE);

    // The browser answers round.ending with [event: ending]: no second goodbye, nothing recorded.
    let before = turns(&app, &child).await;
    let (status, said) = turn_text(&app, &token, &child, "[event: ending]").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(said, "", "no second goodbye");
    assert_eq!(turns(&app, &child).await, before, "nothing recorded");

    let ended = frame_of(&mut ws, "round.ended", Duration::from_secs(3))
        .await
        .expect("round.ended");
    assert_eq!(ended["d"]["reason"], "completed");
    assert_eq!(
        app.llm.requests.lock().unwrap().len(),
        streamed,
        "no model call for the goodbye or after it"
    );
    let (status, reason) = ended_as(&app, &child).await;
    assert_eq!(
        (status.as_str(), reason.as_deref()),
        ("scoring", Some("completed"))
    );
}

#[tokio::test]
async fn retry_goodbye_comes_when_the_time_check_is_missed() {
    let app = live::test_app(Options {
        timing: goodbye_timing(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let (child, token, mut ws) = live_retry(&app, &base).await;
    let streamed = app.llm.requests.lock().unwrap().len();

    // Past 120 s and no app event for 5 s more: the server asks the browser to end.
    jump(&app, &child, 126).await;
    let ending = frame_of(&mut ws, "round.ending", Duration::from_secs(3))
        .await
        .expect("round.ending");
    assert_eq!(ending["d"]["closing_line"], ir_server::retry::CLOSING_LINE);
    // The browser's [event: ending] gets the app's line, word for word.
    let (status, said) = turn_text(&app, &token, &child, "[event: ending]").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(said, ir_server::retry::CLOSING_LINE);
    let ended = frame_of(&mut ws, "round.ended", Duration::from_secs(4))
        .await
        .expect("round.ended");
    assert_eq!(ended["d"]["reason"], "completed");
    assert_eq!(app.llm.requests.lock().unwrap().len(), streamed);
    assert_eq!(ended_as(&app, &child).await.1.as_deref(), Some("completed"));
}

/// Any round: once end_round came with the closing line, the browser's [event: ending] gets nothing.
#[tokio::test]
async fn app_event_after_end_round_gets_no_second_goodbye() {
    let app = live::test_app(Options {
        timing: goodbye_timing(),
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let me = app.guest().await;
    let res = app.create(&me, short_req("fake")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let id = res.body["session_id"].as_str().unwrap().to_string();
    let token = res.body["client_token"].as_str().unwrap().to_string();
    let mut ws = hello(&base, &id, &token, 0).await;
    frame_of(&mut ws, "round.state", Duration::from_secs(3))
        .await
        .unwrap();
    turn_text(&app, &token, &id, "[event: start]").await;
    turn_text(&app, &token, &id, "I'd start with the read path.").await;
    // The interviewer's end_round, as the director applies it after the closing line played.
    {
        let handle = app.state.registry.get(&id).expect("in memory");
        let mut st = handle.lock().await;
        st.apply_tool_calls(&[ToolCall {
            id: "t1".into(),
            name: "end_round".into(),
            input: json!({"closing_line": "That's our time. Your scorecard is coming up next."}),
            panelist_id: "p1".into(),
        }]);
    }
    frame_of(&mut ws, "round.ending", Duration::from_secs(3))
        .await
        .expect("round.ending");
    let streamed = app.llm.requests.lock().unwrap().len();
    let before = turns(&app, &id).await;
    let (status, said) = turn_text(&app, &token, &id, "[event: ending]").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(said, "", "no second goodbye");
    assert_eq!(
        app.llm.requests.lock().unwrap().len(),
        streamed,
        "no model call"
    );
    assert_eq!(turns(&app, &id).await, before, "nothing recorded");
    let ended = frame_of(&mut ws, "round.ended", Duration::from_secs(4))
        .await
        .expect("round.ended");
    assert_eq!(ended["d"]["reason"], "completed");
}

#[tokio::test]
async fn me_never_offers_sign_in() {
    let app = live::test_app(Options {
        env: &[
            ("GOOGLE_CLIENT_ID", "client.apps.example"),
            ("GOOGLE_CLIENT_SECRET", "secret"),
        ],
        ..Options::default()
    })
    .await;
    let res = app.call(Method::GET, "/api/me", None, None).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["sign_in_available"], false);
}

/// The next `round.state` that asks for a time check.
async fn time_check(ws: &mut live::Ws) -> Value {
    loop {
        let f = frame_of(ws, "round.state", Duration::from_secs(3))
            .await
            .expect("round.state");
        if f["d"]["time_check_due"] == true {
            return f;
        }
    }
}

#[tokio::test]
async fn retry_counts_as_quick_round_for_guest_limits() {
    let app = live::test_app(Options {
        env: &[("USAGE_PHASE", "judging")],
        ..Options::default()
    })
    .await;
    let base = app.serve().await;
    let me = app.guest().await;
    let parent = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;
    // One more quick round played today.
    sqlx::query(
        "insert into sessions (identity_id, mode, round_id, length, level, style, voice, status, started_at) \
         select identity_id, 'interview', round_id, 'short', 'mid', 'neutral', 'fake', 'scored', now() \
         from sessions where id = $1::uuid",
    )
    .bind(&parent)
    .execute(&app.state.db)
    .await
    .unwrap();
    let left = |body: &Value| body["limits"]["short_left_today"].clone();
    let me_now = app.call(Method::GET, "/api/me", Some(&me), None).await;
    assert_eq!(left(&me_now.body), json!(1));

    let res = retry(&app, &me, &parent).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    go_live(&base, &res.body).await;
    let child = res.body["session_id"].as_str().unwrap().to_string();
    let db = app.state.db.clone();
    eventually("the retry started", Duration::from_secs(3), || {
        let (db, child) = (db.clone(), child.clone());
        async move {
            sqlx::query_scalar::<_, bool>(
                "select started_at is not null from sessions where id = $1::uuid",
            )
            .bind(&child)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    })
    .await;

    // The retry took today's last quick round.
    let me_now = app.call(Method::GET, "/api/me", Some(&me), None).await;
    assert_eq!(left(&me_now.body), json!(0));
    assert_eq!(me_now.body["limits"]["reason"], "guest_daily_limit");
    let res = retry(&app, &me, &parent).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{}", res.body);
    assert_eq!(res.body["code"], "guest_daily_limit");
    assert_eq!(
        res.body["message"],
        "You've used today's rounds on this device. Come back tomorrow for more."
    );
    let quick = app.create(&me, short_req("fake")).await;
    assert_eq!(quick.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn retry_scoring_second_attempt_runs_on_another_model_after_an_overload() {
    let app = live::test_app(Options::default()).await;
    let base = app.serve().await;
    let me = app.guest().await;
    let parent = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;
    *app.llm.scribe.lock().unwrap() =
        Some(r#"{"after_score": 3, "note": "You named the write path this time."}"#.into());
    let res = retry(&app, &me, &parent).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let child = res.body["session_id"].as_str().unwrap().to_string();
    let token = res.body["client_token"].as_str().unwrap().to_string();
    go_live(&base, &res.body).await;
    turn_text(&app, &token, &child, "[event: start]").await;
    turn_text(
        &app,
        &token,
        &child,
        "I'd shard the key value store by the short code.",
    )
    .await;
    let end = app
        .call(
            Method::POST,
            &format!("/api/sessions/{child}/end"),
            Some(&me),
            Some(json!({"reason": "user_ended"})),
        )
        .await;
    assert_eq!(end.status, StatusCode::ACCEPTED);
    // Sonnet (the fast model) is overloaded while the retry is scored.
    *app.llm.down.lock().unwrap() = vec!["claude-sonnet-5-5".to_string()];
    let mut deps = ScoringDeps::new(
        app.state.db.clone(),
        app.state.llm.clone(),
        Arc::new(fixture_catalog()),
        Arc::new(schema()),
        "claude-opus-5-5",
    );
    deps.fast_model = "claude-sonnet-5-5".into();
    let child_id = Uuid::parse_str(&child).unwrap();
    score_session(&deps, child_id)
        .await
        .expect("scored on the second model");
    let models: Vec<String> = app
        .llm
        .scribe_calls()
        .iter()
        .filter(|r| r.messages[0].text().contains("2 of 4"))
        .map(|r| r.model.clone())
        .collect();
    assert_eq!(models, ["claude-sonnet-5-5", "claude-haiku-5-5"]);
    let rows: Vec<Option<String>> = sqlx::query_scalar(
        "select model from usage_events where session_id = $1 and kind = 'retry_scoring' order by id",
    )
    .bind(child_id)
    .fetch_all(&app.state.db)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [
            Some("claude-sonnet-5-5".to_string()),
            Some("claude-haiku-5-5".to_string())
        ]
    );
}
