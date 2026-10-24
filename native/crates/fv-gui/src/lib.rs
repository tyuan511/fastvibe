//! The desktop app. It talks to `fastvibe-server` and nothing else: no engine, no storage.
//! What a client needs to know about a conversation is in [`view_model`], free of any
//! window code so that it can be tested without one.

pub mod backend;
pub mod theme;
pub mod view_model;
pub mod workspace;
