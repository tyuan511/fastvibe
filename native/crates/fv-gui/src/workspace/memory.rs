//! Long-term memory settings use the same protocol as every other client.
use crate::ui::px;
use fv_protocol::methods::{MemoryClear, MemoryConfigure, MemoryRead, MemoryRun};
use fv_protocol::types::{Empty, MemoryConfig, MemoryPhase, MemoryState, UiLanguage};
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::model_menu::{PickerRow, picker_row_view, picker_rows, provider_groups};
use super::personalization::{group, local_time, model_trigger, outline_sm, rich_row};
use super::settings::{Section, menu_item, popover, setting_row, switch};
use crate::ui::{Muted as _, TEXT_SM, icon};

fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

pub struct MemorySettings {
    session: u64,
    read: u64,
    busy: Option<u64>,
    state: Option<MemoryState>,
    error: Option<String>,
    models: bool,
    /// Which provider is unfolded under `models`. The pane lists its choices inline, so its second
    /// level opens under its provider rather than beside it.
    model_open: Option<String>,
    confirm_clear: bool,
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            session: next_id(),
            read: 0,
            busy: None,
            state: None,
            error: None,
            models: false,
            model_open: None,
            confirm_clear: false,
        }
    }
}

impl MemorySettings {
    fn accept(&mut self, state: MemoryState) {
        if self
            .state
            .as_ref()
            .is_none_or(|old| old.revision <= state.revision)
        {
            self.state = Some(state);
        }
    }

    /// Dev capture: the pane's model list is behind a disclosure and folds by provider, so a
    /// screenshot has to open both to show what a click would.
    pub(super) fn show_models_for_capture(&mut self, provider: Option<String>) {
        // The pane draws nothing until the host has answered, and the capture harness has no host.
        if self.state.is_none() {
            self.state = Some(MemoryState {
                revision: 0,
                config: MemoryConfig {
                    enabled: true,
                    model: Some("deepseek/deepseek-v4-pro".into()),
                },
                phase: MemoryPhase::Idle,
                conversations: 3,
                pending: 0,
                ready: true,
                last_run_at: None,
                error: None,
                folder: String::new(),
            });
        }
        self.models = true;
        self.model_open = provider;
    }
}

impl Workspace {
    pub(super) fn refresh_memory(&mut self, cx: &mut Context<Self>) {
        let Some(s) = self
            .settings
            .as_mut()
            .filter(|s| s.section == Section::Memory)
        else {
            return;
        };
        let Some(backend) = self.backend.clone() else {
            // The capture harness has no host; draw what a fresh install answers.
            #[cfg(feature = "capture")]
            if s.memory.state.is_none() {
                s.memory.state = Some(MemoryState {
                    revision: 0,
                    config: MemoryConfig::default(),
                    phase: MemoryPhase::Idle,
                    conversations: 0,
                    pending: 0,
                    ready: false,
                    last_run_at: None,
                    error: None,
                    folder: String::new(),
                });
            }
            return;
        };
        s.memory.read = next_id();
        let request = s.memory.read;
        let session = s.memory.session;
        cx.spawn(async move |this, cx| {
            let result = backend.call::<MemoryRead>(Empty {}).await;
            let _ = this.update(cx, |this, cx| {
                let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.memory.session == session && s.memory.read == request)
                else {
                    return;
                };
                match result {
                    Ok(state) => s.memory.accept(state),
                    Err(e) => s.memory.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn memory_changed(&mut self, state: MemoryState, cx: &mut Context<Self>) {
        if let Some(s) = &mut self.settings {
            s.memory.accept(state);
            cx.notify();
        }
    }

    fn memory_action(&mut self, config: Option<MemoryConfig>, clear: bool, cx: &mut Context<Self>) {
        let Some(s) = self
            .settings
            .as_mut()
            .filter(|s| s.section == Section::Memory && s.memory.busy.is_none())
        else {
            return;
        };
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let request = next_id();
        let session = s.memory.session;
        s.memory.busy = Some(request);
        s.memory.error = None;
        s.memory.models = false;
        s.memory.confirm_clear = false;
        cx.spawn(async move |this, cx| {
            let result = if clear {
                backend.call::<MemoryClear>(Empty {}).await
            } else if let Some(config) = config {
                backend.call::<MemoryConfigure>(config).await
            } else {
                backend.call::<MemoryRun>(Empty {}).await
            };
            let _ = this.update(cx, |this, cx| {
                let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.memory.session == session && s.memory.busy == Some(request))
                else {
                    return;
                };
                s.memory.busy = None;
                match result {
                    Ok(state) => s.memory.accept(state),
                    Err(e) => s.memory.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn memory_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let Some(s) = self.settings.as_ref() else {
            return div().into_any_element();
        };
        let memory = &s.memory;
        let Some(state) = &memory.state else {
            return div()
                .text_size(px(TEXT_SM))
                .muted(p)
                .child(
                    memory
                        .error
                        .clone()
                        .unwrap_or_else(|| trs!(english, "memory.loading_memory_status").into()),
                )
                .into_any_element();
        };
        let busy = memory.busy.is_some();
        let config = state.config.clone();
        let mut enabled = config.clone();
        enabled.enabled = !enabled.enabled;
        let model_label = config
            .model
            .as_ref()
            .map(|label| {
                self.models
                    .iter()
                    .find(|m| &m.label == label)
                    .map(|m| format!("{}/{}", m.provider_name, m.model.id))
                    .unwrap_or_else(|| label.clone())
            })
            .unwrap_or_else(|| trs!(english, "memory.follow_default_model").into());
        let mut model_choices = div().flex().flex_col();
        let follow_current = config.model.is_none();
        let mut follow = config.clone();
        follow.model = None;
        let hover = p.c(Token::Muted);
        model_choices = model_choices.child(
            menu_item("memory-model-follow".into(), follow_current, hover)
                .justify_between()
                .child(trs!(english, "memory.follow_default_model"))
                .when(follow_current, |d| {
                    d.child(icon("tick02", 14.0, p.c(Token::Foreground)))
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.memory_action(Some(follow.clone()), false, cx)
                })),
        );
        // Memory reads one model out of every provider's, so the list folds by provider the same
        // way the composer's chip does — inline here, because this picker lives in the pane.
        let open = memory.model_open.clone();
        let current = config.model.as_deref();
        for row in picker_rows(&provider_groups(&self.models), open.as_deref(), current) {
            let view =
                super::personalization::as_menu_row(picker_row_view("memory-model", &row, p));
            model_choices = model_choices.child(match row {
                PickerRow::Provider { id, .. } => {
                    view.on_click(cx.listener(move |this, _, _, cx| {
                        let Some(s) = this
                            .settings
                            .as_mut()
                            .filter(|s| s.section == Section::Memory)
                        else {
                            return;
                        };
                        s.memory.model_open = if s.memory.model_open.as_deref() == Some(id.as_str())
                        {
                            None
                        } else {
                            Some(id.clone())
                        };
                        cx.notify();
                    }))
                }
                PickerRow::Model { label, .. } => {
                    let mut chosen = config.clone();
                    chosen.model = Some(label.clone());
                    view.on_click(cx.listener(move |this, _, _, cx| {
                        this.memory_action(Some(chosen.clone()), false, cx)
                    }))
                }
            });
        }
        let status: SharedString = match state.phase {
            MemoryPhase::Extracting => trs!(english, "memory.extracting").into(),
            MemoryPhase::Consolidating => trs!(english, "memory.consolidating").into(),
            MemoryPhase::Idle if state.conversations == 0 => trs!(english, "memory.empty").into(),
            MemoryPhase::Idle => tr!(
                english,
                "memory.counts",
                count = state.conversations,
                pending = state.pending
            )
            .into(),
        };
        let root = state.folder.clone();
        let can_open = state.ready;
        let error = memory.error.clone().or_else(|| state.error.clone());
        let on = config.enabled;
        let idle = state.phase == MemoryPhase::Idle;
        let toggle = switch("memory-enabled".into(), on, p)
            .when(busy, |d| d.opacity(0.5))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.memory_action(Some(enabled.clone()), false, cx)
            }));
        let picker = model_trigger("memory-model-picker", model_label, 224.0, p).on_click(
            cx.listener(|this, _, _, cx| {
                if let Some(s) = &mut this.settings
                    && s.memory.busy.is_none()
                {
                    s.memory.models = !s.memory.models;
                    if !s.memory.models {
                        s.memory.model_open = None;
                    }
                    cx.notify();
                }
            }),
        );
        let picker = div().relative().child(picker).when(memory.models, |d| {
            d.child(crate::ui::float(
                popover(p)
                    .absolute()
                    .top(px(36.0))
                    .right(px(0.0))
                    .w(px(224.0))
                    .child(
                        div()
                            .id("memory-model-choices")
                            .max_h(px(280.0))
                            .overflow_y_scroll()
                            .child(model_choices),
                    ),
            ))
        });
        let run_disabled = busy || !on || !idle;
        let clear_disabled = busy || !idle || (!state.ready && state.conversations == 0);
        let status_desc = div()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(status)
            .children(
                state
                    .last_run_at
                    .map(|at| div().child(tr!(english, "memory.last_run", time = local_time(at)))),
            )
            .children(error.map(|error| div().text_color(p.c(Token::Destructive)).child(error)))
            .children(memory.confirm_clear.then(|| {
                div()
                    .text_color(p.c(Token::Destructive))
                    .child(trs!(english, "memory.clear_confirm"))
            }));
        let files = div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                outline_sm("memory-folder", p)
                    .when(!can_open, |d| d.opacity(0.5))
                    .child(trs!(english, "memory.open_folder"))
                    .on_click(move |_, _, cx| {
                        if can_open {
                            cx.reveal_path(std::path::Path::new(&root));
                        }
                    }),
            )
            .child(
                outline_sm("memory-clear", p)
                    .when(clear_disabled, |d| d.opacity(0.5))
                    .when(memory.confirm_clear, |d| {
                        d.text_color(p.c(Token::Destructive))
                    })
                    .child(if memory.confirm_clear {
                        trs!(english, "memory.confirm_clear")
                    } else {
                        trs!(english, "memory.clear")
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if clear_disabled {
                            return;
                        }
                        let confirm = this
                            .settings
                            .as_ref()
                            .is_some_and(|s| s.memory.confirm_clear);
                        if confirm {
                            this.memory_action(None, true, cx);
                        } else if let Some(s) = &mut this.settings {
                            s.memory.confirm_clear = true;
                            cx.notify();
                        }
                    })),
            );
        div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(group(
                Some(trs!(english, "memory.title")),
                p,
                [
                    setting_row(
                        trs!(english, "memory.enable"),
                        trs!(english, "memory.enable_desc"),
                        false,
                        p,
                        toggle,
                    )
                    .into_any_element(),
                    setting_row(
                        trs!(english, "memory.model"),
                        trs!(english, "memory.model_desc"),
                        true,
                        p,
                        picker,
                    )
                    .into_any_element(),
                ],
            ))
            .child(group(
                Some(trs!(english, "memory.data_title")),
                p,
                [
                    rich_row(
                        trs!(english, "memory.status"),
                        Some(status_desc.into_any_element()),
                        false,
                        p,
                        outline_sm("memory-run", p)
                            .when(run_disabled, |d| d.opacity(0.5))
                            .child(trs!(english, "memory.run_now"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !run_disabled {
                                    this.memory_action(None, false, cx);
                                }
                            })),
                    )
                    .into_any_element(),
                    setting_row(
                        trs!(english, "memory.files"),
                        trs!(english, "memory.files_desc"),
                        true,
                        p,
                        files,
                    )
                    .into_any_element(),
                ],
            ))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::MemorySettings;
    use fv_protocol::types::{MemoryConfig, MemoryPhase, MemoryState};

    fn state(revision: u64) -> MemoryState {
        MemoryState {
            revision,
            config: MemoryConfig::default(),
            phase: MemoryPhase::Idle,
            conversations: revision as u32,
            pending: 0,
            ready: false,
            last_run_at: None,
            error: None,
            folder: "/memory".into(),
        }
    }

    #[test]
    fn a_late_read_cannot_replace_a_newer_memory_notification() {
        let mut settings = MemorySettings::default();
        settings.accept(state(12));
        settings.accept(state(11));
        assert_eq!(settings.state.as_ref().unwrap().conversations, 12);
        settings.accept(state(13));
        assert_eq!(settings.state.as_ref().unwrap().conversations, 13);
        assert_ne!(settings.session, MemorySettings::default().session);
    }
}
