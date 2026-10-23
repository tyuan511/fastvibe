//! Talking to models: FastVibe's own request/stream types on one side, `genai`'s four wire
//! protocols (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Google Gemini)
//! on the other.
//!
//! Nothing outside this crate names a genai type. What FastVibe decides for itself lives
//! here: which protocol a model speaks, how a stored base URL becomes the one genai wants,
//! how thinking effort is spelled, and when a failed request is worth repeating.

mod config;
mod convert;
mod error;
mod model;
mod models_list;
mod url;

pub use config::{ModelConfig, Protocol, ThinkingLevel};
pub use error::classify;
pub use model::GenaiModel;
pub use models_list::{FetchedModel, fetch_models};
pub use url::{engine_base_url, infer_protocol};
