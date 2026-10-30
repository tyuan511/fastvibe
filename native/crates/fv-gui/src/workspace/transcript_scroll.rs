//! Follow the live edge until the reader takes over. Compare input with the offset recorded
//! after layout, so text growth, folding and viewport changes cannot masquerade as user scrolls.

use std::{cell::Cell, rc::Rc};

use fv_protocol::types::ThreadId;
use gpui_kit::{IntoElement, Pixels, ScrollHandle, Styled, canvas, px};

#[derive(Clone, Copy)]
struct Position {
    offset: Pixels,
    following: bool,
}

pub(super) struct TranscriptScroll {
    pub handle: ScrollHandle,
    thread: Option<ThreadId>,
    position: Rc<Cell<Position>>,
}

impl Default for TranscriptScroll {
    fn default() -> Self {
        Self {
            handle: ScrollHandle::new(),
            thread: None,
            position: Rc::new(Cell::new(Position {
                offset: px(0.0),
                following: true,
            })),
        }
    }
}

impl TranscriptScroll {
    /// Navigation starts at the end; refreshing either conversation's snapshot does not.
    pub fn bind(&mut self, thread: Option<&ThreadId>) -> bool {
        if self.thread.as_ref() != thread {
            *self = Self {
                thread: thread.cloned(),
                ..Self::default()
            };
            return true;
        }
        false
    }

    pub fn pause(&self) {
        let mut position = self.position.get();
        position.following = false;
        self.position.set(position);
    }

    /// Run before the scroller lays out: its maximum still belongs to the previous frame,
    /// while its offset already includes wheel/trackpad input. Even a small upward movement
    /// releases the live edge. Only a downward movement reaching the end re-arms it.
    pub fn prepare(&self) {
        let mut position = self.position.get();
        let offset = self.handle.offset().y;
        let max = self.handle.max_offset().y;
        if offset > position.offset && max > px(0.0) {
            position.following = false;
        } else if offset < position.offset && max + offset <= px(1.0) {
            position.following = true;
        }
        position.offset = offset;
        self.position.set(position);
        if position.following {
            // GPUI consumes this during layout, using the *new* content/viewport height.
            self.handle.scroll_to_bottom();
        }
    }

    /// Record after the parent scroller has clamped its offset to this frame's layout.
    /// This canvas has no layout footprint and never requests an extra frame.
    pub fn recorder(&self) -> impl IntoElement + use<> {
        let handle = self.handle.clone();
        let position = self.position.clone();
        canvas(
            move |_, _, _| {
                let mut value = position.get();
                value.offset = handle.offset().y;
                position.set(value);
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0()
    }
}

#[cfg(test)]
mod tests {
    use super::TranscriptScroll;
    use gpui_kit::gpui;
    use gpui_kit::{
        AppContext, Context, InteractiveElement, IntoElement, Modifiers, MouseButton,
        MouseDownEvent, MouseUpEvent, ParentElement, PlatformInput, Render, ScrollDelta,
        ScrollWheelEvent, StatefulInteractiveElement, Styled, TestAppContext, TouchPhase, Window,
        div, point, px,
    };
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    struct Fixture {
        scroll: Rc<RefCell<TranscriptScroll>>,
        height: Rc<Cell<f32>>,
        result_clicked: Rc<Cell<bool>>,
    }

    impl Render for Fixture {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let scroll = self.scroll.borrow();
            let result_clicked = self.result_clicked.clone();
            scroll.prepare();
            div().size(px(400.0)).child(
                div()
                    .id("transcript-scroll-fixture")
                    .relative()
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&scroll.handle)
                    .child(
                        div()
                            .relative()
                            .w_full()
                            .h(px(self.height.get()))
                            // The first 224px stand in for a multi-file result card. It is
                            // intentionally not an inner scroll viewport: wheel input here must
                            // keep moving the conversation, while each file row stays clickable.
                            .child(
                                div()
                                    .id("result-file-rows")
                                    .absolute()
                                    .top(px((self.height.get() - 224.0).max(0.0)))
                                    .left_0()
                                    .right_0()
                                    .h(px(224.0))
                                    .cursor_pointer()
                                    .on_click(move |_, _, _| result_clicked.set(true)),
                            ),
                    )
                    .child(scroll.recorder()),
            )
        }
    }

    struct Rig {
        window: gpui::AnyWindowHandle,
        scroll: Rc<RefCell<TranscriptScroll>>,
        height: Rc<Cell<f32>>,
        result_clicked: Rc<Cell<bool>>,
    }

    impl Rig {
        fn new(cx: &mut TestAppContext, height: f32) -> Self {
            let scroll = Rc::new(RefCell::new(TranscriptScroll::default()));
            scroll.borrow_mut().bind(Some(&"a".into()));
            let height = Rc::new(Cell::new(height));
            let result_clicked = Rc::new(Cell::new(false));
            let fixture = Fixture {
                scroll: scroll.clone(),
                height: height.clone(),
                result_clicked: result_clicked.clone(),
            };
            let window = cx.add_window(move |_, _| fixture).into();
            let rig = Self {
                window,
                scroll,
                height,
                result_clicked,
            };
            rig.draw(cx);
            rig
        }

        fn draw(&self, cx: &mut TestAppContext) {
            cx.update_window(self.window, |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })
            .unwrap();
        }

        fn resize_content(&self, cx: &mut TestAppContext, height: f32) {
            self.height.set(height);
            self.draw(cx);
        }

        fn wheel(&self, cx: &mut TestAppContext, delta: f32) {
            cx.update_window(self.window, |_, window, cx| {
                window.dispatch_event(
                    PlatformInput::ScrollWheel(ScrollWheelEvent {
                        position: point(px(200.0), px(200.0)),
                        delta: ScrollDelta::Pixels(point(px(0.0), px(delta))),
                        modifiers: Modifiers::default(),
                        touch_phase: TouchPhase::default(),
                    }),
                    cx,
                );
                window.draw(cx).clear(cx);
            })
            .unwrap();
        }

        fn assert_offset(&self, offset: f32) {
            assert_eq!(self.scroll.borrow().handle.offset().y, px(offset));
        }

        fn click_result(&self, cx: &mut TestAppContext) {
            cx.update_window(self.window, |_, window, cx| {
                let position = point(px(200.0), px(200.0));
                window.dispatch_event(
                    PlatformInput::MouseDown(MouseDownEvent {
                        button: MouseButton::Left,
                        position,
                        click_count: 1,
                        ..Default::default()
                    }),
                    cx,
                );
                window.dispatch_event(
                    PlatformInput::MouseUp(MouseUpEvent {
                        button: MouseButton::Left,
                        position,
                        click_count: 1,
                        ..Default::default()
                    }),
                    cx,
                );
            })
            .unwrap();
        }
    }

    #[gpui::test]
    fn follows_growth_in_the_same_frame_including_after_an_initially_short_chat(
        cx: &mut TestAppContext,
    ) {
        let rig = Rig::new(cx, 100.0);
        rig.assert_offset(0.0);
        rig.resize_content(cx, 1200.0);
        rig.assert_offset(-800.0);
        rig.resize_content(cx, 1600.0);
        rig.assert_offset(-1200.0);
    }

    #[gpui::test]
    fn file_rows_remain_clickable_at_the_live_edge(cx: &mut TestAppContext) {
        let rig = Rig::new(cx, 1200.0);
        rig.click_result(cx);
        assert!(
            rig.result_clicked.get(),
            "the final result row receives clicks"
        );
    }

    #[gpui::test]
    fn scrolling_over_file_result_rows_moves_the_conversation(cx: &mut TestAppContext) {
        let rig = Rig::new(cx, 1200.0);
        // Rig::wheel lands at y=200, inside the simulated result card's file list.
        rig.wheel(cx, 2.0);
        rig.assert_offset(-798.0);
    }

    #[gpui::test]
    fn even_a_small_upward_scroll_releases_the_bottom_through_repeated_updates(
        cx: &mut TestAppContext,
    ) {
        let rig = Rig::new(cx, 1200.0);
        // New output and the user's gesture can arrive before the same frame is drawn.
        rig.height.set(1250.0);
        rig.wheel(cx, 2.0);
        rig.assert_offset(-798.0);
        for height in [1300.0, 1400.0, 1600.0] {
            rig.resize_content(cx, height);
            rig.assert_offset(-798.0);
        }
    }

    #[gpui::test]
    fn only_scrolling_back_to_the_end_resumes_following(cx: &mut TestAppContext) {
        let rig = Rig::new(cx, 1200.0);
        rig.wheel(cx, 200.0);
        rig.wheel(cx, -100.0);
        rig.resize_content(cx, 1400.0);
        rig.assert_offset(-700.0);
        rig.wheel(cx, -500.0);
        rig.assert_offset(-1000.0);
        // Momentum at the bottom must not release following.
        rig.wheel(cx, -10.0);
        rig.resize_content(cx, 1600.0);
        rig.assert_offset(-1200.0);
    }

    #[gpui::test]
    fn layout_clamping_at_the_end_does_not_rearm_following(cx: &mut TestAppContext) {
        let rig = Rig::new(cx, 1200.0);
        rig.wheel(cx, 200.0);
        rig.resize_content(cx, 900.0);
        rig.assert_offset(-500.0);
        rig.resize_content(cx, 1400.0);
        rig.assert_offset(-500.0);
    }

    #[gpui::test]
    fn refreshing_the_same_chat_keeps_position_but_navigation_starts_at_the_end(
        cx: &mut TestAppContext,
    ) {
        let rig = Rig::new(cx, 1200.0);
        rig.wheel(cx, 200.0);
        assert!(!rig.scroll.borrow_mut().bind(Some(&"a".into())));
        rig.resize_content(cx, 1400.0);
        rig.assert_offset(-600.0);
        assert!(rig.scroll.borrow_mut().bind(Some(&"b".into())));
        rig.draw(cx);
        rig.assert_offset(-1000.0);
    }

    #[gpui::test]
    fn search_can_park_away_from_the_bottom_until_the_reader_returns(cx: &mut TestAppContext) {
        let rig = Rig::new(cx, 1200.0);
        {
            let scroll = rig.scroll.borrow();
            scroll.pause();
            scroll.handle.set_offset(point(px(0.0), px(-200.0)));
        }
        rig.draw(cx);
        rig.resize_content(cx, 1600.0);
        rig.assert_offset(-200.0);
        rig.wheel(cx, -1400.0);
        rig.resize_content(cx, 1800.0);
        rig.assert_offset(-1400.0);
    }
}
