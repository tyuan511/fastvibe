//! Small building blocks shaped after the Electron app's shadcn Nova primitives, so the views
//! read like the components they replicate. Sizes are Tailwind's at the 16px root: `text-sm`
//! is 14/20, `text-xs` 12/16, `size-3.5` 14px, `h-8` 32px, `rounded-md` 8px.

use fv_theme::Token;
use gpui_kit::component::shimmer::ShimmerText;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::assets;
use crate::theme::Palette;

pub const TEXT_SM: f32 = 14.0;
pub const TEXT_XS: f32 = 12.0;

/// A Hugeicons glyph, `size` pixels square, painted in `color`.
pub fn icon(name: &str, size: f32, color: Hsla) -> Svg {
    svg()
        .path(assets::icon(name))
        .size(px(size))
        .flex_none()
        .text_color(color)
}

/// A rotating spinner glyph, `size` pixels square, painted in `color`.
pub fn spinner(id: impl Into<ElementId>, size: f32, color: Hsla) -> impl IntoElement {
    icon("loading03", size, color).with_animation(
        id,
        Animation::new(std::time::Duration::from_millis(1000)).repeat_synced(),
        |svg, delta| svg.with_transformation(Transformation::rotate(percentage(delta))),
    )
}

/// Text with an animated theme-aware shimmer highlight.
pub fn shimmer(id: impl Into<ElementId>, text: impl Into<SharedString>) -> ShimmerText {
    ShimmerText::new(text)
        .id(id)
        .duration(std::time::Duration::from_millis(2500))
        .spread(0.4)
}

/// The chevron that turns to point down when its section is open.
pub fn chevron(open: bool, size: f32, color: Hsla) -> Svg {
    let i = icon("arrow-right01", size, color);
    if open {
        i.with_transformation(Transformation::rotate(percentage(0.25)))
    } else {
        i
    }
}

/// `IconButton size="icon-sm" variant="ghost"`: 28px square, 16px glyph, muted until hovered.
pub fn icon_button(id: impl Into<ElementId>, name: &str, p: &Palette) -> Stateful<Div> {
    ghost_square(id, 28.0, 8.0, p).child(icon(name, 16.0, p.c(Token::MutedForeground)))
}

/// `size="icon-xs"`: 24px square, 14px glyph.
pub fn icon_button_xs(id: impl Into<ElementId>, name: &str, p: &Palette) -> Stateful<Div> {
    icon_button_xs_tinted(id, name, p.c(Token::MutedForeground), p)
}

/// `icon_button_xs` whose glyph carries a state of its own, such as a bookmarked page's star.
pub fn icon_button_xs_tinted(
    id: impl Into<ElementId>,
    name: &str,
    color: Hsla,
    p: &Palette,
) -> Stateful<Div> {
    ghost_square(id, 24.0, 8.0, p).child(icon(name, 14.0, color))
}

fn ghost_square(id: impl Into<ElementId>, size: f32, radius: f32, p: &Palette) -> Stateful<Div> {
    let hover = p.c(Token::Accent);
    div()
        .id(id)
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(radius))
        .role(Role::Button)
        .cursor_pointer()
        .hover(move |d| d.bg(hover))
}

/// The floating panels' 4×32px grip, revealed on hover or while dragging.
pub fn panel_grip(group: &'static str, dragging: bool, p: &Palette) -> Div {
    div()
        .absolute()
        .top(relative(0.5))
        .mt(px(-16.0))
        .left(px(2.0))
        .w(px(4.0))
        .h(px(32.0))
        .rounded_full()
        .bg(p.c(Token::MutedForeground).opacity(0.65))
        .when(!dragging, |d| d.invisible())
        .group_hover(group, |d| d.visible())
}

/// A single line that ends in an ellipsis instead of wrapping.
pub fn truncate(text: impl Into<SharedString>) -> Div {
    div()
        .min_w_0()
        .overflow_hidden()
        .text_ellipsis()
        .whitespace_nowrap()
        .child(text.into())
}

/// A horizontal hairline that takes the remaining width.
pub fn rule(p: &Palette) -> Div {
    div().flex_1().h(px(1.0)).bg(p.c(Token::Border))
}

/// `bg-sidebar-accent/50`-style hover fills are half the accent.
pub fn half(c: Hsla) -> Hsla {
    // GPUI multiplies the existing alpha. Including it in the factor again squares
    // translucent glass tokens (9% becomes 0.405% instead of Electron's 4.5%).
    c.opacity(0.5)
}

/// Paint `menu` above everything else in the window and stop clicks going through it. An
/// absolutely positioned child is otherwise drawn in tree order, so the card it hangs from
/// (its border, its focus ring) can show through.
pub fn float(menu: Div) -> Deferred {
    deferred(menu.occlude()).with_priority(10)
}

/// A thin ring, `fraction` of it (from the top, clockwise) in `color` over a `track`.
pub fn ring(fraction: f32, size: f32, track: Hsla, color: Hsla) -> impl IntoElement {
    let fraction = fraction.clamp(0.0, 1.0);
    div().size(px(size)).flex_none().child(
        canvas(
            |_, _, _| (),
            move |bounds, _, window, _| {
                let stroke = 2.0_f32;
                let r = size / 2.0 - stroke / 2.0;
                let c = bounds.center();
                let arc = |from: f32, to: f32, color: Hsla, window: &mut Window| {
                    let steps = (((to - from).abs() * 48.0).ceil() as usize).max(2);
                    let mut path = PathBuilder::stroke(px(stroke));
                    for i in 0..=steps {
                        let t = from + (to - from) * (i as f32 / steps as f32);
                        let a = t * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                        let p = point(c.x + px(r * a.cos()), c.y + px(r * a.sin()));
                        if i == 0 {
                            path.move_to(p);
                        } else {
                            path.line_to(p);
                        }
                    }
                    if let Ok(path) = path.build() {
                        window.paint_path(path, color);
                    }
                };
                arc(0.0, 0.999, track, window);
                if fraction > 0.0 {
                    arc(0.0, fraction, color, window);
                }
            },
        )
        .size_full(),
    )
}

/// Liquid Glass's specular rim (`index.css`, `--glass-rim`): a 1px ring that is bright where the
/// light would catch the edge (top left) and fades round to the far corner. CSS cuts it out of
/// a gradient box with a mask; here the ring is two gradient strokes, one for each half of the
/// gradient line (GPUI's gradients have two stops).
pub fn glass_rim(radius: f32, p: &Palette) -> Option<Div> {
    let strong = p.get(Token::GlassRimStrong)?;
    let weak = p.get(Token::GlassRimWeak)?;
    let clear = Hsla { a: 0.0, ..weak };
    Some(
        div().absolute().inset_0().child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    let inset = 0.5_f32;
                    let (w, h) = (
                        f32::from(bounds.size.width) - 2.0 * inset,
                        f32::from(bounds.size.height) - 2.0 * inset,
                    );
                    let r = (radius - inset).min(w / 2.0).min(h / 2.0).max(0.0);
                    let (ox, oy) = (
                        f32::from(bounds.origin.x) + inset,
                        f32::from(bounds.origin.y) + inset,
                    );
                    let mut ring = Vec::new();
                    let corner = |cx: f32, cy: f32, from: f32, ring: &mut Vec<(f32, f32)>| {
                        for i in 0..=10 {
                            let a = from + (i as f32 / 10.0) * std::f32::consts::FRAC_PI_2;
                            ring.push((cx + r * a.cos(), cy + r * a.sin()));
                        }
                    };
                    use std::f32::consts::{FRAC_PI_2, PI};
                    corner(ox + w - r, oy + r, -FRAC_PI_2, &mut ring);
                    corner(ox + w - r, oy + h - r, 0.0, &mut ring);
                    corner(ox + r, oy + h - r, FRAC_PI_2, &mut ring);
                    corner(ox + r, oy + r, PI, &mut ring);
                    let paint = |bg: Background, window: &mut Window| {
                        let mut path = PathBuilder::stroke(px(1.0));
                        for (i, (x, y)) in ring.iter().enumerate() {
                            let pt = point(px(*x), px(*y));
                            if i == 0 {
                                path.move_to(pt);
                            } else {
                                path.line_to(pt);
                            }
                        }
                        path.line_to(point(px(ring[0].0), px(ring[0].1)));
                        if let Ok(path) = path.build() {
                            window.paint_path(path, bg);
                        }
                    };
                    paint(
                        linear_gradient(
                            155.0,
                            linear_color_stop(strong, 0.0),
                            linear_color_stop(clear, 0.48),
                        ),
                        window,
                    );
                    paint(
                        linear_gradient(
                            155.0,
                            linear_color_stop(clear, 0.62),
                            linear_color_stop(weak, 1.0),
                        ),
                        window,
                    );
                },
            )
            .size_full(),
        ),
    )
}

/// The rest of a glass pane's edge: the 0.5px dark hairline and the light the top edge catches
/// (`inset 0 0 0 0.5px edge, inset 0 18px 32px -28px sheen`), over a pane `radius` round.
pub fn glass_edge(radius: f32, p: &Palette) -> Option<Div> {
    let edge = p.get(Token::GlassEdge)?;
    let sheen = p.get(Token::GlassSheen)?;
    let clear = Hsla { a: 0.0, ..sheen };
    Some(
        div()
            .absolute()
            .inset_0()
            .rounded(px(radius))
            .border_1()
            .border_color(Hsla {
                a: edge.a * 0.5,
                ..edge
            })
            .overflow_hidden()
            .child(div().w_full().h(px(26.0)).bg(linear_gradient(
                180.0,
                linear_color_stop(
                    Hsla {
                        a: sheen.a * 0.6,
                        ..sheen
                    },
                    0.0,
                ),
                linear_color_stop(clear, 1.0),
            ))),
    )
}

/// Both of the above, for a pane or card `radius` round; nothing without glass.
pub fn glass_surface(radius: f32, p: &Palette) -> impl IntoElement {
    div()
        .absolute()
        .inset_0()
        .children(glass_edge(radius, p))
        .children(glass_rim(radius, p))
}

pub trait Muted {
    fn muted(self, p: &Palette) -> Self;
}

impl<E: Styled> Muted for E {
    fn muted(self, p: &Palette) -> Self {
        self.text_color(p.c(Token::MutedForeground))
    }
}

#[cfg(test)]
mod tests {
    use super::{half, shimmer, spinner};
    use crate::theme::Palette;
    use fv_theme::{Preferences, ThemeKind, ThemeMode, Token, all_ids, seed};

    #[test]
    fn sidebar_hover_matches_electron_in_every_theme_and_glass_mode() {
        for id in all_ids() {
            let dark = seed(id).unwrap().kind == ThemeKind::Dark;
            for glass in [false, true] {
                let p = Palette::new(
                    Preferences {
                        mode: if dark {
                            ThemeMode::Dark
                        } else {
                            ThemeMode::Light
                        },
                        light_theme: id.into(),
                        dark_theme: id.into(),
                        glass,
                    }
                    .resolve(dark, true),
                );
                let accent = p.c(Token::SidebarAccent);
                let hover = half(accent);
                // Electron: hover:bg-sidebar-accent/50. Glass uses a 9% foreground
                // tint in light themes and 12% in dark themes; solid fills are opaque.
                let expected_alpha = if glass {
                    if dark { 0.06 } else { 0.045 }
                } else {
                    0.5
                };
                assert!(
                    (hover.a - expected_alpha).abs() < 1e-6,
                    "{id}, glass={glass}: hover alpha {} != {expected_alpha}",
                    hover.a
                );
                assert_eq!((hover.h, hover.s, hover.l), (accent.h, accent.s, accent.l));
            }
        }
    }

    #[test]
    fn spinner_and_shimmer_construct() {
        let _ = spinner("test-spin", 14.0, gpui_kit::black());
        let _ = shimmer("test-shimmer", "正在思考");
    }
}
