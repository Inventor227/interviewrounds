//! Public scorecard links: `POST /api/shares` and `DELETE /api/shares/{slug}` (the session's owner only), and the
//! page itself, `GET /s/{slug}`: server-rendered HTML with no script, readable by anyone with the link.
//!
//! A session has at most one live link. Posting the same choice again returns that link; posting a different
//! `include_transcript` revokes it and makes a new one (the old slug then answers 410). Slugs are 10 random
//! URL-safe characters, never derived from ids. The page shows the scorecard (never a name or an id); the
//! transcript and quotes only when the link was made with `include_transcript`. Report text is model output that
//! quotes the user, so every value is escaped.

use axum::Json;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::app::AppState;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::persist::PanelEntry;
use crate::retry::Line;

pub const SLUG_LEN: usize = 10;
const SLUG_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/// The page's title and the link preview's title.
pub const PAGE_TITLE: &str = "Interview Rounds scorecard";

/// A new slug: 10 characters from a 64 character URL-safe alphabet (60 random bits).
pub fn new_slug() -> String {
    let mut buf = [0u8; SLUG_LEN];
    getrandom::fill(&mut buf).expect("the OS random source is available");
    buf.iter()
        .map(|b| SLUG_ALPHABET[(b & 63) as usize] as char)
        .collect()
}

pub fn valid_slug(slug: &str) -> bool {
    slug.len() == SLUG_LEN && slug.bytes().all(|b| SLUG_ALPHABET.contains(&b))
}

#[derive(Debug, Deserialize)]
pub struct ShareReq {
    pub session_id: String,
    #[serde(default)]
    pub include_transcript: bool,
}

fn refuse(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({"status": status.as_u16(), "code": code, "message": message})),
    )
        .into_response()
}

fn link(app: &AppState, slug: &str) -> String {
    format!("{}/s/{slug}", app.config.public_base_url)
}

/// `POST /api/shares {session_id, include_transcript}` -> `{slug, url}`. 404 for a session that is not the
/// caller's; 409 `not_scored` until it has its report.
pub async fn create(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Json(req): Json<ShareReq>,
) -> AppResult<Response> {
    let id = Uuid::parse_str(req.session_id.trim()).map_err(|_| AppError::NotFound)?;
    let row: Option<(Uuid, String, bool)> = sqlx::query_as(
        "select s.identity_id, s.status, exists (select 1 from reports r where r.session_id = s.id) \
         from sessions s where s.id = $1",
    )
    .bind(id)
    .fetch_optional(&app.db)
    .await?;
    let Some((owner, status, has_report)) = row.filter(|r| r.0 == identity.id) else {
        return Err(AppError::NotFound);
    };
    if status != "scored" || !has_report {
        return Ok(refuse(
            StatusCode::CONFLICT,
            "not_scored",
            "This round has no scorecard to share yet.",
        ));
    }

    // One live link per session: the session row lock serialises concurrent posts.
    let mut tx = app.db.begin().await?;
    sqlx::query("select 1 from sessions where id = $1 for update")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let live: Option<(String, bool)> = sqlx::query_as(
        "select slug, include_transcript from shares where session_id = $1 and revoked_at is null",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let slug = match live {
        Some((slug, with)) if with == req.include_transcript => slug,
        other => {
            if let Some((old, _)) = other {
                sqlx::query("update shares set revoked_at = now() where slug = $1")
                    .bind(&old)
                    .execute(&mut *tx)
                    .await?;
            }
            let mut made = None;
            for _ in 0..4 {
                let slug = new_slug();
                let inserted: Option<String> = sqlx::query_scalar(
                    "insert into shares (slug, session_id, identity_id, include_transcript) \
                     values ($1, $2, $3, $4) on conflict (slug) do nothing returning slug",
                )
                .bind(&slug)
                .bind(id)
                .bind(owner)
                .bind(req.include_transcript)
                .fetch_optional(&mut *tx)
                .await?;
                if inserted.is_some() {
                    made = Some(slug);
                    break;
                }
            }
            made.ok_or_else(|| anyhow::anyhow!("no free share slug after 4 tries"))?
        }
    };
    tx.commit().await?;
    let url = link(&app, &slug);
    Ok(Json(json!({ "slug": slug, "url": url })).into_response())
}

/// `DELETE /api/shares/{slug}` -> 204. Takes the link down (idempotent); 404 when it is not the caller's. With
/// the `X-Dev-Key` header any link can be taken down (operators clean up after smoke runs).
pub async fn delete(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> AppResult<StatusCode> {
    if !valid_slug(&slug) {
        return Err(AppError::NotFound);
    }
    let operator = super::sessions::dev_key_ok(&app, &headers);
    let done = sqlx::query(
        "update shares set revoked_at = coalesce(revoked_at, now()) \
         where slug = $1 and (identity_id = $2 or $3)",
    )
    .bind(&slug)
    .bind(identity.id)
    .bind(operator)
    .execute(&app.db)
    .await?
    .rows_affected();
    if done == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The report's `share` block: the session's live link, if any.
pub async fn share_block(db: &PgPool, session_id: Uuid) -> Result<Value, sqlx::Error> {
    let live: Option<(String, bool)> = sqlx::query_as(
        "select slug, include_transcript from shares where session_id = $1 and revoked_at is null",
    )
    .bind(session_id)
    .fetch_optional(db)
    .await?;
    Ok(match live {
        Some((slug, with)) => json!({ "public_slug": slug, "include_quotes": with }),
        None => json!({ "public_slug": null, "include_quotes": false }),
    })
}

// ---------- the page ----------

/// `GET /s/{slug}`: the scorecard (200), a link that was turned off (410) or one that never existed (404).
pub async fn page(State(app): State<AppState>, Path(slug): Path<String>) -> Response {
    match page_inner(&app, &slug).await {
        Ok(res) => res,
        Err(err) => {
            tracing::error!(error = %format!("{err:#}"), "share page failed");
            html_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "no-store",
                &notice_page(
                    "This scorecard did not load",
                    "Something went wrong on our side. Try the link again in a minute.",
                ),
            )
        }
    }
}

type PageRow = (
    Value,
    Option<String>,
    String,
    Value,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
);

async fn page_inner(app: &AppState, slug: &str) -> anyhow::Result<Response> {
    let missing = || {
        html_response(
            StatusCode::NOT_FOUND,
            "no-store",
            &notice_page(
                "This scorecard link does not exist",
                "Check the link you were sent. It may have a typo.",
            ),
        )
    };
    if !valid_slug(slug) {
        return Ok(missing());
    }
    let share: Option<(Uuid, bool, Option<DateTime<Utc>>)> = sqlx::query_as(
        "select session_id, include_transcript, revoked_at from shares where slug = $1",
    )
    .bind(slug)
    .fetch_optional(&app.db)
    .await?;
    let (session_id, with_transcript) = match share {
        None => return Ok(missing()),
        Some((_, _, Some(_))) => {
            return Ok(html_response(
                StatusCode::GONE,
                "no-store",
                &notice_page(
                    "This scorecard link was turned off",
                    "Whoever shared it has taken it down.",
                ),
            ));
        }
        Some((id, with, None)) => (id, with),
    };
    let row: Option<PageRow> = sqlx::query_as(
        "select r.report, s.round_id, s.mode, s.panel, s.started_at, s.created_at \
         from reports r join sessions s on s.id = r.session_id where r.session_id = $1",
    )
    .bind(session_id)
    .fetch_optional(&app.db)
    .await?;
    let Some((mut report, round_id, mode, panel, started_at, created_at)) = row else {
        return Ok(missing());
    };
    crate::scoring::readable_report(&app.db, session_id, &mut report).await?;
    let lines = if with_transcript {
        crate::retry::lines(&app.db, session_id).await?
    } else {
        Vec::new()
    };
    let title = round_id
        .as_deref()
        .and_then(|id| app.catalog.round(id))
        .map(|r| r.title.clone())
        .unwrap_or_else(|| {
            if mode == "meeting" {
                "Meeting rehearsal".into()
            } else {
                "Practice round".into()
            }
        });
    let date = report["session"]["started_at"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc))
        .or(started_at)
        .unwrap_or(created_at);
    let panel: Vec<PanelEntry> = serde_json::from_value(panel).unwrap_or_default();
    let page = Scorecard {
        title: &title,
        date,
        report: &report,
        transcript: with_transcript.then_some(lines.as_slice()),
        panel: &panel,
        url: &link(app, slug),
    };
    Ok(html_response(
        StatusCode::OK,
        "private, max-age=60",
        &render(&page),
    ))
}

fn html_response(status: StatusCode, cache: &'static str, body: &str) -> Response {
    let mut res = (status, body.to_string()).into_response();
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    h.insert(
        header::HeaderName::from_static("x-robots-tag"),
        HeaderValue::from_static("noindex"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    res
}

/// Escapes text for HTML element content and quoted attribute values.
pub fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Everything the scorecard page shows.
pub struct Scorecard<'a> {
    pub title: &'a str,
    pub date: DateTime<Utc>,
    pub report: &'a Value,
    /// The spoken lines, when the link includes the transcript.
    pub transcript: Option<&'a [Line]>,
    pub panel: &'a [PanelEntry],
    pub url: &'a str,
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("").trim()
}

fn verdict_name(label: &str) -> &'static str {
    match label {
        "strong_no_hire" => "Strong no hire",
        "no_hire" => "No hire",
        "leaning_no_hire" => "Leaning no hire",
        "leaning_hire" => "Leaning hire",
        "hire" => "Hire",
        "strong_hire" => "Strong hire",
        _ => "No verdict",
    }
}

fn outcome_name(outcome: &str) -> Option<&'static str> {
    Some(match outcome {
        "approved" => "Approved",
        "approved_with_conditions" => "Approved with conditions",
        "need_more_info" => "Need more information",
        "not_now" => "Not now",
        _ => return None,
    })
}

fn score_text(score: f64) -> String {
    if score.fract() == 0.0 {
        format!("{score:.0}")
    } else {
        format!("{score:.1}")
    }
}

/// The first sentence of a text (a one-line rationale), at most 160 characters.
fn one_line(text: &str) -> String {
    let text = text.trim();
    let end = text
        .char_indices()
        .find(|(i, c)| matches!(c, '.' | '?' | '!') && text[i + c.len_utf8()..].starts_with(' '))
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(text.len());
    crate::scoring::report::clip_line(&text[..end], 160)
}

fn clock(ms: i64) -> String {
    let s = (ms.max(0) / 1000) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

fn quote_of(report: &Value, point: &Value) -> Option<String> {
    let id = point["evidence_ids"][0].as_str()?;
    report["evidence"]
        .as_array()?
        .iter()
        .find(|e| e["id"] == id)
        .and_then(|e| e["quote"].as_str())
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty())
}

fn points(report: &Value, key: &str, quotes: bool, tone: &str) -> String {
    let mut out = String::new();
    for p in report[key].as_array().into_iter().flatten().take(3) {
        out.push_str(&format!(
            "<li class=\"pt {tone}\"><strong>{}</strong><span>{}</span>",
            esc(s(p, "title")),
            esc(s(p, "detail"))
        ));
        if quotes && let Some(q) = quote_of(report, p) {
            out.push_str(&format!("<q>{}</q>", esc(&q)));
        }
        out.push_str("</li>");
    }
    out
}

fn verdict_block(report: &Value) -> String {
    let summary = esc(s(&report["headline"], "summary"));
    let v = &report["headline"]["verdict"];
    let meeting = report["session"]["mode"] == "meeting";
    let (chip, tone, extra) = if v.is_object() {
        let label = s(v, "label");
        let index = v["index"].as_i64().unwrap_or(0);
        let pre = if v["is_provisional"].as_bool().unwrap_or(false) {
            "<span class=\"pre\">Signal so far</span>"
        } else {
            ""
        };
        let confidence = match s(v, "confidence") {
            "high" => "High confidence",
            "medium" => "Medium confidence",
            _ => "Low confidence",
        };
        (
            format!("{pre}<span class=\"name\">{}</span>", verdict_name(label)),
            if index >= 4 { "up" } else { "down" },
            format!("<span class=\"conf\">{confidence}</span>"),
        )
    } else if let Some(name) = meeting
        .then(|| outcome_name(s(&report["round_details"], "outcome")))
        .flatten()
    {
        (
            format!("<span class=\"pre\">Outcome</span><span class=\"name\">{name}</span>"),
            "up",
            String::new(),
        )
    } else {
        (
            format!(
                "<span class=\"name\">{}</span>",
                if meeting {
                    "No decision recorded"
                } else {
                    "Not enough signal yet"
                }
            ),
            "mid",
            String::new(),
        )
    };
    format!(
        "<section class=\"card verdict\"><div class=\"top\"><p class=\"chip {tone}\">{chip}</p>{extra}</div>\
         <p class=\"summary\">{summary}</p></section>"
    )
}

fn bars(report: &Value) -> String {
    let mut rows = String::new();
    for c in report["competencies"].as_array().into_iter().flatten() {
        let name = esc(s(c, "name"));
        let rationale = esc(&one_line(s(c, "rationale")));
        let (score, width, tone) = match c["score"].as_f64() {
            Some(x) => (
                format!("<strong>{}</strong> of 4", score_text(x)),
                ((x.clamp(0.0, 4.0) / 4.0) * 100.0).round() as u32,
                if x >= 3.0 {
                    "good"
                } else if x >= 2.0 {
                    "warn"
                } else {
                    "bad"
                },
            ),
            None => ("Not observed".to_string(), 0, "none"),
        };
        rows.push_str(&format!(
            "<li class=\"bar\"><div class=\"bar-head\"><span>{name}</span><span class=\"score\">{score}</span></div>\
             <div class=\"track\"><span class=\"fill {tone}\" style=\"width:{width}%\"></span></div>\
             <p class=\"why\">{rationale}</p></li>"
        ));
    }
    if rows.is_empty() {
        return String::new();
    }
    let lede = if report["session"]["mode"] == "meeting" {
        "Scored 1 to 4. 3 is a solid, professional meeting."
    } else {
        "Scored 1 to 4 against the bar for the level. 3 meets the bar."
    };
    format!(
        "<section class=\"card\"><h2>Competencies</h2><p class=\"muted\">{lede}</p><ul class=\"bars\">{rows}</ul></section>"
    )
}

fn transcript_block(lines: &[Line], panel: &[PanelEntry], meeting: bool) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let you = if meeting { "Presenter" } else { "Candidate" };
    let mut out = String::new();
    for l in lines {
        let who = if l.speaker == "user" {
            you.to_string()
        } else {
            l.panelist_id
                .as_deref()
                .and_then(|pid| panel.iter().find(|p| p.panelist_id == pid))
                .map(|p| p.display_name.clone())
                .unwrap_or_else(|| "Interviewer".into())
        };
        let stamp = l.started_ms.map(clock).unwrap_or_default();
        out.push_str(&format!(
            "<li class=\"{}\"><span class=\"stamp\">{}</span><span class=\"who\">{}</span><span class=\"said\">{}</span></li>",
            if l.speaker == "user" { "you" } else { "them" },
            esc(&stamp),
            esc(&who),
            esc(crate::scoring::report::scrub_str(l.text.trim()).as_str())
        ));
    }
    format!(
        "<section class=\"card\"><h2>Transcript</h2><ol class=\"transcript\">{out}</ol></section>"
    )
}

/// The scorecard page.
pub fn render(page: &Scorecard<'_>) -> String {
    let r = page.report;
    let meeting = r["session"]["mode"] == "meeting";
    let quotes = page.transcript.is_some();
    let length = match (meeting, s(&r["session"], "length")) {
        (true, _) => "Meeting rehearsal",
        (_, "full") => "Full round",
        _ => "Quick round",
    };
    let facts = format!("{}, {}", page.date.format("%B %-d, %Y"), length);
    let mut body = String::new();
    body.push_str(&verdict_block(r));
    body.push_str(&bars(r));
    let strengths = points(r, "strengths", quotes, "good");
    if !strengths.is_empty() {
        body.push_str(&format!(
            "<section class=\"card\"><h2>What went well</h2><ul class=\"points\">{strengths}</ul></section>"
        ));
    }
    let fixes = points(r, "weaknesses", quotes, "bad");
    if !fixes.is_empty() {
        body.push_str(&format!(
            "<section class=\"card\"><h2>What to work on</h2><ul class=\"points\">{fixes}</ul></section>"
        ));
    }
    let weakest = s(&r["weakest_moment"], "question");
    if !weakest.is_empty() {
        body.push_str(&format!(
            "<section class=\"card\"><h2>Hardest question</h2><p class=\"question\">{}</p></section>",
            esc(weakest)
        ));
    }
    let mut drills = String::new();
    for d in r["next_drills"].as_array().into_iter().flatten().take(3) {
        drills.push_str(&format!(
            "<li><strong>{}</strong><span>{}</span></li>",
            esc(s(d, "title")),
            esc(s(d, "why"))
        ));
    }
    if !drills.is_empty() {
        body.push_str(&format!(
            "<section class=\"card\"><h2>Practicing next</h2><ul class=\"drills\">{drills}</ul></section>"
        ));
    }
    if let Some(lines) = page.transcript {
        body.push_str(&transcript_block(lines, page.panel, meeting));
    }
    let description = s(&r["headline"], "summary");
    let head = format!(
        "<meta name=\"description\" content=\"{d}\">\
         <meta property=\"og:type\" content=\"website\">\
         <meta property=\"og:site_name\" content=\"Interview Rounds\">\
         <meta property=\"og:title\" content=\"{PAGE_TITLE}\">\
         <meta property=\"og:description\" content=\"{d}\">\
         <meta property=\"og:url\" content=\"{u}\">\
         <meta name=\"twitter:card\" content=\"summary\">\
         <meta name=\"twitter:title\" content=\"{PAGE_TITLE}\">\
         <meta name=\"twitter:description\" content=\"{d}\">",
        d = esc(description),
        u = esc(page.url),
    );
    shell(
        &head,
        &format!(
            "<header class=\"hero\"><p class=\"eyebrow\">Practice scorecard</p><h1>{}</h1><p class=\"muted\">{}</p></header>{body}\
             <footer class=\"foot\"><p>Made with Interview Rounds: practice interviews and meetings out loud, then a \
             scorecard that quotes you.</p><a class=\"btn\" href=\"/\">Try a round</a></footer>",
            esc(page.title),
            esc(&facts)
        ),
    )
}

/// The small page for a link that was turned off or never existed.
pub fn notice_page(title: &str, text: &str) -> String {
    shell(
        "",
        &format!(
            "<section class=\"card notice\"><h1>{}</h1><p>{}</p><a class=\"btn\" href=\"/\">Try a round</a></section>",
            esc(title),
            esc(text)
        ),
    )
}

const STYLE: &str = ":root{--bg:#faf8f5;--surface:#fff;--ink:#1c1b1a;--muted:#6b6760;--accent:#1f4e79;\
--accent-ink:#fff;--good:#2e7d4f;--warn:#b26b00;--bad:#a23b2a;--line:#e7e3dc;--track:#efebe4;\
--up-bg:#1f4e79;--up-ink:#fff;--down-bg:#f6e3df;--down-ink:#a23b2a;--mid-bg:#f6ecd9;--mid-ink:#7a4a00;\
color-scheme:light dark}\
@media (prefers-color-scheme:dark){:root{--bg:#141413;--surface:#1e1d1b;--ink:#f4f2ee;--muted:#aaa59c;\
--accent:#8db7e0;--accent-ink:#10202e;--good:#7cc79a;--warn:#e3ad52;--bad:#ec8f7d;--line:#34312d;--track:#2c2a27;\
--up-bg:#8db7e0;--up-ink:#10202e;--down-bg:#3a2522;--down-ink:#ec8f7d;--mid-bg:#3a3020;--mid-ink:#e3ad52}}\
*{box-sizing:border-box}\
html{-webkit-text-size-adjust:100%}\
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 Inter,system-ui,-apple-system,'Segoe UI',Roboto,\
'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}\
.wrap{max-width:720px;margin:0 auto;padding:16px 16px 48px}\
.brand{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--ink);text-decoration:none;margin:4px 0 24px}\
h1{font-size:1.9rem;line-height:1.2;margin:0 0 6px;letter-spacing:-0.01em}\
h2{font-size:1.15rem;margin:0 0 10px}\
p{margin:0 0 12px}\
.muted{color:var(--muted)}\
.eyebrow{color:var(--muted);font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;margin:0 0 4px}\
.hero{margin-bottom:20px}\
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 18px 8px;margin:0 0 16px}\
.top{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;margin-bottom:12px}\
.chip{display:inline-flex;flex-direction:column;padding:8px 16px;border-radius:14px;margin:0}\
.chip .pre{font-size:.75rem;opacity:.85}\
.chip .name{font-weight:700;font-size:1.25rem}\
.chip.up{background:var(--up-bg);color:var(--up-ink)}\
.chip.down{background:var(--down-bg);color:var(--down-ink)}\
.chip.mid{background:var(--mid-bg);color:var(--mid-ink)}\
.conf{color:var(--muted);font-size:.95rem}\
.summary{font-size:1.1rem}\
ul,ol{list-style:none;margin:0;padding:0}\
.bar{margin:0 0 14px}\
.bar-head{display:flex;justify-content:space-between;gap:12px}\
.score{color:var(--muted);white-space:nowrap}\
.score strong{color:var(--ink)}\
.track{height:8px;border-radius:4px;background:var(--track);margin:6px 0;overflow:hidden}\
.fill{display:block;height:100%;border-radius:4px}\
.fill.good{background:var(--good)}.fill.warn{background:var(--warn)}.fill.bad{background:var(--bad)}\
.why{color:var(--muted);font-size:.93rem;margin:0}\
.pt,.drills li{display:flex;flex-direction:column;gap:2px;padding:0 0 12px 14px;border-left:3px solid var(--line);margin:0 0 12px}\
.pt.good{border-left-color:var(--good)}.pt.bad{border-left-color:var(--bad)}\
.pt span,.drills span{color:var(--muted)}\
q{font-style:italic;color:var(--ink);margin-top:4px}\
.question{font-size:1.1rem}\
.transcript li{display:grid;grid-template-columns:3.2em 1fr;gap:0 10px;margin:0 0 10px}\
.stamp{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.85rem;padding-top:2px}\
.who{font-weight:600;font-size:.9rem}\
.said{grid-column:2}\
.transcript .you .who{color:var(--accent)}\
.foot{margin-top:28px;color:var(--muted)}\
.btn{display:inline-block;background:var(--accent);color:var(--accent-ink);padding:12px 20px;border-radius:12px;\
font-weight:600;text-decoration:none;min-height:44px}\
.btn:focus-visible{outline:3px solid var(--accent);outline-offset:2px}\
.notice{padding-bottom:18px}\
@media (max-width:480px){h1{font-size:1.6rem}.card{padding:16px 14px 6px}}";

fn shell(head: &str, main: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex\"><title>{PAGE_TITLE}</title>{head}<style>{STYLE}</style></head>\
         <body><div class=\"wrap\"><a class=\"brand\" href=\"/\" aria-label=\"Interview Rounds, home\">\
         <svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" aria-hidden=\"true\">\
         <rect x=\"2\" y=\"13\" width=\"20\" height=\"3\" rx=\"1.5\" fill=\"currentColor\"/>\
         <circle cx=\"7\" cy=\"7.5\" r=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/>\
         <circle cx=\"17\" cy=\"7.5\" r=\"3\" fill=\"currentColor\"/></svg><span>Interview Rounds</span></a>\
         <main>{main}</main></div></body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_url_safe_and_random() {
        let a = new_slug();
        assert_eq!(a.len(), SLUG_LEN);
        assert!(valid_slug(&a));
        assert_ne!(a, new_slug());
        assert!(!valid_slug("short"));
        assert!(!valid_slug("abc/def%gh"));
    }

    #[test]
    fn escapes_markup() {
        assert_eq!(
            esc("<b onclick=\"x\">'&'</b>"),
            "&lt;b onclick=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;"
        );
    }

    #[test]
    fn one_line_takes_the_first_sentence() {
        assert_eq!(
            one_line("Asked for scale. Then sized it."),
            "Asked for scale."
        );
        assert_eq!(one_line("No full stop"), "No full stop");
    }
}
