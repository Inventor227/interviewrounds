//! Guard in front of `POST /v1/chat/completions` (the custom LLM endpoint Fish calls, and the browser on the
//! fake voice path):
//! - turns are served only while the round is `live` (or ending, for the closing line);
//! - on the client-token (fake voice) path a turn is at most 2,000 characters and a session at most 150 turns;
//! - a session dropped from memory by a restart is reloaded;
//! - the model calls of the turn are charged to its session in the ledger.

use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use futures::Stream;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::AppState;
use crate::error::AppError;
use crate::orchestrator::{SessionStatus, constant_time_eq};
use crate::persist;
use crate::usage::LLM_SESSION;

/// Largest request body (Fish sends the whole transcript).
const MAX_BODY: usize = 1024 * 1024;
/// Client-token path limits.
pub const MAX_TURN_CHARS: usize = 2000;
pub const MAX_TURNS: usize = 150;

fn refuse(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({"status": status.as_u16(), "code": code, "message": message})),
    )
        .into_response()
}

fn newest_user_text(v: &Value) -> String {
    let Some(m) = v["messages"]
        .as_array()
        .and_then(|ms| ms.iter().rev().find(|m| m["role"] == "user"))
    else {
        return String::new();
    };
    match &m["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

pub async fn gate(State(app): State<AppState>, req: Request, next: Next) -> Response {
    let (parts, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY).await else {
        return refuse(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "The request is too large.",
        );
    };
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let bearer = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, t)| t.trim().to_string());
    let session = v
        .pointer("/fishaudio_extra_body/session_id")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok());
    let req = Request::from_parts(parts, Body::from(bytes));
    // Without a token or a session the endpoint answers itself (401 / 404).
    let (Some(token), Some(id)) = (bearer, session) else {
        return next.run(req).await;
    };
    let via_secret = constant_time_eq(token.as_bytes(), app.config.fish_llm_secret.as_bytes());
    if !via_secret
        && !app
            .session_auth
            .client_token_ok(&id.to_string(), &token)
            .await
    {
        return AppError::Unauthorized.into_response();
    }
    let handle = match persist::load_live(&app, id).await {
        Ok(Some(h)) => h,
        // Unknown or ended: not in memory, so the endpoint answers 404.
        Ok(None) => return next.run(req).await,
        Err(err) => {
            tracing::warn!(session_id = %id, error = %format!("{err:#}"), "could not load the session for a turn");
            return next.run(req).await;
        }
    };
    let ending = match app.hubs.get(&id.to_string()) {
        Some(hub) => hub.is_ending().await,
        None => false,
    };
    let (status, turns) = {
        let st = handle.lock().await;
        let turns = st
            .turns
            .iter()
            .filter(|t| t.speaker == "candidate" || t.speaker == "app")
            .count();
        (st.status, turns)
    };
    if status != SessionStatus::Live && !ending {
        return refuse(
            StatusCode::CONFLICT,
            "session_not_live",
            "The round is not live right now.",
        );
    }
    if !via_secret {
        if newest_user_text(&v).chars().count() > MAX_TURN_CHARS {
            return refuse(
                StatusCode::PAYLOAD_TOO_LARGE,
                "turn_too_long",
                "That answer is too long to send in one go.",
            );
        }
        if turns >= MAX_TURNS {
            return refuse(
                StatusCode::TOO_MANY_REQUESTS,
                "turn_limit",
                "This round has reached its turn limit.",
            );
        }
    }
    // The handler runs and its streamed body is polled inside the session scope, so every model call of the
    // turn is charged to this session.
    let res = LLM_SESSION.scope(id, next.run(req)).await;
    let (parts, body) = res.into_parts();
    let stream = Scoped {
        inner: Box::pin(body.into_data_stream()),
        id,
    };
    Response::from_parts(parts, Body::from_stream(stream))
}

struct Scoped {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, axum::Error>> + Send>>,
    id: Uuid,
}

impl Stream for Scoped {
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let id = self.id;
        LLM_SESSION.sync_scope(id, || self.inner.as_mut().poll_next(cx))
    }
}
