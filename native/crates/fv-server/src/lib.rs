//! `fastvibe-server`: the engine process. Desktop, phone, SSH and CLI clients all talk to it
//! over the same protocol (`fv-protocol`); nothing here knows which one is on the other end
//! beyond the [`ClientOrigin`] its connection was accepted with.

mod connection;
mod listener;
mod log;
mod mapping;
mod policy;
mod projects;
mod prompt;
mod providers;
mod runtime;
mod settings;
mod state;
mod turn;

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
        model,
        tools: std::sync::Arc::new(tools),
        system: String::new(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
    }
}
