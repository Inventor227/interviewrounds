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
use crate::error::{AppError, AppResult};
use crate::meeting::prepare::PrepareError;
use crate::meeting::{MeetingSetup, MeetingState, prepare, validate_setup};

/// Plans one identity may prepare per 24 hours (each is a model call).
pub const DAILY_PREPARE_LIMIT: i64 = 30;

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

/// Parses and checks the setup, prepares the plan, stores it and returns the public response.
pub async fn prepare_for(app: &AppState, identity_id: Uuid, body: &[u8]) -> AppResult<Value> {
    let setup = parse_setup(body)?;
    let recent: i64 = sqlx::query_scalar(
        "select count(*) from meeting_plans where identity_id = $1 and created_at > now() - interval '1 day'",
    )
    .bind(identity_id)
    .fetch_one(&app.db)
    .await?;
    if recent >= DAILY_PREPARE_LIMIT {
        return Err(AppError::Limited {
            code: "prepare_limit",
            message: "You have prepared a lot of meetings today. Try again tomorrow.".into(),
        });
    }
    let plan = prepare(app.llm.as_ref(), &app.catalog, &setup)
        .await
        .map_err(|e| match e {
            PrepareError::Invalid(msg) => AppError::BadRequest(msg),
            PrepareError::Content(msg) => AppError::Internal(anyhow::anyhow!(msg)),
        })?;
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
