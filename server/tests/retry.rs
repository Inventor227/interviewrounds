//! Retries: `POST /api/sessions/{id}/retry` (a two minute re-ask of the weakest moment), its scoring into the
//! parent report, and its place in the guest limits. Needs Postgres (remote.sh --pg); the model is a fake.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::live::{self, Options, eventually, fixture_catalog, full_req, go_live, short_req};
use common::scored::{LEAD_ASKS, SECOND_ASKS, example_report, scored, turn_text};
use ir_server::scoring::{ReportSchema, ScoringDeps, score_session};
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
        assert!(system.contains("What breaks first at 10x traffic?"));
        assert!(!system.contains("Round script: system design"));
        assert_eq!(
            st.brief.as_ref().unwrap().question,
            "What breaks first at 10x traffic?"
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
    eventually("the retry's model call in the ledger", Duration::from_secs(3), || {
        let db = db.clone();
        async move {
            let n: i64 = sqlx::query_scalar(
                "select count(*) from usage_events where session_id = $1 and provider = 'anthropic' \
                   and kind = 'model_call' and model = 'claude-sonnet-5-5'",
            )
            .bind(child_id)
            .fetch_one(&db)
            .await
            .unwrap();
            n == 1
        }
    })
    .await;

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
