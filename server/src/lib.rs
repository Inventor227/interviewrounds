//! Interview Rounds server: API, Fish custom LLM endpoint, websocket and the static web app.

pub mod app;
pub mod config;
pub mod db;
pub mod error;

pub use app::{AppState, router};
pub use config::Config;
