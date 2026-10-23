//! The agent loop: sample the model, run the tools it asks for, repeat until it answers.
//!
//! Modelled on codex's `run_turn` / `try_run_sampling_request`, with the provider behind the
//! [`Model`] trait (so the loop is tested against scripted models) and the outside world
//! behind [`Tool`]. The loop knows nothing about threads, clients or storage: it appends to a
//! history it is handed and reports what happens on an event channel.

mod event;
mod history;
mod model;
mod tool;
mod turn;

pub mod testing;

pub use event::{AgentEvent, BlockKind};
pub use history::normalize;
pub use model::{Model, ModelError, ModelEvent, ModelRequest};
pub use tool::{Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
pub use turn::{AgentContext, TurnOutcome, run_turn};
