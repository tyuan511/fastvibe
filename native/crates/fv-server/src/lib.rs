//! `fastvibe-server`: the engine process. Desktop, phone, SSH and CLI clients all talk to it
//! over the same protocol (`fv-protocol`); nothing here knows which one is on the other end
//! beyond the [`ClientOrigin`] its connection was accepted with.

mod catalog;
mod connection;
pub mod context;
mod git;
mod keep_awake;
mod listener;
mod log;
mod mapping;
pub mod memory;
mod model_detail;
pub mod office;
mod policy;
mod project_files;
mod projects;
mod prompt;
mod provider_test;
mod providers;
mod queue;
mod runtime;
mod schedules;
mod search;
mod settings;
mod state;
mod subagents;
mod suggestion;
mod terminal;
mod turn;
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

/// Captured once at process startup, never from a replacement executable on disk.
pub fn build_fingerprint() -> Option<String> {
    use sha2::{Digest, Sha256};
    static STARTED_WITH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    STARTED_WITH
        .get_or_init(|| {
            let bytes = std::fs::read(std::env::current_exe().ok()?).ok()?;
            Some(format!("{:x}", Sha256::digest(bytes)))
        })
        .clone()
}

/// The agent every server runs: the given model, and all of the built-in tools. `main` and the
/// tests both build it here, so what the tests exercise is what ships.
pub fn agent_with_builtin_tools(
    model: std::sync::Arc<dyn fv_agent::Model>,
) -> fv_agent::AgentContext {
    let mut tools = fv_agent::ToolRegistry::new();
    fv_tools::register_builtin(&mut tools);
    fv_agent::AgentContext {
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
