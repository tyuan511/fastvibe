//! The prompt of the turn being read, pinned to the top of the reading column — the native
//! equivalent of `message-list.tsx`'s turn-scoped sticky row.
//!
//! GPUI has no `position: sticky`, so the pinned row is a *second copy*: an absolutely positioned
//! child of the scroller, at a content-space y that [`pinned`] recomputes every frame. Inside the
//! scroller rather than beside it, so the scroll translation moves it like any other row and what
//! is painted follows this frame's offset instead of lagging it by one. The copy in flow stops
//! painting while it is the pinned one, and both decisions come from the same [`Pin`], so no frame
//! shows the prompt twice or not at all.
//!
//! The geometry is measured, not derived: [`recorder`] is a canvas that paints nothing and records
//! its parent's box while it prepaints. A scroller's children are prepainted inside
//! `with_element_offset(scroll_offset)`, so what they report is screen space; subtracting
//! `window.element_offset()` and the scroller's own origin turns it into content space. That
//! subtraction is also what removes the current offset, which is why a turn's span does not move
//! when the reader scrolls.
//!
//! Under 玻璃效果 Electron paints the sticky row transparent and masks the reply rows under it
//! instead (`GLASS_CUT_FEATHER`). GPUI has no per-element alpha mask, so the band carries a
//! floating layer's own fill and hides them by being dense — see `Workspace::pinned_prompt`.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::*;

/// Where one turn sits, in the scroller's content coordinates.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct TurnSpan {
    pub top: f32,
    pub bottom: f32,
    /// The prompt row's height, which is how far up it rides at the end of its turn. Zero until it
    /// has been measured, and a turn with no prompt row never measures one — so it never pins.
    pub prompt: f32,
}

/// The row to draw over the top of the reading column, and where.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Pin {
    pub turn: usize,
    pub y: f32,
}

/// Every turn's span, written by the recorders as they prepaint and read by the next render.
pub(super) type Marks = Rc<RefCell<Vec<TurnSpan>>>;

/// Which turn the reader is inside, and where that turn's prompt goes.
///
/// Turn-scoped, like the CSS this replaces: a prompt sticks only while its own turn is on screen,
/// and at the turn's end it rides up out of the way — which is the next turn's prompt pushing it
/// away. In the gap between two turns nothing is pinned, so the old prompt has left before the new
/// one arrives.
pub(super) fn pinned(spans: &[TurnSpan], view_top: f32) -> Option<Pin> {
    spans.iter().enumerate().find_map(|(turn, span)| {
        (span.prompt > 0.0 && span.top < view_top && view_top < span.bottom).then(|| Pin {
            turn,
            // `span.bottom - span.prompt` is the ride-up: the row never leaves its own turn.
            y: view_top.min(span.bottom - span.prompt),
        })
    })
}

/// A child that paints nothing and records its parent's box. The parent must be `relative`.
///
/// With `prompt` it records the height alone, of the prompt row; otherwise the turn's extent.
/// Entries are addressed by turn index, so a gap left by a turn that is not rendered stays at its
/// default and can never pin.
pub(super) fn recorder(
    marks: Marks,
    scroller: ScrollHandle,
    index: usize,
    prompt: bool,
) -> impl IntoElement {
    canvas(
        move |bounds, window: &mut Window, _| {
            let origin = window.element_offset().y + scroller.bounds().origin.y;
            let top = f32::from(bounds.origin.y - origin);
            let mut marks = marks.borrow_mut();
            if marks.len() <= index {
                marks.resize(index + 1, TurnSpan::default());
            }
            if prompt {
                marks[index].prompt = f32::from(bounds.size.height);
            } else {
                marks[index].top = top;
                marks[index].bottom = top + f32::from(bounds.size.height);
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
}

#[cfg(test)]
mod tests {
    use super::{Pin, TurnSpan, pinned};

    /// A long turn, the 28px gap the reading column puts between turns, a short one, and a third
    /// that has no prompt of its own (an injected continuation).
    fn spans() -> Vec<TurnSpan> {
        vec![
            TurnSpan {
                top: 8.0,
                bottom: 400.0,
                prompt: 44.0,
            },
            TurnSpan {
                top: 428.0,
                bottom: 500.0,
                prompt: 44.0,
            },
            TurnSpan {
                top: 528.0,
                bottom: 900.0,
                prompt: 0.0,
            },
        ]
    }

    #[test]
    fn a_prompt_at_its_own_place_is_not_pinned() {
        // Nothing scrolled, and exactly at the boundary: the row in flow is already at the top, so
        // a copy over it would only be a second chance to get it wrong.
        assert_eq!(pinned(&spans(), 0.0), None);
        assert_eq!(pinned(&spans(), 8.0), None);
        assert_eq!(pinned(&[], 200.0), None);
    }

    #[test]
    fn the_turn_being_read_pins_its_prompt_at_the_top() {
        assert_eq!(pinned(&spans(), 200.0), Some(Pin { turn: 0, y: 200.0 }));
        assert_eq!(pinned(&spans(), 430.0), Some(Pin { turn: 1, y: 430.0 }));
    }

    #[test]
    fn a_prompt_rides_up_at_the_end_of_its_own_turn() {
        // 400 - 44: the row parks on the foot of its turn and scrolls out with it, which is what
        // the next turn's prompt pushes it into doing.
        assert_eq!(pinned(&spans(), 380.0), Some(Pin { turn: 0, y: 356.0 }));
        assert_eq!(pinned(&spans(), 399.0), Some(Pin { turn: 0, y: 356.0 }));
        assert_eq!(pinned(&spans(), 480.0), Some(Pin { turn: 1, y: 456.0 }));
    }

    #[test]
    fn nothing_is_pinned_in_the_gap_between_turns() {
        assert_eq!(pinned(&spans(), 410.0), None);
        assert_eq!(pinned(&spans(), 510.0), None);
    }

    #[test]
    fn a_turn_without_a_prompt_pins_nothing() {
        // It is inside a turn, so something would have to be drawn — but there is no prompt to
        // draw, and the previous turn's has already ridden out.
        assert_eq!(pinned(&spans(), 700.0), None);
    }

    #[test]
    fn an_unmeasured_span_pins_nothing() {
        // The first frame after an open, or one where the transcript was not drawn: the recorders
        // have not run yet, and a default span must not put a row at the top of an empty view.
        assert_eq!(pinned(&[TurnSpan::default()], 200.0), None);
    }
}

#[cfg(test)]
mod recorder_tests {
    use super::{TurnSpan, pinned, recorder};
    // Explicit imports, never `use gpui_kit::*` or `use super::*`: the Kit's glob re-exports
    // GPUI's `test` macro too, and the `#[test]` that macro generates would expand itself forever.
    use gpui_kit::gpui;
    use gpui_kit::{
        AppContext, Context, InteractiveElement, IntoElement, Modifiers, ParentElement,
        PlatformInput, Render, ScrollDelta, ScrollHandle, ScrollWheelEvent,
        StatefulInteractiveElement, Styled, TestAppContext, Window, div, point, px,
    };
    use std::cell::RefCell;
    use std::rc::Rc;

    /// Three 300px turns with a 44px prompt each, in a 400px scroller — the reading column's own
    /// shape (a `relative` turn wrapper, a `gap`, a prompt row) with the content taken out.
    struct Fixture {
        scroller: ScrollHandle,
        marks: Rc<RefCell<Vec<TurnSpan>>>,
    }

    impl Render for Fixture {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let mut body = div().w_full().flex().flex_col().gap(px(28.0)).pt(px(8.0));
            for index in 0..3 {
                body = body.child(
                    div()
                        .relative()
                        .w_full()
                        .h(px(300.0))
                        .child(recorder(
                            self.marks.clone(),
                            self.scroller.clone(),
                            index,
                            false,
                        ))
                        .child(div().relative().w_full().h(px(44.0)).child(recorder(
                            self.marks.clone(),
                            self.scroller.clone(),
                            index,
                            true,
                        ))),
                );
            }
            div().size(px(400.0)).child(
                div()
                    .id("sticky-fixture")
                    .relative()
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroller)
                    .child(body),
            )
        }
    }

    fn draw(cx: &mut TestAppContext, fixture: Fixture) -> gpui::AnyWindowHandle {
        let window: gpui::AnyWindowHandle = cx.add_window(move |_, _| fixture).into();
        cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
            .expect("draw the sticky fixture");
        window
    }

    /// A turn's span is a fact about the transcript, not about where the reader is looking: this
    /// is the coordinate conversion the whole feature rests on, and it is the part that fails
    /// silently (the pinned row would sit one scroll offset away from the top).
    #[gpui::test]
    fn spans_are_in_content_coordinates_and_do_not_move_when_scrolled(cx: &mut TestAppContext) {
        let scroller = ScrollHandle::new();
        let marks = Rc::new(RefCell::new(Vec::new()));
        let window = draw(
            cx,
            Fixture {
                scroller: scroller.clone(),
                marks: marks.clone(),
            },
        );
        let before = marks.borrow().clone();
        assert_eq!(
            before,
            vec![
                TurnSpan {
                    top: 8.0,
                    bottom: 308.0,
                    prompt: 44.0
                },
                TurnSpan {
                    top: 336.0,
                    bottom: 636.0,
                    prompt: 44.0
                },
                TurnSpan {
                    top: 664.0,
                    bottom: 964.0,
                    prompt: 44.0
                },
            ],
            "the recorders must measure each turn's own box, in content coordinates"
        );

        cx.update_window(window, |_, window, cx| {
            window.dispatch_event(
                PlatformInput::ScrollWheel(ScrollWheelEvent {
                    position: point(px(200.0), px(200.0)),
                    delta: ScrollDelta::Pixels(point(px(0.0), px(-240.0))),
                    modifiers: Modifiers::default(),
                    touch_phase: gpui::TouchPhase::default(),
                }),
                cx,
            );
            window.draw(cx).clear(cx);
        })
        .expect("scroll the sticky fixture");

        assert_eq!(scroller.offset().y, px(-240.0), "the wheel must move it");
        assert_eq!(
            marks.borrow().clone(),
            before,
            "a scrolled transcript is the same transcript: the spans must not follow the offset"
        );

        // And the frame's own arithmetic: 240 of scroll is 240 into the first turn.
        let view_top = -f32::from(scroller.offset().y);
        assert_eq!(
            pinned(&marks.borrow(), view_top),
            Some(super::Pin { turn: 0, y: 240.0 })
        );
    }
}
