//! Interview Rounds server: API, Fish custom LLM endpoint, websocket and the static web app.

pub mod api;
pub mod app;
pub mod claude;
pub mod config;
pub mod content;
pub mod db;
pub mod error;
pub mod fish;
pub mod identity;
pub mod orchestrator;
pub mod persist;
pub mod usage;
pub mod ws;

pub use app::{AppState, router};
pub use config::Config;
