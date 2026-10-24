//! Small building blocks shaped after the Electron app's shadcn Nova primitives, so the views
//! read like the components they replicate. Sizes are Tailwind's at the 16px root: `text-sm`
//! is 14/20, `text-xs` 12/16, `size-3.5` 14px, `h-8` 32px, `rounded-md` 8px.

use fv_theme::Token;
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
    ghost_square(id, 24.0, 8.0, p).child(icon(name, 14.0, p.c(Token::MutedForeground)))
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
        .cursor_pointer()
        .hover(move |d| d.bg(hover))
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
    c.opacity(c.a * 0.5)
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

pub trait Muted {
    fn muted(self, p: &Palette) -> Self;
}

impl<E: Styled> Muted for E {
    fn muted(self, p: &Palette) -> Self {
        self.text_color(p.c(Token::MutedForeground))
    }
}
