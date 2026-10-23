//! Themes (皮肤) for the native client, ported from `src/renderer/src/lib/themes.ts`.
//!
//! A theme is a compact [`Seed`]; [`Tokens::solid`] derives the full token set from it
//! (`buildTokens`) and [`Tokens::glass`] the translucent form used over the macOS blur
//! (`glassTokens`). Nothing here depends on GPUI, so the derivation is unit-tested against
//! a snapshot exported from the TypeScript original (`native/scripts/export-themes.mjs`).
//!
//! Views never name a colour: they read a [`Token`] from the active [`Tokens`].

pub mod color;
mod tokens;

use std::collections::BTreeMap;
use std::sync::OnceLock;

pub use color::Color;
pub use tokens::{Token, Tokens};

use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeKind {
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Syntax {
    pub keyword: Color,
    pub string: Color,
    pub comment: Color,
    pub number: Color,
}

/// The raw palette a theme is built from.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    pub label: String,
    pub source: String,
    pub kind: ThemeKind,
    pub bg: Color,
    pub fg: Color,
    pub surface: Color,
    pub border: Color,
    pub muted: Color,
    pub muted_fg: Color,
    pub accent: Color,
    pub accent_fg: Color,
    pub destructive: Color,
    pub warning: Color,
    pub success: Color,
    pub sidebar: Option<Color>,
    pub sidebar_muted: Option<Color>,
    pub code_bg: Option<Color>,
    pub syntax: Syntax,
    pub charts: Option<[Color; 5]>,
}

#[derive(Deserialize)]
struct Catalog {
    light: Vec<String>,
    dark: Vec<String>,
    order: Vec<String>,
    seeds: BTreeMap<String, Seed>,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../data/themes.json"))
            .expect("data/themes.json is generated and valid")
    })
}

pub const DEFAULT_LIGHT_THEME: &str = "github-light";
pub const DEFAULT_DARK_THEME: &str = "github-dark";

/// Default 界面字号 in px: the root font size every rem-based size scales from.
pub const DEFAULT_UI_FONT_SIZE: f32 = 16.0;
pub const UI_FONT_SIZE_MIN: f32 = 12.0;
pub const UI_FONT_SIZE_MAX: f32 = 20.0;

pub fn clamp_ui_font_size(size: f32) -> f32 {
    size.round().clamp(UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX)
}

/// Every theme id, in the order the TypeScript catalogue declares them.
pub fn all_ids() -> impl Iterator<Item = &'static str> {
    catalog().order.iter().map(String::as_str)
}

/// Picker order for one kind: most-installed first.
pub fn ids_for(kind: ThemeKind) -> &'static [String] {
    match kind {
        ThemeKind::Light => &catalog().light,
        ThemeKind::Dark => &catalog().dark,
    }
}

pub fn seed(id: &str) -> Option<&'static Seed> {
    catalog().seeds.get(id)
}

#[derive(Clone, Debug)]
pub struct Preferences {
    pub mode: ThemeMode,
    pub light_theme: String,
    pub dark_theme: String,
    /// 玻璃效果; on unless the user turned it off.
    pub glass: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            mode: ThemeMode::System,
            light_theme: DEFAULT_LIGHT_THEME.into(),
            dark_theme: DEFAULT_DARK_THEME.into(),
            glass: true,
        }
    }
}

/// The concrete theme in force: which one, and its tokens.
#[derive(Clone, Debug)]
pub struct ActiveTheme {
    pub id: &'static str,
    pub kind: ThemeKind,
    pub tokens: Tokens,
}

impl Preferences {
    /// Which concrete theme is active. `has_vibrancy` is whether the window has a blur to
    /// show: without one a translucent page would only wash out, so glass stays off.
    pub fn resolve(&self, prefers_dark: bool, has_vibrancy: bool) -> ActiveTheme {
        let kind = match self.mode {
            ThemeMode::Light => ThemeKind::Light,
            ThemeMode::Dark => ThemeKind::Dark,
            ThemeMode::System if prefers_dark => ThemeKind::Dark,
            ThemeMode::System => ThemeKind::Light,
        };
        let (wanted, fallback) = match kind {
            ThemeKind::Dark => (&self.dark_theme, DEFAULT_DARK_THEME),
            ThemeKind::Light => (&self.light_theme, DEFAULT_LIGHT_THEME),
        };
        let (id, seed) = catalog()
            .seeds
            .get_key_value(wanted.as_str())
            .or_else(|| catalog().seeds.get_key_value(fallback))
            .expect("default themes exist");
        let tokens = if self.glass && has_vibrancy {
            Tokens::glass(seed)
        } else {
            Tokens::solid(seed)
        };
        ActiveTheme {
            id: id.as_str(),
            kind: seed.kind,
            tokens,
        }
    }
}

#[cfg(test)]
mod tests;
