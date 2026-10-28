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

use crate::ui::px;
use fv_protocol::types::{QueuePauseReason, QueueState};
use fv_theme::Token;
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

impl Workspace {
    /// `MessageQueue`: a rounded-top tray that tucks under the input card, one numbered row per
    /// pending prompt, with the pause banner on top when the queue is standing still.
    pub(super) fn queue_tray(&self, queue: QueueState, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let english = self.english();
        let row_hover = p.c(Token::Muted).opacity(0.6);
        let ghost_hover = p.c(Token::Muted);
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
            let group = SharedString::from(format!("queue-row-{id}"));
            list = list.child(
                div()
                    .id(SharedString::from(format!("queue-{id}")))
                    .group(group.clone())
                    .h(px(ROW_HEIGHT))
                    .flex_none()
                    .pl(px(6.0))
                    .pr(px(4.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .rounded(px(8.0))
                    .hover(move |d| d.bg(row_hover))
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
                    )
                    .children(
                        skill
                            .as_ref()
                            .map(|s| super::skill_picker::badge(s.name, p).flex_none()),
                    )
                    .child(
                        truncate(text_value)
                            .flex_1()
                            .text_size(px(TEXT_SM))
                            .text_color(p.c(Token::Foreground)),
                    )
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
                            .group_hover(group, |d| d.text_color(p.c(Token::Foreground)))
                            .hover(move |d| d.bg(ghost_hover))
                            .child(icon("arrow-up02", 14.0, p.c(Token::MutedForeground)))
                            .child(trs!(english, "queue_tray.now"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.queue_send_now(send_id.clone(), cx);
                            })),
                    )
                    .child(
                        icon_button_xs(
                            SharedString::from(format!("queue-drop-{id}")),
                            "cancel01",
                            p,
                        )
                        .aria_label(trs!(english, "queue_tray.remove"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.queue_remove(id.clone(), cx);
                        })),
                    ),
            );
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
}
