//! Public scorecard links: `POST /api/shares`, `DELETE /api/shares/{slug}` and the page at `/s/{slug}`.
//! Needs Postgres (`DATABASE_URL`).

mod common;

use axum::http::{Method, StatusCode, header};
use common::live::{self, Options, short_req};
use common::scored::{LEAD_ASKS, example_report, get_raw, scored};
use serde_json::{Value, json};

async fn share(app: &live::TestApp, cookie: &str, id: &str, transcript: bool) -> live::Res {
    app.call(
        Method::POST,
        "/api/shares",
        Some(cookie),
        Some(json!({"session_id": id, "include_transcript": transcript})),
    )
    .await
}

fn slug_of(res: &live::Res) -> String {
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    res.body["slug"].as_str().unwrap().to_string()
}

async fn report(app: &live::TestApp, cookie: &str, id: &str) -> Value {
    let res = app
        .call(
            Method::GET,
            &format!("/api/sessions/{id}/report"),
            Some(cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    res.body
}

async fn live_links(app: &live::TestApp, id: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from shares where session_id = $1::uuid and revoked_at is null",
    )
    .bind(id)
    .fetch_one(&app.state.db)
    .await
    .unwrap()
}

#[tokio::test]
async fn share_requires_scored_owned_session() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let other = app.guest().await;
    let id = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;

    // Someone else's session looks like it does not exist; so does a made-up one.
    assert_eq!(
        share(&app, &other, &id, false).await.status,
        StatusCode::NOT_FOUND
    );
    let unknown = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        share(&app, &me, &unknown, false).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        share(&app, &me, "not-a-uuid", false).await.status,
        StatusCode::NOT_FOUND
    );
    // Without a cookie there is no caller at all.
    let anon = app
        .call(
            Method::POST,
            "/api/shares",
            None,
            Some(json!({"session_id": id, "include_transcript": false})),
        )
        .await;
    assert_eq!(anon.status, StatusCode::UNAUTHORIZED);

    // The caller's own round that has no report yet.
    let open = app.create(&me, short_req("fake")).await;
    let open_id = open.body["session_id"].as_str().unwrap();
    let res = share(&app, &me, open_id, false).await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.body);
    assert_eq!(res.body["code"], "not_scored");

    let res = share(&app, &me, &id, false).await;
    let slug = slug_of(&res);
    assert_eq!(slug.len(), 10);
    assert!(
        slug.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "{slug}"
    );
    assert!(!id.contains(&slug) && !me.contains(&slug));
    assert_eq!(
        res.body["url"],
        format!("https://rounds.example.test/s/{slug}")
    );
}

#[tokio::test]
async fn share_upsert_same_choice_returns_same_slug() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let id = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;

    let a = slug_of(&share(&app, &me, &id, false).await);
    let b = slug_of(&share(&app, &me, &id, false).await);
    assert_eq!(a, b);
    assert_eq!(live_links(&app, &id).await, 1);
    let r = report(&app, &me, &id).await;
    assert_eq!(
        r["share"],
        json!({"public_slug": a, "include_quotes": false})
    );
}

#[tokio::test]
async fn share_changing_transcript_revokes_old() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let id = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;

    let old = slug_of(&share(&app, &me, &id, false).await);
    let new = slug_of(&share(&app, &me, &id, true).await);
    assert_ne!(old, new);
    assert_eq!(live_links(&app, &id).await, 1);
    assert_eq!(
        get_raw(&app, &format!("/s/{old}")).await.0,
        StatusCode::GONE
    );
    let (status, _, html) = get_raw(&app, &format!("/s/{new}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        html.contains("UNIQUE CANDIDATE LINE"),
        "the transcript is on the page"
    );
    assert!(
        html.contains("I&#39;d just add more caching there."),
        "quotes are on the page"
    );
    let r = report(&app, &me, &id).await;
    assert_eq!(
        r["share"],
        json!({"public_slug": new, "include_quotes": true})
    );
    // The same choice again keeps the new link.
    assert_eq!(slug_of(&share(&app, &me, &id, true).await), new);
}

#[tokio::test]
async fn share_page_hides_transcript_by_default() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let id = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;
    let slug = slug_of(&share(&app, &me, &id, false).await);

    // No cookie: the page is public.
    let (status, headers, html) = get_raw(&app, &format!("/s/{slug}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "private, max-age=60");
    assert!(
        headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    for want in [
        "<meta name=\"robots\" content=\"noindex\">",
        "<meta property=\"og:title\" content=\"Interview Rounds scorecard\">",
        "<meta property=\"og:description\" content=\"Clear request path and good numbers. The scaling probe stayed shallow.\">",
        "<meta name=\"twitter:card\" content=\"summary\">",
        "<meta name=\"twitter:title\" content=\"Interview Rounds scorecard\">",
        "System design",
        "November 13, 2026",
        "Signal so far",
        "Leaning hire",
        "Low confidence",
        "Requirements and scoping",
        "<strong>3</strong> of 4",
        "Asked for scale and read/write ratio, then used both to size the store.",
        "Scoped with numbers",
        "Trade-offs left implicit",
        "What breaks first at 10x traffic?",
        "Retry the 10x question",
        "<a class=\"btn\" href=\"/\">Try a round</a>",
        "prefers-color-scheme:dark",
    ] {
        assert!(html.contains(want), "missing {want:?}");
    }
    for never in [
        "UNIQUE CANDIDATE LINE",
        "I&#39;d just add more caching there.",
        "<script",
        id.as_str(),
    ] {
        assert!(!html.contains(never), "the page shows {never:?}");
    }
    let owner: uuid::Uuid =
        sqlx::query_scalar("select identity_id from sessions where id = $1::uuid")
            .bind(&id)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert!(!html.contains(&owner.to_string()));
}

#[tokio::test]
async fn share_page_escapes_report_text() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let id = scored(&app, &me, short_req("fake"), &LEAD_ASKS, |id| {
        let mut r = example_report(id);
        r["headline"]["summary"] = json!("<script>alert(\"x\")</script> & more");
        r["strengths"][0]["title"] = json!("<img src=x onerror=alert(1)>");
        r["competencies"][0]["rationale"] = json!("Said \"</p><p>\" out loud.");
        r
    })
    .await;
    sqlx::query(
        "update turns set text = '<b>bold</b> answer' where session_id = $1::uuid and seq = 2",
    )
    .bind(&id)
    .execute(&app.state.db)
    .await
    .unwrap();
    let slug = slug_of(&share(&app, &me, &id, true).await);
    let (status, _, html) = get_raw(&app, &format!("/s/{slug}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("<script"), "{html}");
    assert!(!html.contains("<img"));
    assert!(!html.contains("<b>bold"));
    assert!(!html.contains("</p><p>\""));
    assert!(html.contains("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more"));
    assert!(
        html.contains("content=\"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more\"")
    );
    assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
    assert!(html.contains("&lt;b&gt;bold&lt;/b&gt; answer"));
}

#[tokio::test]
async fn revoked_share_is_410() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let other = app.guest().await;
    let id = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;
    let slug = slug_of(&share(&app, &me, &id, false).await);

    // Only the owner can take it down.
    let res = app
        .call(
            Method::DELETE,
            &format!("/api/shares/{slug}"),
            Some(&other),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(get_raw(&app, &format!("/s/{slug}")).await.0, StatusCode::OK);

    for _ in 0..2 {
        let res = app
            .call(
                Method::DELETE,
                &format!("/api/shares/{slug}"),
                Some(&me),
                None,
            )
            .await;
        assert_eq!(res.status, StatusCode::NO_CONTENT, "deleting twice is fine");
    }
    let (status, headers, html) = get_raw(&app, &format!("/s/{slug}")).await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(html.contains("This scorecard link was turned off"));
    assert!(html.contains("Try a round"));
    assert!(!html.contains("Leaning hire"));
    let r = report(&app, &me, &id).await;
    assert_eq!(r["share"]["public_slug"], Value::Null);

    // Never made, or not a slug at all.
    let (status, _, html) = get_raw(&app, "/s/AAAAAAAAAA").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(html.contains("This scorecard link does not exist"));
    assert_eq!(get_raw(&app, "/s/nope").await.0, StatusCode::NOT_FOUND);
    let res = app
        .call(Method::DELETE, "/api/shares/AAAAAAAAAA", Some(&me), None)
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn operator_can_revoke_any_link() {
    let app = live::test_app(Options::default()).await;
    let me = app.guest().await;
    let operator = app.guest().await;
    let id = scored(&app, &me, short_req("fake"), &LEAD_ASKS, example_report).await;
    let slug = slug_of(&share(&app, &me, &id, true).await);
    let path = format!("/api/shares/{slug}");

    // A wrong or empty key is just another guest.
    for key in ["wrong", ""] {
        let res = app
            .call_with(
                Method::DELETE,
                &path,
                Some(&operator),
                None,
                &[("x-dev-key", key)],
            )
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "key {key:?}");
    }
    assert_eq!(get_raw(&app, &format!("/s/{slug}")).await.0, StatusCode::OK);

    let res = app
        .call_with(
            Method::DELETE,
            &path,
            Some(&operator),
            None,
            &[("x-dev-key", "test-dev-key")],
        )
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(
        get_raw(&app, &format!("/s/{slug}")).await.0,
        StatusCode::GONE
    );
}
