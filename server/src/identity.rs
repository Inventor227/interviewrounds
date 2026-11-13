//! Who is calling: a device guest (cookie `ir_id`) or the signed-in user that guest was claimed into.
//! The cookie holds 128 random bits; only its sha-256 is stored.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::app::AppState;
use crate::error::AppError;

pub const COOKIE: &str = "ir_id";
const COOKIE_MAX_AGE_S: u64 = 365 * 24 * 3600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityKind {
    Guest,
    User,
}

impl IdentityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IdentityKind::Guest => "guest",
            IdentityKind::User => "user",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Identity {
    pub id: Uuid,
    pub kind: IdentityKind,
    pub name: Option<String>,
    pub email: Option<String>,
    pub onboarding_done: bool,
}

/// The identity, plus the `Set-Cookie` value when a new guest was made for this request.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub identity: Identity,
    pub set_cookie: Option<HeaderValue>,
}

/// `n` random bytes as lowercase hex.
pub fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("the OS random source is available");
    hex::encode(buf)
}

pub fn sha256(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}

/// The `ir_id` value from the request cookies, if it is well formed (32 hex characters).
pub fn cookie_value(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE)
        .map(|(_, value)| value.trim().to_string())
        .filter(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn set_cookie_header(value: &str) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE}={value}; Path=/; Max-Age={COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax"
    ))
    .expect("cookie value is hex")
}

type Row = (
    Uuid,
    String,
    Option<String>,
    Option<String>,
    bool,
    Option<Uuid>,
);

async fn by_id(db: &PgPool, id: Uuid) -> Result<Option<Row>, sqlx::Error> {
    sqlx::query_as(
        "select id, kind, name, email, onboarding_done, claimed_into from identities where id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

fn identity(row: Row) -> Identity {
    Identity {
        id: row.0,
        kind: if row.1 == "user" {
            IdentityKind::User
        } else {
            IdentityKind::Guest
        },
        name: row.2,
        email: row.3,
        onboarding_done: row.4,
    }
}

/// Finds the caller's identity from the `ir_id` cookie, following a claim into a signed-in user. Without a
/// known cookie a new guest is created with a fresh random cookie (never one the client chose).
pub async fn resolve(headers: &HeaderMap, db: &PgPool) -> Result<Resolved, sqlx::Error> {
    if let Some(value) = cookie_value(headers) {
        let found: Option<Row> = sqlx::query_as(
            "select id, kind, name, email, onboarding_done, claimed_into from identities where cookie_hash = $1",
        )
        .bind(sha256(&value))
        .fetch_optional(db)
        .await?;
        if let Some(mut row) = found {
            // A guest claimed on sign-in resolves to the user (one hop; claims are never chained).
            if let Some(owner) = row.5
                && let Some(user) = by_id(db, owner).await?
            {
                row = user;
            }
            sqlx::query(
                "update identities set last_seen_at = now() \
                 where id = $1 and last_seen_at < now() - interval '1 hour'",
            )
            .bind(row.0)
            .execute(db)
            .await?;
            return Ok(Resolved {
                identity: identity(row),
                set_cookie: None,
            });
        }
    }
    let value = random_hex(16);
    let id: Uuid = sqlx::query_scalar(
        "insert into identities (kind, cookie_hash) values ('guest', $1) returning id",
    )
    .bind(sha256(&value))
    .fetch_one(db)
    .await?;
    Ok(Resolved {
        identity: Identity {
            id,
            kind: IdentityKind::Guest,
            name: None,
            email: None,
            onboarding_done: false,
        },
        set_cookie: Some(set_cookie_header(&value)),
    })
}

/// Middleware for routes that need an identity: puts `Identity` in the request extensions and sets the cookie
/// on the response when a guest was just created.
pub async fn require(State(app): State<AppState>, mut req: Request, next: Next) -> Response {
    let resolved = match resolve(req.headers(), &app.db).await {
        Ok(r) => r,
        Err(err) => return AppError::from(err).into_response(),
    };
    req.extensions_mut().insert(resolved.identity);
    let mut res = next.run(req).await;
    if let Some(cookie) = resolved.set_cookie {
        res.headers_mut().append(header::SET_COOKIE, cookie);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_a_well_formed_cookie() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("a=b; ir_id=0123456789abcdef0123456789ABCDEF; c=d"),
        );
        assert_eq!(
            cookie_value(&h).as_deref(),
            Some("0123456789abcdef0123456789ABCDEF")
        );
        h.insert(header::COOKIE, HeaderValue::from_static("ir_id=short"));
        assert_eq!(cookie_value(&h), None);
        assert_eq!(cookie_value(&HeaderMap::new()), None);
    }

    #[test]
    fn random_values_are_hex_and_differ() {
        let a = random_hex(16);
        assert_eq!(a.len(), 32);
        assert_ne!(a, random_hex(16));
        let cookie = set_cookie_header(&a);
        let s = cookie.to_str().unwrap();
        for part in [
            "HttpOnly",
            "Secure",
            "SameSite=Lax",
            "Max-Age=31536000",
            "Path=/",
        ] {
            assert!(s.contains(part), "{s}");
        }
    }
}
