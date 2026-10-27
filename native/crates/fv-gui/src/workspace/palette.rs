//! ⌘K: commands, recent conversations and full-text transcript search over the shared protocol.

use fv_protocol::{methods::ThreadSearch, types::*};
use fv_theme::Token;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::*;

use super::settings::{Section, dialog_card, menu_item};
use super::{Workspace, text};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon};

#[derive(Clone)]
enum Hit {
    NewChat,
    Settings,
    Thread(String, Option<String>),
}

struct Row {
    hit: Hit,
    label: String,
    glyph: &'static str,
    detail: Option<String>,
}

#[derive(Default)]
pub(super) struct SearchResults {
    generation: u64,
    query: String,
    hits: Vec<ThreadSearchHit>,
    loading: bool,
    error: Option<String>,
    include_archived: bool,
}

impl Workspace {
    pub(super) fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search_box.is_some() {
            return;
        }
        self.search_results = SearchResults {
            generation: self.search_results.generation + 1,
            ..Default::default()
        };
        let placeholder = if self.app_settings.language == UiLanguage::English {
            "Search chats, titles, or commands"
        } else {
            "搜索对话正文、标题或命令"
        };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        input.update(cx, |st, cx| st.focus(window, cx));
        cx.subscribe_in(
            &input,
            window,
            |this, input, ev: &InputEvent, window, cx| match ev {
                InputEvent::Change => {
                    this.search_palette(input.read(cx).value().trim().to_lowercase(), cx)
                }
                InputEvent::PressEnter { .. } => {
                    let query = input.read(cx).value().trim().to_lowercase();
                    if let Some(row) = this.palette_hits(&query).into_iter().next() {
                        this.choose(row.hit, window, cx);
                    }
                }
                _ => {}
            },
        )
        .detach();
        self.search_box = Some(input);
        self.close_menus(cx);
    }

    pub(super) fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search_box.take().is_some() {
            self.search_task = None;
            self.search_results.generation += 1;
            let input = self.input.clone();
            input.update(cx, |st, cx| st.focus(window, cx));
            cx.notify();
        }
    }

    /// Debounce typing and discard replies belonging to a previous query or closed dialog.
    pub(super) fn search_palette(&mut self, query: String, cx: &mut Context<Self>) {
        self.search_task = None;
        let s = &mut self.search_results;
        s.generation += 1;
        s.query = query.clone();
        s.hits.clear();
        s.error = None;
        s.loading = !query.is_empty();
        let generation = s.generation;
        let include_archived = s.include_archived;
        cx.notify();
        if query.is_empty() {
            return;
        }
        let Some(b) = self.backend.clone() else {
            self.search_results.loading = false;
            self.search_results.error = Some("连接服务器后可搜索正文".into());
            return;
        };
        let delay = cx
            .background_executor()
            .timer(std::time::Duration::from_millis(200));
        self.search_task = Some(cx.spawn(async move |this, cx| {
            delay.await;
            let result = b
                .call::<ThreadSearch>(ThreadSearchParams {
                    query,
                    include_archived,
                })
                .await;
            this.update(cx, |this, cx| {
                if this.search_box.is_none() || this.search_results.generation != generation {
                    return;
                }
                this.search_results.loading = false;
                match result {
                    Ok(r) => this.search_results.hits = r.hits,
                    Err(e) => this.search_results.error = Some(format!("搜索失败：{e}")),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn palette_hits(&self, query: &str) -> Vec<Row> {
        let mut rows = Vec::new();
        for (hit, label, glyph) in [
            (
                Hit::NewChat,
                text::new_chat(self.app_settings.language),
                "message-square-plus",
            ),
            (
                Hit::Settings,
                text::settings(self.app_settings.language),
                "settings01",
            ),
        ] {
            if query.is_empty() || label.to_lowercase().contains(query) {
                rows.push(Row {
                    hit,
                    label: label.into(),
                    glyph,
                    detail: None,
                });
            }
        }
        // Local title/project matches remain immediate; body results join them by thread id.
        let mut threads: Vec<_> = self
            .threads
            .iter()
            .filter(|t| !t.archived || self.search_results.include_archived)
            .filter(|t| {
                query.is_empty()
                    || t.title.to_lowercase().contains(query)
                    || t.project
                        .as_ref()
                        .is_some_and(|p| p.to_lowercase().contains(query))
            })
            .map(|t| (t.clone(), None))
            .collect();
        if self.search_results.query == query {
            for hit in &self.search_results.hits {
                match threads.iter_mut().find(|(t, _)| t.id == hit.thread.id) {
                    Some((_, snippet)) => *snippet = hit.snippet.clone(),
                    None => threads.push((hit.thread.clone(), hit.snippet.clone())),
                }
            }
        }
        threads.sort_by(|(a, _), (b, _)| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        for (t, snippet) in threads
            .into_iter()
            .take(if query.is_empty() { 9 } else { 50 })
        {
            let body_query = snippet.as_ref().map(|_| query.to_string());
            let detail = snippet.or(t.project);
            let detail = if t.archived {
                Some(if self.app_settings.language == UiLanguage::English {
                    format!("Archived · {}", detail.unwrap_or_default())
                } else {
                    format!("已归档 · {}", detail.unwrap_or_default())
                })
            } else {
                detail
            };
            rows.push(Row {
                hit: Hit::Thread(t.id, body_query),
                label: if t.title.trim().is_empty() {
                    text::untitled(self.app_settings.language).into()
                } else {
                    t.title
                },
                glyph: "message-square-plus",
                detail,
            });
        }
        rows
    }

    fn choose(&mut self, hit: Hit, window: &mut Window, cx: &mut Context<Self>) {
        self.close_palette(window, cx);
        match hit {
            Hit::NewChat => {
                self.settings = None;
                self.selected = None;
                cx.notify();
            }
            Hit::Settings => self.open_settings(Section::General, window, cx),
            Hit::Thread(id, query) => {
                self.search_target = query.map(|q| (id.clone(), q));
                self.search_jump_pending = false;
                self.settings = None;
                self.select(id, cx);
            }
        }
    }

    pub(super) fn palette_view(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let input = self.search_box.clone()?;
        let p = self.palette.clone();
        let query = input.read(cx).value().trim().to_lowercase();
        let hits = self.palette_hits(&query);
        let hover = p.c(Token::Accent);
        let mut list = div()
            .id("palette-list")
            .max_h(px(360.0))
            .overflow_y_scroll()
            .p(px(6.0))
            .flex()
            .flex_col();
        let status = self.search_results.error.clone().or_else(|| {
            if self.search_results.loading {
                Some(if self.app_settings.language == UiLanguage::English {
                    "Searching chats…".into()
                } else {
                    "正在搜索正文…".into()
                })
            } else if hits.is_empty() {
                Some(if self.app_settings.language == UiLanguage::English {
                    "No matching results".into()
                } else {
                    "没有匹配的结果".into()
                })
            } else {
                None
            }
        });
        for (i, row) in hits.into_iter().enumerate() {
            let hit = row.hit;
            list =
                list.child(
                    menu_item(SharedString::from(format!("hit-{i}")), i == 0, hover)
                        .h_auto()
                        .min_h(px(36.0))
                        .py(px(6.0))
                        .child(icon(row.glyph, 14.0, p.c(Token::MutedForeground)))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.0))
                                .flex()
                                .flex_col()
                                .gap(px(3.0))
                                .child(highlight(row.label, &query, &p))
                                .children(row.detail.map(|detail| {
                                    highlight(detail, &query, &p)
                                        .text_size(px(TEXT_XS))
                                        .muted(&p)
                                })),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.choose(hit.clone(), window, cx)
                        })),
                );
        }
        if let Some(status) = status {
            list = list.child(
                div()
                    .px(px(8.0))
                    .py(px(12.0))
                    .text_size(px(TEXT_SM))
                    .muted(&p)
                    .child(status),
            );
        }
        let include = self.search_results.include_archived;
        let body = dialog_card(&p, 560.0)
            .child(
                div()
                    .p(px(10.0))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .child(Input::new(&input).prefix(icon(
                        "search01",
                        14.0,
                        p.c(Token::MutedForeground),
                    ))),
            )
            .child(list)
            .child(
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .text_size(px(TEXT_XS))
                    .muted(&p)
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(if self.app_settings.language == UiLanguage::English {
                        "Enter opens the first result · Esc closes"
                    } else {
                        "Enter 打开第一项 · Esc 关闭"
                    })
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("search-archived")
                            .cursor_pointer()
                            .child(if include {
                                if self.app_settings.language == UiLanguage::English {
                                    "☑ Include archived chats"
                                } else {
                                    "☑ 包括已归档对话"
                                }
                            } else {
                                if self.app_settings.language == UiLanguage::English {
                                    "☐ Include archived chats"
                                } else {
                                    "☐ 包括已归档对话"
                                }
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.search_results.include_archived =
                                    !this.search_results.include_archived;
                                let query = this.search_results.query.clone();
                                this.search_palette(query, cx);
                            })),
                    ),
            );
        Some(
            div()
                .id("palette-backdrop")
                .absolute()
                .inset_0()
                .bg(hsla(0.0, 0.0, 0.0, 0.18))
                .flex()
                .flex_col()
                .items_center()
                .pt(px(96.0))
                .on_click(cx.listener(|this, _, window, cx| this.close_palette(window, cx)))
                .child(
                    div()
                        .id("palette-body")
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .child(body),
                )
                .into_any_element(),
        )
    }
}

/// Byte ranges for GPUI; skip highlighting when case folding changes byte offsets.
fn highlight_ranges(text: &str, query: &str) -> Vec<std::ops::Range<usize>> {
    let folded = text.to_lowercase();
    if query.is_empty()
        || text
            .chars()
            .any(|c| c.len_utf8() != c.to_lowercase().map(char::len_utf8).sum::<usize>())
    {
        return Vec::new();
    }
    folded
        .match_indices(query)
        .filter_map(|(i, _)| {
            let end = i + query.len();
            (text.is_char_boundary(i) && text.is_char_boundary(end)).then_some(i..end)
        })
        .take(3)
        .collect()
}

fn highlight(text: String, query: &str, p: &crate::theme::Palette) -> Div {
    let marks = highlight_ranges(&text, query)
        .into_iter()
        .map(|range| {
            (
                range,
                HighlightStyle {
                    background_color: Some(p.c(Token::Warning).opacity(0.3)),
                    ..Default::default()
                },
            )
        })
        .collect::<Vec<_>>();
    div()
        .overflow_hidden()
        .text_ellipsis()
        .child(StyledText::new(text).with_highlights(marks))
}

/// Only text a reader can see can be a navigation target.
pub(super) fn item_matches(item: &Item, query: &str) -> bool {
    let text = match item {
        Item::UserMessage { text, .. } | Item::AgentMessage { text, .. } => Some(text),
        Item::ToolCall { output, .. } => output.as_ref(),
        _ => None,
    };
    !query.is_empty() && text.is_some_and(|text| text.to_lowercase().contains(query))
}

pub(super) fn turn_matches(turn: &Turn, query: &str) -> bool {
    turn.items.iter().any(|item| item_matches(item, query))
}

#[cfg(test)]
mod tests {
    use super::highlight_ranges;
    #[test]
    fn navigation_ignores_private_items_and_matches_tool_output() {
        use fv_protocol::types::Item;
        assert!(!super::item_matches(
            &Item::Reasoning {
                id: "r".into(),
                text: "needle".into()
            },
            "needle"
        ));
        let call = Item::ToolCall {
            id: "c".into(),
            name: "exec_command".into(),
            arguments: serde_json::json!({"command": "argument-only"}),
            output: Some("Needle in output".into()),
            is_error: false,
        };
        assert!(super::item_matches(&call, "needle"));
        assert!(!super::item_matches(&call, "argument-only"));
    }

    #[test]
    fn highlights_are_literal_bounded_and_safe_after_unicode_folding() {
        assert_eq!(
            highlight_ranges("Foo.bar fooXbar FOO.BAR", "foo.bar"),
            [0..7, 16..23]
        );
        assert_eq!(
            highlight_ranges("中文 中文 中文 中文", "中文"),
            [0..6, 7..13, 14..20]
        );
        assert!(highlight_ranges("İstanbul", "i").is_empty());
        assert!(highlight_ranges("İİaaaK", "a").is_empty());
        assert!(highlight_ranges("abc", "").is_empty());
    }
}
