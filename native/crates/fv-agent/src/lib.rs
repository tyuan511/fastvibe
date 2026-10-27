//! The agent loop: sample the model, run the tools it asks for, repeat until it answers.
//!
//! Modelled on codex's `run_turn` / `try_run_sampling_request`, with the provider behind the
//! [`Model`] trait (so the loop is tested against scripted models) and the outside world
//! behind [`Tool`]. The loop knows nothing about threads, clients or storage: it appends to a
//! history it is handed and reports what happens on an event channel.

pub mod budget;
mod compact;
mod compact_input;
mod event;
mod history;
mod model;
mod permissions;
mod prompt;
mod steer;
mod tool;
mod turn;

pub mod testing;

pub use budget::ContextBudget;
pub use compact::{
    CompactError, DEFAULT_CONTEXT_WINDOW, SUMMARIZATION_PROMPT, compact, context_used,
    context_window, effective_context_window, needs_compaction,
};
pub use event::{AgentEvent, BlockKind};
pub use history::normalize;
pub use model::{Model, ModelError, ModelEvent, ModelRequest};
pub use permissions::{
    ApprovalKind, ApprovalPolicy, ApprovalRequest, Approver, Decision, Permissions, Policy,
    SandboxMode,
};
pub use prompt::base_instructions;
pub use steer::Steers;
pub use tool::{
    LoadedTools, NestedTools, Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec, UserInput,
};
pub use turn::{
    AgentContext, CompactionPolicy, MemorySource, NEW_CONTEXT_WINDOW_TOOL, TurnOutcome, run_turn,
};
