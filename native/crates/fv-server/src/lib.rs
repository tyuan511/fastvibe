//! `fastvibe-server`: the engine process. Desktop, phone, SSH and CLI clients all talk to it
//! over the same protocol (`fv-protocol`); nothing here knows which one is on the other end
//! beyond the [`ClientOrigin`] its connection was accepted with.

mod connection;
mod listener;
mod log;
mod mapping;
mod policy;
mod runtime;
mod state;
mod turn;

pub use connection::serve_connection;
pub use listener::{ListenError, UnixServer};
pub use policy::allows;
pub use state::ServerState;

/// What `initialize` reports as the server's version.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
