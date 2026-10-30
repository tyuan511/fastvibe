//! Electron's `TerminalPanel`: one frame, a separately folding command, and bounded stdout.

use crate::{
    assets::MONO_FONT,
    presentation,
    theme::Palette,
    ui::{self, TEXT_SM, px},
};
use fv_theme::Token;
use gpui_kit::{
    base::{Button, SelectableText},
    component::scroll::ScrollableElement as _,
    prelude::FluentBuilder as _,
    *,
};

#[derive(Default)]
struct CommandState {
    command: SharedString,
    expanded: bool,
    overflows: bool,
    measured: Option<(Pixels, Pixels)>,
}

#[derive(IntoElement)]
pub(super) struct TerminalTool {
    pub id: SharedString,
    pub command: SharedString,
    pub prompt: Option<&'static str>,
    pub running: bool,
    pub output: Option<SharedString>,
    pub english: bool,
    pub palette: Palette,
}

impl RenderOnce for TerminalTool {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let p = &self.palette;
        let command: SharedString = presentation::unwrap_shell_command(&self.command)
            .to_string()
            .into();
        let state = window.use_keyed_state(
            SharedString::from(format!("terminal-command-state-{}", self.id)),
            cx,
            |_, _| CommandState::default(),
        );
        state.update(cx, |s, _| {
            if s.command != command {
                *s = CommandState {
                    command: command.clone(),
                    ..Default::default()
                };
            }
        });
        let expanded = state.read(cx).expanded;
        let overflows = state.read(cx).overflows;
        let measure_state = state.clone();
        let measure_command = command.clone();
        // Measure the complete command at its actual text width, even when its visible
        // text is clamped. Width/font changes (pane resize and interface scale) remeasure.
        let measure = canvas(
            move |bounds, window, cx| {
                let style = window.text_style();
                let font_size = style.font_size.to_pixels(window.rem_size());
                let measured = (bounds.size.width, font_size);
                if measure_state.read(cx).measured == Some(measured) {
                    return;
                }
                let lines = window
                    .text_system()
                    .shape_text(
                        measure_command.clone(),
                        font_size,
                        &[style.to_run(measure_command.len())],
                        Some(bounds.size.width),
                        None,
                    )
                    .unwrap_or_default();
                let line_height = window.rem_size() * (20.0 / 16.0);
                let height: Pixels = lines.iter().map(|line| line.size(line_height).height).sum();
                let overflows = height > line_height * 3.0 + gpui_kit::px(1.0);
                let state = measure_state.clone();
                cx.defer(move |cx| {
                    state.update(cx, |s, cx| {
                        if s.command != measure_command {
                            return;
                        }
                        let changed = s.overflows != overflows;
                        s.overflows = overflows;
                        s.measured = Some(measured);
                        if changed {
                            cx.notify();
                        }
                    })
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        let command_text = div()
            .flex_1()
            .min_w_0()
            .when(overflows, |d| d.pr(px(24.0)))
            .child(
                div()
                    .relative()
                    .w_full()
                    .when(!expanded, |d| d.line_clamp(3))
                    .child(
                        SelectableText::new(
                            SharedString::from(format!("terminal-command-text-{}", self.id)),
                            command,
                        )
                        .selection_color(p.c(Token::Primary).opacity(0.25)),
                    )
                    .child(measure),
            );
        let command_body = div()
            .w_full()
            .min_w_0()
            .flex()
            .items_start()
            .gap(px(8.0))
            .px(px(16.0))
            .py(px(12.0))
            .children(self.prompt.map(|prompt| {
                div()
                    .flex_none()
                    .text_color(p.c(Token::MutedForeground))
                    .child(prompt)
            }))
            .child(command_text);
        let command_view: AnyElement = if expanded {
            div()
                .id(SharedString::from(format!(
                    "terminal-command-scroll-{}",
                    self.id
                )))
                .w_full()
                .max_h(px(184.0))
                .child(command_body)
                .overflow_y_scrollbar()
                .id(SharedString::from(format!(
                    "terminal-command-scroll-{}",
                    self.id
                )))
                .into_any_element()
        } else {
            command_body.into_any_element()
        };
        let mut header = div().relative().w_full().min_w_0().child(command_view);
        if overflows {
            let label = trs!(
                self.english,
                if expanded {
                    "transcript.collapse"
                } else {
                    "transcript.expand"
                }
            );
            header = header.child(
                Button::new(SharedString::from(format!(
                    "terminal-command-toggle-{}",
                    self.id
                )))
                .absolute()
                .top(px(12.0))
                .right(px(12.0))
                .size(px(20.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.0))
                .accessibility_label(label)
                .cursor_pointer()
                .hover({
                    let hover = p.c(Token::Accent);
                    move |d| d.bg(hover)
                })
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx)
                })
                .child(ui::icon(
                    if expanded {
                        "arrow-up01"
                    } else {
                        "arrow-down01"
                    },
                    14.0,
                    p.c(Token::MutedForeground),
                ))
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    state.update(cx, |s, cx| {
                        s.expanded = !s.expanded;
                        cx.notify();
                    });
                }),
            );
        }
        let output = presentation::terminal_output(self.output.as_deref().unwrap_or_default());
        div()
            .w_full()
            .min_w_0()
            .mb(px(4.0))
            .overflow_hidden()
            .rounded(px(12.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Muted).opacity(0.3))
            .font_family(MONO_FONT)
            .text_size(px(TEXT_SM))
            .line_height(px(20.0))
            .text_color(p.c(Token::Foreground))
            .child(header)
            .when(!output.is_empty(), |d| {
                d.child(
                    div()
                        .id(SharedString::from(format!(
                            "terminal-output-scroll-{}",
                            self.id
                        )))
                        .w_full()
                        .min_w_0()
                        .max_h(px(288.0))
                        .px(px(16.0))
                        .pb(px(12.0))
                        .text_color(p.c(Token::MutedForeground))
                        .child(
                            SelectableText::new(
                                SharedString::from(format!("terminal-output-text-{}", self.id)),
                                output,
                            )
                            .selection_color(p.c(Token::Primary).opacity(0.25)),
                        )
                        .overflow_y_scrollbar()
                        .id(SharedString::from(format!(
                            "terminal-output-scroll-{}",
                            self.id
                        ))),
                )
            })
            .when(
                !self.running
                    && self.output.is_some()
                    && self.output.as_deref().is_some_and(|s| s.trim().is_empty()),
                |d| {
                    d.child(
                        div()
                            .px(px(16.0))
                            .pb(px(12.0))
                            .text_color(p.c(Token::MutedForeground))
                            .child(trs!(self.english, "transcript.no_output")),
                    )
                },
            )
    }
}
