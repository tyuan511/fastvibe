//! The prompts waiting behind the reply in flight, above the composer: the Electron app's
//! `message-queue.tsx`.
//!
//! Three controls per row, and each one is a different promise:
//!
//! - **立即** sends that prompt next. The reply in front of it is stopped, so the row stays in
//!   the list until the server has actually started it — a prompt that vanished on the click
//!   and then failed to run would be lost with no trace.
//! - **×** drops it from the queue. It was never sent, so nothing is taken back.
//! - The pause banner's **继续** lets the whole queue drain again. A queue stops on its own only
//!   when a turn failed, so this is the one place that says why it is standing still.

use fv_protocol::types::{QueuePauseReason, QueueState};
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{Workspace, text};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon, icon_button_xs, truncate};

/// How many rows are drawn before the list scrolls: a queue of ten prompts would otherwise push
/// the composer down by ten rows. Five is the same cap the turn's changed-file list uses.
const VISIBLE_ROWS: usize = 5;
const ROW_HEIGHT: f32 = 30.0;

impl Workspace {
    pub(super) fn queue_tray(&self, queue: QueueState, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let mut list = div().flex().flex_col();
        for item in &queue.items {
            let id = item.id.clone();
            let skill = crate::skill_draft::invocation(&item.text);
            let text_value = skill
                .as_ref()
                .map(|s| s.text)
                .unwrap_or(&item.text)
                .to_string();
            let send_id = item.id.clone();
            list = list.child(
                div()
                    .id(SharedString::from(format!("queue-{id}")))
                    .h(px(ROW_HEIGHT))
                    .flex_none()
                    .px(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .rounded(px(8.0))
                    .text_size(px(TEXT_SM))
                    .hover(move |d| d.bg(hover))
                    .child(icon("clock01", 12.0, p.c(Token::MutedForeground)))
                    .children(
                        skill
                            .as_ref()
                            .map(|s| super::skill_picker::badge(s.name, p)),
                    )
                    .child(div().flex_1().min_w_0().child(truncate(text_value)))
                    .child(
                        div()
                            .id(SharedString::from(format!("queue-send-{send_id}")))
                            .h(px(22.0))
                            .px(px(8.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .rounded(px(6.0))
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .cursor_pointer()
                            .hover(move |d| d.bg(hover).text_color(p.c(Token::Foreground)))
                            .child(text::QUEUE_SEND_NOW)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.queue_send_now(send_id.clone(), cx);
                            })),
                    )
                    .child(icon_button_xs(
                        SharedString::from(format!("queue-drop-{id}")),
                        "cancel01",
                        p,
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.queue_remove(id.clone(), cx);
                    })),
            );
        }
        // Rows past the cap scroll inside the tray rather than lengthening the page.
        let capped = queue.items.len() > VISIBLE_ROWS;
        let scroller = div()
            .id("queue-list")
            .when(capped, |d| {
                d.max_h(px(ROW_HEIGHT * VISIBLE_ROWS as f32))
                    .overflow_y_scroll()
            })
            .child(list);

        div()
            .mb(px(8.0))
            .rounded(px(14.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Card))
            .overflow_hidden()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(28.0))
                    .flex_none()
                    .px(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(icon(
                        if queue.pause.is_some() {
                            "alert02"
                        } else {
                            "list"
                        },
                        12.0,
                        if queue.pause.is_some() {
                            p.c(Token::Warning)
                        } else {
                            p.c(Token::MutedForeground)
                        },
                    ))
                    .when_some(queue.pause, |d, reason| {
                        d.text_color(p.c(Token::Warning)).child(match reason {
                            QueuePauseReason::Stopped => text::QUEUE_PAUSED_STOPPED,
                            QueuePauseReason::Failed => text::QUEUE_PAUSED,
                        })
                    })
                    .child(SharedString::from(format!(
                        "{} {}",
                        queue.items.len(),
                        text::QUEUE_UNIT
                    )))
                    .child(div().flex_1())
                    .when(queue.pause.is_some() && !queue.items.is_empty(), |d| {
                        d.child(
                            div()
                                .id("queue-resume")
                                .h(px(20.0))
                                .px(px(8.0))
                                .flex()
                                .items_center()
                                .gap(px(4.0))
                                .rounded(px(6.0))
                                .text_color(p.c(Token::Warning))
                                .cursor_pointer()
                                .hover(move |d| d.bg(hover))
                                .child(icon("play", 10.0, p.c(Token::Warning)))
                                .child(text::QUEUE_RESUME)
                                .on_click(cx.listener(|this, _, _, cx| this.queue_resume(cx))),
                        )
                    }),
            )
            .child(scroller)
    }
}
