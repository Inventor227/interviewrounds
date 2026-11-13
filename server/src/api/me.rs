//! `GET /api/me` and friends: identity, settings, streak, the daily round, history and the skill chart.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Extension, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Datelike, Days, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::app::AppState;
use crate::content::Catalog;
use crate::error::{AppError, AppResult};
use crate::identity::{COOKIE, Identity};
use crate::persist;
use crate::usage;

/// `settings.schema.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub default_role: Option<String>,
    pub default_level: crate::orchestrator::Level,
    pub default_style: crate::orchestrator::Style,
    pub voice_speed: f64,
    pub captions: bool,
    pub dominant_hand: String,
    pub sfx_volume: f64,
    pub avatar_brightness: f64,
    pub practice_mode: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            default_role: None,
            default_level: crate::orchestrator::Level::Mid,
            default_style: crate::orchestrator::Style::Neutral,
            voice_speed: 1.0,
            captions: false,
            dominant_hand: "right".into(),
            sfx_volume: 0.6,
            avatar_brightness: 1.0,
            practice_mode: false,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(role) = &self.default_role
            && !["sde", "pm"].contains(&role.as_str())
        {
            return Err("default_role must be sde, pm or null".into());
        }
        if !["right", "left"].contains(&self.dominant_hand.as_str()) {
            return Err("dominant_hand must be right or left".into());
        }
        for (name, v, lo, hi) in [
            ("voice_speed", self.voice_speed, 0.8, 1.25),
            ("sfx_volume", self.sfx_volume, 0.0, 1.0),
            ("avatar_brightness", self.avatar_brightness, 0.6, 1.2),
        ] {
            if !(lo..=hi).contains(&v) {
                return Err(format!("{name} must be between {lo} and {hi}"));
            }
        }
        Ok(())
    }
}

/// Stored settings over the defaults (a stored document from an older shape still loads).
pub async fn load_settings(db: &PgPool, identity: Uuid) -> Result<Settings, sqlx::Error> {
    let stored: Option<Value> =
        sqlx::query_scalar("select data from settings where identity_id = $1")
            .bind(identity)
            .fetch_optional(db)
            .await?;
    let mut v = json!(Settings::default());
    if let (Some(Value::Object(stored)), Some(base)) = (stored, v.as_object_mut()) {
        for (k, val) in stored {
            if base.contains_key(&k) {
                base.insert(k, val);
            }
        }
    }
    Ok(serde_json::from_value::<Settings>(v)
        .ok()
        .filter(|s| s.validate().is_ok())
        .unwrap_or_default())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Streak {
    pub current: u32,
    pub best: u32,
    pub today_done: bool,
}

/// Consecutive UTC days with at least one scored session. The current run counts back from today, or from
/// yesterday when today has none yet (the streak is still alive until the day ends).
pub fn streak_from_days(days: &[NaiveDate], today: NaiveDate) -> Streak {
    let mut days: Vec<NaiveDate> = days.iter().copied().filter(|d| *d <= today).collect();
    days.sort();
    days.dedup();
    let mut best = 0u32;
    let mut run = 0u32;
    let mut prev: Option<NaiveDate> = None;
    for d in &days {
        run = match prev {
            Some(p) if p.succ_opt() == Some(*d) => run + 1,
            _ => 1,
        };
        best = best.max(run);
        prev = Some(*d);
    }
    let today_done = days.last() == Some(&today);
    let yesterday = today - Days::new(1);
    let current = match days.last() {
        Some(last) if *last == today || *last == yesterday => run,
        _ => 0,
    };
    Streak {
        current,
        best,
        today_done,
    }
}

/// `me::streak`: scored sessions by UTC day of their start.
pub async fn streak(db: &PgPool, identity: Uuid, today: NaiveDate) -> Result<Streak, sqlx::Error> {
    let days: Vec<NaiveDate> = sqlx::query_scalar(
        "select distinct (coalesce(started_at, created_at) at time zone 'UTC')::date from sessions \
         where identity_id = $1 and status = 'scored'",
    )
    .bind(identity)
    .fetch_all(db)
    .await?;
    Ok(streak_from_days(&days, today))
}

/// Today's suggested round: the role's short rounds in id order, rotated by day of year.
pub fn daily_round(catalog: &Catalog, date: NaiveDate, role: &str) -> Option<(String, String)> {
    let shorts: Vec<_> = catalog
        .rounds
        .values()
        .filter(|r| r.role == role && r.length == "short")
        .collect();
    if shorts.is_empty() {
        return None;
    }
    let r = shorts[date.ordinal0() as usize % shorts.len()];
    Some((r.id.clone(), r.title.clone()))
}

/// The round ids of a role (None = every round).
fn role_rounds(catalog: &Catalog, role: Option<&str>) -> Option<Vec<String>> {
    role.map(|want| {
        catalog
            .rounds
            .values()
            .filter(|r| r.role == want)
            .map(|r| r.id.clone())
            .collect()
    })
}

/// Competency scores of the role's last 10 scored sessions, oldest first.
pub async fn skills(
    db: &PgPool,
    catalog: &Catalog,
    identity: Uuid,
    role: Option<&str>,
) -> Result<Value, sqlx::Error> {
    let rounds = role_rounds(catalog, role);
    let mut picked: Vec<(Uuid, Option<String>, DateTime<Utc>, Value)> = sqlx::query_as(
        "select s.id, s.round_id, coalesce(s.started_at, s.created_at), \
                coalesce(r.report -> 'competencies', '[]'::jsonb) \
         from sessions s join reports r on r.session_id = s.id \
         where s.identity_id = $1 and s.status = 'scored' and ($2::text[] is null or s.round_id = any($2)) \
         order by coalesce(s.started_at, s.created_at) desc limit 10",
    )
    .bind(identity)
    .bind(rounds)
    .fetch_all(db)
    .await?;
    picked.reverse();
    let mut competencies: BTreeMap<String, (String, Vec<Value>)> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for (session_id, _, at, competencies_json) in picked {
        for c in competencies_json.as_array().into_iter().flatten() {
            let (Some(id), Some(score)) = (c["id"].as_str(), c["score"].as_f64()) else {
                continue;
            };
            let name = c["name"].as_str().unwrap_or(id).to_string();
            let entry = competencies.entry(id.to_string()).or_insert_with(|| {
                order.push(id.to_string());
                (name, Vec::new())
            });
            entry
                .1
                .push(json!({"session_id": session_id, "at": at, "score": score}));
        }
    }
    let list: Vec<Value> = order
        .iter()
        .filter_map(|id| {
            competencies
                .get(id)
                .map(|(name, points)| json!({"id": id, "name": name, "points": points}))
        })
        .collect();
    Ok(json!({ "competencies": list }))
}

/// `GET /api/me`.
pub async fn me(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> AppResult<Json<Value>> {
    let now = Utc::now();
    let settings = load_settings(&app.db, identity.id).await?;
    let streak = streak(&app.db, identity.id, now.date_naive()).await?;
    let role = settings
        .default_role
        .clone()
        .unwrap_or_else(|| "sde".into());
    let daily = daily_round(&app.catalog, now.date_naive(), &role)
        .map(|(round_id, title)| json!({"round_id": round_id, "title": title}));
    let mut conn = app.db.acquire().await?;
    let limits = usage::limits(&mut conn, &identity, &app.config, now).await?;
    let entitlements = usage::entitlements(&mut conn, &identity).await?;
    drop(conn);
    let resumable = resumable(&app, identity.id).await?;
    let mut who = json!({"kind": identity.kind.as_str()});
    if let Some(name) = &identity.name {
        who["name"] = json!(name);
    }
    if let Some(email) = &identity.email {
        who["email"] = json!(email);
    }
    Ok(Json(json!({
        "identity": who,
        "sign_in_available": app.config.google_client_id.is_some(),
        "settings": settings,
        "onboarding_done": identity.onboarding_done,
        "streak": streak,
        "daily": daily,
        "limits": limits,
        "entitlements": entitlements,
        "resumable": resumable,
    })))
}

/// A started round of this identity with no browser connected that can still be resumed:
/// `{session_id, round_title, expires_at}`. A live round can be resumed for the offline window after the drop; a
/// paused one until its pause budget runs out (resuming from a pause does not use up a resume).
pub async fn resumable(app: &AppState, identity: Uuid) -> Result<Option<Value>, sqlx::Error> {
    type Row = (
        Uuid,
        Option<String>,
        String,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
        Option<f64>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "select id, round_id, status, started_at, last_socket_at, (live_state->>'elapsed_ms')::float8 \
         from sessions \
         where identity_id = $1 and status in ('live', 'paused') and started_at is not null \
           and (resume_count < 3 or status = 'paused') \
         order by started_at desc limit 5",
    )
    .bind(identity)
    .fetch_all(&app.db)
    .await?;
    let window = chrono::Duration::from_std(app.timing.offline_limit).unwrap_or_default();
    let budget = chrono::Duration::from_std(app.timing.pause_limit).unwrap_or_default();
    let now = Utc::now();
    for (id, round_id, status, started_at, last_socket_at, elapsed_ms) in rows {
        let key = id.to_string();
        let expires_at = match (app.hubs.get(&key), app.registry.get(&key)) {
            // In memory: only when no socket is connected now.
            (Some(hub), Some(handle)) => {
                match crate::ws::resume_window_left(app, &hub, &handle).await {
                    Some(left) => now + chrono::Duration::from_std(left).unwrap_or_default(),
                    None => continue,
                }
            }
            // Not loaded (the server restarted). Paused: the round time stood still since the pause, so the
            // budget ends at start + round time + budget. Live: the last time a socket was seen.
            _ if status == "paused" => match started_at {
                Some(start) => {
                    start
                        + chrono::Duration::milliseconds(elapsed_ms.unwrap_or(0.0) as i64)
                        + budget
                }
                None => continue,
            },
            _ => match last_socket_at {
                Some(t) => t + window,
                None => continue,
            },
        };
        if expires_at <= now {
            continue;
        }
        let round_title = round_id
            .as_deref()
            .and_then(|r| app.catalog.round(r))
            .map(|r| r.title.clone())
            .unwrap_or_default();
        return Ok(Some(json!({
            "session_id": id,
            "round_title": round_title,
            "expires_at": expires_at,
        })));
    }
    Ok(None)
}

#[derive(Debug, Deserialize)]
pub struct RoleQuery {
    #[serde(default)]
    pub role: Option<String>,
}

/// Session id, round id, start, headline.
type HistoryRow = (Uuid, Option<String>, DateTime<Utc>, Option<String>);

/// `GET /api/me/history?role=`: sessions with a report, newest first.
pub async fn history(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Query(q): Query<RoleQuery>,
) -> AppResult<Json<Value>> {
    let role = q.role.as_deref().filter(|r| !r.is_empty());
    let rows: Vec<HistoryRow> = sqlx::query_as(
        "select s.id, s.round_id, coalesce(s.started_at, s.created_at), r.report -> 'headline' ->> 'summary' \
         from sessions s join reports r on r.session_id = s.id \
         where s.identity_id = $1 and ($2::text[] is null or s.round_id = any($2)) \
         order by coalesce(s.started_at, s.created_at) desc limit 200",
    )
    .bind(identity.id)
    .bind(role_rounds(&app.catalog, role))
    .fetch_all(&app.db)
    .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, round, at, headline)| {
            let round_id = round.unwrap_or_default();
            let title = app
                .catalog
                .round(&round_id)
                .map(|r| r.title.clone())
                .unwrap_or_else(|| round_id.clone());
            json!({
                "session_id": id,
                "round_id": round_id,
                "title": title,
                "started_at": at,
                "headline": headline.unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(Value::Array(list)))
}

/// `GET /api/me/skills?role=`.
pub async fn skills_route(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Query(q): Query<RoleQuery>,
) -> AppResult<Json<Value>> {
    let role = q.role.as_deref().filter(|r| !r.is_empty());
    Ok(Json(
        skills(&app.db, &app.catalog, identity.id, role).await?,
    ))
}

/// `PUT /api/me/settings` with the whole `Settings` object.
pub async fn put_settings(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Json(body): Json<Value>,
) -> AppResult<Json<Settings>> {
    let settings: Settings = serde_json::from_value(body)
        .map_err(|e| AppError::BadRequest(format!("Settings are not valid: {e}")))?;
    settings
        .validate()
        .map_err(|e| AppError::BadRequest(format!("Settings are not valid: {e}")))?;
    sqlx::query(
        "insert into settings (identity_id, data, updated_at) values ($1, $2, now()) \
         on conflict (identity_id) do update set data = excluded.data, updated_at = now()",
    )
    .bind(identity.id)
    .bind(json!(settings))
    .execute(&app.db)
    .await?;
    Ok(Json(settings))
}

/// `POST /api/me/onboarding-done`.
pub async fn onboarding_done(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> AppResult<StatusCode> {
    sqlx::query("update identities set onboarding_done = true where id = $1")
        .bind(identity.id)
        .execute(&app.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/me`: removes the identity and everything it owns, and clears the cookie.
pub async fn delete_me(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> AppResult<Response> {
    // Spend first: open rounds end and Fish minutes are settled into the ledger, which outlives the identity.
    let claimed: Vec<Uuid> =
        sqlx::query_scalar("select id from identities where claimed_into = $1")
            .bind(identity.id)
            .fetch_all(&app.db)
            .await?;
    for who in std::iter::once(identity.id).chain(claimed) {
        persist::settle_identity(&app, who).await?;
    }
    // Guests claimed into this user go too.
    sqlx::query("delete from identities where id = $1 or claimed_into = $1")
        .bind(identity.id)
        .execute(&app.db)
        .await?;
    tracing::info!(identity_id = %identity.id, kind = identity.kind.as_str(), "identity deleted");
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"
        ))
        .expect("static cookie"),
    );
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, day).unwrap()
    }

    #[test]
    fn streak_counts_runs() {
        let s = streak_from_days(&[d(10), d(11), d(12), d(14)], d(14));
        assert_eq!(
            s,
            Streak {
                current: 1,
                best: 3,
                today_done: true
            }
        );
        // Yesterday still counts until today ends.
        let s = streak_from_days(&[d(10), d(11), d(12)], d(13));
        assert_eq!((s.current, s.best, s.today_done), (3, 3, false));
        let s = streak_from_days(&[d(10)], d(13));
        assert_eq!(s.current, 0);
        assert_eq!(streak_from_days(&[], d(13)).best, 0);
    }

    #[test]
    fn settings_ranges_are_checked() {
        assert!(Settings::default().validate().is_ok());
        let s = Settings {
            voice_speed: 2.0,
            ..Settings::default()
        };
        assert!(s.validate().is_err());
        let s = Settings {
            default_role: Some("chef".into()),
            ..Settings::default()
        };
        assert!(s.validate().is_err());
    }
}
