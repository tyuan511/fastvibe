//! The wire protocol between `fastvibe-server` and its clients (desktop, phone, CLI).
//!
//! JSON-RPC shaped, without the `"jsonrpc":"2.0"` member (the same as codex's app server):
//! requests carry an `id`, notifications do not, responses and errors echo the `id`.
//!
//! Methods are declared once, in [`methods`]; a macro derives the request/notification enums,
//! the method-name table and a typed [`Rpc`] marker per call from that single list, so adding a
//! method is one line and the server's `match` over [`ClientRequest`] stops compiling until it
//! handles it. The JSON Schema in `native/schema/` is generated from these types.

pub mod catalog;
pub mod jsonrpc;
pub mod methods;
pub mod models;
pub mod provider_test;
pub mod shortcuts;
pub mod types;
pub mod usage;

pub use jsonrpc::{ErrorObject, Message, RequestId};
pub use methods::{ClientNotification, ClientRequest, ServerNotification, ServerRequest};

/// Bumped on a breaking change to the wire format; exchanged in `initialize`.
pub const PROTOCOL_VERSION: u32 = 1;

/// One client → server call: its wire name and the types on either side.
pub trait Rpc {
    const METHOD: &'static str;
    type Params: serde::Serialize + serde::de::DeserializeOwned;
    type Response: serde::Serialize + serde::de::DeserializeOwned;
}

#[cfg(test)]
mod tests;
