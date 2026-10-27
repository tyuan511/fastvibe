//! Long-term memory settings use the same protocol as every other client.
use fv_protocol::methods::{MemoryClear, MemoryConfigure, MemoryRead, MemoryRun};
use fv_protocol::types::{Empty, MemoryConfig, MemoryPhase, MemoryState, UiLanguage};
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::settings::{Section, card, outline_button, switch};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

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
        let mut model_choices = div().flex().flex_col().gap(px(4.0));
        for (index, (label, name)) in std::iter::once((
            None,
            trs!(english, "memory.follow_default_model").to_string(),
        ))
        .chain(self.models.iter().map(|m| {
            (
                Some(m.label.clone()),
                format!("{}/{}", m.provider_name, m.model.id),
            )
        }))
        .enumerate()
        {
            let mut chosen = config.clone();
            chosen.model = label;
            model_choices = model_choices.child(
                outline_button(SharedString::from(format!("memory-model-{index}")), p)
                    .child(name)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.memory_action(Some(chosen.clone()), false, cx)
                    })),
            );
        }
        let status = match state.phase {
            MemoryPhase::Extracting => {
                trs!(english, "memory.extracting_memories")
            }
            MemoryPhase::Consolidating => {
                trs!(english, "memory.consolidating_memories")
            }
            MemoryPhase::Idle if state.ready => {
                trs!(english, "memory.memory_is_ready")
            }
            MemoryPhase::Idle => {
                trs!(english, "memory.no_memories_generated_yet")
            }
        };
        let status_text = tr!(
            english,
            "memory.status_arg1_conversations_consolidated_arg2",
            arg1 = state.conversations,
            arg2 = state.pending,
            status = status
        );
        let root = state.folder.clone();
        let can_open = state.ready;
        let error = memory.error.clone().or_else(|| state.error.clone());
        let on = config.enabled;
        let toggle = switch("memory-enabled".into(), on, p)
            .when(busy, |d| d.opacity(0.5))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.memory_action(Some(enabled.clone()), false, cx)
            }));
        let header = div()
            .p(px(16.0))
            .flex()
            .items_center()
            .gap(px(12.0))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .child(trs!(english, "memory.long_term_memory")),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(trs!(english, "memory.extract_experience_from_chats_idle")),
                    ),
            )
            .child(toggle);
        let model_picker = div()
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .child(trs!(english, "memory.consolidation_model")),
            )
            .child(
                outline_button("memory-model-picker", p)
                    .child(crate::ui::truncate(model_label))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(s) = &mut this.settings
                            && s.memory.busy.is_none()
                        {
                            s.memory.models = !s.memory.models;
                            cx.notify();
                        }
                    })),
            )
            .children(memory.models.then(|| {
                div()
                    .id("memory-model-choices")
                    .max_h(px(240.0))
                    .overflow_y_scroll()
                    .child(model_choices)
            }));
        let actions = div()
            .flex()
            .items_center()
            .flex_wrap()
            .gap(px(8.0))
            .child(
                outline_button("memory-run", p)
                    .when(busy || !on || state.phase != MemoryPhase::Idle, |d| {
                        d.opacity(0.5)
                    })
                    .child(trs!(english, "memory.run_now"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if on {
                            this.memory_action(None, false, cx);
                        }
                    })),
            )
            .child(
                outline_button("memory-folder", p)
                    .when(!can_open, |d| d.opacity(0.5))
                    .child(trs!(english, "memory.open_folder"))
                    .on_click(move |_, _, cx| {
                        if can_open {
                            cx.reveal_path(std::path::Path::new(&root));
                        }
                    }),
            )
            .child(
                outline_button("memory-clear", p)
                    .child(if memory.confirm_clear {
                        trs!(english, "memory.confirm_clear_all_memories")
                    } else {
                        trs!(english, "memory.clear_memories")
                    })
                    .text_color(p.c(Token::Destructive))
                    .on_click(cx.listener(|this, _, _, cx| {
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
        let details = div()
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(div().text_size(px(TEXT_SM)).child(status_text))
            .children(state.last_run_at.map(|at| {
                div().text_size(px(TEXT_XS)).muted(p).child(tr!(
                    english,
                    "memory.last_run_arg1_minutes_ago",
                    arg1 = ((now_ms() - at) / 60_000).max(0)
                ))
            }))
            .children(error.map(|error| {
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(error)
            }))
            .child(actions)
            .children(memory.confirm_clear.then(|| {
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(trs!(
                        english,
                        "memory.clearing_deletes_existing_memories_and"
                    ))
            }));
        div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(card(p).child(header))
            .child(card(p).child(model_picker))
            .child(card(p).child(details))
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
