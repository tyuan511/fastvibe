//! The composer, after `components/chat/composer.tsx`: a 22px-round card holding the text area,
//! and under it the attach button, the model and thinking chip, and send / stop.

use fv_protocol::types::ThinkingLevel;
use fv_theme::Token;
use gpui_kit::component::Sizable as _;
use gpui_kit::component::input::Textarea;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::transcript::{THREAD_MAX, THREAD_PAD};
use super::{Workspace, text};
use crate::ui::{Muted as _, TEXT_SM, icon};

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
    pub(super) fn composer(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
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
        let thinking = self
            .selected
            .as_ref()
            .and_then(|id| self.views.get(id))
            .and_then(|v| v.thread.thinking)
            .or(self.defaults.thinking)
            .map(thinking_label);

        // How full the model's window is: a ring that warms up as it nears the limit.
        let usage = self
            .selected
            .as_ref()
            .and_then(|id| self.views.get(id))
            .and_then(|v| v.token_usage)
            .filter(|u| u.window > 0);
        let context_ring = usage.map(|u| {
            let fraction = u.used as f32 / u.window as f32;
            let color = if fraction >= 0.9 {
                p.c(Token::Destructive)
            } else if fraction >= 0.7 {
                p.c(Token::Warning)
            } else {
                p.c(Token::MutedForeground)
            };
            div()
                .id("context-ring")
                .size(px(28.0))
                .flex()
                .items_center()
                .justify_center()
                .child(crate::ui::ring(fraction, 14.0, p.c(Token::Border), color))
        });
        let send_enabled = running || !empty;
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
            .child(icon(
                if running { "square" } else { "arrow-up02" },
                16.0,
                p.c(Token::PrimaryForeground),
            ))
            .on_click(cx.listener(move |this, _, window, cx| {
                if running {
                    this.interrupt(cx);
                } else {
                    this.send(window, cx);
                }
            }));

        let chip_hover = p.c(Token::Accent);
        let chip = div()
            .id("model-chip")
            .h(px(28.0))
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
            .child(SharedString::from(model_text))
            .when_some(thinking, |d, t| d.child(div().ml(px(4.0)).child(t)))
            .child(icon("arrow-down01", 12.0, p.c(Token::MutedForeground)))
            .on_click(cx.listener(|this, _, _, cx| {
                this.model_menu = !this.model_menu;
                cx.notify();
            }));

        let menu = self.model_menu.then(|| self.model_menu(cx));
        // Only a conversation that does not exist yet can still choose where it runs.
        let project_row = self.selected.is_none().then(|| self.project_chip(cx));
        let send_error = self.send_error.clone();

        div()
            .w_full()
            .max_w(px(THREAD_MAX))
            .mx_auto()
            .px(px(THREAD_PAD))
            .pb(px(20.0))
            .flex_none()
            .children(project_row)
            .children(send_error.map(|e| {
                div()
                    .mb(px(8.0))
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(12.0))
                    .border_1()
                    .border_color(p.c(Token::Destructive).opacity(0.25))
                    .bg(p.c(Token::Destructive).opacity(0.05))
                    .text_size(px(TEXT_SM))
                    .text_color(p.c(Token::Destructive))
                    .child(SharedString::from(e))
            }))
            .child(
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
                            .min_h(px(52.0))
                            .pt(px(12.0))
                            .px(px(8.0))
                            .pb(px(6.0))
                            .text_size(px(TEXT_SM))
                            .line_height(px(24.0))
                            .child(
                                Textarea::new(&self.input)
                                    .appearance(false)
                                    .bordered(false)
                                    // Its text is 0.875 of its size: 16 gives `text-sm`.
                                    .with_size(gpui_kit::component::Size::Size(px(16.0))),
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
                            .child(div().flex_1())
                            .children(context_ring)
                            .child(chip)
                            .child(send),
                    )
                    .children(menu.map(crate::ui::float)),
            )
    }

    fn model_menu(&self, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let mut list = div()
            .absolute()
            .bottom(px(44.0))
            .right(px(10.0))
            .min_w(px(280.0))
            .p(px(4.0))
            .rounded(px(12.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.get(Token::GlassOverlay).unwrap_or(p.c(Token::Popover)))
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
                    .child(SharedString::from(format!(
                        "{}/{}",
                        m.provider_name, m.model.id
                    )))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.pick_model(label.clone(), cx)),
                    ),
            );
        }
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
                .on_click(cx.listener(|this, _, window, cx| {
                    this.model_menu = false;
                    this.open_settings(super::settings::Section::Providers, window, cx)
                })),
        );
        list
    }

    /// 选择项目: the folder chip above a new conversation's composer, and its list.
    fn project_chip(&self, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let hover = p.c(Token::Muted);
        let label = match &self.draft_project {
            Some(path) => super::transcript::project_name(path).to_string(),
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
                .bg(p.get(Token::GlassOverlay).unwrap_or(p.c(Token::Popover)))
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
                        .child(crate::ui::truncate(
                            super::transcript::project_name(project).to_string(),
                        ))
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
            .children(menu.map(crate::ui::float))
    }
}
