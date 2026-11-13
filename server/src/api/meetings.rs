//! `POST /api/meetings/prepare` `MeetingSetup` → `{meeting_plan_id, plan: MeetingPlanPublic}`.
//!
//! The plan is stored whole (with each attendee's hidden block) in `meeting_plans`, next to the setup it came from;
//! the browser gets it without the hidden blocks. Sessions load both with `load_meeting`.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Extension, State};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::app::AppState;
use crate::claude::Usage;
use crate::error::{AppError, AppResult};
use crate::meeting::prepare::{PrepareError, prepare_with_usage};
use crate::meeting::{MeetingSetup, MeetingState, validate_setup};

/// Prepare calls one identity may make (each is an Opus call), counted in the ledger.
pub const HOURLY_PREPARE_LIMIT: i64 = 6;
pub const DAILY_PREPARE_LIMIT: i64 = 20;
/// Ledger kind of a prepare call.
pub const PREPARE_KIND: &str = "meeting_prepare";
/// A reservation older than this no longer blocks a new prepare (the request died).
const RUNNING_STALE_MINUTES: i64 = 5;

/// Who is calling, set by the identity layer in front of the API routes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caller {
    pub identity_id: Uuid,
}

pub async fn prepare_route(
    State(app): State<AppState>,
    caller: Option<Extension<Caller>>,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let Some(Extension(caller)) = caller else {
        return Err(AppError::Unauthorized);
    };
    Ok(Json(prepare_for(&app, caller.identity_id, &body).await?))
}

/// Parses and checks the setup (all size caps before any model call), reserves a prepare in the ledger (limits
/// per hour and day, one at a time per identity), prepares the plan, records its spend, stores it and returns the
/// public response.
pub async fn prepare_for(app: &AppState, identity_id: Uuid, body: &[u8]) -> AppResult<Value> {
    let setup = parse_setup(body)?;
    let ledger_id = reserve_prepare(app, identity_id).await?;
    let prepared = prepare_with_usage(app.llm.as_ref(), &app.catalog, &setup).await;
    let usage = prepared.as_ref().ok().and_then(|p| p.usage.clone());
    let state = if prepared.is_ok() { "done" } else { "failed" };
    if let Err(e) = settle_prepare(&app.db, ledger_id, usage.as_ref(), state).await {
        tracing::warn!(error = %e, "could not record the prepare spend");
    }
    let plan = prepared
        .map_err(|e| match e {
            PrepareError::Invalid(msg) => AppError::BadRequest(msg),
            PrepareError::Content(msg) => AppError::Internal(anyhow::anyhow!(msg)),
        })?
        .plan;
    let id: Uuid = sqlx::query_scalar(
        "insert into meeting_plans (identity_id, template_id, setup, plan) values ($1, $2, $3, $4) returning id",
    )
    .bind(identity_id)
    .bind(setup.template_id.map(|t| t.as_str()))
    .bind(serde_json::to_value(&setup).map_err(|e| AppError::Internal(e.into()))?)
    .bind(serde_json::to_value(&plan).map_err(|e| AppError::Internal(e.into()))?)
    .fetch_one(&app.db)
    .await?;
    tracing::info!(meeting_plan_id = %id, attendees = plan.attendees.len(), user_chairs = plan.user_chairs, "meeting prepared");
    Ok(json!({ "meeting_plan_id": id, "plan": plan.public() }))
}

/// Counts this identity's prepares and, when allowed, records a running one, all under a per-identity lock so
/// concurrent requests cannot all pass. Returns the ledger row id.
async fn reserve_prepare(app: &AppState, identity_id: Uuid) -> AppResult<i64> {
    let mut tx = app.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1::text, 18))")
        .bind(identity_id)
        .execute(&mut *tx)
        .await?;
    let (hour, day, running): (i64, i64, i64) = sqlx::query_as(
        "select count(*) filter (where created_at > now() - interval '1 hour'), \
                count(*), \
                count(*) filter (where meta->>'state' = 'running' \
                                   and created_at > now() - make_interval(mins => $3)) \
         from usage_events \
         where identity_id = $1 and kind = $2 and created_at > now() - interval '1 day'",
    )
    .bind(identity_id)
    .bind(PREPARE_KIND)
    .bind(RUNNING_STALE_MINUTES as i32)
    .fetch_one(&mut *tx)
    .await?;
    if running > 0 {
        return Err(AppError::Limited {
            code: "prepare_running",
            message: "Your meeting is still being prepared. Wait for it to finish.".into(),
        });
    }
    if hour >= HOURLY_PREPARE_LIMIT {
        return Err(AppError::Limited {
            code: "prepare_limit",
            message:
                "You have prepared several meetings in the last hour. Try again a little later."
                    .into(),
        });
    }
    if day >= DAILY_PREPARE_LIMIT {
        return Err(AppError::Limited {
            code: "prepare_limit",
            message: "You have prepared a lot of meetings today. Try again tomorrow.".into(),
        });
    }
    let id: i64 = sqlx::query_scalar(
        "insert into usage_events (identity_id, provider, kind, model, usage_phase, meta) \
         values ($1, 'anthropic', $2, $3, $4, '{\"state\": \"running\"}'::jsonb) returning id",
    )
    .bind(identity_id)
    .bind(PREPARE_KIND)
    .bind(crate::meeting::PREPARE_MODEL)
    .bind(app.config.usage_phase.as_str())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(id)
}

/// Records what the prepare call used and cost, and that it finished.
async fn settle_prepare(
    db: &PgPool,
    ledger_id: i64,
    usage: Option<&(String, Usage)>,
    state: &str,
) -> Result<(), sqlx::Error> {
    let (model, u) = match usage {
        Some((m, u)) => (Some(m.as_str()), u.clone()),
        None => (None, Usage::default()),
    };
    sqlx::query(
        "update usage_events set model = coalesce($2, model), input_tokens = $3, output_tokens = $4, \
           cache_read_tokens = $5, cache_write_tokens = $6, cost_usd = $7, \
           meta = jsonb_build_object('state', $8::text) \
         where id = $1",
    )
    .bind(ledger_id)
    .bind(model)
    .bind(u.input_tokens as i64)
    .bind(u.output_tokens as i64)
    .bind(u.cache_read_input_tokens as i64)
    .bind(u.cache_creation_input_tokens as i64)
    .bind(model.map(|m| prepare_cost(m, &u)).unwrap_or(0.0))
    .bind(state)
    .execute(db)
    .await?;
    Ok(())
}

/// Dollars for one call at list prices per million tokens (input, output, cache read, cache write). The shared
/// ledger's price table replaces this at merge.
pub fn prepare_cost(model: &str, u: &Usage) -> f64 {
    let (i, o, r, w) = if model.starts_with("claude-sonnet-5-5") {
        (2.0, 10.0, 0.10, 2.5)
    } else if model.starts_with("claude-haiku-5-5") {
        (0.10, 0.50, 0.01, 0.125)
    } else {
        (4.0, 20.0, 0.20, 5.0)
    };
    (u.input_tokens as f64 * i
        + u.output_tokens as f64 * o
        + u.cache_read_input_tokens as f64 * r
        + u.cache_creation_input_tokens as f64 * w)
        / 1_000_000.0
}

/// The setup from a request body; a message the setup page can show when it does not fit the rules.
pub fn parse_setup(body: &[u8]) -> AppResult<MeetingSetup> {
    let setup: MeetingSetup = serde_json::from_slice(body)
        .map_err(|e| AppError::BadRequest(format!("This meeting setup is not valid: {e}")))?;
    validate_setup(&setup).map_err(AppError::BadRequest)?;
    Ok(setup)
}

/// The starting meeting state of a stored plan, for a new meeting session (404 when the plan is not this
/// identity's).
pub async fn load_meeting(
    db: &PgPool,
    plan_id: Uuid,
    identity_id: Uuid,
) -> AppResult<MeetingState> {
    let (setup, plan): (Value, Value) =
        sqlx::query_as("select setup, plan from meeting_plans where id = $1 and identity_id = $2")
            .bind(plan_id)
            .bind(identity_id)
            .fetch_optional(db)
            .await?
            .ok_or(AppError::NotFound)?;
    MeetingState::from_json(&setup, &plan).map_err(AppError::Internal)
}
