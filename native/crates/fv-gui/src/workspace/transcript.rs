//! The conversation column, after `App.tsx`'s header, `message-list.tsx` and `message-row.tsx`.

use std::collections::HashMap;

use crate::terminal_transcript;
use crate::ui::px;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{Status, Workspace, text};
use crate::presentation::{self, FileChange, TurnLayout};
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon, icon_button, shimmer, spinner};
use crate::view_model::ThreadView;

/// The reading column: `max-w-3xl` with `px-6`, so 720px of content.
pub const THREAD_MAX: f32 = 768.0;
pub const THREAD_PAD: f32 = 24.0;
/// A reply's own cap, `max-w-2xl`.
const REPLY_MAX: f32 = 672.0;

fn projected_items<'a>(turn: &'a Turn, terminals: &'a HashMap<String, Item>) -> Vec<&'a Item> {
    turn.items
        .iter()
        .map(|item| match item {
            Item::ToolCall { id, .. } => terminals.get(id).unwrap_or(item),
            _ => item,
        })
        .filter(|item| !terminal_transcript::hidden(item))
        .collect()
}

impl Workspace {
    pub(super) fn main(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let empty = self.selected.is_none() && matches!(self.status, Status::Ready);
        let resources = self.resources_elements(window, cx);
        div()
            .relative()
            .flex_1()
            .min_w_0()
            .h_full()
            .pt(px(8.0))
            .overflow_hidden()
            .flex()
            .flex_col()
            .child(self.header(window, cx))
            .map(|d| {
                if empty {
                    d.child(self.hero(window, cx))
                } else {
                    d.child(self.transcript(cx))
                        .child(self.composer(window, cx))
                }
            })
            .children(resources)
    }

    fn header(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let language = self.app_settings.language;
        let thread = self
            .selected
            .as_ref()
            .and_then(|id| self.threads.iter().find(|t| &t.id == id));
        let mut left = div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(4.0))
            .text_size(px(TEXT_SM))
            .line_height(px(20.0));
        if let Some(t) = thread {
            if let Some(project) = &t.project {
                let name = self.project_label(project);
                left = left
                    .child(ui::truncate(name).max_w(px(128.0)).flex_none().muted(p))
                    .child(div().flex_none().muted(p).child("/"));
            }
            let title = if t.title.trim().is_empty() {
                text::untitled(language).to_string()
            } else {
                t.title.clone()
            };
            left = left.child(
                ui::truncate(title)
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.c(Token::Foreground)),
            );
            left = left.children(self.header_git_chip(window, cx));
        }
        let english = language == UiLanguage::English;
        let viewport = f32::from(window.viewport_size().width);
        let sidebar_closed = self.app_settings.sidebar.collapsed;
        let open_fraction = (self.sidebar_motion.width
            / self.sidebar_resting_width(f32::from(window.viewport_size().width)))
        .clamp(0.0, 1.0);
        let left_inset = if cfg!(target_os = "macos") {
            96.0 - 80.0 * open_fraction
        } else {
            16.0
        };
        let sidebar_chrome = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(2.0))
            .child(
                icon_button("expand-sidebar", "panel-left-open", p)
                    .aria_label(trs!(english, "header.expand_sidebar"))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.on_toggle_sidebar(&super::ToggleSidebar, window, cx)
                    })),
            )
            .child(
                icon_button("header-new-chat", "message-square-plus", p)
                    .aria_label(trs!(english, "header.new_chat"))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.on_new_chat(&super::NewChat, window, cx)
                    })),
            )
            .child(
                icon_button("header-back", "arrow-left01", p)
                    .opacity(if self.navigation.can_back() {
                        1.0
                    } else {
                        0.35
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.navigate(false, cx))),
            )
            .child(
                icon_button("header-forward", "arrow-right01", p)
                    .opacity(if self.navigation.can_forward() {
                        1.0
                    } else {
                        0.35
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.navigate(true, cx))),
            );
        div()
            .h(px(44.0))
            .flex_none()
            .pl(px(left_inset))
            .pr(px(8.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .children(sidebar_closed.then_some(sidebar_chrome))
            .child(left)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(
                        icon_button("resources", "ai-expand", p)
                            .aria_label(trs!(english, "resources.title"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.toggle_resources(viewport, cx);
                            })),
                    )
                    .when(self.side_pane_collapsed, |d| {
                        d.child(
                            icon_button("expand-side-pane", "panel-right-open", p)
                                .aria_label(trs!(english, "header.expand_side_pane"))
                                .on_click(cx.listener(|this, _, _, cx| this.toggle_side_pane(cx))),
                        )
                    }),
            )
    }

    /// A new conversation: the greeting above the composer, the composer a little above centre.
    fn hero(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let language = self.app_settings.language;
        let hour = local_hour();
        let greeting = if language == UiLanguage::English {
            match hour {
                5..=10 => "Good morning",
                11..=12 => "Good afternoon",
                13..=17 => "Good afternoon",
                18..=22 => "Good evening",
                _ => "Good night",
            }
        } else {
            match hour {
                5..=10 => "早上好呀，新的一天开始啦",
                11..=12 => "中午好呀，记得好好吃饭",
                13..=17 => "下午好呀，继续加油",
                18..=22 => "晚上好呀，今天辛苦啦",
                _ => "夜深啦，早点休息呀",
            }
        };
        div()
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .child(
                div()
                    .flex_grow(2.0)
                    .flex_basis(px(0.0))
                    .w_full()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_end()
                    .gap(px(16.0))
                    .pb(px(24.0))
                    .child(img("app-icon.png").size(px(48.0)).rounded(px(12.0)))
                    .child(
                        div()
                            .text_size(px(24.0))
                            .line_height(px(32.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(greeting),
                    ),
            )
            .child(self.composer(window, cx))
            .child(
                div()
                    .flex_grow(3.0)
                    .flex_basis(px(0.0))
                    .min_h_0()
                    .w_full()
                    .flex()
                    .flex_col()
                    .items_center()
                    .pt(px(4.0))
                    .child(self.new_session_footer(cx)),
            )
    }

    /// `NewSessionFooter`: the way back into recent work, then the composer's shortcuts.
    fn new_session_footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let english = self.english();
        let p = &self.palette;
        let language = self.app_settings.language;
        let project = self.draft_project.clone();
        let mut recent: Vec<&Thread> = self
            .threads
            .iter()
            .filter(|t| !t.archived && t.project == project)
            .collect();
        recent.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
        recent.truncate(4);
        let now = now_ms();
        let heading = match &project {
            Some(path) if language == UiLanguage::English => {
                format!("Recent chats in {}", self.project_label(path))
            }
            Some(path) => format!("{} 中的最近对话", self.project_label(path)),
            None if language == UiLanguage::English => "Recent chats".to_string(),
            None => "最近对话".to_string(),
        };
        let hover = p.c(Token::Muted);
        let mut list = div().flex().flex_col();
        for t in &recent {
            let id = t.id.clone();
            let group = SharedString::from(format!("recent-{}", t.id));
            list = list.child(
                div()
                    .id(SharedString::from(format!("recent-row-{}", t.id)))
                    .group(group.clone())
                    .px(px(12.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .rounded(px(10.0))
                    .cursor_pointer()
                    .text_size(px(TEXT_SM))
                    .line_height(px(20.0))
                    .hover(move |d| d.bg(hover))
                    .child(ui::truncate(t.title.clone()).flex_1())
                    .child(div().flex_none().text_size(px(TEXT_XS)).muted(p).child(
                        SharedString::from(relative_time(t.updated_at, now, english)),
                    ))
                    .child(
                        div()
                            .invisible()
                            .group_hover(group, |s| s.visible())
                            .child(icon("arrow-right01", 14.0, p.c(Token::MutedForeground))),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx))),
            );
        }
        let kbd = |key: &'static str| {
            div()
                .h(px(20.0))
                .min_w(px(20.0))
                .px(px(4.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.0))
                .bg(p.c(Token::Muted))
                .font_weight(FontWeight::MEDIUM)
                .child(key)
        };
        let hint = |key: &'static str, label: &'static str| {
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(kbd(key))
                .child(label)
        };
        div()
            .w_full()
            .max_w(px(THREAD_MAX))
            .px(px(THREAD_PAD))
            .flex()
            .flex_col()
            .gap(px(20.0))
            .when(!recent.is_empty(), |d| {
                d.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            div()
                                .px(px(12.0))
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(icon("clock01", 14.0, p.c(Token::MutedForeground)))
                                .child(ui::truncate(heading)),
                        )
                        .child(list),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_center()
                    .gap_x(px(16.0))
                    .gap_y(px(8.0))
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(hint(
                        "/",
                        if language == UiLanguage::English {
                            "Skills and commands"
                        } else {
                            "技能与命令"
                        },
                    ))
                    .when(project.is_some(), |d| {
                        d.child(hint(
                            "@",
                            if language == UiLanguage::English {
                                "Reference files"
                            } else {
                                "引用文件"
                            },
                        ))
                    })
                    .child(hint(
                        "⌘K",
                        if language == UiLanguage::English {
                            "Search chats"
                        } else {
                            "搜索对话"
                        },
                    )),
            )
    }

    fn transcript(&self, cx: &mut Context<Self>) -> impl IntoElement {
        self.transcript_scroll.prepare();
        let p = &self.palette;
        let language = self.app_settings.language;
        let view = self.selected.as_ref().and_then(|id| self.views.get(id));
        let mut body = div()
            .w_full()
            .max_w(px(THREAD_MAX))
            .mx_auto()
            .px(px(THREAD_PAD))
            .pt(px(8.0))
            .pb(px(64.0))
            .flex()
            .flex_col()
            .gap(px(28.0));
        match (&self.status, view) {
            (Status::Failed(m), _) => {
                body = body.child(
                    div()
                        .text_color(p.c(Token::Destructive))
                        .child(SharedString::from(m.clone())),
                )
            }
            (Status::Connecting, _) => {
                body = body.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .muted(p)
                        .child(spinner(
                            "connecting-spinner",
                            14.0,
                            p.c(Token::MutedForeground),
                        ))
                        .child(text::connecting(language)),
                )
            }
            (Status::Ready, None) => {}
            (Status::Ready, Some(view)) => {
                let terminals = terminal_transcript::project(&view.turns, self.english());
                let last = view.turns.len().saturating_sub(1);
                let target_turn = self
                    .jump_turn
                    .as_ref()
                    .filter(|(id, _)| Some(id) == self.selected.as_ref())
                    .and_then(|(_, turn)| view.turns.iter().position(|t| &t.id == turn))
                    .or_else(|| {
                        self.search_target
                            .as_ref()
                            .filter(|(id, _)| Some(id) == self.selected.as_ref())
                            .and_then(|(_, query)| {
                                view.turns
                                    .iter()
                                    .position(|t| super::palette::turn_matches(t, query))
                            })
                    });
                for (i, turn) in view.turns.iter().enumerate() {
                    let running = view.running && i == last;
                    let row = self.turn(&view.thread.id, turn, &terminals, running, cx);
                    if target_turn == Some(i) {
                        body = body.child(
                            div()
                                .id("search-target-turn")
                                .flex()
                                .flex_col()
                                .gap(px(28.0))
                                .anchor_scroll(Some(self.search_anchor.clone()))
                                .child(row),
                        );
                    } else {
                        body = body.child(row);
                    }
                }
            }
        }
        div()
            .id("transcript")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.transcript_scroll.handle)
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.capture_transcript_selection(window, cx);
                }),
            )
            .on_click(cx.listener(|this, _, window, cx| {
                // A plain click should dismiss a prior selection. Drag selection is captured
                // from mouse-up; GPUI does not emit a click for the completed drag.
                this.clear_transcript_selection(window, cx);
            }))
            .child(body)
            .child(self.transcript_scroll.recorder())
            .children(self.transcript_selection_actions(cx))
    }

    /// The same server-backed transcript used by the main column, rendered inside an auxiliary
    /// pane without changing the selected parent conversation.
    pub(super) fn side_chat_transcript(
        &self,
        thread_id: &str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = &self.palette;
        let language = self.app_settings.language;
        let view = self.views.get(thread_id);
        let mut body = div()
            .w_full()
            .max_w(px(THREAD_MAX))
            .mx_auto()
            .px(px(16.0))
            .pt(px(8.0))
            .pb(px(24.0))
            .flex()
            .flex_col()
            .gap(px(24.0));
        match view {
            None => {
                body = body.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .muted(p)
                        .child(spinner(
                            "pane-chat-loading",
                            14.0,
                            p.c(Token::MutedForeground),
                        ))
                        .child(text::connecting(language)),
                )
            }
            Some(view) => {
                let terminals = terminal_transcript::project(&view.turns, self.english());
                let last = view.turns.len().saturating_sub(1);
                for (index, turn) in view.turns.iter().enumerate() {
                    body = body.child(self.turn(
                        thread_id,
                        turn,
                        &terminals,
                        view.running && index == last,
                        cx,
                    ));
                }
            }
        }
        div()
            .id("pane-chat-transcript")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(body)
    }

    fn transcript_selection_actions(&self, cx: &mut Context<Self>) -> Option<Div> {
        let text = self.transcript_selection.clone()?;
        let p = &self.palette;
        let copy_text = text.clone();
        let add_text = text.clone();
        let ask_text = text.clone();
        let copy = action_button(
            "selection-copy",
            "copy01",
            if self.english() { "Copy" } else { "复制" },
            p,
        )
        .on_click(cx.listener(move |this, _, window, cx| {
            this.copy_text(copy_text.clone(), cx);
            this.clear_transcript_selection(window, cx);
        }));
        let add = action_button(
            "selection-add",
            "add01",
            if self.english() {
                "Add to conversation"
            } else {
                "添加到对话"
            },
            p,
        )
        .on_click(cx.listener(move |this, _, window, cx| {
            this.add_selection_to_composer(add_text.clone(), window, cx);
        }));
        let ask = action_button(
            "selection-ask-side",
            "message-square",
            if self.english() {
                "Ask in side chat"
            } else {
                "询问侧边聊天"
            },
            p,
        )
        .on_click(cx.listener(move |this, _, window, cx| {
            this.ask_selection_in_side_chat(ask_text.clone(), window, cx);
        }));
        Some(
            super::settings::popover(p)
                .absolute()
                .right(px(16.0))
                .bottom(px(16.0))
                .flex()
                .items_center()
                .gap(px(4.0))
                .children([
                    copy.into_any_element(),
                    add.into_any_element(),
                    ask.into_any_element(),
                ]),
        )
    }

    /// One turn, as one box: the gap inside is the gap between its rows.
    fn turn(
        &self,
        thread_id: &str,
        turn: &Turn,
        terminals: &HashMap<String, Item>,
        running: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Compaction remains a transcript-level rule. Only terminal calls are replaced;
        // prose and large media payloads stay borrowed from the original turn.
        let (compactions, items): (Vec<&Item>, Vec<&Item>) = projected_items(turn, terminals)
            .into_iter()
            .partition(|i| matches!(i, Item::ContextCompaction { .. }));
        let layout = presentation::layout_refs(
            &items,
            running || items.iter().any(|i| terminal_transcript::active(i)),
        );
        let mut wrapper = div().flex().flex_col().gap(px(28.0));
        if let Some(user) = layout.user {
            wrapper = wrapper.child(self.user_row(thread_id, &turn.id, user, turn.started_at, cx));
        }
        for c in compactions {
            wrapper = wrapper.child(self.compaction(c, running && layout.answer.is_empty()));
        }
        if !layout.process.is_empty() || !layout.answer.is_empty() || running {
            wrapper = wrapper.child(self.reply(thread_id, turn, &layout, running, cx));
        }
        wrapper.into_any_element()
    }

    fn user_row(
        &self,
        thread_id: &str,
        turn_id: &str,
        item: &Item,
        at: Option<i64>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let Item::UserMessage { id, text } = item else {
            return div().into_any_element();
        };
        // Edit puts the words back in the composer: correcting a prompt is a rewrite of that
        // turn, and sending it again would only add a second one after the reply it corrects.
        let edit_text = text.clone();
        let edit_turn = turn_id.to_string();
        let edit_thread = thread_id.to_string();
        let edit = action_button(
            SharedString::from(format!("edit-{id}")),
            "pencil-edit02",
            trs!(self.english(), "transcript.edit"),
            p,
        )
        .on_click(cx.listener(move |this, _, window, cx| {
            if this.selected.as_deref() != Some(edit_thread.as_str()) {
                this.select(edit_thread.clone(), cx);
            }
            this.start_edit(edit_turn.clone(), edit_text.clone(), window, cx);
        }));
        let copy_text = text.clone();
        let copy = action_button(
            SharedString::from(format!("copy-{id}")),
            "copy01",
            trs!(self.english(), "transcript.copy"),
            p,
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            this.copy_text(copy_text.clone(), cx);
        }));
        let group = SharedString::from(format!("row-{id}"));
        let skill = crate::skill_draft::invocation(text);
        let body = fv_core::strip_attachment_block(skill.as_ref().map(|s| s.text).unwrap_or(text));
        let files: Vec<_> = fv_core::attachment_paths(text)
            .into_iter()
            .filter_map(|path| self.transcript_path(thread_id, &path))
            .collect();
        div()
            .group(group.clone())
            .w_full()
            .flex()
            .flex_col()
            .items_end()
            .gap(px(11.0))
            .children(self.attachment_row(&files, id, cx))
            .children(
                skill
                    .as_ref()
                    .map(|s| super::skill_picker::badge(s.name, p)),
            )
            .when(!body.is_empty(), |d| {
                d.child(
                    div()
                        .max_w(relative(0.85))
                        .px(px(13.0))
                        .py(px(9.0))
                        .rounded(px(14.0))
                        .bg(p.c(Token::Muted))
                        .text_size(px(TEXT_SM))
                        .line_height(px(24.0))
                        .child(SharedString::from(body.to_string())),
                )
            })
            .child(actions(
                &group,
                at.map(|t| (clock(t), None)),
                vec![copy.into_any_element(), edit.into_any_element()],
                p,
            ))
            .into_any_element()
    }

    fn compaction(&self, item: &Item, live: bool) -> AnyElement {
        let p = &self.palette;
        let language = self.app_settings.language;
        let Item::ContextCompaction {
            reason,
            tokens_before,
            tokens_after,
            ..
        } = item
        else {
            return div().into_any_element();
        };
        // `CompactNotice`: the reason and the request size it moved, after the label.
        let english = language == UiLanguage::English;
        let reason = match reason.as_deref() {
            Some("threshold") => Some(trs!(english, "text.compact_threshold").to_string()),
            Some("overflow") => Some(trs!(english, "text.compact_overflow").to_string()),
            _ => None,
        };
        let tokens = match (tokens_before, tokens_after) {
            (Some(b), Some(a)) => Some(format!("{} → {}", compact_count(*b), compact_count(*a))),
            (Some(b), None) => Some(compact_count(*b)),
            _ => None,
        };
        let detail = [reason, tokens]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
        let label: AnyElement = if live {
            shimmer("compaction-live", text::compacting(language))
                .text_color(p.c(Token::Foreground))
                .into_any_element()
        } else {
            div()
                .flex_none()
                .text_color(p.c(Token::MutedForeground).opacity(0.6))
                .child(text::compacted(language))
                .into_any_element()
        };
        div()
            .w_full()
            .flex()
            .items_center()
            .gap(px(12.0))
            .text_size(px(TEXT_XS))
            .line_height(px(16.0))
            .child(ui::rule(p))
            .child(div().flex().items_center().gap(px(6.0)).child(label).when(
                !live && !detail.is_empty(),
                |d| {
                    d.child(
                        div()
                            .text_color(p.c(Token::MutedForeground).opacity(0.4))
                            .child("·"),
                    )
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(p.c(Token::MutedForeground).opacity(0.8))
                            .child(SharedString::from(detail)),
                    )
                },
            ))
            .child(ui::rule(p))
            .into_any_element()
    }

    fn reply(
        &self,
        thread_id: &str,
        turn: &Turn,
        layout: &TurnLayout<'_>,
        running: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let language = self.app_settings.language;
        let turn_id = turn.id.as_str();
        let group = SharedString::from(format!("row-reply-{turn_id}"));
        let mut col = div()
            .group(group.clone())
            .w_full()
            .flex()
            .flex_col()
            .items_start()
            .gap(px(10.0));
        if running {
            let start = turn.started_at.unwrap_or_else(now_ms);
            let elapsed = (now_ms() - start).max(1000) as u64;
            let progress = div().w_full().max_w(px(REPLY_MAX)).flex().flex_col().child(
                div()
                    .pt(px(8.0))
                    .pb(px(8.0))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .line_height(px(20.0))
                            .muted(p)
                            .child(if language == UiLanguage::English {
                                format!(
                                    "Processed {}",
                                    presentation::format_duration(
                                        elapsed,
                                        language == UiLanguage::English
                                    )
                                )
                            } else {
                                format!(
                                    "已处理 {}",
                                    presentation::format_duration(
                                        elapsed,
                                        language == UiLanguage::English
                                    )
                                )
                            }),
                    ),
            );
            col = col.child(progress);
        } else if layout.folded {
            let open = self.open_folds.contains(turn_id);
            let key = turn_id.to_string();
            // 用时: the work the fold hides, up to where the answer began.
            let label = match (turn.started_at, turn.process_ended_at.or(turn.completed_at)) {
                (Some(a), Some(b)) if b >= a => {
                    if language == UiLanguage::English {
                        format!(
                            "Took {}",
                            presentation::format_duration(
                                (b - a) as u64,
                                language == UiLanguage::English
                            )
                        )
                    } else {
                        format!(
                            "用时 {}",
                            presentation::format_duration(
                                (b - a) as u64,
                                language == UiLanguage::English
                            )
                        )
                    }
                }
                _ => text::processed(language).to_string(),
            };
            let mut fold = div().w_full().max_w(px(REPLY_MAX)).flex().flex_col().child(
                div()
                    .pt(px(8.0))
                    .pb(px(8.0))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .child(
                        div()
                            .id(SharedString::from(format!("fold-{turn_id}")))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .cursor_pointer()
                            .text_size(px(TEXT_SM))
                            .line_height(px(20.0))
                            .muted(p)
                            .child(SharedString::from(label))
                            .child(ui::chevron(
                                open,
                                14.0,
                                p.c(Token::MutedForeground).opacity(0.6),
                            ))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.open_folds.remove(&key) {
                                    this.open_folds.insert(key.clone());
                                }
                                cx.notify();
                            })),
                    ),
            );
            if open {
                let mut inner = div().pt(px(12.0)).flex().flex_col().gap(px(10.0));
                inner = inner.children(self.parts(thread_id, &layout.process, false, cx));
                fold = fold.child(inner);
            }
            col = col.child(fold);
        }
        col = col.children(self.parts(thread_id, &layout.answer, running, cx));
        let live_tail = layout
            .answer
            .iter()
            .any(|i| matches!(i, Item::ToolCall { output: None, .. }))
            || layout
                .answer
                .last()
                .is_some_and(|i| matches!(i, Item::AgentMessage { .. } | Item::Reasoning { .. }));
        if running && !live_tail {
            col = col.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_SM))
                    .line_height(px(20.0))
                    .child(spinner(
                        SharedString::from(format!("working-spin-{}", turn.id)),
                        16.0,
                        p.c(Token::MutedForeground),
                    ))
                    .child(
                        shimmer(
                            SharedString::from(format!("working-text-{}", turn.id)),
                            text::working(language),
                        )
                        .text_color(p.c(Token::Foreground)),
                    ),
            );
        }
        if !running && !layout.changes.is_empty() {
            col = col.child(
                self.changes_card(thread_id, turn_id, &layout.changes, cx)
                    .mt(px(4.0)),
            );
        }
        if !running {
            // 用时: the whole turn, from the user's message to the last entry (Electron's
            // `message.elapsed`, which English renders as the bare duration).
            let stamp = turn.completed_at.map(|end| {
                let took = turn.started_at.filter(|s| end >= *s).map(|s| {
                    let english = language == UiLanguage::English;
                    let span = presentation::format_duration((end - s) as u64, english);
                    if english {
                        span
                    } else {
                        format!("用时 {span}")
                    }
                });
                (clock(end), took)
            });
            // The answer as text, without the process the fold hides.
            let answer: String = layout
                .answer
                .iter()
                .filter_map(|i| match i {
                    Item::AgentMessage { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let copy = action_button(
                SharedString::from(format!("copy-reply-{turn_id}")),
                "copy01",
                if language == UiLanguage::English {
                    "Copy"
                } else {
                    trs!(self.english(), "transcript.copy")
                },
                p,
            )
            .on_click(cx.listener(move |this, _, _, cx| this.copy_text(answer.clone(), cx)));
            let fork_thread_id = thread_id.to_string();
            let fork_turn_id = turn_id.to_string();
            let fork = action_button(
                SharedString::from(format!("fork-{turn_id}")),
                "git-fork",
                if language == UiLanguage::English {
                    "Fork from here"
                } else {
                    "从此处分叉"
                },
                p,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.fork_thread_at(fork_thread_id.clone(), Some(fork_turn_id.clone()), cx);
            }));
            // 重试 asks for this turn again: its reply is thrown away and the same prompt is
            // re-sent, which is the only sense in which a reply can be "run again".
            let retry_id = turn_id.to_string();
            let retry_thread = thread_id.to_string();
            let retry = action_button(
                SharedString::from(format!("retry-{turn_id}")),
                "rotate-ccw",
                if language == UiLanguage::English {
                    "Retry"
                } else {
                    "重试"
                },
                p,
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.retry_thread(retry_thread.clone(), retry_id.clone(), window, cx)
            }));
            col = col.child(actions(
                &group,
                stamp,
                vec![
                    copy.into_any_element(),
                    fork.into_any_element(),
                    retry.into_any_element(),
                ],
                p,
            ));
        }
        col.into_any_element()
    }

    pub(super) fn cached_markdown(&self, id: &str, text: &str) -> SharedString {
        let identity = (text.as_ptr() as usize, text.len());
        if let Some((cached, source)) = self.markdown_cache.borrow().get(id)
            && *cached == identity
        {
            return source.clone();
        }
        let source = SharedString::from(fv_core::strip_memory_citation(text).into_owned());
        let key = id.to_owned();
        let mut cache = self.markdown_cache.borrow_mut();
        let mut order = self.markdown_cache_order.borrow_mut();
        cache.insert(key.clone(), (identity, source.clone()));
        order.retain(|existing| existing != &key);
        order.push(key);
        while order.len() > self.markdown_cache_limit {
            if let Some(oldest) = order.first().cloned() {
                order.remove(0);
                cache.remove(&oldest);
            }
        }
        source
    }

    fn markdown(&self, id: &str, text: &str) -> Div {
        div()
            .w_full()
            .text_size(px(TEXT_SM))
            .line_height(px(24.0))
            .child(crate::markdown::view(
                SharedString::from(format!("a-{id}")),
                self.cached_markdown(id, text),
                &self.palette,
            ))
    }

    pub(super) fn reasoning_duration(&self, item_id: &str) -> Option<u64> {
        let current_view = self.selected.as_ref().and_then(|id| self.views.get(id));
        let views: Box<dyn Iterator<Item = &ThreadView>> = match current_view {
            Some(v) => Box::new(std::iter::once(v)),
            None => Box::new(self.views.values()),
        };
        for view in views {
            if let Some(&secs) = view.reasoning_durations.get(item_id) {
                return Some(secs);
            }
            for turn in &view.turns {
                if turn.items.iter().any(|i| match i {
                    Item::Reasoning { id, .. } => id == item_id,
                    _ => false,
                }) {
                    if let Some(start) = turn.started_at
                        && let Some(end) = turn.process_ended_at.or(turn.completed_at)
                        && end >= start
                    {
                        return Some(((end - start + 999) / 1000).max(1) as u64);
                    }
                    break;
                }
            }
        }
        None
    }

    fn open_media(&mut self, thread_id: &str, id: &str, cx: &mut Context<Self>) {
        let Some((mime, data)) = self
            .views
            .get(thread_id)
            .into_iter()
            .flat_map(|view| view.turns.iter())
            .flat_map(|turn| turn.items.iter())
            .find_map(|item| match item {
                Item::Audio {
                    id: item_id,
                    mime,
                    data,
                    ..
                }
                | Item::Image {
                    id: item_id,
                    mime,
                    data,
                    ..
                } if item_id == id => Some((mime.as_str(), data.as_str())),
                _ => None,
            })
        else {
            return;
        };
        let url = format!("data:{mime};base64,{data}");
        cx.open_url(&url);
    }

    fn process_item(&self, thread_id: &str, item: &Item, cx: &mut Context<Self>) -> Div {
        self.process_item_live(thread_id, item, false, cx)
    }

    /// A thought or a tool call: one quiet line, opened by a click to what it said or did.
    fn process_item_live(
        &self,
        thread_id: &str,
        item: &Item,
        live: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = &self.palette;
        let language = self.app_settings.language;
        let (id, header, body): (String, Div, Option<Div>) = match item {
            Item::Reasoning { id, text: body } => {
                let header = if live {
                    div().flex_none().child(
                        shimmer(
                            SharedString::from(format!("think-live-{id}")),
                            if language == UiLanguage::English {
                                "Thinking"
                            } else {
                                "正在思考"
                            },
                        )
                        .text_color(p.c(Token::MutedForeground)),
                    )
                } else {
                    let elapsed = self.reasoning_duration(id);
                    if let Some(secs) = elapsed {
                        div()
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .line_height(px(20.0))
                                    .muted(p)
                                    .child(text::thinking(language)),
                            )
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .line_height(px(20.0))
                                    .text_color(p.c(Token::MutedForeground).opacity(0.4))
                                    .child("·"),
                            )
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .line_height(px(20.0))
                                    .text_color(p.c(Token::MutedForeground).opacity(0.6))
                                    .child(format!("{secs} 秒")),
                            )
                    } else {
                        div()
                            .flex_none()
                            .text_size(px(TEXT_SM))
                            .line_height(px(20.0))
                            .muted(p)
                            .child(text::thinking(language))
                    }
                };
                let preview_line = if live {
                    body.lines()
                        .rev()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("")
                } else {
                    ""
                };
                let mut row = div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(icon("brain", 16.0, p.c(Token::MutedForeground)))
                    .child(header);
                if live && !preview_line.is_empty() {
                    let preview = ui::truncate(preview_line.to_string())
                        .flex_1()
                        .text_color(p.c(Token::MutedForeground).opacity(0.7));
                    row = row.child(preview);
                }
                let open = self.open_items.contains(id);
                let detail = open.then(|| {
                    // The fold already insets this body by `ml-2 border-l pl-3.5`, so only the
                    // tool body's own 12px is added here: a thought then starts on the same
                    // column as the output of a tool call above or below it. The old 24 stacked
                    // on top of that rule and put the text 46px in from the reply's edge.
                    div()
                        .pl(px(12.0))
                        .text_size(px(TEXT_SM))
                        .line_height(px(22.0))
                        .muted(p)
                        .child(SharedString::from(body.clone()))
                });
                (id.clone(), row, detail)
            }
            Item::ToolCall {
                id,
                name,
                arguments,
                output,
                is_error,
            } => {
                let running = terminal_transcript::running(arguments, output.as_deref());
                let view = presentation::describe(name, arguments, running, self.english());
                let path = presentation::tool_path(name, arguments);
                let row = self
                    .tool_head(thread_id, item, &view, path.as_deref(), cx)
                    .children(terminal_transcript::status(arguments, self.english()).map(
                        |status| {
                            div()
                                .flex_none()
                                .text_color(p.c(Token::MutedForeground))
                                .child(status)
                        },
                    ));
                let open = terminal_transcript::active(item) || self.open_items.contains(id);
                let detail = open.then(|| {
                    if presentation::family_of(name) == presentation::Family::Terminal {
                        div().child(super::terminal_tool::TerminalTool {
                            id: SharedString::from(format!("terminal-tool-{id}")),
                            command: SharedString::from(
                                presentation::terminal_command(name, arguments).to_string(),
                            ),
                            prompt: Some("$"),
                            running,
                            output: output
                                .as_deref()
                                .map(|text| SharedString::from(text.to_string())),
                            english: self.english(),
                            palette: self.palette.clone(),
                        })
                    } else {
                        self.tool_detail(name, arguments, output.as_deref(), *is_error)
                    }
                });
                (id.clone(), row, detail)
            }
            Item::Audio {
                id,
                name,
                mime,
                data: _,
            } => {
                let media_id = id.clone();
                let media_thread_id = thread_id.to_owned();
                let label = if name.is_empty() {
                    if language == UiLanguage::English {
                        "Audio artifact"
                    } else {
                        "音频产物"
                    }
                } else {
                    name.as_str()
                };
                let row = div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(icon("play", 16.0, p.c(Token::MutedForeground)))
                    .child(
                        div()
                            .text_color(p.c(Token::Foreground))
                            .child(format!("{label} · {mime}")),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("play-audio-{id}")))
                            .cursor_pointer()
                            .text_color(p.c(Token::Primary))
                            .child(if language == UiLanguage::English {
                                "Play"
                            } else {
                                "播放"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_media(&media_thread_id, &media_id, cx)
                            })),
                    );
                (id.clone(), row, None)
            }
            Item::Image {
                id,
                name,
                mime,
                data: _,
            } => {
                let media_id = id.clone();
                let media_thread_id = thread_id.to_owned();
                let label = if name.is_empty() {
                    if language == UiLanguage::English {
                        "Image artifact"
                    } else {
                        "图片产物"
                    }
                } else {
                    name.as_str()
                };
                let row = div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(icon("image01", 16.0, p.c(Token::MutedForeground)))
                    .child(
                        div()
                            .text_color(p.c(Token::Foreground))
                            .child(format!("{label} · {mime}")),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("open-image-{id}")))
                            .cursor_pointer()
                            .text_color(p.c(Token::Primary))
                            .child(if language == UiLanguage::English {
                                "View"
                            } else {
                                "查看"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_media(&media_thread_id, &media_id, cx)
                            })),
                    );
                (id.clone(), row, None)
            }
            _ => return div(),
        };
        self.fold_row(id, header, body, false, cx)
    }

    /// `ToolRow`: a header that opens to a body set off by a rule on its left (`ml-2 border-l
    /// pl-3.5`). The chevron shows on hover, or always when `chevron_always`.
    fn fold_row(
        &self,
        id: String,
        header: Div,
        body: Option<Div>,
        chevron_always: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let p = &self.palette;
        let open = body.is_some() && (self.open_items.contains(&id) || !chevron_always);
        let key = id.clone();
        let group = SharedString::from(format!("tool-{id}"));
        div()
            .w_full()
            .max_w(px(REPLY_MAX))
            .flex()
            .flex_col()
            .text_size(px(TEXT_SM))
            .line_height(px(20.0))
            .child(
                div()
                    .id(SharedString::from(format!("item-{id}")))
                    .group(group.clone())
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    // The chevron follows the summary, as `ToolRow` places it: right after the
                    // words, or at the end when a trailing context takes the leftover width.
                    .child(
                        div().flex_1().min_w_0().child(
                            header.child(
                                div()
                                    .flex_none()
                                    .when(!chevron_always && !open, |d| {
                                        d.invisible().group_hover(group, |s| s.visible())
                                    })
                                    .child(ui::chevron(open, 14.0, p.c(Token::MutedForeground))),
                            ),
                        ),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.open_items.remove(&key) {
                            this.open_items.insert(key.clone());
                        }
                        cx.notify();
                    })),
            )
            .children(body.map(|body| {
                div().pt(px(8.0)).child(
                    div()
                        .ml(px(8.0))
                        .pl(px(14.0))
                        .border_l_1()
                        .border_color(p.c(Token::Border))
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(body),
                )
            }))
    }

    /// The row a call opens with: its family's icon, the category in muted words, what it acted
    /// on in mono, and the directory or glob after that in fainter mono.
    fn tool_head(
        &self,
        thread_id: &str,
        item: &Item,
        v: &presentation::ToolView,
        path: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Div {
        let Item::ToolCall {
            id,
            arguments,
            output,
            is_error: failed,
            ..
        } = item
        else {
            return div();
        };
        let running = terminal_transcript::running(arguments, output.as_deref());
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let icon_el: AnyElement = if running {
            spinner(
                SharedString::from(format!("tool-spin-{id}")),
                14.0,
                p.c(Token::MutedForeground),
            )
            .into_any_element()
        } else {
            ui::icon(
                presentation::family_icon(v.family, true),
                14.0,
                p.c(Token::MutedForeground),
            )
            .into_any_element()
        };
        let label_el: AnyElement = if running {
            shimmer(
                SharedString::from(format!("tool-label-{id}")),
                v.label.clone(),
            )
            .text_color(p.c(Token::Foreground))
            .into_any_element()
        } else {
            div()
                .flex_none()
                .text_color(p.c(Token::MutedForeground))
                .child(SharedString::from(v.label.clone()))
                .into_any_element()
        };
        div()
            .w_full()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(icon_el)
            .child(label_el)
            .when(!v.subject.is_empty(), |d| {
                if let Some(path) = path {
                    d.child(self.file_link(
                        thread_id,
                        format!("tool-file-{id}"),
                        path,
                        v.subject.clone(),
                        cx,
                    ))
                } else {
                    d.child(
                        ui::truncate(v.subject.clone())
                            .font_family(crate::assets::MONO_FONT)
                            .text_color(p.c(Token::Foreground)),
                    )
                }
            })
            .when(!v.context.is_empty(), |d| {
                d.child(
                    ui::truncate(v.context.clone())
                        .flex_1()
                        .font_family(crate::assets::MONO_FONT)
                        .text_color(p.c(Token::MutedForeground).opacity(0.6)),
                )
            })
            .when(*failed, |d| {
                d.child(
                    div()
                        .flex_none()
                        .text_color(p.c(Token::Destructive))
                        .child(trs!(english, "transcript.execution_failed")),
                )
            })
    }

    /// Several settled calls folded into one line, 「已运行 2 个命令，读取 App.tsx」.
    fn run_row(&self, thread_id: &str, items: &[&Item], cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let Some(Item::ToolCall { id, .. }) = items.first() else {
            return div();
        };
        let id = format!("run:{id}");
        let mut line = div()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .flex()
            .items_center();
        for piece in presentation::run_summary(items, self.english()) {
            line = match piece {
                presentation::Piece::Text(t) => line.child(SharedString::from(t)),
                // A file is the underlined path link the transcript uses everywhere; only a
                // query or a tool name is a chip.
                presentation::Piece::Path(n) => line.child(self.file_link(
                    thread_id,
                    format!("run-file-{id}-{n}"),
                    &n,
                    n.clone(),
                    cx,
                )),
                presentation::Piece::Name(n) => line.child(
                    div()
                        .mx(px(2.0))
                        .text_size(px(13.0))
                        .px(px(6.0))
                        .rounded(px(6.0))
                        .bg(p.c(Token::Muted))
                        .font_family(crate::assets::MONO_FONT)
                        .text_color(p.c(Token::Foreground))
                        .child(SharedString::from(n)),
                ),
            };
        }
        let head = div()
            .w_full()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(ui::icon("layers01", 14.0, p.c(Token::MutedForeground)))
            .child(line.muted(p));
        let body = self.open_items.contains(&id).then(|| {
            let mut col = div().w_full().flex().flex_col().gap(px(8.0));
            for item in items {
                col = col.child(self.process_item(thread_id, item, cx));
            }
            col
        });
        self.fold_row(id, head, body, true, cx)
    }

    /// A stretch of the process or answer, drawn the way the transcript draws it: prose as
    /// markdown, settled calls in a row each or folded into one, and the tail marked live.
    pub(super) fn parts(
        &self,
        thread_id: &str,
        items: &[&Item],
        running: bool,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let last = items.last().copied();
        presentation::fold_runs(items, running, self.app_settings.collapse_thinking)
            .into_iter()
            .map(|part| match part {
                presentation::Part::Run(batch) => {
                    self.run_row(thread_id, &batch, cx).into_any_element()
                }
                presentation::Part::Item(item) => {
                    let live = running && last.is_some_and(|l| std::ptr::eq(l, item));
                    match item {
                        Item::AgentMessage { id, text } => {
                            self.markdown(id, text).into_any_element()
                        }
                        Item::Error { message, .. } => {
                            self.error_notice(message).into_any_element()
                        }
                        other => self
                            .process_item_live(thread_id, other, live, cx)
                            .into_any_element(),
                    }
                }
            })
            .collect()
    }

    /// What a tool call was asked and what it said back.
    fn tool_detail(
        &self,
        name: &str,
        arguments: &serde_json::Value,
        output: Option<&str>,
        is_error: bool,
    ) -> Div {
        let p = &self.palette;
        if name == "web_search" && arguments.get("hosted").and_then(|v| v.as_bool()) == Some(true) {
            let mut col = div().flex().flex_col().gap(px(6.0));
            let action = &arguments["action"];
            if let Some(queries) = action.get("queries").and_then(|v| v.as_array()) {
                for q in queries.iter().filter_map(|v| v.as_str()) {
                    col = col.child(self.code_block(q, false));
                }
            } else if let Some(query) = action
                .get("query")
                .or_else(|| action.get("url"))
                .and_then(|v| v.as_str())
            {
                col = col.child(self.code_block(query, false));
            }
            let english = self.app_settings.language == UiLanguage::English;
            let status = match arguments
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
            {
                "completed" => {
                    trs!(english, "transcript.completed")
                }
                "failed" => {
                    trs!(english, "transcript.failed")
                }
                "interrupted" => {
                    trs!(english, "transcript.interrupted")
                }
                "searching" => {
                    trs!(english, "transcript.searching")
                }
                _ => {
                    trs!(english, "transcript.preparing_search")
                }
            };
            col = col.child(div().text_size(px(TEXT_XS)).muted(p).child(tr!(
                english,
                "transcript.status_status",
                status = status
            )));
            if let Some(sources) = arguments.get("sources").and_then(|v| v.as_array()) {
                for (index, source) in sources.iter().enumerate() {
                    let Some(url) = source
                        .get("url")
                        .and_then(|v| v.as_str())
                        .and_then(fv_core::safe_web_url)
                    else {
                        continue;
                    };
                    let title = source
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&url)
                        .to_string();
                    col = col.child(
                        div()
                            .id(SharedString::from(format!("web-source-{index}-{url}")))
                            .cursor_pointer()
                            .text_color(p.c(Token::Primary))
                            .child(title)
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    );
                }
            }
            return col;
        }
        let asked = match name {
            "code_mode" => arguments
                .get("code")
                .and_then(|v| v.as_str())
                .map(|code| self.code_block(code, false)),
            "exec_command" => arguments
                .get("cmd")
                .and_then(|v| v.as_str())
                .map(|c| self.code_block(&format!("$ {c}"), false)),
            "write_stdin" => Some(self.code_block(
                &format!(
                        "session {}\n{}",
                        arguments
                            .get("session_id")
                            .map(|id| id.to_string())
                            .unwrap_or_default(),
                        match arguments
                            .get("chars")
                            .and_then(|chars| chars.as_str())
                            .unwrap_or("")
                        {
                            "" => "等待新输出",
                            "\u{3}" => "Ctrl-C",
                            "\u{4}" => "Ctrl-D",
                            chars => chars,
                        }
                    ),
                false,
            )),
            "apply_patch" => arguments
                .get("input")
                .and_then(|v| v.as_str())
                .map(|patch| self.code_block(patch, true)),
            _ => Some(self.code_block(
                &serde_json::to_string_pretty(arguments).unwrap_or_default(),
                false,
            )),
        };
        let mut col = div().flex().flex_col().gap(px(6.0)).children(asked);
        if let Some(out) = output.filter(|o| !o.trim().is_empty()) {
            let mut block = self.code_block(out, false);
            if is_error {
                block = block.text_color(p.c(Token::Destructive));
            }
            col = col.child(block);
        }
        col
    }

    /// Monospace text in a scrolling box; a patch gets its added and removed lines tinted.
    fn code_block(&self, text: &str, diff: bool) -> Stateful<Div> {
        const MAX_LINES: usize = 400;
        let p = &self.palette;
        let mut lines = div().flex().flex_col();
        for line in text.lines().take(MAX_LINES) {
            let (bg, fg) = if diff && line.starts_with('+') && !line.starts_with("+++") {
                (Some(p.c(Token::Success).opacity(0.12)), None)
            } else if diff && line.starts_with('-') && !line.starts_with("---") {
                (Some(p.c(Token::Destructive).opacity(0.12)), None)
            } else if diff && line.starts_with("***") {
                (None, Some(p.c(Token::MutedForeground)))
            } else {
                (None, None)
            };
            lines = lines.child(
                div()
                    .min_h(px(20.0))
                    .px(px(12.0))
                    .when_some(bg, |d, c| d.bg(c))
                    .when_some(fg, |d, c| d.text_color(c))
                    .child(SharedString::from(
                        if line.is_empty() { " " } else { line }.to_string(),
                    )),
            );
        }
        if text.lines().count() > MAX_LINES {
            lines = lines.child(div().px(px(12.0)).muted(p).child(SharedString::from(tr!(
                self.english(),
                "transcript.more_lines",
                arg1 = text.lines().count() - MAX_LINES
            ))));
        }
        div()
            .id(SharedString::from(format!("code-{:x}", {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                text.hash(&mut h);
                h.finish()
            })))
            .w_full()
            .max_h(px(240.0))
            .overflow_y_scroll()
            .py(px(8.0))
            .rounded(px(10.0))
            .bg(p.c(Token::CodeBg))
            .font_family(crate::assets::MONO_FONT)
            .text_size(px(12.0))
            .line_height(px(20.0))
            .child(lines)
    }

    fn error_notice(&self, message: &str) -> Div {
        let p = &self.palette;
        let red = p.c(Token::Destructive);
        div()
            .w_full()
            .max_w(px(REPLY_MAX))
            .px(px(12.0))
            .py(px(10.0))
            .rounded(px(12.0))
            .border_1()
            .border_color(red.opacity(0.25))
            .bg(red.opacity(0.05))
            .text_size(px(TEXT_SM))
            .line_height(px(20.0))
            .text_color(red)
            .child(SharedString::from(message.to_string()))
    }

    /// `TurnFileChips`: 已修改 N 个文件, the totals, 查看变更, then one row per file.
    fn changes_card(
        &self,
        thread_id: &str,
        turn_id: &str,
        files: &[FileChange],
        cx: &mut Context<Self>,
    ) -> Div {
        let p = &self.palette;
        let language = self.app_settings.language;
        let added: u32 = files.iter().map(|f| f.added).sum();
        let removed: u32 = files.iter().map(|f| f.removed).sum();
        let counts = |a: u32, r: u32| {
            div()
                .font_family(crate::assets::MONO_FONT)
                .flex()
                .gap(px(6.0))
                .child(
                    div()
                        .text_color(p.c(Token::Success))
                        .child(SharedString::from(format!("+{a}"))),
                )
                .child(
                    div()
                        .text_color(p.c(Token::Destructive))
                        .child(SharedString::from(format!("-{r}"))),
                )
        };
        let review_path = files
            .first()
            .and_then(|file| self.transcript_path(thread_id, &file.path));
        let review_thread = thread_id.to_string();
        let mut rows = div().px(px(6.0)).flex().flex_col();
        for f in files {
            let (name, dir) = presentation::split_path(&f.path);
            let row = div()
                .id(SharedString::from(format!(
                    "changed-file-{turn_id}-{}",
                    f.path
                )))
                .h(px(32.0))
                .px(px(8.0))
                .rounded(px(8.0))
                .flex()
                .items_center()
                .gap(px(10.0))
                .text_size(px(TEXT_SM))
                .child(
                    img(crate::file_icons::path(name, !p.is_dark()))
                        .size(px(16.0))
                        .flex_none(),
                )
                .child(
                    div()
                        .flex_none()
                        .child(SharedString::from(name.to_string())),
                )
                .child(
                    ui::truncate(dir.to_string())
                        .flex_1()
                        .text_size(px(TEXT_XS))
                        .text_color(p.c(Token::MutedForeground).opacity(0.7)),
                )
                .child(counts(f.added, f.removed));
            rows = rows.child(self.file_actions(thread_id, row, &f.path, true, cx));
        }
        div()
            .w_full()
            .max_w(px(REPLY_MAX))
            .rounded(px(14.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Card).opacity(0.4))
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(38.0))
                    .px(px(13.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_SM))
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .child(SharedString::from(if language == UiLanguage::English {
                                format!("{} files changed", files.len())
                            } else {
                                text::CHANGED_FILES.replace("{n}", &files.len().to_string())
                            })),
                    )
                    .child(counts(added, removed).font_weight(FontWeight::MEDIUM))
                    .child(icon("arrow-down01", 14.0, p.c(Token::MutedForeground)))
                    .child(div().flex_1())
                    .child(
                        div()
                            .id(SharedString::from(format!("review-turn-changes-{turn_id}")))
                            .role(Role::Button)
                            .aria_label(text::view_changes(language))
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if let Some(path) = &review_path {
                                    this.review_transcript_file_for(
                                        &review_thread,
                                        path.clone(),
                                        window,
                                        cx,
                                    );
                                }
                            }))
                            .h(px(24.0))
                            .px(px(10.0))
                            .flex()
                            .items_center()
                            .rounded_full()
                            .border_1()
                            .border_color(p.c(Token::Border))
                            .bg(p.c(Token::Background))
                            .text_size(px(TEXT_XS))
                            .font_weight(FontWeight::MEDIUM)
                            .child(text::view_changes(language)),
                    ),
            )
            // GPUI dispatches a wheel event to scrollable ancestors too. File rows stay
            // content-sized so scrolling over this card moves the conversation only.
            .child(div().pb(px(6.0)).child(rows))
    }
}

/// `MessageActions`: the time (and how long the turn took), then 18px buttons, shown while
/// the pointer is over the message.
/// A clickable 14px glyph in the hover row under a message.
fn action_button(
    id: impl Into<ElementId>,
    glyph: &'static str,
    label: &'static str,
    p: &crate::theme::Palette,
) -> gpui_kit::Stateful<Div> {
    let hover = p.c(Token::Muted);
    div()
        .id(id)
        .role(Role::Button)
        .focusable()
        .tab_index(0)
        .aria_label(label)
        .p(px(2.0))
        .rounded(px(6.0))
        .cursor_pointer()
        .hover(move |d| d.bg(hover))
        .tooltip(move |window, cx| {
            gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx)
        })
        .child(icon(glyph, 14.0, p.c(Token::MutedForeground)))
}

fn actions(
    group: &SharedString,
    stamp: Option<(String, Option<String>)>,
    buttons: Vec<AnyElement>,
    p: &crate::theme::Palette,
) -> Div {
    let mut row = div()
        .h(px(20.0))
        .flex()
        .items_center()
        .gap(px(4.0))
        .text_size(px(TEXT_XS))
        .font_weight(FontWeight::MEDIUM)
        .muted(p)
        .invisible()
        .group_hover(group.clone(), |s| s.visible());
    if let Some((time, took)) = stamp {
        row = row.child(
            div()
                .flex()
                .child(SharedString::from(time))
                .when_some(took, |d, t| {
                    d.child(
                        div()
                            .text_color(p.c(Token::MutedForeground).opacity(0.6))
                            .child(SharedString::from(format!(" · {t}"))),
                    )
                }),
        );
    }
    row.children(buttons)
}

/// `HH:MM` in local time.
fn clock(ms: i64) -> String {
    // SAFETY: `localtime_r` writes only into the `tm` it is given.
    unsafe {
        let secs = (ms / 1000) as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return String::new();
        }
        format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
    }
}

pub(super) fn project_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `formatRelativeTime`: 刚刚, N 分钟前, N 小时前, then the date.
fn relative_time(at: i64, now: i64, english: bool) -> String {
    let mins = (now - at).max(0) / 60_000;
    if mins < 1 {
        trs!(english, "transcript.just_now").into()
    } else if mins < 60 {
        tr!(english, "transcript.mins_min_ago", mins = mins)
    } else if mins < 24 * 60 {
        tr!(english, "transcript.h_ago", arg1 = mins / 60)
    } else {
        // SAFETY: `localtime_r` writes only into the `tm` it is given.
        unsafe {
            let secs = (at / 1000) as libc::time_t;
            let mut tm: libc::tm = std::mem::zeroed();
            if libc::localtime_r(&secs, &mut tm).is_null() {
                return String::new();
            }
            format!("{}/{}/{}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday)
        }
    }
}

fn local_hour() -> u32 {
    // SAFETY: `localtime_r` writes only into the `tm` it is given.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return 12;
        }
        tm.tm_hour as u32
    }
}

/// `formatCount` beside the compaction divider: `45.5K`, `1.2M`.
fn compact_count(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}K", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod terminal_projection_tests {
    use super::{presentation, projected_items, terminal_transcript};
    use fv_protocol::types::{Item, Turn};
    use serde_json::json;

    fn tool(id: &str, name: &str, arguments: serde_json::Value, output: Option<&str>) -> Item {
        Item::ToolCall {
            id: id.into(),
            name: name.into(),
            arguments,
            output: output.map(str::to_string),
            is_error: false,
        }
    }

    #[test]
    fn continuation_output_belongs_to_latest_session_owner_without_mutating_history() {
        let running =
            "Wall time: 0.1 seconds\nProcess running with session ID 7\nProcess ID: 12\nOutput:\n";
        let exited = "Wall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n";
        let turns = vec![
            Turn::new(
                "first".into(),
                vec![tool(
                    "old",
                    "exec_command",
                    json!({"cmd":"old"}),
                    Some(&format!("{running}old")),
                )],
            ),
            Turn::new(
                "second".into(),
                vec![
                    tool(
                        "old-poll",
                        "write_stdin",
                        json!({"session_id":7,"chars":""}),
                        Some(&format!("{exited}-done")),
                    ),
                    tool(
                        "read",
                        "read_file",
                        json!({"path":"notes.md"}),
                        Some("unrelated output"),
                    ),
                    tool(
                        "new",
                        "exec_command",
                        json!({"cmd":"new"}),
                        Some(&format!("{running}new")),
                    ),
                    tool(
                        "new-poll",
                        "write_stdin",
                        json!({"session_id":7,"chars":""}),
                        Some(&format!("{exited}-tail")),
                    ),
                ],
            ),
        ];
        let before = serde_json::to_value(&turns).unwrap();
        let projected = terminal_transcript::project(&turns, true);
        let output = |id: &str| match &projected[id] {
            Item::ToolCall {
                output: Some(output),
                ..
            } => output.as_str(),
            _ => panic!("command output"),
        };
        assert_eq!(output("old"), "old-done");
        assert_eq!(output("new"), "new-tail");
        let second = projected_items(&turns[1], &projected);
        assert_eq!(second.len(), 2);
        assert!(
            std::ptr::eq(second[0], &turns[1].items[1]),
            "unrelated tool is preserved"
        );
        assert_eq!(serde_json::to_value(&turns).unwrap(), before);
    }

    #[test]
    fn render_projection_borrows_media_hides_polls_and_keeps_active_commands_visible() {
        let turns = vec![
            Turn::new(
                "original-turn".into(),
                vec![
                    tool(
                        "exec",
                        "exec_command",
                        json!({"cmd":"watch"}),
                        Some(
                            "Wall time: 0.1 seconds\nProcess running with session ID 7\nProcess ID: 12\nOutput:\nfirst",
                        ),
                    ),
                    Item::AgentMessage {
                        id: "reply".into(),
                        text: "Working".into(),
                    },
                    Item::Image {
                        id: "image".into(),
                        name: "plot.png".into(),
                        mime: "image/png".into(),
                        data: "large-payload".repeat(1000),
                    },
                ],
            ),
            Turn::new(
                "poll-turn".into(),
                vec![tool(
                    "poll",
                    "write_stdin",
                    json!({"session_id":7,"chars":""}),
                    None,
                )],
            ),
        ];
        let projected = terminal_transcript::project(&turns, true);
        let first = projected_items(&turns[0], &projected);
        assert!(
            std::ptr::eq(first[2], &turns[0].items[2]),
            "media payload stays borrowed"
        );
        assert!(
            projected_items(&turns[1], &projected).is_empty(),
            "continuation has no separate row"
        );
        assert!(terminal_transcript::active(first[0]));
        let layout = presentation::layout_refs(
            &first,
            first.iter().any(|item| terminal_transcript::active(item)),
        );
        assert!(
            !layout.folded,
            "active command must not hide behind completed-turn process"
        );
        let parts = presentation::fold_runs(&first, false, true);
        assert!(
            matches!(parts.first(), Some(presentation::Part::Item(Item::ToolCall { id, .. })) if id == "exec")
        );
        let Item::ToolCall {
            arguments, output, ..
        } = first[0]
        else {
            panic!("command")
        };
        assert!(terminal_transcript::running(arguments, output.as_deref()));
        assert!(terminal_transcript::status(arguments, true).is_some());
        assert_eq!(turns[0].id, "original-turn");
        assert!(
            matches!(&turns[1].items[0], Item::ToolCall { name, output: None, .. } if name == "write_stdin")
        );
    }
}
