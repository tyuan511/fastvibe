//! User-authored Agent instructions. Notifications update pristine fields, while a dirty
//! draft stays local until an explicit save or reload. The server guards concurrent edits.

use fv_protocol::methods::SettingsSet;
use fv_protocol::types::{AppSettingsPatch, UiLanguage};
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::settings::{card, outline_button};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS};

fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[derive(Clone)]
struct Submission {
    id: u64,
    text: String,
    expected: String,
}

struct Draft {
    base: String,
    current: String,
    latest: String,
    saving: Option<Submission>,
    /// Keep until its broadcast arrives, even if the RPC response arrives first.
    submitted: Option<String>,
    sync_editor: bool,
    notice: Option<String>,
}

impl Draft {
    fn new(saved: &str) -> Self {
        Self {
            base: saved.into(),
            current: saved.into(),
            latest: saved.into(),
            saving: None,
            submitted: None,
            sync_editor: true,
            notice: None,
        }
    }

    fn edit(&mut self, text: String) {
        self.current = text;
        if self.current == self.latest {
            self.base.clone_from(&self.latest);
        }
    }

    fn observe(&mut self, saved: &str) {
        let pristine = self.current == self.base;
        self.latest = saved.into();
        if self.submitted.as_deref() == Some(saved) {
            // Preserve typing and undo that happened after Save, even a return to the old base.
            self.base = saved.into();
            self.submitted = None;
        } else if (pristine && self.submitted.is_none()) || self.current == saved {
            self.sync_editor |= self.current != saved;
            self.current = saved.into();
            self.base = saved.into();
        }
    }

    fn conflict(&self) -> bool {
        self.base != self.latest && self.current != self.latest
    }

    fn begin(&mut self, overwrite: bool) -> Option<Submission> {
        if self.saving.is_some() || self.current == self.latest || (self.conflict() && !overwrite) {
            return None;
        }
        let submission = Submission {
            id: next_id(),
            text: self.current.clone(),
            expected: self.latest.clone(),
        };
        self.saving = Some(submission.clone());
        self.submitted = Some(submission.text.clone());
        self.notice = None;
        Some(submission)
    }

    fn finish(&mut self, id: u64, result: Result<(), String>) {
        if !self.saving.as_ref().is_some_and(|s| s.id == id) {
            return;
        }
        self.saving = None;
        if result.is_err() {
            self.submitted = None;
        }
        // Only a notification (or a fresh settings read) advances the saved value. An RPC
        // response may predate a newer write by another window and must not roll it back.
        self.notice = Some(match result {
            Ok(()) => "已保存".into(),
            Err(e) => format!("保存失败，草稿已保留：{e}"),
        });
    }

    fn reload(&mut self) {
        self.submitted = None;
        self.base.clone_from(&self.latest);
        self.current.clone_from(&self.latest);
        self.sync_editor = true;
        self.notice = None;
    }
}

pub struct PersonalizationSettings {
    editor: Entity<TextareaState>,
    draft: Draft,
}

impl PersonalizationSettings {
    pub fn new(saved: &str, window: &mut Window, cx: &mut App) -> Self {
        Self {
            editor: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(12, 24)
                    .placeholder(
                        "例如 / For example: 始终使用中文或 English；说明编辑代码前的计划。",
                    )
            }),
            draft: Draft::new(saved),
        }
    }
}

impl Workspace {
    pub(super) fn subscribe_personalization(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(s) = &self.settings else { return };
        let editor = s.personalization.editor.clone();
        let owner = editor.entity_id();
        cx.subscribe_in(
            &editor,
            window,
            move |this, editor, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change)
                    && let Some(s) = this.settings.as_mut()
                    && s.personalization.editor.entity_id() == owner
                {
                    s.personalization
                        .draft
                        .edit(editor.read(cx).value().to_string());
                    cx.notify();
                }
            },
        )
        .detach();
    }

    pub(super) fn observe_personalization(&mut self, saved: &str) {
        if let Some(s) = self.settings.as_mut() {
            s.personalization.draft.observe(saved);
        }
    }

    pub(super) fn sync_personalization_editor(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(s) = self.settings.as_mut()
            && std::mem::take(&mut s.personalization.draft.sync_editor)
        {
            let text = s.personalization.draft.current.clone();
            s.personalization
                .editor
                .update(cx, |state, cx| state.set_value(text, window, cx));
        }
    }

    fn save_personalization(&mut self, overwrite: bool, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        let Some(submission) = s.personalization.draft.begin(overwrite) else {
            return;
        };
        let owner = s.personalization.editor.entity_id();
        let call = backend.call::<SettingsSet>(AppSettingsPatch {
            custom_system_prompt: Some(submission.text),
            expected_custom_system_prompt: Some(submission.expected),
            ..Default::default()
        });
        cx.spawn(async move |this, cx| {
            let result = call.await.map(|_| ()).map_err(|e| e.to_string());
            this.update(cx, |this, cx| {
                if let Some(s) = this.settings.as_mut()
                    && s.personalization.editor.entity_id() == owner
                {
                    s.personalization.draft.finish(submission.id, result);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(super) fn personalization_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(s) = self.settings.as_ref() else {
            return div().into_any_element();
        };
        let s = &s.personalization;
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let busy = s.draft.saving.is_some();
        let enabled = !busy && !s.draft.conflict() && s.draft.current != s.draft.latest;
        let mut pane = card(p)
            .p(px(16.0))
            .gap(px(12.0))
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(px(16.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .child(trs!(english, "personalization.agent_instructions")),
                            )
                            .child(div().text_size(px(TEXT_XS)).muted(p).child(trs!(
                                english,
                                "personalization.appended_after_the_system_prompt"
                            ))),
                    )
                    .child(
                        outline_button("save-personalization", p)
                            .child(if busy {
                                trs!(english, "personalization.saving")
                            } else {
                                trs!(english, "personalization.save")
                            })
                            .when(!enabled, |b| b.opacity(0.4))
                            .when(enabled, |b| {
                                b.on_click(cx.listener(|this, _, _, cx| {
                                    this.save_personalization(false, cx)
                                }))
                            }),
                    ),
            )
            .child(
                Textarea::new(&s.editor)
                    .aria_label(trs!(english, "personalization.agent_instructions")),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(trs!(english, "personalization.used_in_every_turn_leave")),
            );
        if s.draft.conflict() {
            pane = pane.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .text_color(p.c(Token::Destructive))
                            .child(trs!(
                                english,
                                "personalization.another_window_changed_the_instructions"
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .child(
                                outline_button("reload-personalization", p)
                                    .child(trs!(english, "personalization.load_saved_content"))
                                    .when(!busy, |b| {
                                        b.on_click(cx.listener(|this, _, _, cx| {
                                            if let Some(s) = this.settings.as_mut() {
                                                s.personalization.draft.reload();
                                            }
                                            cx.notify();
                                        }))
                                    }),
                            )
                            .child(
                                outline_button("overwrite-personalization", p)
                                    .child(trs!(english, "personalization.save_anyway"))
                                    .when(!busy, |b| {
                                        b.on_click(cx.listener(|this, _, _, cx| {
                                            this.save_personalization(true, cx)
                                        }))
                                    }),
                            ),
                    ),
            );
        }
        if let Some(notice) = &s.draft.notice {
            let notice = if english {
                if notice == "已保存" {
                    trs!(english, "personalization.saved").to_string()
                } else if let Some(error) = notice.strip_prefix("保存失败，草稿已保留：")
                {
                    tr!(english, "personalization.save_failed", error = error)
                } else {
                    notice.clone()
                }
            } else {
                notice.clone()
            };
            pane = pane.child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(SharedString::from(notice)),
            );
        }
        pane.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::Draft;

    #[test]
    fn another_window_updates_pristine_fields_but_preserves_a_dirty_draft() {
        let mut draft = Draft::new("initial");
        draft.observe("remote");
        assert_eq!(draft.current, "remote");
        draft.edit("local draft".into());
        draft.observe("new remote");
        assert_eq!(draft.current, "local draft");
        assert!(draft.conflict());
        assert!(draft.begin(false).is_none());
        let save = draft.begin(true).unwrap();
        assert_eq!(
            (save.text.as_str(), save.expected.as_str()),
            ("local draft", "new remote")
        );
    }

    #[test]
    fn saving_does_not_replace_new_typing_or_roll_back_a_later_remote_write() {
        let mut draft = Draft::new("initial");
        draft.edit("submitted".into());
        let save = draft.begin(false).unwrap();
        assert!(draft.begin(false).is_none());
        draft.edit("typed while saving".into());
        draft.observe("submitted");
        draft.observe("later remote");
        draft.finish(save.id, Ok(()));
        assert_eq!(draft.current, "typed while saving");
        assert_eq!(draft.latest, "later remote");
        assert!(draft.conflict());
    }

    #[test]
    fn failed_save_keeps_the_draft_and_stale_completions_do_not_finish_a_new_save() {
        let mut draft = Draft::new("initial");
        draft.edit("draft".into());
        let first = draft.begin(false).unwrap();
        draft.finish(first.id, Err("offline".into()));
        assert_eq!(draft.current, "draft");
        assert!(draft.notice.as_ref().unwrap().contains("offline"));
        let second = draft.begin(false).unwrap();
        draft.finish(first.id, Ok(()));
        assert_eq!(draft.saving.as_ref().unwrap().id, second.id);
        draft.observe("draft");
        draft.finish(second.id, Ok(()));
        assert_eq!(draft.current, draft.base);
    }

    #[test]
    fn undo_during_save_survives_an_acknowledgement_that_precedes_its_notification() {
        let mut draft = Draft::new("initial");
        draft.edit("submitted".into());
        let save = draft.begin(false).unwrap();
        draft.edit("initial".into());
        draft.finish(save.id, Ok(()));
        draft.observe("submitted");
        assert_eq!(draft.current, "initial");
        assert_eq!(draft.base, "submitted");
        assert!(!draft.conflict());
        assert_eq!(draft.begin(false).unwrap().text, "initial");
    }

    #[test]
    fn reload_discards_only_on_request_and_clearing_can_be_saved() {
        let mut draft = Draft::new("initial");
        draft.edit("draft".into());
        draft.observe("remote");
        draft.reload();
        assert_eq!(draft.current, "remote");
        assert!(!draft.conflict());
        draft.edit(String::new());
        let save = draft.begin(false).unwrap();
        assert_eq!(save.text, "");
        assert_eq!(save.expected, "remote");
    }
}
