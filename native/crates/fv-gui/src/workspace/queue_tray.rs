//! The prompts waiting behind the reply in flight, above the composer: the Electron app's
//! `message-queue.tsx`.
//!
//! Four controls per row, and each one is a different promise:
//!
//! - **立即** sends that prompt next. The reply in front of it is stopped, so the row stays in
//!   the list until the server has actually started it — a prompt that vanished on the click
//!   and then failed to run would be lost with no trace.
//! - **编辑** rewrites it in place. A queued prompt has not been sent yet, so correcting a typo
//!   in it is the cheapest possible fix — re-typing it into the composer and sending it again
//!   would throw away the order the user arranged.
//! - **×** drops it from the queue. It was never sent, so nothing is taken back.
//! - Dragging a row moves it. The whole queue is sent in order, so which prompt goes first is
//!   the one thing about it worth rearranging.
//!
//! The pause banner's **继续** lets the whole queue drain again. A queue stops on its own only
//! when a turn failed, so this is the one place that says why it is standing still.

use crate::ui::px;
use fv_protocol::types::{QueuePauseReason, QueueState};
use fv_theme::Token;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon, icon_button_xs, truncate};

/// How many rows are drawn before the list scrolls: a queue of ten prompts would otherwise push
/// the composer down by ten rows. Five is the same cap the turn's changed-file list uses.
const VISIBLE_ROWS: usize = 5;
/// `h-8` rows with `space-y-0.5` between them.
const ROW_HEIGHT: f32 = 32.0;
const ROW_GAP: f32 = 2.0;
/// How far the tray tucks under the input card (`-mb-7`, `--tray-tuck`).
const TUCK: f32 = 28.0;

/// A queued prompt being rewritten in the tray.
pub(super) struct QueueEdit {
    pub item_id: String,
    pub input: Entity<InputState>,
}

/// The value a row drag carries: which row, in which conversation.
#[derive(Clone)]
pub(super) struct QueueDrag {
    pub thread_id: String,
    pub item_id: String,
    pub text: String,
}

impl Render for QueueDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        // The overlay follows the pointer above the tray, so it is drawn in its own colours
        // rather than the tray's (the sidebar's drag overlay does the same).
        div()
            .h(px(ROW_HEIGHT))
            .px(px(10.0))
            .flex()
            .items_center()
            .rounded(px(8.0))
            .border_1()
            .border_color(rgb(0x3f3f46))
            .bg(rgb(0x27272a))
            .text_color(rgb(0xfafafa))
            .text_size(px(TEXT_SM))
            .child(truncate(self.text.clone()))
    }
}

impl QueueDrag {
    /// What a drop would produce, given the queue's ids in their current order.
    ///
    /// The rule is the sidebar's (`sidebar_state::reordered`): the dragged row leaves its place
    /// and re-enters above or below the row the pointer is over. It lives here, apart from the
    /// element tree, so the arithmetic can be tested without a window.
    pub fn drop_order(
        ids: &[String],
        drag: &QueueDrag,
        target: &str,
        after: bool,
    ) -> Option<Vec<String>> {
        crate::sidebar_state::reordered(ids, &drag.item_id, target, after)
    }
}

impl Workspace {
    /// `MessageQueue`: a rounded-top tray that tucks under the input card, one numbered row per
    /// pending prompt, with the pause banner on top when the queue is standing still.
    pub(super) fn queue_tray(&self, queue: QueueState, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let english = self.english();
        let row_hover = p.c(Token::Muted).opacity(0.6);
        let ghost_hover = p.c(Token::Muted);
        let thread_id = self.selected.clone().unwrap_or_default();
        let editing = self
            .queue_edit
            .as_ref()
            .map(|edit| (edit.item_id.clone(), edit.input.clone()));
        let reorder_hint = trs!(english, "queue_tray.reorder");
        let mut list = div().flex().flex_col().gap(px(ROW_GAP));
        for (index, item) in queue.items.iter().enumerate() {
            let id = item.id.clone();
            let skill = crate::skill_draft::invocation(&item.text);
            let text_value = skill
                .as_ref()
                .map(|s| s.text)
                .unwrap_or(&item.text)
                .to_string();
            let send_id = item.id.clone();
            let edit_id = item.id.clone();
            let remove_id = item.id.clone();
            let group = SharedString::from(format!("queue-row-{id}"));
            // The row an edit belongs to draws its field instead of its text; every other row
            // is a plain row.
            let open = editing
                .as_ref()
                .filter(|(editing_id, _)| editing_id == &id)
                .map(|(_, input)| input.clone());
            let indicator = self
                .queue_drop
                .as_ref()
                .filter(|(target, _)| target == &id)
                .map(|(_, after)| *after);
            let target_id = id.clone();
            let mut row = div()
                .id(SharedString::from(format!("queue-{id}")))
                .group(group.clone())
                .relative()
                .h(px(ROW_HEIGHT))
                .flex_none()
                .pl(px(6.0))
                .pr(px(4.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .rounded(px(8.0))
                .when(open.is_none(), move |d| d.hover(move |d| d.bg(row_hover)))
                .child(
                    // The grip is what the row is dragged by, so it is also what says so.
                    div()
                        .id(SharedString::from(format!("queue-grip-{id}")))
                        .size(px(20.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_grab()
                        .tooltip(move |window, cx| Tooltip::new(reorder_hint).build(window, cx))
                        .child(icon(
                            "drag-drop-vertical",
                            14.0,
                            p.c(Token::MutedForeground).opacity(0.4),
                        )),
                )
                .child(
                    div()
                        .size(px(20.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .bg(p.c(Token::Muted))
                        .text_size(px(TEXT_XS))
                        .font_weight(FontWeight::MEDIUM)
                        .muted(p)
                        .child(SharedString::from((index + 1).to_string())),
                );
            let editing_row = open.is_some();
            row = match open.as_ref() {
                Some(input) => row.child(div().flex_1().min_w_0().child(Input::new(input))),
                None => row
                    .children(
                        skill
                            .as_ref()
                            .map(|s| super::skill_picker::badge(s.name, p).flex_none()),
                    )
                    .child(
                        truncate(text_value.clone())
                            .flex_1()
                            .text_size(px(TEXT_SM))
                            .text_color(p.c(Token::Foreground)),
                    ),
            };
            let row = row
                .child(
                    div()
                        .id(SharedString::from(format!("queue-send-{send_id}")))
                        .h(px(24.0))
                        .px(px(8.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .rounded(px(8.0))
                        .text_size(px(TEXT_XS))
                        .font_weight(FontWeight::MEDIUM)
                        .muted(p)
                        .cursor_pointer()
                        .group_hover(group.clone(), |d| d.text_color(p.c(Token::Foreground)))
                        .hover(move |d| d.bg(ghost_hover))
                        .child(icon("arrow-up02", 14.0, p.c(Token::MutedForeground)))
                        .child(trs!(english, "queue_tray.now"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.queue_send_now(send_id.clone(), cx);
                        })),
                )
                .child(
                    icon_button_xs(
                        SharedString::from(format!("queue-edit-{edit_id}")),
                        "pencil-edit02",
                        p,
                    )
                    .aria_label(trs!(english, "queue_tray.edit"))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.queue_begin_edit(edit_id.clone(), window, cx);
                    })),
                )
                .child(
                    icon_button_xs(
                        SharedString::from(format!("queue-drop-{remove_id}")),
                        "cancel01",
                        p,
                    )
                    .aria_label(trs!(english, "queue_tray.remove"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.queue_remove(remove_id.clone(), cx);
                    })),
                )
                // The insertion line says where the row would land, above or below the one the
                // pointer is over — the same reading the sidebar's drag has.
                .children(indicator.map(|after| {
                    let line = div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .h(px(2.0))
                        .bg(p.c(Token::Primary));
                    if after {
                        line.bottom(px(-ROW_GAP / 2.0))
                    } else {
                        line.top(px(-ROW_GAP / 2.0))
                    }
                }));

            // Only a row that is not being edited drags: dragging a field is selecting text.
            let row = if editing_row {
                row
            } else {
                let drag = QueueDrag {
                    thread_id: thread_id.clone(),
                    item_id: id.clone(),
                    text: text_value.clone(),
                };
                let drop_thread = thread_id.clone();
                let drop_target = target_id.clone();
                row.on_drag(drag, |drag: &QueueDrag, _, _, cx| cx.new(|_| drag.clone()))
                    .can_drop(move |value, _, _| {
                        value
                            .downcast_ref::<QueueDrag>()
                            .is_some_and(|d| d.thread_id == drop_thread && d.item_id != drop_target)
                    })
                    .on_drag_move(cx.listener({
                        let target = target_id.clone();
                        let thread = thread_id.clone();
                        move |this, e: &DragMoveEvent<QueueDrag>, _, cx| {
                            let drag = e.drag(cx);
                            if drag.thread_id != thread
                                || drag.item_id == target
                                || !e.bounds.contains(&e.event.position)
                            {
                                return;
                            }
                            let after =
                                e.event.position.y > e.bounds.origin.y + e.bounds.size.height / 2.0;
                            let next = Some((target.clone(), after));
                            if this.queue_drop != next {
                                this.queue_drop = next;
                                cx.notify();
                            }
                        }
                    }))
                    .on_drop(cx.listener({
                        let target = target_id.clone();
                        move |this, drag: &QueueDrag, _, cx| {
                            // The half the pointer is in was decided by this row's own drag
                            // move, which is the only place that knows the row's bounds.
                            let after = this
                                .queue_drop
                                .as_ref()
                                .filter(|(id, _)| id == &target)
                                .is_some_and(|(_, after)| *after);
                            this.drop_queue_row(drag, &target, after, cx)
                        }
                    }))
            };
            list = list.child(row);
        }
        // Rows past the cap scroll inside the tray rather than lengthening the page.
        let capped = queue.items.len() > VISIBLE_ROWS;
        let scroller = div()
            .id("queue-list")
            .when(capped, |d| {
                d.max_h(px((ROW_HEIGHT + ROW_GAP) * VISIBLE_ROWS as f32 - ROW_GAP))
                    .overflow_y_scroll()
            })
            .child(list);

        div()
            .relative()
            .w_full()
            .mb(px(-TUCK))
            .p(px(6.0))
            .pb(px(TUCK + 8.0))
            .rounded_t(px(16.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Card))
            .overflow_hidden()
            .flex()
            .flex_col()
            .when_some(queue.pause, |d, reason| {
                d.child(
                    div()
                        .mb(px(4.0))
                        .min_h(px(32.0))
                        .px(px(10.0))
                        .py(px(6.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .rounded(px(8.0))
                        .bg(p.c(Token::Muted).opacity(0.5))
                        .text_size(px(TEXT_XS))
                        .child(icon("alert02", 14.0, p.c(Token::Warning)))
                        .child(
                            truncate(match reason {
                                QueuePauseReason::Stopped => trs!(english, "queue_tray.stopped"),
                                QueuePauseReason::Failed => trs!(english, "queue_tray.error"),
                            })
                            .flex_1()
                            .text_color(p.c(Token::Foreground)),
                        )
                        .when(!queue.items.is_empty(), |d| {
                            d.child(
                                div()
                                    .id("queue-resume")
                                    .h(px(24.0))
                                    .px(px(8.0))
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .rounded(px(8.0))
                                    .border_1()
                                    .border_color(p.c(Token::Border))
                                    .bg(p.c(Token::Background))
                                    .font_weight(FontWeight::MEDIUM)
                                    .cursor_pointer()
                                    .hover(move |d| d.bg(ghost_hover))
                                    .child(trs!(english, "queue_tray.continue"))
                                    .on_click(cx.listener(|this, _, _, cx| this.queue_resume(cx))),
                            )
                        }),
                )
            })
            .child(scroller)
    }

    /// A row was dropped on another: move it there, above or below the target, and send the
    /// queue's whole new order to the server.
    pub(super) fn drop_queue_row(
        &mut self,
        drag: &QueueDrag,
        target: &str,
        after: bool,
        cx: &mut Context<Self>,
    ) {
        self.queue_drop = None;
        if drag.item_id == target {
            return;
        }
        let Some(thread_id) = self.selected.clone() else {
            return;
        };
        if drag.thread_id != thread_id {
            return;
        }
        let Some(ids) = self.views.get(&thread_id).map(|view| {
            view.queue
                .items
                .iter()
                .map(|item| item.id.clone())
                .collect::<Vec<String>>()
        }) else {
            return;
        };
        let Some(next) = QueueDrag::drop_order(&ids, drag, target, after) else {
            return;
        };
        self.queue_reorder(next, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::QueueDrag;

    fn drag(item: &str) -> QueueDrag {
        QueueDrag {
            thread_id: "t".into(),
            item_id: item.into(),
            text: String::new(),
        }
    }

    fn ids() -> Vec<String> {
        ["a", "b", "c", "d"].into_iter().map(String::from).collect()
    }

    /// A drop above or below the row it is over, in both directions — the whole meaning of the
    /// drag, and the one thing a window is not needed to check.
    #[test]
    fn a_drop_lands_above_or_below_the_row_it_is_over() {
        assert!(
            QueueDrag::drop_order(&ids(), &drag("a"), "b", false).is_none(),
            "dropping a row back where it already is asks for nothing"
        );
        assert_eq!(
            QueueDrag::drop_order(&ids(), &drag("a"), "c", false).unwrap(),
            ["b", "a", "c", "d"]
        );
        assert_eq!(
            QueueDrag::drop_order(&ids(), &drag("a"), "c", true).unwrap(),
            ["b", "c", "a", "d"]
        );
        assert_eq!(
            QueueDrag::drop_order(&ids(), &drag("d"), "b", false).unwrap(),
            ["a", "d", "b", "c"]
        );
        assert_eq!(
            QueueDrag::drop_order(&ids(), &drag("d"), "a", false).unwrap(),
            ["d", "a", "b", "c"]
        );
    }

    /// A target that is no longer queued (it was sent while the drag was in flight) produces no
    /// order at all rather than a guess: the queue's own next notice corrects the screen.
    #[test]
    fn a_drop_on_a_row_that_is_gone_does_nothing() {
        assert!(QueueDrag::drop_order(&ids(), &drag("a"), "gone", false).is_none());
        assert!(QueueDrag::drop_order(&ids(), &drag("gone"), "b", false).is_none());
    }
}
