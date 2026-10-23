use crate::{Color, Seed, ThemeKind};

macro_rules! tokens {
    ($($variant:ident => $css:literal,)*) => {
        /// One named colour. The CSS name is the Electron app's custom property, minus `--`.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Token { $($variant,)* }

        impl Token {
            pub const ALL: &'static [Token] = &[$(Token::$variant,)*];

            pub fn css_name(self) -> &'static str {
                match self { $(Token::$variant => $css,)* }
            }

            pub fn from_css_name(name: &str) -> Option<Token> {
                match name { $($css => Some(Token::$variant),)* _ => None }
            }
        }
    };
}

tokens! {
    Background => "background",
    Foreground => "foreground",
    Card => "card",
    CardForeground => "card-foreground",
    Popover => "popover",
    PopoverForeground => "popover-foreground",
    Primary => "primary",
    PrimaryForeground => "primary-foreground",
    Secondary => "secondary",
    SecondaryForeground => "secondary-foreground",
    Muted => "muted",
    MutedForeground => "muted-foreground",
    Accent => "accent",
    AccentForeground => "accent-foreground",
    Destructive => "destructive",
    DestructiveForeground => "destructive-foreground",
    Border => "border",
    Input => "input",
    Ring => "ring",
    Warning => "warning",
    Success => "success",
    Info => "info",
    Sidebar => "sidebar",
    SidebarForeground => "sidebar-foreground",
    SidebarBorder => "sidebar-border",
    SidebarPrimary => "sidebar-primary",
    SidebarPrimaryForeground => "sidebar-primary-foreground",
    SidebarAccent => "sidebar-accent",
    SidebarAccentForeground => "sidebar-accent-foreground",
    SidebarRing => "sidebar-ring",
    Chart1 => "chart-1",
    Chart2 => "chart-2",
    Chart3 => "chart-3",
    Chart4 => "chart-4",
    Chart5 => "chart-5",
    CodeBg => "code-bg",
    CodeInlineBg => "code-inline-bg",
    CodeKeyword => "code-keyword",
    CodeString => "code-string",
    CodeComment => "code-comment",
    CodeNumber => "code-number",
    // Written only while 玻璃效果 is on.
    GlassPane => "glass-pane",
    GlassOverlay => "glass-overlay",
    GlassRimStrong => "glass-rim-strong",
    GlassRimWeak => "glass-rim-weak",
    GlassSheen => "glass-sheen",
    GlassEdge => "glass-edge",
    GlassShade => "glass-shade",
}

/// A full token set. Glass-only tokens are absent from a solid set.
#[derive(Clone, Debug)]
pub struct Tokens {
    values: Vec<Option<Color>>,
}

impl Tokens {
    fn empty() -> Self {
        Self {
            values: vec![None; Token::ALL.len()],
        }
    }

    fn set(&mut self, token: Token, color: Color) {
        self.values[token as usize] = Some(color);
    }

    pub fn get(&self, token: Token) -> Option<Color> {
        self.values[token as usize]
    }

    /// For tokens every theme has; a missing one means a glass-only token was asked of a solid set.
    pub fn color(&self, token: Token) -> Color {
        self.get(token)
            .unwrap_or_else(|| panic!("token {} is not set (glass-only?)", token.css_name()))
    }

    /// `buildTokens`.
    pub fn solid(seed: &Seed) -> Self {
        use Token::*;
        let sidebar = seed.sidebar.unwrap_or(seed.surface);
        let sidebar_muted = seed.sidebar_muted.unwrap_or(seed.muted);
        let code_bg = seed.code_bg.unwrap_or(seed.muted);
        let charts = seed.charts.unwrap_or([
            seed.accent,
            seed.syntax.keyword,
            seed.syntax.string,
            seed.syntax.number,
            seed.muted_fg,
        ]);
        let mut t = Self::empty();
        for (token, color) in [
            (Background, seed.bg),
            (Foreground, seed.fg),
            (Card, seed.surface),
            (CardForeground, seed.fg),
            (Popover, seed.surface),
            (PopoverForeground, seed.fg),
            (Primary, seed.accent),
            (PrimaryForeground, seed.accent_fg),
            (Secondary, seed.muted),
            (SecondaryForeground, seed.fg),
            (Muted, seed.muted),
            (MutedForeground, seed.muted_fg),
            (Accent, seed.muted),
            (AccentForeground, seed.fg),
            (Destructive, seed.destructive),
            // oklch(0.985 0 0)
            (
                DestructiveForeground,
                crate::color::parse("oklch(0.985 0 0)").expect("literal"),
            ),
            (Border, seed.border),
            (Input, seed.border),
            (Ring, seed.accent),
            (Warning, seed.warning),
            (Success, seed.success),
            (Info, seed.accent),
            (Sidebar, sidebar),
            (SidebarForeground, seed.fg),
            (SidebarBorder, seed.border),
            (SidebarPrimary, seed.accent),
            (SidebarPrimaryForeground, seed.accent_fg),
            (SidebarAccent, sidebar_muted),
            (SidebarAccentForeground, seed.fg),
            (SidebarRing, seed.accent),
            (Chart1, charts[0]),
            (Chart2, charts[1]),
            (Chart3, charts[2]),
            (Chart4, charts[3]),
            (Chart5, charts[4]),
            (CodeBg, code_bg),
            (CodeInlineBg, seed.fg.mix_with_transparent(8.0)),
            (CodeKeyword, seed.syntax.keyword),
            (CodeString, seed.syntax.string),
            (CodeComment, seed.syntax.comment),
            (CodeNumber, seed.syntax.number),
        ] {
            t.set(token, color);
        }
        t
    }

    /// `buildTokens` with `glassTokens` laid over it: the fills that cover the window go
    /// translucent, anything floating over text stays solid.
    pub fn glass(seed: &Seed) -> Self {
        use Token::*;
        let dark = seed.kind == ThemeKind::Dark;
        let pick = |dark_v: f32, light_v: f32| if dark { dark_v } else { light_v };
        let tint = |p: f32| seed.fg.mix_with_transparent(p);
        let fill = |c: Color, p: f32| c.mix_with_transparent(p);
        let white = |a: f32| Color {
            r: 255,
            g: 255,
            b: 255,
            a,
        };
        let black = |a: f32| Color {
            r: 0,
            g: 0,
            b: 0,
            a,
        };
        let hover = tint(pick(9.0, 7.0));
        let hairline = tint(pick(11.0, 10.0));
        let sidebar = seed.sidebar.unwrap_or(seed.surface);

        let mut t = Self::solid(seed);
        for (token, color) in [
            (Background, fill(seed.bg, pick(42.0, 46.0))),
            (Card, fill(seed.surface, pick(52.0, 56.0))),
            (Secondary, hover),
            (Muted, hover),
            (Accent, hover),
            (Border, hairline),
            (Input, hairline),
            (Sidebar, fill(sidebar, 14.0)),
            (SidebarBorder, hairline),
            (SidebarAccent, tint(pick(12.0, 9.0))),
            (GlassPane, white(pick(0.055, 0.42))),
            (GlassOverlay, fill(seed.surface, pick(84.0, 90.0))),
            (GlassRimStrong, white(pick(0.5, 0.95))),
            (GlassRimWeak, white(pick(0.1, 0.45))),
            (GlassSheen, white(pick(0.10, 0.55))),
            (GlassEdge, black(pick(0.45, 0.10))),
            (GlassShade, black(pick(0.45, 0.16))),
        ] {
            t.set(token, color);
        }
        t
    }
}
