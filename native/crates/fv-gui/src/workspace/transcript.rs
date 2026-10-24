//! The conversation column, after `App.tsx`'s header, `message-list.tsx` and `message-row.tsx`.

use fv_protocol::RequestId;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::component::text::TextView;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{Status, Workspace, text};
use crate::presentation::{self, FileChange, TurnLayout};
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon, icon_button};

/// The reading column: `max-w-3xl` with `px-6`, so 720px of content.
pub const THREAD_MAX: f32 = 768.0;
pub const THREAD_PAD: f32 = 24.0;
/// A reply's own cap, `max-w-2xl`.
const REPLY_MAX: f32 = 672.0;

impl Workspace {
    pub(super) fn main(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let empty = self.selected.is_none() && matches!(self.status, Status::Ready);
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .pt(px(8.0))
            .mr(px(10.0))
            .flex()
            .flex_col()
            .child(self.header())
            .map(|d| {
                if empty {
                    d.child(self.hero(window, cx))
                } else {
                    d.child(self.transcript(cx))
                        .child(self.composer(window, cx))
                }
            })
    }

    fn header(&self) -> impl IntoElement {
        let p = &self.palette;
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
                text::UNTITLED.to_string()
            } else {
                t.title.clone()
            };
            left = left.child(
                ui::truncate(title)
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.c(Token::Foreground)),
            );
        }
        div()
            .h(px(44.0))
            .flex_none()
            .pl(px(17.0))
            .pr(px(8.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(left)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(icon_button("resources", "ai-expand", p))
                    .child(icon_button("expand-side-pane", "panel-right-open", p)),
            )
    }

    /// A new conversation: the greeting above the composer, the composer a little above centre.
    fn hero(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let hour = local_hour();
        let greeting = match hour {
            5..=10 => "早上好呀，新的一天开始啦",
            11..=12 => "中午好呀，记得好好吃饭",
            13..=17 => "下午好呀，继续加油",
            18..=22 => "晚上好呀，今天辛苦啦",
            _ => "夜深啦，早点休息呀",
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
        let p = &self.palette;
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
            Some(path) => format!("{} 中的最近对话", self.project_label(path)),
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
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(SharedString::from(relative_time(t.updated_at, now))),
                    )
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
                    .child(hint("/", "技能与命令"))
                    .when(project.is_some(), |d| d.child(hint("@", "引用文件")))
                    .child(hint("⌘K", "搜索对话")),
            )
    }

    fn transcript(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
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
            (Status::Connecting, _) => body = body.child(div().muted(p).child(text::CONNECTING)),
            (Status::Ready, None) => {}
            (Status::Ready, Some(view)) => {
                let last = view.turns.len().saturating_sub(1);
                for (i, turn) in view.turns.iter().enumerate() {
                    let running = view.running && i == last;
                    body = body.children(self.turn(turn, running, cx));
                }
                for (id, q) in &view.questions {
                    body = body.child(self.question(id.clone(), q, cx));
                }
            }
        }
        div()
            .id("transcript")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(body)
    }

    fn turn(&self, turn: &Turn, running: bool, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut rows = Vec::new();
        // A compaction is a transcript-level rule of its own, before what follows it.
        let (compactions, items): (Vec<&Item>, Vec<&Item>) = turn
            .items
            .iter()
            .partition(|i| matches!(i, Item::ContextCompaction { .. }));
        let items: Vec<Item> = items.into_iter().cloned().collect();
        let layout = presentation::layout(&items, running);
        if let Some(user) = layout.user {
            rows.push(self.user_row(user, turn.started_at));
        }
        for c in compactions {
            rows.push(self.compaction(c, running && layout.answer.is_empty()));
        }
        if !layout.process.is_empty() || !layout.answer.is_empty() || running {
            rows.push(self.reply(turn, &layout, running, cx));
        }
        rows
    }

    fn user_row(&self, item: &Item, at: Option<i64>) -> AnyElement {
        let p = &self.palette;
        let Item::UserMessage { id, text } = item else {
            return div().into_any_element();
        };
        let group = SharedString::from(format!("row-{id}"));
        div()
            .group(group.clone())
            .w_full()
            .flex()
            .flex_col()
            .items_end()
            .gap(px(11.0))
            .child(
                div()
                    .max_w(relative(0.85))
                    .px(px(13.0))
                    .py(px(9.0))
                    .rounded(px(14.0))
                    .bg(p.c(Token::Muted))
                    .text_size(px(TEXT_SM))
                    .line_height(px(24.0))
                    .child(SharedString::from(text.clone())),
            )
            .child(actions(
                &group,
                at.map(|t| (clock(t), None)),
                &["copy01", "pencil-edit02", "rotate-ccw"],
                p,
            ))
            .into_any_element()
    }

    fn compaction(&self, item: &Item, live: bool) -> AnyElement {
        let p = &self.palette;
        let Item::ContextCompaction { .. } = item else {
            return div().into_any_element();
        };
        div()
            .w_full()
            .flex()
            .items_center()
            .gap(px(12.0))
            .text_size(px(TEXT_XS))
            .line_height(px(16.0))
            .child(ui::rule(p))
            .child(
                div()
                    .flex_none()
                    .text_color(p.c(Token::MutedForeground).opacity(0.6))
                    .child(if live {
                        text::COMPACTING
                    } else {
                        text::COMPACTED
                    }),
            )
            .child(ui::rule(p))
            .into_any_element()
    }

    fn reply(
        &self,
        turn: &Turn,
        layout: &TurnLayout<'_>,
        running: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let turn_id = turn.id.as_str();
        let group = SharedString::from(format!("row-reply-{turn_id}"));
        let mut col = div()
            .group(group.clone())
            .w_full()
            .flex()
            .flex_col()
            .items_start()
            .gap(px(10.0));
        if layout.folded {
            let open = self.open_folds.contains(turn_id);
            let key = turn_id.to_string();
            // 用时: the work the fold hides, up to where the answer began.
            let label = match (turn.started_at, turn.process_ended_at) {
                (Some(a), Some(b)) if b >= a => {
                    format!("用时 {}", presentation::format_duration((b - a) as u64))
                }
                _ => text::PROCESSED.to_string(),
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
                for item in &layout.process {
                    inner = inner.child(match item {
                        Item::AgentMessage { id, text } => self.markdown(id, text),
                        other => self.process_item(other, cx),
                    });
                }
                fold = fold.child(inner);
            }
            col = col.child(fold);
        }
        let last = layout.answer.len().saturating_sub(1);
        for (i, item) in layout.answer.iter().enumerate() {
            let live_tail = running && i == last;
            col = col.child(match item {
                Item::AgentMessage { id, text } => self.markdown(id, text),
                Item::Error { message, .. } => self.error_notice(message),
                other => self.process_item_live(other, live_tail, cx),
            });
        }
        let ends_live = layout
            .answer
            .last()
            .is_some_and(|i| matches!(i, Item::AgentMessage { .. } | Item::Reasoning { .. }));
        if running && !ends_live {
            col = col.child(
                div()
                    .text_size(px(TEXT_SM))
                    .line_height(px(20.0))
                    .muted(p)
                    .child(text::WORKING),
            );
        }
        if !running && !layout.changes.is_empty() {
            col = col.child(self.changes_card(&layout.changes).mt(px(4.0)));
        }
        if !running {
            // 耗时: the whole turn, from the user's message to the last entry.
            let stamp = turn.completed_at.map(|end| {
                let took = turn
                    .started_at
                    .filter(|s| end >= *s)
                    .map(|s| format!("耗时 {}", presentation::format_duration((end - s) as u64)));
                (clock(end), took)
            });
            col = col.child(actions(
                &group,
                stamp,
                &["copy01", "git-fork", "rotate-ccw"],
                p,
            ));
        }
        col.into_any_element()
    }

    fn markdown(&self, id: &str, text: &str) -> Div {
        div()
            .w_full()
            .text_size(px(TEXT_SM))
            .line_height(px(24.0))
            .child(TextView::markdown(
                SharedString::from(format!("a-{id}")),
                SharedString::from(text.to_string()),
            ))
    }

    fn process_item(&self, item: &Item, cx: &mut Context<Self>) -> Div {
        self.process_item_live(item, false, cx)
    }

    /// A thought or a tool call: one quiet line, opened by a click to what it said or did.
    fn process_item_live(&self, item: &Item, live: bool, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let (id, header, body): (String, Div, Option<Div>) = match item {
            Item::Reasoning { id, text: body } => {
                let first = body.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
                let header = div().flex_none().muted(p).child(if live {
                    "正在思考"
                } else {
                    text::THINKING
                });
                let preview = ui::truncate(first.to_string())
                    .flex_1()
                    .text_color(p.c(Token::MutedForeground).opacity(0.7));
                let row = div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(header)
                    .child(preview);
                let open = self.open_items.contains(id);
                let detail = open.then(|| {
                    div()
                        .pl(px(10.0))
                        .border_l_2()
                        .border_color(p.c(Token::Border))
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
                let (verb, detail) = presentation::tool_title(name, arguments, output.is_none());
                let row = div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(div().flex_none().muted(p).child(verb))
                    .child(ui::truncate(detail).text_color(p.c(Token::Foreground)))
                    .when(*is_error, |d| {
                        d.child(icon("alert-circle", 14.0, p.c(Token::Destructive)))
                    });
                let open = self.open_items.contains(id);
                let detail =
                    open.then(|| self.tool_detail(name, arguments, output.as_deref(), *is_error));
                (id.clone(), row, detail)
            }
            _ => return div(),
        };
        let open = self.open_items.contains(&id);
        let key = id.clone();
        div()
            .w_full()
            .max_w(px(REPLY_MAX))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .text_size(px(TEXT_SM))
            .line_height(px(20.0))
            .child(
                div()
                    .id(SharedString::from(format!("item-{id}")))
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(div().flex_1().min_w_0().child(header))
                    .child(ui::chevron(
                        open,
                        14.0,
                        p.c(Token::MutedForeground).opacity(0.6),
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.open_items.remove(&key) {
                            this.open_items.insert(key.clone());
                        }
                        cx.notify();
                    })),
            )
            .children(body)
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
        let asked = match name {
            "exec_command" => arguments
                .get("cmd")
                .and_then(|v| v.as_str())
                .map(|c| self.code_block(&format!("$ {c}"), false)),
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
            lines = lines.child(
                div()
                    .px(px(12.0))
                    .muted(p)
                    .child(SharedString::from(format!(
                        "… 还有 {} 行",
                        text.lines().count() - MAX_LINES
                    ))),
            );
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
    fn changes_card(&self, files: &[FileChange]) -> Div {
        let p = &self.palette;
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
        let mut rows = div().px(px(6.0)).pb(px(6.0)).flex().flex_col();
        for f in files {
            let (name, dir) = presentation::split_path(&f.path);
            rows = rows.child(
                div()
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
                    .child(counts(f.added, f.removed)),
            );
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
                            .child(SharedString::from(
                                text::CHANGED_FILES.replace("{n}", &files.len().to_string()),
                            )),
                    )
                    .child(counts(added, removed).font_weight(FontWeight::MEDIUM))
                    .child(icon("arrow-down01", 14.0, p.c(Token::MutedForeground)))
                    .child(div().flex_1())
                    .child(
                        div()
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
                            .child(text::VIEW_CHANGES),
                    ),
            )
            .child(rows)
    }

    pub(super) fn question(
        &self,
        request: RequestId,
        q: &UserInputRequest,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let total = q.questions.len();
        let blocks = q.questions.iter().map(|question| {
            let chosen = self
                .answers
                .get(&request)
                .and_then(|a| a.get(&question.id))
                .and_then(|a| a.answers.first().cloned());
            let buttons = question.options.iter().map(|opt| {
                let request = request.clone();
                let qid = question.id.clone();
                let label = opt.label.clone();
                let on = chosen.as_deref() == Some(opt.label.as_str());
                div()
                    .id(SharedString::from(format!("q-{request:?}-{qid}-{label}")))
                    .h(px(28.0))
                    .px(px(10.0))
                    .flex()
                    .items_center()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(p.c(Token::Border))
                    .cursor_pointer()
                    .text_size(px(TEXT_SM))
                    .when(on, |d| {
                        d.bg(p.c(Token::Primary))
                            .text_color(p.c(Token::PrimaryForeground))
                    })
                    .child(SharedString::from(opt.label.clone()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.answer(request.clone(), total, qid.clone(), label.clone(), cx)
                    }))
            });
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .text_size(px(TEXT_XS))
                        .muted(p)
                        .child(SharedString::from(question.header.clone())),
                )
                .child(
                    div()
                        .text_size(px(TEXT_SM))
                        .child(SharedString::from(question.question.clone())),
                )
                .child(div().flex().gap(px(6.0)).flex_wrap().children(buttons))
        });
        div()
            .w_full()
            .max_w(px(REPLY_MAX))
            .p(px(14.0))
            .rounded(px(14.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Card))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .children(blocks)
            .into_any_element()
    }
}

/// `MessageActions`: the time (and how long the turn took), then 18px buttons, shown while
/// the pointer is over the message.
fn actions(
    group: &SharedString,
    stamp: Option<(String, Option<String>)>,
    glyphs: &[&str],
    p: &crate::theme::Palette,
) -> Div {
    let hover = p.c(Token::Muted);
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
    for g in glyphs {
        row = row.child(
            div()
                .p(px(2.0))
                .rounded(px(6.0))
                .hover(move |d| d.bg(hover))
                .child(icon(g, 14.0, p.c(Token::MutedForeground))),
        );
    }
    row
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
fn relative_time(at: i64, now: i64) -> String {
    let mins = (now - at).max(0) / 60_000;
    if mins < 1 {
        "刚刚".into()
    } else if mins < 60 {
        format!("{mins} 分钟前")
    } else if mins < 24 * 60 {
        format!("{} 小时前", mins / 60)
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
