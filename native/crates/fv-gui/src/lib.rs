//! The desktop app. It talks to `fastvibe-server` for application data. Only client pane recovery is stored locally.
//! What a client needs to know about a conversation is in [`view_model`], and how a turn is
//! laid out in [`presentation`], both free of window code so that they can be tested without
//! one.

pub mod assets;
pub mod backend;
pub mod context_stats;
pub mod file_icons;
pub mod fixture;
pub mod markdown;
pub mod pane_layout;
pub mod presentation;
pub mod sidebar_state;
pub mod skill_draft;
pub mod terminal_state;
pub mod theme;
pub mod ui;
pub mod vibrancy;
pub mod view_model;
pub mod web_content;
pub mod webview;
pub mod workspace;
