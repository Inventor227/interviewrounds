//! Interview Rounds server: API, Fish custom LLM endpoint, websocket and the static web app.

pub mod app;
pub mod claude;
pub mod config;
pub mod content;
pub mod db;
pub mod error;
pub mod fish;
pub mod orchestrator;
pub mod scoring;

pub use app::{AppState, router};
pub use config::Config;
