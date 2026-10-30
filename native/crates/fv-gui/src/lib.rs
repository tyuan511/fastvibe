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

/// What `key` resolves to in `locale`, or `None` when the table holds nothing for it.
///
/// rust-i18n bakes the table in at compile time and answers a miss with the key itself, so a
/// row that reads `settings.some_key` on screen is a *missing* entry rather than English copy.
/// An entire file disappears that way when its `_version: 2` header is absent: the loader then
/// reads it as a locale named after the file, and every key in it becomes unreachable.
/// `tests/i18n_keys.rs` walks the source and asks this for each key it finds.
pub fn translation(locale: &str, key: &str) -> Option<String> {
    _rust_i18n_try_translate(locale, key).map(|text| text.into_owned())
}

pub mod assets;
pub mod backend;
pub mod computer_host;
pub mod context_stats;
mod conversation_resources;
pub mod dock;
pub mod file_icons;
pub mod fixture;
mod history_cache;
pub mod markdown;
pub mod notify;
pub mod pane_layout;
pub mod presentation;
pub mod sidebar_state;
pub mod skill_draft;
pub mod terminal_state;
mod terminal_transcript;
pub mod theme;
pub mod ui;
pub mod vibrancy;
pub mod view_model;
pub mod web_content;
pub mod webview;
#[cfg(target_os = "macos")]
mod webview_shortcuts;
#[cfg(target_os = "macos")]
mod webview_container;
#[cfg(target_os = "macos")]
mod webview_downloads;
pub mod workspace;
