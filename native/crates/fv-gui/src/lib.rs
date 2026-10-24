//! The desktop app. It talks to `fastvibe-server` and nothing else: no engine, no storage.
//! What a client needs to know about a conversation is in [`view_model`], and how a turn is
//! laid out in [`presentation`], both free of window code so that they can be tested without
//! one.

pub mod assets;
pub mod backend;
pub mod file_icons;
pub mod fixture;
pub mod presentation;
pub mod theme;
pub mod ui;
pub mod view_model;
pub mod workspace;
