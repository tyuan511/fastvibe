//! The composer, after `components/chat/composer.tsx`: a 22px-round card holding the text area,
//! and under it the attach button, the model and thinking chip, and send / stop.

use fv_protocol::types::ThinkingLevel;
use fv_theme::Token;
use gpui_kit::component::Sizable as _;
use gpui_kit::component::input::Textarea;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::transcript::{THREAD_MAX, THREAD_PAD};
use super::{Workspace, text};
use crate::context_stats::{cache_hit, format_cost, format_count, format_speed, token_pair};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon};

/// `text-[0.8rem]`: the chip's size.
const CHIP_TEXT: f32 = 12.8;

pub fn thinking_label(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Minimal => "极低",
        ThinkingLevel::Low => "低",
        ThinkingLevel::Medium => "中",
        ThinkingLevel::High => "高",
        ThinkingLevel::Xhigh => "极高",
        ThinkingLevel::Max => "最高",
    }
}

impl Workspace {
    /// The `Tab` chip that leads the guessed placeholder.
    fn suggestion_hint(&self) -> Div {
        let p = &self.palette;
        div()
            .absolute()
            .left(px(12.0))
            .top(px(14.0))
            .px(px(5.0))
            .h(px(18.0))
            .flex()
            .items_center()
            .rounded(px(4.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Muted))
            .text_size(px(10.0))
            .line_height(px(12.0))
            .muted(p)
            .child("Tab")
    }

    pub(super) fn composer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.refresh_skill_picker(cx);
        let p = &self.palette;
        // 回复推荐 rides in the placeholder: an empty composer shows what the user is likely to
        // say next, and Tab takes it. Written only when it changed — the text area is a child
        // entity, so setting it every frame would make every frame a change.
        let wanted_placeholder = self
            .compose_suggestion
            .clone()
            .unwrap_or_else(|| text::PLACEHOLDER.to_string());
        if wanted_placeholder != self.placeholder_shown {
            self.placeholder_shown = wanted_placeholder.clone();
            self.input.update(cx, |state, cx| {
                state.set_placeholder(wanted_placeholder.clone(), window, cx)
            });
            cx.notify();
        }
        let running = self
            .selected
            .as_ref()
            .and_then(|id| self.views.get(id))
            .is_some_and(|v| v.running);
        let empty = self.input.read(cx).value().trim().is_empty();
        let focused = self.input.read(cx).focus_handle(cx).is_focused(window);
        let label = self.current_model_label();
        let entry = label
            .as_deref()
            .and_then(|l| self.models.iter().find(|m| m.label == l));
        let model_text = match (entry, label.as_deref()) {
            (Some(m), _) => format!("{}/{}", m.provider_name, m.model.id),
            (None, Some(l)) => l.to_string(),
            (None, None) => text::NO_MODEL.to_string(),
        };
        let thinking_text = self
            .current_thinking()
            .map(thinking_label)
            .unwrap_or("跟随默认");

        // How full the model's window is: a ring that warms up as it nears the limit.
        let usage = self
            .selected
            .as_ref()
            .and_then(|id| self.views.get(id))
            .and_then(|v| v.token_usage)
            .filter(|u| u.window > 0);
        let context_menu = self.context_menu.then(|| self.context_menu_view(cx));
        let context_ring = usage.map(|u| {
            let fraction = u.used as f32 / u.window as f32;
            let color = if fraction >= 0.9 {
                p.c(Token::Destructive)
            } else if fraction >= 0.7 {
                p.c(Token::Warning)
            } else {
                p.c(Token::MutedForeground)
            };
            // The panel hangs off the ring, not off the card. The ring sits left of the model
            // chip, so anchoring the popover to the card's right edge parked it a whole chip
            // away from the icon that opened it — Electron anchors it `side="top" align="end"`.
            div()
                .relative()
                .flex_none()
                .child(
                    div()
                        .id("context-ring")
                        .size(px(28.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .child(crate::ui::ring(fraction, 14.0, p.c(Token::Border), color))
                        .on_click(cx.listener(|this, _, _, cx| {
                            let open = !this.context_menu;
                            this.close_menus(cx);
                            this.context_menu = open;
                            cx.notify();
                        })),
                )
                .children(context_menu.map(crate::ui::float))
        });
        // One button, three jobs: queue the words behind the reply in flight, stop it when there
        // is nothing typed, or send. A run never disables the composer — text typed while the
        // agent is working is the normal case, and the queue is where it goes.
        let stops = running && empty;
        let send_enabled = !empty || running;
        let send = div()
            .id("send")
            .size(px(28.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .bg(p.c(Token::Primary))
            .when(!send_enabled, |d| d.opacity(0.5))
            .cursor_pointer()
            .tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(if stops {
                    "停止"
                } else if running {
                    "加入队列"
                } else {
                    "发送"
                })
                .build(window, cx)
            })
            .child(icon(
                if stops { "square" } else { "arrow-up02" },
                16.0,
                p.c(Token::PrimaryForeground),
            ))
            .on_click(cx.listener(move |this, _, window, cx| {
                if stops {
                    this.interrupt(cx);
                } else {
                    this.send(window, cx);
                }
            }));

        let chip_hover = p.c(Token::Accent);
        let chip = div()
            .id("model-chip")
            .h(px(28.0))
            .max_w(px(320.0))
            .px(px(9.0))
            .flex()
            .items_center()
            .gap(px(4.0))
            .rounded_full()
            .cursor_pointer()
            .text_size(px(CHIP_TEXT))
            .line_height(px(19.2))
            .muted(p)
            .hover(move |d| d.bg(chip_hover))
            .child(crate::ui::truncate(model_text))
            .child(div().flex_none().text_color(p.c(Token::Border)).child("·"))
            .child(div().flex_none().child(thinking_text))
            .child(icon("arrow-down01", 12.0, p.c(Token::MutedForeground)))
            .on_click(cx.listener(|this, _, _, cx| {
                let open = !this.model_menu;
                this.close_menus(cx);
                this.model_menu = open;
                this.thinking_menu = false;
                cx.notify();
            }));

        let menu = self.model_menu.then(|| self.model_menu(cx));
        let thinking_menu = (self.model_menu && self.thinking_menu).then(|| self.thinking_menu(cx));
        // Only a conversation that does not exist yet can still choose where it runs.
        let project_row = self.selected.is_none().then(|| self.project_chip(cx));
        let notice = self.notice.clone();
        // A question stands above the composer; a command to allow covers it.
        let (covered, panel) = match self.pending() {
            Some(super::ask::Pending::Approval(id, a)) => {
                (true, Some(self.approval_panel(id, a, cx)))
            }
            Some(super::ask::Pending::Question(id, q)) => {
                (false, Some(self.question_panel(id, q, cx)))
            }
            None => (false, None),
        };
        let mention = self.mention_panel(cx);
        let skill_menu = self.skill_panel(cx);
        let input_palette = p.clone();
        let skill_input = self.input.clone();
        let access = self.access_button(cx);
        let access_menu = self.access_menu.then(|| self.access_menu_view(cx));
        // What is queued behind the reply in flight. Drawn only when there is something to say,
        // so an empty queue costs no space above the composer.
        // A prompt being rewritten says so above the composer: otherwise the corrected words
        // look like a new message and the discarded reply comes as a surprise.
        let editing = self.editing_turn.clone().map(|_| {
            let p = &self.palette;
            let hover = p.c(Token::Accent);
            div()
                .mb(px(8.0))
                .px(px(12.0))
                .py(px(6.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .rounded(px(10.0))
                .bg(p.c(Token::Muted))
                .text_size(px(TEXT_XS))
                .muted(p)
                .child(icon("pencil-edit02", 12.0, p.c(Token::MutedForeground)))
                .child(text::EDIT_HINT)
                .child(div().flex_1())
                .child(
                    div()
                        .id("edit-cancel")
                        .px(px(6.0))
                        .rounded(px(4.0))
                        .cursor_pointer()
                        .hover(move |d| d.bg(hover))
                        .child(text::EDIT_CANCEL)
                        .on_click(cx.listener(|this, _, _, cx| this.cancel_edit_public(cx))),
                )
        });
        let queue = self
            .selected
            .as_ref()
            .and_then(|id| self.views.get(id))
            .map(|v| v.queue.clone())
            .filter(|q| !q.items.is_empty())
            .map(|q| self.queue_tray(q, cx).into_any_element());

        div()
            .w_full()
            .max_w(px(THREAD_MAX))
            .mx_auto()
            .px(px(THREAD_PAD))
            .pb(px(20.0))
            .flex_none()
            .children(project_row)
            // The `@` menu hangs just above the card, where the caret is looking.
            .children(mention)
            .children(skill_menu)
            .children(notice.map(|notice| {
                // Three tones, because they mean three different things: nothing happened
                // (red), something happened and is worth knowing (neutral, with a check), or
                // something happened incompletely (amber).
                let (border, fill, ink, glyph) = match &notice {
                    super::Notice::Failed(_) => (
                        p.c(Token::Destructive).opacity(0.25),
                        p.c(Token::Destructive).opacity(0.05),
                        p.c(Token::Destructive),
                        None,
                    ),
                    super::Notice::Done(_) => (
                        p.c(Token::Border),
                        p.c(Token::Muted).opacity(0.5),
                        p.c(Token::MutedForeground),
                        Some("checkmark-circle02"),
                    ),
                    super::Notice::Partial(_) => (
                        p.c(Token::Warning).opacity(0.3),
                        p.c(Token::Warning).opacity(0.08),
                        p.c(Token::Warning),
                        Some("alert02"),
                    ),
                };
                div()
                    .mb(px(8.0))
                    .px(px(12.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .rounded(px(12.0))
                    .border_1()
                    .border_color(border)
                    .bg(fill)
                    .text_size(px(TEXT_SM))
                    .text_color(ink)
                    .children(glyph.map(|g| icon(g, 13.0, ink)))
                    .child(SharedString::from(notice.text().to_string()))
            }))
            .children(panel.map(|panel| {
                div()
                    .mb(px(8.0))
                    .when(covered, |d| d.mb(px(0.0)))
                    .child(panel)
            }))
            .children(editing)
            .children(queue)
            .children((!covered).then(|| {
                div()
                    .relative()
                    .rounded(px(22.0))
                    .border_1()
                    // `focus-within:border-ring`
                    .border_color(if focused {
                        p.c(Token::Ring)
                    } else {
                        p.c(Token::Border)
                    })
                    .bg(p.c(Token::Card))
                    .shadow_sm()
                    .flex()
                    .flex_col()
                    .child(
                        // `14px 16px 8px` around the text, less the 8px / 2px the control
                        // insets by itself at this size.
                        div()
                            .relative()
                            // Tab takes the guess only while the box is empty; with text in it,
                            // Tab stays the editor's own indent.
                            .key_context(if self.skill_picker.open() {
                                "FilledComposer MentionOpen SkillOpen"
                            } else if self.mention.is_some() {
                                // While the `@` menu is open it owns the arrows and Escape.
                                "FilledComposer MentionOpen"
                            } else if empty {
                                "EmptyComposer"
                            } else {
                                "FilledComposer"
                            })
                            .min_h(px(52.0))
                            .pt(px(12.0))
                            // The Tab chip leads the line, so the placeholder starts after it
                            // (Electron's `pl-14`) instead of running under it.
                            .pl(if empty && self.compose_suggestion.is_some() {
                                px(48.0)
                            } else {
                                px(8.0)
                            })
                            .pr(px(8.0))
                            .pb(px(6.0))
                            .text_size(px(TEXT_SM))
                            .line_height(px(24.0))
                            .child(
                                Textarea::new(&self.input)
                                    .token(move |context, _, _| {
                                        super::skill_picker::input_badge(
                                            context,
                                            &input_palette,
                                            skill_input.clone(),
                                        )
                                    })
                                    .appearance(false)
                                    .bordered(false)
                                    // Its text is 0.875 of its size: 16 gives `text-sm`.
                                    .with_size(gpui_kit::component::Size::Size(px(16.0))),
                            )
                            // The key that takes it, ahead of the guess: a placeholder says what
                            // would be typed, and this says how it gets there.
                            .children(
                                (empty && self.compose_suggestion.is_some())
                                    .then(|| self.suggestion_hint()),
                            ),
                    )
                    .child(
                        div()
                            .px(px(10.0))
                            .pb(px(10.0))
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .child(crate::ui::icon_button("attach", "attachment", p).rounded_full())
                            .child(access)
                            .child(div().flex_1())
                            .children(context_ring)
                            .child(chip)
                            .child(send),
                    )
                    // The rim sits on the border and yields to the focus ring.
                    .children((!focused).then(|| crate::ui::glass_rim(22.0, p)).flatten())
                    .children(menu.map(|menu| deferred(menu.occlude()).with_priority(10)))
                    .children(thinking_menu.map(|m| deferred(m.occlude()).with_priority(11)))
                    .children(access_menu.map(crate::ui::float))
            }))
    }

    fn model_menu(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let mut list = div()
            .id("composer-model-list")
            .max_h(px(440.0))
            .overflow_y_scroll()
            .absolute()
            .bottom(px(44.0))
            .right(px(10.0))
            .w(px(280.0))
            .p(px(4.0))
            .rounded(px(12.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.overlay())
            .text_color(p.c(Token::PopoverForeground))
            .shadow_md()
            .flex()
            .flex_col()
            .text_size(px(TEXT_SM));
        if self.models.is_empty() {
            list = list.child(
                div()
                    .px(px(8.0))
                    .py(px(6.0))
                    .muted(p)
                    .child(text::NO_MODEL_HINT),
            );
        }
        for m in &self.models {
            let label = m.label.clone();
            list = list.child(
                div()
                    .id(SharedString::from(format!("m-{}", m.label)))
                    .h(px(32.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .hover(move |d| d.bg(hover))
                    .child(
                        crate::ui::truncate(format!("{}/{}", m.provider_name, m.model.id)).flex_1(),
                    )
                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                        if *hovered && this.thinking_menu {
                            this.thinking_menu = false;
                            cx.notify();
                        }
                    }))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.thinking_menu = false;
                        this.pick_model(label.clone(), cx);
                    })),
            );
        }
        list = list.child(div().my(px(4.0)).h(px(1.0)).bg(p.c(Token::Border)));

        let thinking_text = self
            .current_thinking()
            .map(thinking_label)
            .unwrap_or("跟随默认");
        let thinking_active = self.thinking_menu;
        list = list.child(
            div()
                .id("thinking-sub-trigger")
                .h(px(32.0))
                .px(px(8.0))
                .flex()
                .items_center()
                .justify_between()
                .rounded(px(8.0))
                .cursor_pointer()
                .when(thinking_active, move |d| d.bg(hover))
                .hover(move |d| d.bg(hover))
                .child("思考强度")
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(SharedString::from(thinking_text)),
                        )
                        .child(icon("arrow-right01", 12.0, p.c(Token::MutedForeground))),
                )
                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                    if *hovered && !this.thinking_menu {
                        this.thinking_menu = true;
                        cx.notify();
                    }
                }))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.thinking_menu = !this.thinking_menu;
                    cx.notify();
                })),
        );

        list = list.child(div().my(px(4.0)).h(px(1.0)).bg(p.c(Token::Border)));

        // 管理模型 → 设置 → 模型与默认, at the foot of the list.
        list = list.child(
            div()
                .id("manage-models")
                .h(px(32.0))
                .px(px(8.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .hover(move |d| d.bg(hover))
                .child(icon("settings02", 14.0, p.c(Token::MutedForeground)))
                .child("管理模型")
                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                    if *hovered && this.thinking_menu {
                        this.thinking_menu = false;
                        cx.notify();
                    }
                }))
                .on_click(cx.listener(|this, _, window, cx| {
                    this.model_menu = false;
                    this.thinking_menu = false;
                    this.open_settings(super::settings::Section::Providers, window, cx)
                })),
        );
        list
    }

    fn thinking_menu(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let cur = if self.explicit_thinking().is_none() {
            None
        } else {
            self.current_thinking()
        };
        let allowed = self
            .current_model_label()
            .and_then(|l| self.models.iter().find(|m| m.label == l))
            .map(|m| m.model.allowed_thinking());

        let options: [(Option<ThinkingLevel>, &'static str); 7] = [
            (None, "跟随默认"),
            (Some(ThinkingLevel::Minimal), "极低"),
            (Some(ThinkingLevel::Low), "低"),
            (Some(ThinkingLevel::Medium), "中"),
            (Some(ThinkingLevel::High), "高"),
            (Some(ThinkingLevel::Xhigh), "极高"),
            (Some(ThinkingLevel::Max), "最高"),
        ];

        let mut list = div()
            .id("composer-thinking-submenu")
            .absolute()
            .bottom(px(44.0))
            .right(px(296.0))
            .w(px(160.0))
            .p(px(4.0))
            .rounded(px(12.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.overlay())
            .text_color(p.c(Token::PopoverForeground))
            .shadow_md()
            .flex()
            .flex_col()
            .text_size(px(TEXT_SM));

        for (level, label) in options {
            if level.is_some_and(|l| allowed.as_ref().is_some_and(|v| !v.contains(&l))) {
                continue;
            }
            let is_selected = cur == level;
            list = list.child(
                div()
                    .id(SharedString::from(format!("thinking-opt-{}", label)))
                    .h(px(32.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .hover(move |d| d.bg(hover))
                    .child(label)
                    .when(is_selected, |d| {
                        d.child(icon("tick02", 14.0, p.c(Token::Primary)))
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.pick_thinking(level, cx);
                    })),
            );
        }

        list
    }

    fn context_menu_view(&self, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let view = self.selected.as_ref().and_then(|id| self.views.get(id));
        let usage = view.and_then(|v| v.token_usage).filter(|u| u.window > 0);
        let percent = usage
            .map(|u| (100.0 * u.used as f64 / u.window as f64).round())
            .unwrap_or(0.0);
        let color = if percent >= 90.0 {
            p.c(Token::Destructive)
        } else if percent >= 70.0 {
            p.c(Token::Warning)
        } else {
            p.c(Token::Primary)
        };
        let busy = view.is_some_and(|v| v.running)
            || self
                .selected
                .as_ref()
                .is_some_and(|id| self.compact_pending.contains(id));
        let can_compact = !busy && view.is_some_and(|v| !v.turns.is_empty());
        let remaining = usage.map(|u| u.window.saturating_sub(u.used));
        let button = div()
            .id("compact-context")
            .w_full()
            .h(px(28.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .text_size(px(TEXT_SM))
            .when(!can_compact, |d| d.opacity(0.5))
            .when(can_compact, |d| {
                d.cursor_pointer().hover(|d| d.bg(p.c(Token::Accent)))
            })
            .tooltip(move |window, cx| {
                Tooltip::new(if busy {
                    "会话进行中，无法压缩"
                } else {
                    "压缩上下文"
                })
                .build(window, cx)
            })
            .child(icon("scissor", 14.0, p.c(Token::Foreground)))
            .child("压缩上下文")
            .on_click(cx.listener(move |this, _, _, cx| {
                if can_compact {
                    this.compact(cx);
                }
            }));
        // Anchored to the ring's own 28px box: its right edge lines up with the ring's, and it
        // clears the control by 10px (`sideOffset={10}` in the Electron popover).
        // `dialog_card`'s width is relative to its parent, which here is the ring, so the card
        // states its own ceiling instead of inheriting 26px.
        let mut card = super::settings::dialog_card(p, 288.0)
            .max_w(px(288.0))
            .absolute()
            .bottom(px(38.0))
            .right(px(0.0))
            .p(px(14.0))
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .text_size(px(TEXT_SM))
                            .child(div().font_weight(FontWeight::MEDIUM).child("上下文窗口"))
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(if percent >= 70.0 {
                                        color
                                    } else {
                                        p.c(Token::Foreground)
                                    })
                                    .child(if usage.is_some() {
                                        format!("{percent:.0}%")
                                    } else {
                                        "—".into()
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .w_full()
                            .h(px(6.0))
                            .rounded_full()
                            .overflow_hidden()
                            .bg(p.c(Token::Muted))
                            .child(
                                div()
                                    .h_full()
                                    .w(relative((percent.clamp(0.0, 100.0) / 100.0) as f32))
                                    .rounded_full()
                                    .bg(color),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(SharedString::from(format!(
                                "已用 {}",
                                format_count(usage.map(|u| u.used))
                            )))
                            .child(SharedString::from(format!(
                                "剩余 {} / {}",
                                format_count(remaining),
                                format_count(usage.map(|u| u.window))
                            ))),
                    )
                    .child(button),
            );
        if let Some(view) = view {
            let stats = &view.stats;
            let cache = cache_hit(&stats.tokens);
            let rows = div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(context_stat(
                    "turn-tokens",
                    "本轮 Token",
                    token_pair(stats.turn.as_ref()),
                    "本轮：自你最近一次输入起",
                    false,
                    p,
                ))
                .child(context_stat(
                    "session-tokens",
                    "会话 Token",
                    token_pair(Some(&stats.tokens)),
                    "整个会话累计",
                    false,
                    p,
                ))
                .child(context_stat(
                    "output-speed",
                    "输出速度",
                    format_speed(stats.last_request.as_ref()),
                    "最近一次已完成的模型请求：输出 token ÷ 请求耗时（含首 token 等待）",
                    false,
                    p,
                ))
                .child(context_stat(
                    "steps",
                    "步骤",
                    stats.steps.to_string(),
                    "整个会话累计",
                    false,
                    p,
                ))
                .child(context_stat(
                    "cache-hit",
                    "缓存命中率",
                    cache.map(|v| format!("{v}%")).unwrap_or_else(|| "—".into()),
                    "整个会话累计；缓存读取 /（输入 + 缓存读取）",
                    cache.is_some_and(|v| v > 0),
                    p,
                ))
                .child(context_stat(
                    "cost",
                    "费用",
                    format_cost(stats.cost),
                    if stats.cost.is_some() {
                        "整个会话累计，按 models.dev 价格估算"
                    } else {
                        "models.dev 没有这个模型的价格"
                    },
                    false,
                    p,
                ));
            card = card
                .child(div().w_full().h(px(1.0)).bg(p.c(Token::Border)))
                .child(rows);
        }
        card
    }

    /// 选择项目: the folder chip above a new conversation's composer, and its list.
    fn project_chip(&self, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let hover = p.c(Token::Muted);
        let label = match &self.draft_project {
            Some(path) => self.project_label(path),
            None => "选择项目".to_string(),
        };
        let projects: Vec<String> = self.projects.iter().map(|p| p.path.clone()).collect();
        let menu = self.project_menu.then(|| {
            let mut list = div()
                .absolute()
                .bottom(px(36.0))
                .left(px(0.0))
                .w(px(280.0))
                .p(px(4.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .bg(p.overlay())
                .text_color(p.c(Token::PopoverForeground))
                .shadow_lg()
                .flex()
                .flex_col()
                .text_size(px(TEXT_SM));
            if projects.is_empty() {
                list = list.child(
                    div()
                        .px(px(8.0))
                        .py(px(6.0))
                        .muted(p)
                        .child("没有匹配的项目"),
                );
            }
            for project in &projects {
                let chosen = Some(project.clone());
                let active = self.draft_project.as_ref() == Some(project);
                list = list.child(
                    div()
                        .id(SharedString::from(format!("pick-{project}")))
                        .h(px(32.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .rounded(px(8.0))
                        .cursor_pointer()
                        .when(active, |d| d.bg(p.c(Token::Accent)))
                        .hover(move |d| d.bg(hover))
                        .child(icon("folder01", 14.0, p.c(Token::MutedForeground)))
                        .child(crate::ui::truncate(self.project_label(project)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.draft_project = chosen.clone();
                            this.project_menu = false;
                            cx.notify();
                        })),
                );
            }
            list
        });
        div()
            .relative()
            .pl(px(4.0))
            .mb(px(10.0))
            .flex()
            .items_center()
            .child(
                div()
                    .id("project-chip")
                    .h(px(28.0))
                    .max_w(px(224.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .rounded_full()
                    .cursor_pointer()
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .hover(move |d| d.bg(hover))
                    .child(icon("folder01", 14.0, p.c(Token::MutedForeground)))
                    .child(crate::ui::truncate(label))
                    .child(icon("arrow-down01", 12.0, p.c(Token::MutedForeground)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.project_menu = !this.project_menu;
                        this.model_menu = false;
                        cx.notify();
                    })),
            )
            .children(menu.map(|menu| deferred(menu.occlude()).with_priority(10)))
    }
}

/// Each statistic keeps its scope available on hover, as the Electron StatRow does.
fn context_stat(
    id: &'static str,
    label: &'static str,
    value: String,
    hint: &'static str,
    success: bool,
    p: &crate::theme::Palette,
) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .items_baseline()
        .justify_between()
        .gap(px(12.0))
        .text_size(px(TEXT_XS))
        .tooltip(move |window, cx| Tooltip::new(hint).build(window, cx))
        .child(div().muted(p).child(label))
        .child(
            div()
                .font_weight(FontWeight::MEDIUM)
                .when(success, |d| d.text_color(p.c(Token::Success)))
                .child(SharedString::from(value)),
        )
}
