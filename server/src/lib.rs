//! Interview Rounds server: API, Fish custom LLM endpoint, websocket and the static web app.

pub mod app;
pub mod claude;
pub mod config;
pub mod db;
pub mod error;
pub mod fish;

pub use app::{AppState, router};
pub use config::Config;
