//! Who is calling. The identity layer (cookie `ir_id`, guests and signed-in users) resolves it and puts an
//! [`Identity`] in the request extensions; handlers take `Extension<Identity>`. This file holds only the type,
//! with the same shape, until that layer is merged in.

use uuid::Uuid;

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
