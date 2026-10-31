//! ⌘K: commands, recent conversations and full-text transcript search over the shared protocol.

use crate::ui::px;
use fv_protocol::{methods::ThreadSearch, types::*};
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;

use super::Workspace;
use super::settings::{Section, all_sections, dialog_card};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon};
use fv_protocol::shortcuts::{Chord, ShortcutId, resolve};
use gpui_kit::prelude::FluentBuilder as _;

#[derive(Clone)]
enum Hit {
    NewChat,
    OpenFolder,
    Settings(Section),
    Thread(String, Option<String>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Group {
    Chats,
    Actions,
    Settings,
}

struct Row {
    hit: Hit,
    group: Group,
    label: String,
    glyph: Option<&'static str>,
    /// The excerpt under a chat's title: where the query sits in its text.
    snippet: Option<String>,
    project: Option<String>,
    archived: bool,
    shortcut: Option<String>,
}

#[derive(Default)]
pub(super) struct SearchResults {
    generation: u64,
    query: String,
    hits: Vec<ThreadSearchHit>,
    loading: bool,
    error: Option<String>,
    include_archived: bool,
    /// The highlighted row (`data-selected`), moved by ↑/↓ and taken by Enter.
    selected: usize,
}

/// The words each settings pane is also found by (`app:palette.keywords`). Its name and icon
/// come from the settings list itself, so a renamed pane cannot drift here.
const SETTINGS: &[(Section, &str)] = &[
    (
        Section::General,
        "外观 主题 字号 界面 发送 思考 队列 时间戳 打断 appearance theme font general",
    ),
    (
        Section::Personalization,
        "个性化 指令 personalization instructions",
    ),
    (Section::Shortcuts, "键盘 热键 keymap keyboard shortcuts"),
    (
        Section::Archived,
        "恢复 删除 archive restore delete archived",
    ),
    (Section::Usage, "token 费用 统计 usage cost"),
    (
        Section::Import,
        "导入 迁移 claude codex opencode zcode pi 会话 import",
    ),
    (
        Section::Providers,
        "供应商 api 密钥 模型 providers models key",
    ),
    (Section::Subagents, "子代理 subagents agents"),
    (Section::Memory, "记忆 memory"),
    (Section::Mcp, "工具 mcp tools"),
    (Section::Skills, "skill 技能 skills"),
    (Section::Computer, "电脑 操控 computer use"),
    (Section::Browser, "浏览器 browser"),
    (Section::Proxy, "代理 proxy network"),
    (
        Section::Remote,
        "远程 手机 网页 服务器 密码 设备 remote server password device phone web",
    ),
    (Section::Ssh, "ssh 主机 服务器 hosts server"),
    (Section::About, "版本 about version"),
];

impl Workspace {
    pub(super) fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search_box.is_some() {
            return;
        }
        self.search_results = SearchResults {
            generation: self.search_results.generation + 1,
            ..Default::default()
        };
        let english = self.app_settings.language == UiLanguage::English;
        let input = cx.new(|cx| {
            InputState::new(window, cx).placeholder(trs!(english, "palette.placeholder"))
        });
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
                    let selected = this.search_results.selected;
                    let mut rows = this.palette_hits(&query);
                    if selected < rows.len() {
                        let row = rows.swap_remove(selected);
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
        s.selected = 0;
        // Like the Electron palette, one character only filters titles; the transcript search
        // starts at two.
        s.loading = query.chars().count() >= 2;
        let generation = s.generation;
        let include_archived = s.include_archived;
        cx.notify();
        if !s.loading {
            return;
        }
        let english = self.app_settings.language == UiLanguage::English;
        let Some(b) = self.backend.clone() else {
            self.search_results.loading = false;
            self.search_results.error = Some(trs!(english, "palette.offline").into());
            return;
        };
        let delay = cx
            .background_executor()
            .timer(std::time::Duration::from_millis(180));
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
                    Err(e) => {
                        this.search_results.error =
                            Some(tr!(english, "palette.failed", error = e.to_string()))
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn palette_hits(&self, query: &str) -> Vec<Row> {
        let english = self.app_settings.language == UiLanguage::English;
        let mac = cfg!(target_os = "macos");
        let shortcut = |id: ShortcutId| {
            resolve(id, &self.app_settings.shortcuts)
                .and_then(|s| Chord::parse(s).ok())
                .map(|c| c.label(mac))
        };
        let mut rows = Vec::new();
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
                        .is_some_and(|p| self.project_label(p).to_lowercase().contains(query))
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
        for (i, (t, snippet)) in threads
            .into_iter()
            .take(if query.is_empty() { 9 } else { 50 })
            .enumerate()
        {
            let body_query = snippet.as_ref().map(|_| query.to_string());
            rows.push(Row {
                hit: Hit::Thread(t.id, body_query),
                group: Group::Chats,
                label: if t.title.trim().is_empty() {
                    trs!(english, "palette.new_session").to_string()
                } else {
                    t.title
                },
                glyph: None,
                snippet: snippet
                    .filter(|_| !query.is_empty())
                    .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")),
                project: t.project.as_deref().map(|p| self.project_label(p)),
                archived: t.archived,
                shortcut: query
                    .is_empty()
                    .then(|| format!("{}{}", if mac { "⌘" } else { "Ctrl+" }, i + 1)),
            });
        }
        for (hit, label, keywords, glyph, id) in [
            (
                Hit::NewChat,
                trs!(english, "palette.new_chat"),
                trs!(english, "palette.keywords.new"),
                "message-square-plus",
                ShortcutId::NewChat,
            ),
            (
                Hit::OpenFolder,
                trs!(english, "palette.open_folder"),
                trs!(english, "palette.keywords.folder"),
                "folder01",
                ShortcutId::OpenFolder,
            ),
            (
                Hit::Settings(Section::General),
                trs!(english, "palette.settings"),
                trs!(english, "palette.keywords.settings"),
                "settings01",
                ShortcutId::Settings,
            ),
        ] {
            if query.is_empty() || format!("{label} {keywords}").to_lowercase().contains(query) {
                rows.push(Row {
                    hit,
                    group: Group::Actions,
                    label: label.into(),
                    glyph: Some(glyph),
                    snippet: None,
                    project: None,
                    archived: false,
                    shortcut: shortcut(id),
                });
            }
        }
        if !query.is_empty() {
            let available = all_sections();
            for (section, keywords) in SETTINGS {
                if !available.contains(section) {
                    continue;
                }
                let zh = super::settings::section_label_for(*section, UiLanguage::Chinese);
                let en = super::settings::section_label_for(*section, UiLanguage::English);
                let label = if english { en } else { zh };
                let glyph = super::settings::section_icon(*section);
                let prefix = trs!(english, "palette.group_settings");
                if format!("{prefix} {label} {zh} {en} {keywords}")
                    .to_lowercase()
                    .contains(query)
                {
                    rows.push(Row {
                        hit: Hit::Settings(*section),
                        group: Group::Settings,
                        label: label.into(),
                        glyph: Some(glyph),
                        snippet: None,
                        project: None,
                        archived: false,
                        shortcut: None,
                    });
                }
            }
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
            Hit::OpenFolder => {
                self.settings = None;
                self.open_project_dialog(None, window, cx);
            }
            Hit::Settings(section) => self.open_settings(section, window, cx),
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
        let english = self.app_settings.language == UiLanguage::English;
        let query = input.read(cx).value().trim().to_lowercase();
        let hits = self.palette_hits(&query);
        let count = hits.len();
        let selected = self.search_results.selected.min(count.saturating_sub(1));
        let muted_bg = p.c(Token::Muted);
        let mut list = div()
            .id("palette-list")
            .max_h(px(432.0))
            .overflow_y_scroll()
            .flex()
            .flex_col();
        let mut group: Option<(Group, Div)> = None;
        let heading = |g: Group| {
            div()
                .px(px(8.0))
                .py(px(6.0))
                .text_size(px(TEXT_XS))
                .line_height(px(16.0))
                .font_weight(FontWeight::MEDIUM)
                .muted(&p)
                .child(match g {
                    Group::Chats => trs!(english, "palette.group_chats"),
                    Group::Actions => trs!(english, "palette.group_actions"),
                    Group::Settings => trs!(english, "palette.group_settings"),
                })
        };
        for (i, row) in hits.into_iter().enumerate() {
            if group.as_ref().is_none_or(|(g, _)| *g != row.group) {
                if let Some((_, done)) = group.take() {
                    list = list.child(done);
                }
                group = Some((
                    row.group,
                    div().p(px(4.0)).flex().flex_col().child(heading(row.group)),
                ));
            }
            let hit = row.hit;
            let active = i == selected;
            let title = div()
                .flex()
                .items_center()
                .min_w_0()
                .child(highlight(row.label, &query, &p).min_w_0())
                .when(row.archived, |d| {
                    d.child(
                        div()
                            .flex_none()
                            .ml(px(8.0))
                            .text_size(px(TEXT_XS))
                            .muted(&p)
                            .child(trs!(english, "palette.archived")),
                    )
                });
            let item = div()
                .id(SharedString::from(format!("hit-{i}")))
                .min_h(px(32.0))
                .px(px(8.0))
                .py(px(6.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .rounded(px(10.0))
                .text_size(px(TEXT_SM))
                .line_height(px(20.0))
                .cursor_pointer()
                .when(active, |d| d.bg(muted_bg))
                .hover(move |d| d.bg(muted_bg))
                .children(row.glyph.map(|g| {
                    icon(
                        g,
                        14.0,
                        if active {
                            p.c(Token::Foreground)
                        } else {
                            p.c(Token::MutedForeground)
                        },
                    )
                }))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .flex()
                        .flex_col()
                        .child(title)
                        .children(row.snippet.map(|snippet| {
                            highlight(snippet, &query, &p)
                                .text_size(px(TEXT_XS))
                                .muted(&p)
                        })),
                )
                .children(row.project.map(|project| {
                    crate::ui::truncate(project)
                        .flex_none()
                        .max_w(px(128.0))
                        .text_size(px(TEXT_XS))
                        .muted(&p)
                }))
                .children(row.shortcut.map(|s| kbd(s, &p)))
                .on_click(
                    cx.listener(move |this, _, window, cx| this.choose(hit.clone(), window, cx)),
                );
            group = group.map(|(g, d)| (g, d.child(item)));
        }
        if let Some((_, done)) = group.take() {
            list = list.child(done);
        }
        let status = self.search_results.error.clone().or_else(|| {
            if count == 0 && self.search_results.loading {
                Some(trs!(english, "palette.searching").into())
            } else if count == 0 {
                Some(trs!(english, "palette.empty").into())
            } else {
                None
            }
        });
        if let Some(status) = status {
            list = list.child(
                div()
                    .py(px(24.0))
                    .flex()
                    .justify_center()
                    .text_size(px(TEXT_SM))
                    .child(status),
            );
        }
        let include = self.search_results.include_archived;
        let body = dialog_card(&p, 512.0)
            .rounded(px(10.0))
            .overflow_hidden()
            .text_size(px(TEXT_SM))
            .child(
                div().p(px(4.0)).pb_0().child(
                    div()
                        .h(px(32.0))
                        .pl(px(8.0))
                        .rounded(px(10.0))
                        .border_1()
                        .border_color(p.c(Token::Input).opacity(0.3))
                        .bg(p.c(Token::Input).opacity(0.3))
                        .flex()
                        .items_center()
                        .child(icon("search01", 16.0, p.c(Token::Foreground).opacity(0.5)))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(
                                    crate::ui::input(&input)
                                        .h_8()
                                        .py_0()
                                        .appearance(false)
                                        .bordered(false),
                                ),
                        ),
                ),
            )
            .child(
                div()
                    .id("search-archived")
                    .px(px(12.0))
                    .py(px(8.0))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_XS))
                    .muted(&p)
                    .cursor_pointer()
                    .child(super::settings::checkbox(include, &p))
                    .child(trs!(english, "palette.include_archived"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.search_results.include_archived =
                            !this.search_results.include_archived;
                        let query = this.search_results.query.clone();
                        this.search_palette(query, cx);
                    })),
            )
            .child(list);
        Some(
            div()
                .id("palette-backdrop")
                .absolute()
                .inset_0()
                .bg(hsla(0.0, 0.0, 0.0, 0.18))
                .flex()
                .flex_col()
                .items_center()
                .on_click(cx.listener(|this, _, window, cx| this.close_palette(window, cx)))
                // `top-1/3`.
                .child(div().flex_none().h(relative(1.0 / 3.0)))
                .child(
                    div()
                        .id("palette-body")
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .capture_key_down(cx.listener(
                            move |this, ev: &KeyDownEvent, window, cx| {
                                let key = ev.keystroke.key.as_str();
                                let m = &ev.keystroke.modifiers;
                                match key {
                                    "down" | "up" if count > 0 => {
                                        let s = &mut this.search_results;
                                        s.selected = if key == "down" {
                                            (selected + 1) % count
                                        } else {
                                            (selected + count - 1) % count
                                        };
                                        cx.stop_propagation();
                                        cx.notify();
                                    }
                                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
                                        if (m.platform || m.control)
                                            && this.search_results.query.is_empty() =>
                                    {
                                        let n = key.parse::<usize>().unwrap_or(1) - 1;
                                        let mut rows = this.palette_hits("");
                                        rows.retain(|r| r.group == Group::Chats);
                                        if n < rows.len() {
                                            cx.stop_propagation();
                                            let row = rows.swap_remove(n);
                                            this.choose(row.hit, window, cx);
                                        }
                                    }
                                    _ => {}
                                }
                            },
                        ))
                        .child(body),
                )
                .into_any_element(),
        )
    }
}

/// `Kbd`: a 20px key cap of `text-xs`.
fn kbd(label: String, p: &crate::theme::Palette) -> Div {
    div()
        .flex_none()
        .h(px(20.0))
        .min_w(px(20.0))
        .px(px(4.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.0))
        .bg(p.c(Token::Muted))
        .text_size(px(TEXT_XS))
        .font_weight(FontWeight::MEDIUM)
        .muted(p)
        .child(label)
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
