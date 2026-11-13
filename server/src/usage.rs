//! Spend ledger and caps: what Fish minutes and model calls cost, whether a new session may start, and the
//! `Limits` / `Entitlements` the browser shows.
//!
//! Caps (all config values, `docs/protocol.md` `Limits`):
//! - build: guests are not limited per device, but new Fish sessions stop once recorded plus reserved Fish spend
//!   would pass `fish_build_cap_usd` (the fake voice always works);
//! - judging: guests get 3 quick rounds per device per UTC day and 1 full round per device, under a global spend
//!   cap (`judge_cap_usd`, recorded plus reserved);
//! - after: guests get 1 quick round per device in total;
//! - signed-in free users get 2 rounds, then history and reports only;
//! - in every phase, model spend across everyone per UTC day stops new sessions at `model_daily_cap_usd`.
//!
//! Every model call goes through `MeteredLlm`, which prices it into the ledger (prewarms and streams the caller
//! dropped included; a stream cut before its usage arrived is estimated).
//!
//! A Fish session's minutes are only known at the end, so each new Fish session reserves its worst case
//! (hard stop minutes x concurrent Fish sessions x rate) until the real minutes are recorded.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use async_trait::async_trait;
use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Days, NaiveTime, TimeZone, Utc};
use futures::Stream;
use futures::stream::BoxStream;
use serde::Serialize;
use serde_json::json;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::claude::{ClaudeError, MessagesRequest, MessagesResponse, StreamEvent, Usage};
use crate::config::{Config, PanelMode, UsagePhase};
use crate::content::RoundConfig;
use crate::identity::{Identity, IdentityKind};
use crate::orchestrator::LlmApi;

pub const GUEST_SHORT_PER_DAY: i64 = 3;
pub const GUEST_FULL_PER_DEVICE: i64 = 1;
pub const GUEST_SHORT_AFTER_JUDGING: i64 = 1;
pub const FREE_LIVE_ROUNDS: i64 = 2;
/// Minutes a quick round reserves, for the "blocked" reason shown before a round is picked.
pub const QUICK_ROUND_RESERVE_MIN: f64 = 9.0;

/// List prices in USD per million tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// 5-minute cache writes (1.25 x input).
    pub cache_write: f64,
}

/// Price table by model family. Unknown models are priced as Opus, so a new model never reads as free.
pub fn price_for(model: &str) -> ModelPrice {
    let (input, output, cache_read) = if model.contains("haiku") {
        (0.10, 0.50, 0.01)
    } else if model.contains("sonnet") {
        (2.0, 10.0, 0.10)
    } else {
        (4.0, 20.0, 0.20)
    };
    ModelPrice {
        input,
        output,
        cache_read,
        cache_write: input * 1.25,
    }
}

/// Haiku prompts over 100K tokens cost more.
const HAIKU_LONG_PROMPT: u64 = 100_000;

pub fn claude_cost(model: &str, usage: &Usage) -> f64 {
    let mut p = price_for(model);
    let prompt =
        usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    if model.contains("haiku") && prompt > HAIKU_LONG_PROMPT {
        p = ModelPrice {
            input: 0.50,
            output: 2.50,
            cache_read: 0.05,
            cache_write: 0.50 * 1.25,
        };
    }
    (usage.input_tokens as f64 * p.input
        + usage.output_tokens as f64 * p.output
        + usage.cache_read_input_tokens as f64 * p.cache_read
        + usage.cache_creation_input_tokens as f64 * p.cache_write)
        / 1_000_000.0
}

/// Fish cost of a session: the minutes of each Fish session (one per panelist voice) at the per-minute rate.
/// With all panelists joined for the whole round this is duration x panel sessions x rate.
pub fn fish_cost(minutes_per_session: &[f64], rate_per_min: f64) -> f64 {
    minutes_per_session.iter().map(|m| m.max(0.0)).sum::<f64>() * rate_per_min
}

/// What a new Fish-voiced session holds back until its real minutes are recorded.
pub fn fish_reservation(
    round: &RoundConfig,
    panel_size: usize,
    mode: PanelMode,
    cfg: &Config,
) -> f64 {
    let concurrent = match mode {
        PanelMode::Swap => 1,
        PanelMode::Joined => panel_size.max(1),
    };
    round.hard_stop_minutes.max(round.target_minutes) * concurrent as f64 * cfg.fish_rate_per_min
}

/// Records one model call in the ledger. The identity is taken from the session.
pub async fn record_claude(
    db: &PgPool,
    phase: UsagePhase,
    session_id: Option<Uuid>,
    kind: &str,
    model: &str,
    usage: &Usage,
) -> Result<f64, sqlx::Error> {
    let cost = claude_cost(model, usage);
    sqlx::query(
        "insert into usage_events (identity_id, session_id, provider, kind, model, usage_phase, \
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) \
         values ((select identity_id from sessions where id = $1), $1, 'anthropic', $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(session_id)
    .bind(kind)
    .bind(model)
    .bind(phase.as_str())
    .bind(usage.input_tokens as i64)
    .bind(usage.output_tokens as i64)
    .bind(usage.cache_read_input_tokens as i64)
    .bind(usage.cache_creation_input_tokens as i64)
    .bind(cost)
    .execute(db)
    .await?;
    if let Some(id) = session_id {
        sqlx::query("update sessions set cost_usd = cost_usd + $2 where id = $1")
            .bind(id)
            .bind(cost)
            .execute(db)
            .await?;
    }
    Ok(cost)
}

tokio::task_local! {
    /// The session the model calls of the current request belong to (set around the custom LLM endpoint and
    /// the session routes), so the ledger can charge them to it.
    pub static LLM_SESSION: Uuid;
}

tokio::task_local! {
    /// Set around a model call whose caller records its own ledger row (meeting prepare), so the metered client
    /// does not record it a second time.
    pub static LLM_UNMETERED: ();
}

fn unmetered() -> bool {
    LLM_UNMETERED.try_with(|_| ()).is_ok()
}

fn current_session() -> Option<Uuid> {
    LLM_SESSION.try_with(|id| *id).ok()
}

fn spawn_record(
    db: PgPool,
    phase: UsagePhase,
    session: Option<Uuid>,
    kind: &'static str,
    model: String,
    usage: Usage,
) {
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        tracing::warn!(model = %model, kind, "no runtime to record model usage");
        return;
    };
    rt.spawn(async move {
        if let Err(err) = record_claude(&db, phase, session, kind, &model, &usage).await {
            tracing::warn!(error = %err, kind, "could not record model usage");
        }
    });
}

/// Rough usage of a streamed call that ended before its usage arrived: the newest message as fresh input, the
/// rest of the prompt as a cache read, and about 4 characters per token.
fn estimate(req: &MessagesRequest, out_chars: usize) -> Usage {
    let chars = |v: &serde_json::Value| v.to_string().len() as u64;
    let prefix = chars(&json!({"system": req.system, "tools": req.tools}));
    let (older, newest) = match req.messages.split_last() {
        Some((last, rest)) => (chars(&json!(rest)), chars(&json!(last))),
        None => (0, 0),
    };
    Usage {
        input_tokens: newest / 4 + 1,
        output_tokens: out_chars as u64 / 4,
        cache_read_input_tokens: (prefix + older) / 4,
        cache_creation_input_tokens: 0,
    }
}

/// The model client every caller uses: prices each call into the ledger.
pub struct MeteredLlm {
    inner: Arc<dyn LlmApi>,
    db: PgPool,
    phase: UsagePhase,
}

impl MeteredLlm {
    pub fn new(inner: Arc<dyn LlmApi>, db: PgPool, phase: UsagePhase) -> Self {
        MeteredLlm { inner, db, phase }
    }
}

#[async_trait]
impl LlmApi for MeteredLlm {
    async fn create(&self, req: &MessagesRequest) -> Result<MessagesResponse, ClaudeError> {
        if unmetered() {
            return self.inner.create(req).await;
        }
        let session = current_session();
        let res = self.inner.create(req).await;
        if let Ok(r) = &res {
            let model = if r.model.is_empty() {
                req.model.clone()
            } else {
                r.model.clone()
            };
            let kind = if req.max_tokens == 0 {
                "prewarm"
            } else {
                "model_call"
            };
            spawn_record(
                self.db.clone(),
                self.phase,
                session,
                kind,
                model,
                r.usage.clone(),
            );
        }
        res
    }

    async fn stream(
        &self,
        req: &MessagesRequest,
    ) -> Result<BoxStream<'static, Result<StreamEvent, ClaudeError>>, ClaudeError> {
        if unmetered() {
            return self.inner.stream(req).await;
        }
        let session = current_session();
        let inner = self.inner.stream(req).await?;
        Ok(Box::pin(MeteredStream {
            inner,
            meter: Meter {
                db: self.db.clone(),
                phase: self.phase,
                session,
                model: req.model.clone(),
                estimate: Some(estimate(req, 0)),
                out_chars: 0,
            },
        }))
    }
}

/// Records a stream's usage once: from its stop event, or as an estimate when it is dropped before one.
struct Meter {
    db: PgPool,
    phase: UsagePhase,
    session: Option<Uuid>,
    model: String,
    /// Pending until the stop event arrives.
    estimate: Option<Usage>,
    out_chars: usize,
}

impl Drop for Meter {
    fn drop(&mut self) {
        if let Some(mut usage) = self.estimate.take() {
            usage.output_tokens = self.out_chars as u64 / 4;
            spawn_record(
                self.db.clone(),
                self.phase,
                self.session,
                "live_turn_cut",
                self.model.clone(),
                usage,
            );
        }
    }
}

struct MeteredStream {
    inner: BoxStream<'static, Result<StreamEvent, ClaudeError>>,
    meter: Meter,
}

impl Stream for MeteredStream {
    type Item = Result<StreamEvent, ClaudeError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let next = self.inner.as_mut().poll_next(cx);
        if let Poll::Ready(Some(Ok(ev))) = &next {
            match ev {
                StreamEvent::TextDelta(t) => self.meter.out_chars += t.len(),
                StreamEvent::Stop { usage, .. } if self.meter.estimate.take().is_some() => {
                    let m = &self.meter;
                    spawn_record(
                        m.db.clone(),
                        m.phase,
                        m.session,
                        "live_turn",
                        m.model.clone(),
                        usage.clone(),
                    );
                }
                _ => {}
            }
        }
        next
    }
}

/// One Fish session's measured minutes, and where the number came from (`fish` or `clock`).
#[derive(Clone, Debug, Serialize)]
pub struct FishMinutes {
    pub fish_session_id: String,
    pub panelist_id: String,
    pub minutes: f64,
    pub source: &'static str,
}

/// Records a finished session's Fish minutes and releases its reservation. Runs once per session.
pub async fn record_fish(
    db: &PgPool,
    cfg: &Config,
    session_id: Uuid,
    minutes: &[FishMinutes],
) -> Result<f64, sqlx::Error> {
    let per: Vec<f64> = minutes.iter().map(|m| m.minutes).collect();
    let cost = fish_cost(&per, cfg.fish_rate_per_min);
    let mut tx = db.begin().await?;
    let identity: Option<Uuid> = sqlx::query_scalar(
        "update sessions set fish_usage_recorded = true, cost_usd = cost_usd + $2 \
         where id = $1 and not fish_usage_recorded returning identity_id",
    )
    .bind(session_id)
    .bind(cost)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(identity) = identity else {
        tx.rollback().await?;
        return Ok(0.0);
    };
    sqlx::query(
        "insert into usage_events (identity_id, session_id, provider, kind, usage_phase, minutes, cost_usd, meta) \
         values ($1, $2, 'fish', 'voice', $3, $4, $5, $6)",
    )
    .bind(identity)
    .bind(session_id)
    .bind(cfg.usage_phase.as_str())
    .bind(per.iter().sum::<f64>())
    .bind(cost)
    .bind(json!({ "sessions": minutes, "rate_per_min": cfg.fish_rate_per_min }))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(cost)
}

/// Fish spend in the build phase: outside spend + recorded minutes + reservations of unrecorded Fish sessions.
pub async fn fish_build_spend(conn: &mut PgConnection, cfg: &Config) -> Result<f64, sqlx::Error> {
    let recorded: f64 = sqlx::query_scalar(
        "select coalesce(sum(cost_usd), 0)::float8 from usage_events where provider = 'fish' and usage_phase = 'build'",
    )
    .fetch_one(&mut *conn)
    .await?;
    Ok(cfg.fish_build_spent_usd + recorded + reserved(conn).await?)
}

/// Model spend today (UTC), across everyone.
pub async fn model_spend_today(conn: &mut PgConnection) -> Result<f64, sqlx::Error> {
    sqlx::query_scalar(
        "select coalesce(sum(cost_usd), 0)::float8 from usage_events \
         where provider = 'anthropic' and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'",
    )
    .fetch_one(conn)
    .await
}

/// All spend in the judging phase (Fish and model calls) + reservations of unrecorded Fish sessions.
pub async fn judging_spend(conn: &mut PgConnection) -> Result<f64, sqlx::Error> {
    let recorded: f64 = sqlx::query_scalar(
        "select coalesce(sum(cost_usd), 0)::float8 from usage_events where usage_phase = 'judging'",
    )
    .fetch_one(&mut *conn)
    .await?;
    Ok(recorded + reserved(conn).await?)
}

async fn reserved(conn: &mut PgConnection) -> Result<f64, sqlx::Error> {
    sqlx::query_scalar(
        "select coalesce(sum(fish_reserved_usd), 0)::float8 from sessions \
         where voice = 'fish' and not fish_usage_recorded and status <> 'failed'",
    )
    .fetch_one(conn)
    .await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Length {
    Short,
    Full,
}

/// What a new session would use, for the cap check.
#[derive(Clone, Copy, Debug)]
pub struct StartRequest {
    pub length: Length,
    pub fish: bool,
    /// Fish reservation of this session (0 for the fake voice).
    pub reservation_usd: f64,
}

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum CapError {
    #[error("guest daily limit")]
    GuestDailyLimit { resets_at: Option<DateTime<Utc>> },
    #[error("guest full round used")]
    GuestFullUsed,
    #[error("judging budget reached")]
    JudgeBudgetReached,
    #[error("build budget reached")]
    BuildBudgetReached,
    #[error("free rounds used")]
    FreeRoundsUsed,
    #[error("model budget reached")]
    ModelBudgetReached,
}

impl CapError {
    /// Same values as `Limits.reason`.
    pub fn code(&self) -> &'static str {
        match self {
            CapError::GuestDailyLimit { .. } => "guest_daily_limit",
            CapError::GuestFullUsed => "guest_full_used",
            CapError::JudgeBudgetReached => "judge_budget_reached",
            CapError::BuildBudgetReached => "build_budget_reached",
            CapError::FreeRoundsUsed => "free_rounds_used",
            CapError::ModelBudgetReached => "model_budget_reached",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            CapError::GuestDailyLimit { resets_at: Some(_) } => {
                "You've used today's rounds on this device. Come back tomorrow for more."
            }
            CapError::GuestDailyLimit { resets_at: None } => {
                "You've used the guest round on this device. Your reports and history stay here."
            }
            CapError::GuestFullUsed => {
                "The full round on this device has been used. Quick rounds are still open."
            }
            CapError::JudgeBudgetReached => {
                "The guest pass is fully booked for now. Please come back tomorrow."
            }
            CapError::BuildBudgetReached => {
                "Live voice is paused for now. The text voice still works."
            }
            CapError::FreeRoundsUsed => {
                "You have used your free live rounds. Your history and reports stay here."
            }
            CapError::ModelBudgetReached => {
                "Rounds are fully booked for today. Please come back tomorrow."
            }
        }
    }

    pub fn resets_at(&self) -> Option<DateTime<Utc>> {
        match self {
            CapError::GuestDailyLimit { resets_at } => *resets_at,
            _ => None,
        }
    }
}

impl IntoResponse for CapError {
    fn into_response(self) -> Response {
        let status = StatusCode::TOO_MANY_REQUESTS;
        let body = json!({
            "status": status.as_u16(),
            "code": self.code(),
            "message": self.message(),
            "resets_at": self.resets_at(),
        });
        (status, Json(body)).into_response()
    }
}

/// `me.schema.json#/$defs/limits`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Limits {
    pub short_left_today: Option<i64>,
    pub full_left: Option<i64>,
    pub resets_at: Option<DateTime<Utc>>,
    pub reason: Option<&'static str>,
}

/// `me.schema.json#/$defs/entitlements`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Entitlements {
    pub plan: &'static str,
    pub free_rounds_left: Option<i64>,
    pub minutes_total: Option<i64>,
    pub minutes_used: Option<f64>,
    pub period_end: Option<DateTime<Utc>>,
}

/// Next 00:00 UTC after `now`.
pub fn next_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    let day = now.date_naive() + Days::new(1);
    Utc.from_utc_datetime(&day.and_time(NaiveTime::MIN))
}

fn today_start(now: DateTime<Utc>) -> DateTime<Utc> {
    Utc.from_utc_datetime(&now.date_naive().and_time(NaiveTime::MIN))
}

/// Session counts that limits are based on: rounds that went live (the browser's first socket hello). Failed
/// sessions and sessions that never started (made on the mic tap, never entered) do not count. A retry counts as
/// a quick round.
#[derive(Clone, Copy, Debug, Default)]
struct Counts {
    short_today: i64,
    short_ever: i64,
    full_ever: i64,
    all_ever: i64,
}

async fn counts(
    conn: &mut PgConnection,
    identity: Uuid,
    now: DateTime<Utc>,
) -> Result<Counts, sqlx::Error> {
    let row: (i64, i64, i64, i64) = sqlx::query_as(
        "select count(*) filter (where length in ('short', 'retry') and created_at >= $2), \
                count(*) filter (where length in ('short', 'retry')), \
                count(*) filter (where length = 'full'), \
                count(*) \
         from sessions \
         where identity_id = $1 and status <> 'failed' and started_at is not null",
    )
    .bind(identity)
    .bind(today_start(now))
    .fetch_one(conn)
    .await?;
    Ok(Counts {
        short_today: row.0,
        short_ever: row.1,
        full_ever: row.2,
        all_ever: row.3,
    })
}

/// An active paid plan, if any: (plan, minutes_total, starts_at, expires_at).
async fn paid_plan(
    conn: &mut PgConnection,
    identity: Uuid,
) -> Result<Option<(String, i64, DateTime<Utc>, Option<DateTime<Utc>>)>, sqlx::Error> {
    sqlx::query_as(
        "select plan, minutes_total::bigint, starts_at, expires_at from entitlements \
         where identity_id = $1 and plan <> 'free' and starts_at <= now() \
           and (expires_at is null or expires_at > now()) \
         order by starts_at desc limit 1",
    )
    .bind(identity)
    .fetch_optional(conn)
    .await
}

pub async fn entitlements(
    conn: &mut PgConnection,
    identity: &Identity,
) -> Result<Entitlements, sqlx::Error> {
    if identity.kind == IdentityKind::Guest {
        return Ok(Entitlements {
            plan: "guest",
            free_rounds_left: None,
            minutes_total: None,
            minutes_used: None,
            period_end: None,
        });
    }
    if let Some((plan, _, starts_at, expires_at)) = paid_plan(conn, identity.id).await? {
        let total: i64 = sqlx::query_scalar(
            "select coalesce(sum(minutes_total), 0)::bigint from entitlements \
             where identity_id = $1 and plan <> 'free' and (expires_at is null or expires_at > now())",
        )
        .bind(identity.id)
        .fetch_one(&mut *conn)
        .await?;
        let used: f64 = sqlx::query_scalar(
            "select coalesce(sum(minutes), 0)::float8 from usage_events \
             where identity_id = $1 and provider = 'fish' and created_at >= $2",
        )
        .bind(identity.id)
        .bind(starts_at)
        .fetch_one(&mut *conn)
        .await?;
        let plan = match plan.as_str() {
            "pro" => "pro",
            _ => "sprint",
        };
        return Ok(Entitlements {
            plan,
            free_rounds_left: None,
            minutes_total: Some(total),
            minutes_used: Some(used),
            period_end: expires_at,
        });
    }
    let c = counts(conn, identity.id, Utc::now()).await?;
    Ok(Entitlements {
        plan: "free",
        free_rounds_left: Some((FREE_LIVE_ROUNDS - c.all_ever).max(0)),
        minutes_total: None,
        minutes_used: None,
        period_end: None,
    })
}

/// Whether the spend caps leave room for `extra_usd` more (judging cap for guests and free users in judging;
/// build cap for Fish in the build phase).
async fn budget_error(
    conn: &mut PgConnection,
    identity: &Identity,
    cfg: &Config,
    fish: bool,
    extra_usd: f64,
    capped_user: bool,
) -> Result<Option<CapError>, sqlx::Error> {
    // Every phase, everyone: a safety stop on model spend per UTC day.
    if model_spend_today(conn).await? >= cfg.model_daily_cap_usd {
        return Ok(Some(CapError::ModelBudgetReached));
    }
    if cfg.usage_phase == UsagePhase::Judging
        && (identity.kind == IdentityKind::Guest || capped_user)
        && judging_spend(conn).await? + extra_usd >= cfg.judge_cap_usd
    {
        return Ok(Some(CapError::JudgeBudgetReached));
    }
    if cfg.usage_phase == UsagePhase::Build
        && fish
        && fish_build_spend(conn, cfg).await? + extra_usd >= cfg.fish_build_cap_usd
    {
        return Ok(Some(CapError::BuildBudgetReached));
    }
    Ok(None)
}

/// The limits shown on Home and returned with a new session. `reason` says why a new quick round with the
/// live voice would be refused right now.
pub async fn limits(
    conn: &mut PgConnection,
    identity: &Identity,
    cfg: &Config,
    now: DateTime<Utc>,
) -> Result<Limits, sqlx::Error> {
    let c = counts(conn, identity.id, now).await?;
    let mut limits = Limits {
        short_left_today: None,
        full_left: None,
        resets_at: None,
        reason: None,
    };
    let mut free_user = false;
    match identity.kind {
        IdentityKind::Guest => match cfg.usage_phase {
            UsagePhase::Build => {}
            UsagePhase::Judging => {
                limits.short_left_today = Some((GUEST_SHORT_PER_DAY - c.short_today).max(0));
                limits.full_left = Some((GUEST_FULL_PER_DEVICE - c.full_ever).max(0));
                limits.resets_at = Some(next_midnight(now));
            }
            UsagePhase::After => {
                limits.short_left_today = Some((GUEST_SHORT_AFTER_JUDGING - c.short_ever).max(0));
                limits.full_left = Some(0);
            }
        },
        IdentityKind::User => free_user = paid_plan(conn, identity.id).await?.is_none(),
    }
    // Blocked when there is no room left for one more quick round with the live voice.
    let quick_round = QUICK_ROUND_RESERVE_MIN * cfg.fish_rate_per_min;
    limits.reason = budget_error(conn, identity, cfg, true, quick_round, free_user)
        .await?
        .map(|e| e.code());
    if limits.reason.is_none() {
        if limits.short_left_today == Some(0) {
            limits.reason = Some("guest_daily_limit");
        } else if free_user && c.all_ever >= FREE_LIVE_ROUNDS {
            limits.reason = Some("free_rounds_used");
        }
    }
    Ok(limits)
}

/// Refuses a new session that a cap does not allow. Call it under the creation lock, in the same transaction
/// that inserts the session, so two requests cannot both take the last slot.
pub async fn check_can_start(
    conn: &mut PgConnection,
    identity: &Identity,
    req: &StartRequest,
    cfg: &Config,
) -> Result<Result<(), CapError>, sqlx::Error> {
    let now = Utc::now();
    let free_user =
        identity.kind == IdentityKind::User && paid_plan(conn, identity.id).await?.is_none();
    if let Some(err) = budget_error(
        conn,
        identity,
        cfg,
        req.fish,
        req.reservation_usd,
        free_user,
    )
    .await?
    {
        return Ok(Err(err));
    }
    let c = counts(conn, identity.id, now).await?;
    if identity.kind == IdentityKind::Guest {
        match (cfg.usage_phase, req.length) {
            (UsagePhase::Build, _) => {}
            (UsagePhase::Judging, Length::Short) if c.short_today >= GUEST_SHORT_PER_DAY => {
                return Ok(Err(CapError::GuestDailyLimit {
                    resets_at: Some(next_midnight(now)),
                }));
            }
            (UsagePhase::Judging, Length::Full) if c.full_ever >= GUEST_FULL_PER_DEVICE => {
                return Ok(Err(CapError::GuestFullUsed));
            }
            (UsagePhase::After, Length::Short) if c.short_ever >= GUEST_SHORT_AFTER_JUDGING => {
                return Ok(Err(CapError::GuestDailyLimit { resets_at: None }));
            }
            (UsagePhase::After, Length::Full) => return Ok(Err(CapError::GuestFullUsed)),
            _ => {}
        }
    } else if free_user && c.all_ever >= FREE_LIVE_ROUNDS {
        return Ok(Err(CapError::FreeRoundsUsed));
    }
    Ok(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_follow_the_list() {
        let u = Usage {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_creation_input_tokens: 1_000_000,
        };
        assert!((claude_cost("claude-opus-5-5", &u) - (4.0 + 20.0 + 0.2 + 5.0)).abs() < 1e-9);
        assert!((claude_cost("claude-sonnet-5-5", &u) - (2.0 + 10.0 + 0.1 + 2.5)).abs() < 1e-9);
        // Haiku has a short-prompt tier (up to 100K prompt tokens) and a long-prompt tier above it.
        let short = Usage {
            input_tokens: 50_000,
            output_tokens: 10_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        };
        assert!((claude_cost("claude-haiku-5-5", &short) - (0.005 + 0.005)).abs() < 1e-9);
        assert!((claude_cost("claude-haiku-5-5", &u) - (0.5 + 2.5 + 0.05 + 0.625)).abs() < 1e-9);
        // Unknown models are never free.
        assert_eq!(price_for("something-new"), price_for("claude-opus-5-5"));
    }

    #[test]
    fn fish_cost_is_minutes_times_sessions_times_rate() {
        // Two panelists joined for 10 minutes each at $0.07.
        assert!((fish_cost(&[10.0, 10.0], 0.07) - 1.4).abs() < 1e-9);
        assert_eq!(fish_cost(&[], 0.07), 0.0);
    }

    #[test]
    fn midnight_is_the_next_utc_day() {
        let now = Utc.with_ymd_and_hms(2026, 11, 20, 23, 59, 0).unwrap();
        assert_eq!(
            next_midnight(now),
            Utc.with_ymd_and_hms(2026, 11, 21, 0, 0, 0).unwrap()
        );
    }
}
