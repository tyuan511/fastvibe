//! The desktop app. It talks to `fastvibe-server` for application data. Only client pane recovery is stored locally.
//! What a client needs to know about a conversation is in [`view_model`], and how a turn is
//! laid out in [`presentation`], both free of window code so that they can be tested without
//! one.

rust_i18n::i18n!("locales", fallback = "zh");

/// `tr!(english, "module.key", name = value)`: copy lives in `locales/<module>.yml`.
/// Declared before the child modules so they can use it.
macro_rules! tr {
    ($english:expr, $key:literal $(, $name:ident = $value:expr)* $(,)?) => {
        rust_i18n::t!($key, locale = if $english { "en" } else { "zh" } $(, $name = $value)*)
            .into_owned()
    };
}

/// Like `tr!` for copy with no placeholders, as a `&'static str`. The set of keys is
/// fixed at compile time, so each (key, language) is leaked once.
macro_rules! trs {
    ($english:expr, $key:expr) => {
        $crate::workspace::static_text($english, $key)
    };
}

pub mod assets;
pub mod backend;
pub mod computer_host;
pub mod context_stats;
pub mod dock;
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
