//! `fastvibe-server`: the engine process. Desktop, phone, SSH and CLI clients all talk to it
//! over the same protocol (`fv-protocol`); nothing here knows which one is on the other end
//! beyond the [`ClientOrigin`] its connection was accepted with.

mod async_ask;
pub mod auth;
mod board;
mod browser;
mod catalog;
mod cc_switch;
mod commit_message;
mod computer;
mod connection;
pub mod context;
mod file_chunk;
mod git;
mod goal;
mod guardian;
mod hooks;
mod import;
mod keep_awake;
mod listener;
mod log;
mod mapping;
pub mod memory;
mod mode;
mod model_detail;
pub mod office;
pub mod official;
mod outbound;
mod policy;
mod project_files;
mod projects;
mod prompt;
mod provider_test;
mod providers;
mod queue;
pub mod remote;
mod remote_discovery;
mod runtime;
mod schedules;
mod search;
mod session_title;
mod settings;
mod state;
mod subagents;
mod suggestion;
mod terminal;
mod turn;
mod update;
mod usage;
mod workspace;
mod workspace_entries;
mod worktree;

pub use connection::serve_connection;
pub use listener::{ListenError, UnixServer};
pub use policy::allows;
pub use state::ServerState;

/// What `initialize` reports as the server's version.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The agent every server runs: the given model, and all of the built-in tools. `main` and the
/// tests both build it here, so what the tests exercise is what ships.
pub fn agent_with_builtin_tools(
    model: std::sync::Arc<dyn fv_agent::Model>,
) -> fv_agent::AgentContext {
    let mut tools = fv_agent::ToolRegistry::new();
    fv_tools::register_builtin(&mut tools);
    fv_agent::AgentContext {
        context: Default::default(),
        hooks: None,
        model,
        tools: std::sync::Arc::new(tools),
        system: String::new(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
        permissions: None,
        steer: None,
        memory: None,
        budget: Default::default(),
        compaction: None,
    }
}
