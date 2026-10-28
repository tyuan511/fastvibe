//! The composer, after `components/chat/composer.tsx`: a 22px-round card holding the text area,
//! and under it the attach button, the model and thinking chip, and send / stop.

use crate::ui::px;
use fv_protocol::types::{ThinkingLevel, UiLanguage};
use fv_theme::Token;
use gpui_kit::component::Sizable as _;
use gpui_kit::component::input::Textarea;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::model_menu::{
    group_holds_current, model_display_name, model_row, provider_groups, provider_row,
};
use super::transcript::{THREAD_MAX, THREAD_PAD};
use super::{Workspace, text};
use crate::context_stats::{cache_hit, format_cost, format_count, format_speed, token_pair};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon};

/// `text-[0.8rem]`: the chip's size.
const CHIP_TEXT: f32 = 12.8;

/// The label of a thinking level, in the interface language.
pub fn thinking_label_in(level: ThinkingLevel, english: bool) -> &'static str {
    match level {
        ThinkingLevel::Minimal => trs!(english, "composer.thinking_minimal"),
        ThinkingLevel::Low => trs!(english, "composer.thinking_low"),
        ThinkingLevel::Medium => trs!(english, "composer.thinking_medium"),
        ThinkingLevel::High => trs!(english, "composer.thinking_high"),
        ThinkingLevel::Xhigh => trs!(english, "composer.thinking_xhigh"),
        ThinkingLevel::Max => trs!(english, "composer.thinking_max"),
    }
}

impl Workspace {
    /// The `Tab` chip that leads the guessed placeholder.
    fn suggestion_hint(&self) -> Div {
        let p = &self.palette;
        div()
            .absolute()
            .left(px(16.0))
            .top(px(16.0))
            .px(px(4.0))
            .h(px(20.0))
            .flex()
            .items_center()
            .rounded(px(4.0))
            .bg(p.c(Token::Muted))
            .text_size(px(TEXT_XS))
            .font_weight(FontWeight::MEDIUM)
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
        let language = self.app_settings.language;
        let english = language == UiLanguage::English;
        // 回复推荐 rides in the placeholder: an empty composer shows what the user is likely to
        // say next, and Tab takes it. Written only when it changed — the text area is a child
        // entity, so setting it every frame would make every frame a change.
        let wanted_placeholder = self.compose_suggestion.clone().unwrap_or_else(|| {
            let running = self
                .selected
                .as_ref()
                .and_then(|id| self.views.get(id))
                .is_some_and(|v| v.running);
            if running {
                trs!(english, "composer.placeholder_queued").to_string()
            } else {
                text::placeholder(language).to_string()
            }
        });
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
        let history_live = {
            let value = self.input.read(cx).value().to_string();
            self.history_keys_live(&value)
        };
        let can_resume = self.can_resume();
        let label = self.current_model_label();
        let entry = label
            .as_deref()
            .and_then(|l| self.models.iter().find(|m| m.label == l));
        let model_text = match (entry, label.as_deref()) {
            (Some(m), _) => format!("{}/{}", m.provider_name, m.model.id),
            (None, Some(l)) => l.to_string(),
            (None, None) => text::no_model(language).to_string(),
        };
        let thinking_text = self
            .current_thinking()
            .map(|level| thinking_label_in(level, english))
            .unwrap_or(trs!(english, "composer.follow_default"));

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
        let resumes = can_resume && empty && !running;
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
            .when(!send_enabled && !resumes, |d| d.opacity(0.5))
            .cursor_pointer()
            .tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(if stops {
                    trs!(english, "composer.stop")
                } else if resumes {
                    trs!(english, "composer.resume")
                } else if running {
                    trs!(english, "composer.queue")
                } else {
                    trs!(english, "composer.send")
                })
                .build(window, cx)
            })
            .child(icon(
                if stops {
                    "square"
                } else if resumes {
                    "play"
                } else {
                    "arrow-up02"
                },
                16.0,
                p.c(Token::PrimaryForeground),
            ))
            .on_click(cx.listener(move |this, _, window, cx| {
                if stops {
                    this.interrupt(cx);
                } else if resumes {
                    this.resume_run(window, cx);
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
        let provider_menu = self
            .model_menu
            .then(|| self.model_submenu.clone())
            .flatten()
            .map(|id| self.provider_menu(&id, cx));
        // Only a conversation that does not exist yet can still choose where it runs.
        let project_row = self
            .selected
            .is_none()
            .then(|| self.project_chip(window, cx));
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
                .child(text::edit_hint(language))
                .child(div().flex_1())
                .child(
                    div()
                        .id("edit-cancel")
                        .px(px(6.0))
                        .rounded(px(4.0))
                        .cursor_pointer()
                        .hover(move |d| d.bg(hover))
                        .child(text::edit_cancel(language))
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

        let goal_strip = self.goal_tray(cx);
        let attachments = self.attachment_chips(cx);

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
            .children(self.subagent_tray(cx))
            .children(goal_strip)
            .children(queue)
            .children((!covered).then(|| {
                div()
                    .id("composer-card")
                    .relative()
                    .rounded(px(22.0))
                    .border_1()
                    // Dropping files on the card attaches them; the ring says it will.
                    .drag_over::<ExternalPaths>(|d, _, _, cx| {
                        d.border_color(gpui_kit::component::Theme::global(cx).ring)
                    })
                    .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                        this.attach_paths(paths.paths(), cx)
                    }))
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
                    .children(attachments)
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
                                // ↑ recalls the last prompt, Tab takes the guess.
                                "EmptyComposer HistoryComposer"
                            } else if history_live {
                                "FilledComposer HistoryComposer"
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
                                    .with_size(gpui_kit::component::Size::Size(
                                        gpui_kit::component::Theme::global(cx).font_size,
                                    )),
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
                            .child(
                                crate::ui::icon_button("attach", "attachment", p)
                                    .rounded_full()
                                    .tooltip(move |window, cx| {
                                        Tooltip::new(trs!(english, "composer.attach"))
                                            .build(window, cx)
                                    })
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.pick_attachments(cx)),
                                    ),
                            )
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
                    .children(provider_menu.map(|m| deferred(m.occlude()).with_priority(11)))
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
                    .child(text::no_model_hint(self.app_settings.language)),
            );
        }
        // One row per provider, its models a hover away in a flyout beside this card — the shape
        // Electron's dropdown has, and what keeps a dozen models off one scrolling column.
        let current = self.current_model_label();
        for group in provider_groups(&self.models) {
            let id = group.id.to_string();
            let clicked_id = id.clone();
            let holds_current = group_holds_current(&group, current.as_deref());
            let open = self.model_submenu.as_deref() == Some(group.id);
            list = list.child(
                provider_row(
                    SharedString::from(format!("model-provider-{id}")),
                    group.name,
                    holds_current,
                    open,
                    p,
                )
                .on_hover(cx.listener({
                    let id = id.clone();
                    move |this, hovered: &bool, _, cx| {
                        if *hovered
                            && (this.thinking_menu
                                || this.model_submenu.as_deref() != Some(id.as_str()))
                        {
                            this.thinking_menu = false;
                            this.model_submenu = Some(id.clone());
                            cx.notify();
                        }
                    }
                }))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.thinking_menu = false;
                    this.model_submenu =
                        if this.model_submenu.as_deref() == Some(clicked_id.as_str()) {
                            None
                        } else {
                            Some(clicked_id.clone())
                        };
                    cx.notify();
                })),
            );
        }
        list = list.child(div().my(px(4.0)).h(px(1.0)).bg(p.c(Token::Border)));

        let thinking_text = self
            .current_thinking()
            .map(|level| thinking_label_in(level, self.english()))
            .unwrap_or(trs!(self.english(), "composer.follow_default"));
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
                .child(if self.app_settings.language == UiLanguage::English {
                    "Thinking effort"
                } else {
                    "思考强度"
                })
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
                        this.model_submenu = None;
                        cx.notify();
                    }
                }))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.thinking_menu = !this.thinking_menu;
                    if this.thinking_menu {
                        this.model_submenu = None;
                    }
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
                .child(if self.app_settings.language == UiLanguage::English {
                    "Manage models"
                } else {
                    "管理模型"
                })
                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                    if *hovered && this.thinking_menu {
                        this.thinking_menu = false;
                        cx.notify();
                    }
                }))
                .on_click(cx.listener(|this, _, window, cx| {
                    this.model_menu = false;
                    this.thinking_menu = false;
                    this.model_submenu = None;
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

        let english = self.english();
        let options: [(Option<ThinkingLevel>, &'static str); 7] = [
            (None, trs!(english, "composer.follow_default")),
            (
                Some(ThinkingLevel::Minimal),
                thinking_label_in(ThinkingLevel::Minimal, english),
            ),
            (
                Some(ThinkingLevel::Low),
                thinking_label_in(ThinkingLevel::Low, english),
            ),
            (
                Some(ThinkingLevel::Medium),
                thinking_label_in(ThinkingLevel::Medium, english),
            ),
            (
                Some(ThinkingLevel::High),
                thinking_label_in(ThinkingLevel::High, english),
            ),
            (
                Some(ThinkingLevel::Xhigh),
                thinking_label_in(ThinkingLevel::Xhigh, english),
            ),
            (
                Some(ThinkingLevel::Max),
                thinking_label_in(ThinkingLevel::Max, english),
            ),
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

    /// The models of the provider whose row is open, standing beside the menu that named it. A
    /// sibling float for the same reason the effort flyout is one: the card clips what sticks out.
    fn provider_menu(&self, provider_id: &str, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = &self.palette;
        let current = self.current_model_label();
        let mut list = div()
            .id("composer-model-submenu")
            .max_h(px(440.0))
            .overflow_y_scroll()
            .absolute()
            .bottom(px(44.0))
            .right(px(296.0))
            .w(px(208.0))
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
        for m in self.models.iter().filter(|m| m.provider_id == provider_id) {
            let label = m.label.clone();
            let selected = Some(label.as_str()) == current.as_deref();
            list = list.child(
                model_row(
                    SharedString::from(format!("ms-{label}")),
                    model_display_name(m),
                    selected,
                    p,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.pick_model(label.clone(), cx);
                })),
            );
        }
        list
    }

    fn context_menu_view(&self, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
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
                    trs!(english, "composer.cannot_compact_while_the_chat")
                } else {
                    trs!(english, "composer.compact_context")
                })
                .build(window, cx)
            })
            .child(icon("scissor", 14.0, p.c(Token::Foreground)))
            .child(trs!(english, "composer.compact_context"))
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
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(trs!(english, "composer.context_window")),
                            )
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
                            .child(SharedString::from(tr!(
                                english,
                                "composer.used",
                                count = format_count(usage.map(|u| u.used))
                            )))
                            .child(SharedString::from(tr!(
                                english,
                                "composer.remaining",
                                remaining = format_count(remaining),
                                window = format_count(usage.map(|u| u.window))
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
                    trs!(english, "composer.turn_tokens"),
                    token_pair(stats.turn.as_ref()),
                    trs!(english, "composer.turn_scope"),
                    false,
                    p,
                ))
                .child(context_stat(
                    "session-tokens",
                    trs!(english, "composer.session_tokens"),
                    token_pair(Some(&stats.tokens)),
                    trs!(english, "composer.session_scope"),
                    false,
                    p,
                ))
                .child(context_stat(
                    "output-speed",
                    trs!(english, "composer.output_speed"),
                    format_speed(stats.last_request.as_ref()),
                    trs!(english, "composer.request_speed_scope"),
                    false,
                    p,
                ))
                .child(context_stat(
                    "steps",
                    trs!(english, "composer.steps"),
                    stats.steps.to_string(),
                    trs!(english, "composer.session_scope"),
                    false,
                    p,
                ))
                .child(context_stat(
                    "cache-hit",
                    trs!(english, "composer.cache_hit"),
                    cache.map(|v| format!("{v}%")).unwrap_or_else(|| "—".into()),
                    trs!(english, "composer.cache_scope"),
                    cache.is_some_and(|v| v > 0),
                    p,
                ))
                .child(context_stat(
                    "cost",
                    trs!(english, "composer.cost"),
                    format_cost(stats.cost),
                    if stats.cost.is_some() {
                        trs!(english, "composer.cost_scope")
                    } else {
                        trs!(english, "composer.cost_unknown")
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
    fn project_chip(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let hover = p.c(Token::Muted);
        let label = match &self.draft_project {
            Some(path) => self.project_label(path),
            None => trs!(english, "composer.choose_project").to_string(),
        };
        let query = self.project_search.read(cx).value().trim().to_lowercase();
        let projects: Vec<String> = self
            .projects
            .iter()
            .filter(|p| {
                query.is_empty()
                    || format!("{} {}", self.project_label(&p.path), p.path)
                        .to_lowercase()
                        .contains(&query)
            })
            .map(|p| p.path.clone())
            .collect();
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
            list = list.child(
                div()
                    .px(px(2.0))
                    .pt(px(2.0))
                    .pb(px(4.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(div().pl(px(6.0)).child(icon(
                        "search01",
                        14.0,
                        p.c(Token::MutedForeground),
                    )))
                    .child(
                        div().flex_1().child(
                            gpui_kit::component::input::Input::new(&self.project_search)
                                .appearance(false)
                                .bordered(false),
                        ),
                    ),
            );
            if projects.is_empty() {
                list = list.child(
                    div()
                        .px(px(8.0))
                        .py(px(6.0))
                        .muted(p)
                        .child(trs!(english, "composer.no_matching_projects")),
                );
            }
            if self.draft_project.is_some() {
                list = list.child(
                    div()
                        .id("project-clear")
                        .h(px(32.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .rounded(px(8.0))
                        .cursor_pointer()
                        .muted(p)
                        .hover(move |d| d.bg(hover))
                        .child(icon("cancel01", 14.0, p.c(Token::MutedForeground)))
                        .child(trs!(english, "composer.clear_project"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.draft_project = None;
                            this.project_menu = false;
                            cx.notify();
                        })),
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
            list = list.child(div().my(px(4.0)).h(px(1.0)).bg(p.c(Token::Border)));
            list = list.child(
                div()
                    .id("project-new")
                    .h(px(32.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .muted(p)
                    .hover(move |d| d.bg(hover))
                    .child(icon("add01", 14.0, p.c(Token::MutedForeground)))
                    .child(trs!(english, "composer.new_project"))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.project_menu = false;
                        this.open_project_dialog(None, window, cx);
                    })),
            );
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
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.project_menu = !this.project_menu;
                        this.model_menu = false;
                        this.model_submenu = None;
                        // A fresh list each time, with the keyboard already in its filter.
                        this.project_search
                            .update(cx, |state, cx| state.set_value("", window, cx));
                        if this.project_menu {
                            this.project_search
                                .update(cx, |state, cx| state.focus(window, cx));
                        }
                        cx.notify();
                    })),
            )
            .children(self.header_git_chip(window, cx))
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

/// A pasted text longer than this becomes an attachment instead of filling the box
/// (`PASTED_TEXT_ATTACHMENT_THRESHOLD`).
const PASTED_TEXT_ATTACHMENT_THRESHOLD: usize = 500;

/// How many characters of a long paste name its chip (`pastedTextAttachmentName`).
const PASTED_TEXT_NAME_LENGTH: usize = 32;

/// The first characters of a paste on one line, with an ellipsis when it was cut.
fn pasted_text_name(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = flat.chars().collect();
    let head: String = chars.iter().take(PASTED_TEXT_NAME_LENGTH).collect();
    if chars.len() > PASTED_TEXT_NAME_LENGTH {
        format!("{head}…")
    } else {
        head
    }
}

/// Where pasted text and images are written so the model can open them by path.
fn paste_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("fastvibe-attachments");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn paste_stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

impl Workspace {
    /// The prompts of this conversation, oldest first: what ↑ walks back through.
    fn past_prompts(&self) -> Vec<String> {
        let Some(view) = self.selected.as_ref().and_then(|id| self.views.get(id)) else {
            return Vec::new();
        };
        view.turns
            .iter()
            .flat_map(|turn| turn.items.iter())
            .filter_map(|item| match item {
                fv_protocol::types::Item::UserMessage { text, .. } if !text.trim().is_empty() => {
                    // The reference block is how the files travelled, not what was typed.
                    Some(
                        text.split("\n\n<fastvibe-attachments>")
                            .next()
                            .unwrap_or(text)
                            .to_string(),
                    )
                }
                _ => None,
            })
            .collect()
    }

    /// Whether ↑/↓ belong to history right now: an empty box, or the very prompt that was
    /// recalled, and on its first line (a multi-line recall keeps its arrows for the caret).
    pub(super) fn history_keys_live(&self, value: &str) -> bool {
        if value.contains('\n') {
            return false;
        }
        value.is_empty()
            || self
                .history
                .as_ref()
                .is_some_and(|(_, shown, _)| shown == value)
    }

    fn show_history(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |state, cx| {
            state.set_value(crate::skill_draft::content(text), window, cx)
        });
    }

    pub(super) fn on_history_prev(
        &mut self,
        _: &super::HistoryPrev,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let past = self.past_prompts();
        if past.is_empty() {
            return;
        }
        let value = self.input.read(cx).value().to_string();
        let (index, draft) = match &self.history {
            Some((i, shown, draft)) if *shown == value => {
                if *i == 0 {
                    return;
                }
                (*i - 1, draft.clone())
            }
            _ => (past.len() - 1, value),
        };
        let text = past[index.min(past.len() - 1)].clone();
        self.history = Some((index, text.clone(), draft));
        self.show_history(text, window, cx);
    }

    pub(super) fn on_history_next(
        &mut self,
        _: &super::HistoryNext,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let value = self.input.read(cx).value().to_string();
        let Some((index, shown, draft)) = self.history.clone() else {
            return;
        };
        if shown != value {
            self.history = None;
            return;
        }
        let past = self.past_prompts();
        if index + 1 < past.len() {
            let text = past[index + 1].clone();
            self.history = Some((index + 1, text.clone(), draft));
            self.show_history(text, window, cx);
        } else {
            self.history = None;
            self.show_history(draft, window, cx);
        }
    }

    /// 继续: the last turn stopped before an answer, so say so and let it carry on.
    pub(super) fn can_resume(&self) -> bool {
        use fv_protocol::types::Item;
        let Some(view) = self.selected.as_ref().and_then(|id| self.views.get(id)) else {
            return false;
        };
        if view.running || !view.queue.items.is_empty() || !view.questions.is_empty() {
            return false;
        }
        matches!(
            view.turns.last().and_then(|t| t.items.last()),
            Some(
                Item::UserMessage { .. }
                    | Item::ToolCall { .. }
                    | Item::Reasoning { .. }
                    | Item::Error { .. }
            )
        )
    }

    pub(super) fn resume_run(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_resume() {
            return;
        }
        let prompt = trs!(self.english(), "composer.resume_prompt");
        self.input
            .update(cx, |state, cx| state.set_value(prompt, window, cx));
        self.send(window, cx);
    }

    /// ⌘V in the composer: files, images and long text are attached; ordinary text falls
    /// through to the text area.
    pub(super) fn on_paste_capture(
        &mut self,
        _: &gpui_kit::component::input::Paste,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.input.read(cx).focus_handle(cx).is_focused(window) {
            return;
        }
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        let mut attached = false;
        let mut paths = Vec::new();
        for entry in item.entries() {
            match entry {
                ClipboardEntry::Image(image) => {
                    let ext = match image.format {
                        ImageFormat::Jpeg => "jpg",
                        ImageFormat::Webp => "webp",
                        ImageFormat::Gif => "gif",
                        _ => "png",
                    };
                    let path = paste_dir().join(format!("pasted-image-{}.{ext}", paste_stamp()));
                    if std::fs::write(&path, &image.bytes).is_ok() {
                        paths.push(path);
                    }
                }
                ClipboardEntry::ExternalPaths(files) => {
                    paths.extend(files.paths().iter().cloned());
                }
                ClipboardEntry::String(string) => {
                    let text = string.text();
                    // Files copied in the Finder arrive as their paths, one per line.
                    let listed: Vec<std::path::PathBuf> = text
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .map(|l| std::path::PathBuf::from(l.trim()))
                        .collect();
                    if !listed.is_empty() && listed.iter().all(|p| p.is_absolute() && p.is_file()) {
                        paths.extend(listed);
                    } else if text.chars().count() > PASTED_TEXT_ATTACHMENT_THRESHOLD {
                        let name = pasted_text_name(text);
                        let path = paste_dir().join(format!("pasted-text-{}.txt", paste_stamp()));
                        if std::fs::write(&path, text).is_ok() {
                            self.attached_files.push(fv_protocol::types::FileHit {
                                relative: name,
                                path: path.display().to_string(),
                            });
                            attached = true;
                        }
                    }
                }
            }
        }
        if !paths.is_empty() {
            self.attach_paths(&paths, cx);
            attached = true;
        }
        if attached {
            cx.stop_propagation();
            cx.notify();
        }
    }
}
