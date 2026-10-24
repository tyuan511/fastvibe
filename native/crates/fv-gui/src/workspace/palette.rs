//! 搜索 (⌘K): one box that finds a conversation by title, or runs one of the app's own
//! commands. Searching inside transcripts waits for a server call that reads them.

use fv_protocol::types::Thread;
use fv_theme::Token;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::*;

use super::settings::{Section, dialog_card, menu_item};
use super::{Workspace, text};
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon};

/// What a row of results does when chosen.
#[derive(Clone)]
enum Hit {
    NewChat,
    Settings,
    Thread(String),
}

impl Workspace {
    pub(super) fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search_box.is_some() {
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("搜索对话或命令"));
        input.update(cx, |st, cx| st.focus(window, cx));
        cx.subscribe_in(
            &input,
            window,
            |this, input, ev: &InputEvent, window, cx| match ev {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => {
                    let query = input.read(cx).value().trim().to_lowercase();
                    if let Some(hit) = this.palette_hits(&query).into_iter().next() {
                        this.choose(hit.0, window, cx);
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
            // Typing goes back to the composer.
            let input = self.input.clone();
            input.update(cx, |st, cx| st.focus(window, cx));
            cx.notify();
        }
    }

    /// Commands that match, then conversations that do, newest first.
    fn palette_hits(&self, query: &str) -> Vec<(Hit, String, &'static str)> {
        let mut hits = Vec::new();
        let matches = |label: &str| query.is_empty() || label.to_lowercase().contains(query);
        for (hit, label, glyph) in [
            (Hit::NewChat, text::NEW_CHAT, "message-square-plus"),
            (Hit::Settings, text::SETTINGS, "settings01"),
        ] {
            if matches(label) {
                hits.push((hit, label.to_string(), glyph));
            }
        }
        let mut threads: Vec<&Thread> = self.threads.iter().filter(|t| !t.archived).collect();
        threads.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
        for t in threads.into_iter().filter(|t| matches(&t.title)).take(20) {
            let title = if t.title.trim().is_empty() {
                text::UNTITLED.to_string()
            } else {
                t.title.clone()
            };
            hits.push((Hit::Thread(t.id.clone()), title, "message-square-plus"));
        }
        hits
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
            Hit::Thread(id) => {
                self.settings = None;
                self.select(id, cx);
            }
        }
    }

    pub(super) fn palette_view(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let input = self.search_box.clone()?;
        let colors = self.palette.clone();
        let p = &colors;
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
        if hits.is_empty() {
            list = list.child(
                div()
                    .px(px(8.0))
                    .py(px(12.0))
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child("没有匹配的结果"),
            );
        }
        for (i, (hit, label, glyph)) in hits.into_iter().enumerate() {
            list =
                list.child(
                    menu_item(SharedString::from(format!("hit-{i}")), i == 0, hover)
                        .h(px(36.0))
                        .child(icon(glyph, 14.0, p.c(Token::MutedForeground)))
                        .child(ui::truncate(label).flex_1())
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.choose(hit.clone(), window, cx)
                        })),
                );
        }
        let body = dialog_card(p, 560.0)
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
                    .muted(p)
                    .child("Enter 打开第一项 · Esc 关闭"),
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
