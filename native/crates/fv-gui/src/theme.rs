//! `fv-theme` tokens onto the component library's theme, so every control it draws (input,
//! popover, scrollbar, markdown) takes the same colours as the app's own chrome.

use fv_theme::{ActiveTheme, Color, ThemeKind, Token};
use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, Hsla, Rgba};

pub fn rgba(c: Color) -> Rgba {
    Rgba {
        r: f32::from(c.r) / 255.0,
        g: f32::from(c.g) / 255.0,
        b: f32::from(c.b) / 255.0,
        a: c.a,
    }
}

pub fn hsla(c: Color) -> Hsla {
    rgba(c).into()
}

/// The colours the app paints with, resolved once per theme change.
#[derive(Clone)]
pub struct Palette {
    pub active: ActiveTheme,
}

impl Palette {
    pub fn new(active: ActiveTheme) -> Self {
        Self { active }
    }

    pub fn is_dark(&self) -> bool {
        self.active.kind == ThemeKind::Dark
    }

    pub fn glass(&self) -> bool {
        self.active.tokens.get(Token::GlassPane).is_some()
    }

    pub fn c(&self, t: Token) -> Hsla {
        hsla(self.active.tokens.color(t))
    }

    pub fn get(&self, t: Token) -> Option<Hsla> {
        self.active.tokens.get(t).map(hsla)
    }

    /// The fill of a floating pane: glass over the blur, else the theme's sidebar colour.
    pub fn pane(&self) -> Hsla {
        self.get(Token::GlassPane).unwrap_or(self.c(Token::Sidebar))
    }

    /// The fill of the conversation column.
    pub fn main_pane(&self) -> Hsla {
        self.get(Token::GlassPane)
            .unwrap_or(self.c(Token::Background))
    }

    /// The fill of a floating glass surface: Electron's `--glass-overlay`, 84% dark / 90% light.
    /// A surface that paints it must also blur the page behind itself (`ui::overlay_surface`):
    /// without the blur, the unblurred page shows through at 16/10%.
    /// Solid themes are Electron's `bg-popover/95`.
    pub fn overlay(&self) -> Hsla {
        match self.get(Token::GlassOverlay) {
            Some(fill) => fill,
            None => self.c(Token::Popover).opacity(0.95),
        }
    }

    /// The popover fill for the component library, whose surfaces cannot paint the
    /// backdrop blur (its own div, not ours): denser than `overlay()` so the transcript
    /// under a tooltip or notification stays hidden.
    pub fn overlay_kit(&self) -> Hsla {
        match self.get(Token::GlassOverlay) {
            Some(fill) => Hsla {
                a: if self.is_dark() { 0.96 } else { 0.98 },
                ..fill
            },
            None => self.c(Token::Popover),
        }
    }
}

/// Install `palette` as the component library's theme.
pub fn apply(palette: &Palette, cx: &mut App) {
    let mode = if palette.is_dark() {
        ThemeMode::Dark
    } else {
        ThemeMode::Light
    };
    let theme = Theme::global_mut(cx);
    theme.mode = mode;
    theme.font_family = crate::assets::UI_FONT.into();
    // The root font size (界面字号): `Root` turns it into the window's rem. `Workspace` replaces
    // it with the user's choice; this is the default until settings arrive.
    theme.font_size = gpui_kit::px(fv_theme::DEFAULT_UI_FONT_SIZE);
    theme.mono_font_family = crate::assets::MONO_FONT.into();
    theme.radius = gpui_kit::px(10.0);
    let c = |t| palette.c(t);
    let k = &mut theme.colors;
    k.background = c(Token::Background);
    k.foreground = c(Token::Foreground);
    k.border = c(Token::Border);
    k.input = c(Token::Input);
    k.ring = c(Token::Ring);
    k.caret = c(Token::Foreground);
    k.primary = c(Token::Primary);
    k.primary_foreground = c(Token::PrimaryForeground);
    k.primary_hover = c(Token::Primary).opacity(0.9);
    k.primary_active = c(Token::Primary).opacity(0.8);
    k.secondary = c(Token::Secondary);
    k.secondary_foreground = c(Token::SecondaryForeground);
    k.secondary_hover = c(Token::Secondary).opacity(0.8);
    k.secondary_active = c(Token::Secondary).opacity(0.7);
    k.muted = c(Token::Muted);
    k.muted_foreground = c(Token::MutedForeground);
    k.accent = c(Token::Accent);
    k.accent_foreground = c(Token::AccentForeground);
    k.popover = palette.overlay_kit();
    k.popover_foreground = c(Token::PopoverForeground);
    k.danger = c(Token::Destructive);
    k.danger_foreground = c(Token::DestructiveForeground);
    k.danger_hover = c(Token::Destructive).opacity(0.9);
    k.danger_active = c(Token::Destructive).opacity(0.8);
    k.warning = c(Token::Warning);
    k.success = c(Token::Success);
    k.info = c(Token::Info);
    k.link = c(Token::Primary);
    k.list = Hsla::transparent_black();
    k.list_even = Hsla::transparent_black();
    k.list_hover = c(Token::Accent);
    k.list_active = c(Token::Accent);
    k.sidebar = c(Token::Sidebar);
    k.sidebar_foreground = c(Token::SidebarForeground);
    k.sidebar_border = c(Token::SidebarBorder);
    k.sidebar_accent = c(Token::SidebarAccent);
    k.sidebar_accent_foreground = c(Token::SidebarAccentForeground);
    k.sidebar_primary = c(Token::SidebarPrimary);
    k.sidebar_primary_foreground = c(Token::SidebarPrimaryForeground);
    k.selection = c(Token::Primary).opacity(0.25);
    k.scrollbar = Hsla::transparent_black();
    k.scrollbar_thumb = c(Token::MutedForeground).opacity(0.35);
    k.scrollbar_thumb_hover = c(Token::MutedForeground).opacity(0.6);
    // Tooltip and newer kit components read the fill token instead of the legacy colour.
    theme.tokens.popover = palette.overlay_kit().into();
    theme.highlight_theme = crate::markdown::highlight_theme(palette);
    Theme::sync_base(cx);
}
