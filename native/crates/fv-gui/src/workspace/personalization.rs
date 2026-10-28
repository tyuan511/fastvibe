//! User-authored Agent instructions. Notifications update pristine fields, while a dirty
//! draft stays local until an explicit save or reload. The server guards concurrent edits.

use crate::ui::px;
use fv_protocol::methods::SettingsSet;
use fv_protocol::types::{AppSettingsPatch, UiLanguage};
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::settings::outline_button;
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
    /// The language the placeholder was last written in.
    placeholder_english: Option<bool>,
}

impl PersonalizationSettings {
    pub fn new(saved: &str, window: &mut Window, cx: &mut App) -> Self {
        Self {
            editor: cx.new(|cx| TextareaState::new(window, cx).auto_grow(12, 24)),
            draft: Draft::new(saved),
            placeholder_english: None,
        }
    }
}

/// `Button size="sm"` (the default, filled variant): 28px, `bg-primary`.
pub(super) fn primary_button(id: impl Into<ElementId>, p: &crate::theme::Palette) -> Stateful<Div> {
    let hover = p.c(Token::Primary).opacity(0.8);
    div()
        .id(id)
        .h(px(28.0))
        .px(px(10.0))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(px(4.0))
        .rounded(px(8.0))
        .bg(p.c(Token::Primary))
        .text_color(p.c(Token::PrimaryForeground))
        .text_size(px(12.8))
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .hover(move |d| d.bg(hover))
}

/// `SettingsGroup`'s heading: `px-1 text-sm font-medium`.
pub(super) fn group_title(text: impl Into<SharedString>) -> Div {
    div()
        .px(px(4.0))
        .text_size(px(TEXT_SM))
        .line_height(px(20.0))
        .font_weight(FontWeight::MEDIUM)
        .child(text.into())
}

/// `SettingsGroup`: an optional heading over a card, `space-y-2`.
pub(super) fn group(
    title: Option<&str>,
    p: &crate::theme::Palette,
    rows: impl IntoIterator<Item = AnyElement>,
) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(8.0))
        .when_some(title, |d, t| d.child(group_title(t.to_string())))
        .child(super::settings::card(p).children(rows))
}

/// `SettingsRow` whose description is markup of its own (several lines, a coloured error).
pub(super) fn rich_row(
    title: impl IntoElement,
    description: Option<AnyElement>,
    divider: bool,
    p: &crate::theme::Palette,
    control: impl IntoElement,
) -> Div {
    div()
        .px(px(16.0))
        .py(px(12.0))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(24.0))
        .when(divider, |d| d.border_t_1().border_color(p.c(Token::Border)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .text_size(px(TEXT_SM))
                        .line_height(px(20.0))
                        .font_weight(FontWeight::MEDIUM)
                        .child(title),
                )
                .when_some(description, |d, desc| {
                    d.child(
                        div()
                            .mt(px(2.0))
                            .text_size(px(TEXT_XS))
                            .line_height(px(16.0))
                            .muted(p)
                            .child(desc),
                    )
                }),
        )
        .child(div().flex_none().child(control))
}

/// `Button variant="outline" size="sm"`: 28px.
pub(super) fn outline_sm(id: impl Into<ElementId>, p: &crate::theme::Palette) -> Stateful<Div> {
    outline_button(id, p).h(px(28.0)).justify_center()
}

/// A `Select` trigger: outline, 30px, the value on the left and the unfold glyph on the right.
pub(super) fn select_trigger(
    id: impl Into<ElementId>,
    text: impl Into<SharedString>,
    width: f32,
    p: &crate::theme::Palette,
) -> Stateful<Div> {
    outline_button(id, p)
        .w(px(width))
        .h(px(30.0))
        .justify_between()
        .rounded(px(8.0))
        .font_weight(FontWeight::NORMAL)
        .text_size(px(TEXT_SM))
        .child(crate::ui::truncate(text).flex_1())
        .child(crate::ui::icon(
            "unfold-more",
            14.0,
            p.c(Token::MutedForeground),
        ))
}

/// `DefaultModelSelect`'s trigger: an outline button (32px) with a chevron in the text colour.
pub(super) fn model_trigger(
    id: impl Into<ElementId>,
    text: impl Into<SharedString>,
    width: f32,
    p: &crate::theme::Palette,
) -> Stateful<Div> {
    outline_button(id, p)
        .w(px(width))
        .justify_between()
        .font_weight(FontWeight::NORMAL)
        .text_size(px(TEXT_SM))
        .child(crate::ui::truncate(text).flex_1())
        .child(crate::ui::icon(
            "arrow-down01",
            14.0,
            p.c(Token::Foreground),
        ))
}

/// `Badge` variants the settings lists use.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum BadgeKind {
    Secondary,
    Destructive,
    Outline,
}

/// `Badge`: a 20px pill, an optional 12px glyph before the text.
pub(super) fn badge(
    kind: BadgeKind,
    glyph: Option<&str>,
    text: impl Into<SharedString>,
    p: &crate::theme::Palette,
) -> Div {
    let (bg, fg) = match kind {
        BadgeKind::Secondary => (p.c(Token::Secondary), p.c(Token::SecondaryForeground)),
        BadgeKind::Destructive => (
            p.c(Token::Destructive).opacity(0.1),
            p.c(Token::Destructive),
        ),
        BadgeKind::Outline => (gpui_kit::transparent_black(), p.c(Token::Foreground)),
    };
    div()
        .h(px(20.0))
        .px(px(8.0))
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.0))
        .rounded_full()
        .border_1()
        .border_color(if kind == BadgeKind::Outline {
            p.c(Token::Border)
        } else {
            gpui_kit::transparent_black()
        })
        .bg(bg)
        .text_color(fg)
        .text_size(px(TEXT_XS))
        .font_weight(FontWeight::MEDIUM)
        .when_some(glyph, |d, g| d.child(crate::ui::icon(g, 12.0, fg)))
        .child(text.into())
}

/// The 36px tinted tile an `Item` leads with (`bg-primary/10`, a `ring-primary/15` edge).
pub(super) fn item_tile(glyph: &str, size: f32, p: &crate::theme::Palette) -> Div {
    div()
        .size(px(36.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(12.0))
        .bg(p.c(Token::Primary).opacity(0.1))
        .border_1()
        .border_color(p.c(Token::Primary).opacity(0.15))
        .child(crate::ui::icon(glyph, size, p.c(Token::Primary)))
}

/// `Item variant="outline" size="sm"` as the settings lists draw it: `bg-card/80 p-3`.
pub(super) fn item_card(p: &crate::theme::Palette) -> Div {
    div()
        .p(px(12.0))
        .flex()
        .items_start()
        .gap(px(12.0))
        .rounded(px(10.0))
        .border_1()
        .border_color(p.c(Token::Border))
        .bg(p.c(Token::Card).opacity(0.8))
}

/// A ghost icon button: `icon-xs` is 24px with a 12px glyph, `icon-sm` 28px with 16px.
pub(super) fn ghost_icon(
    id: impl Into<ElementId>,
    glyph: &str,
    box_size: f32,
    glyph_size: f32,
    color: Hsla,
    p: &crate::theme::Palette,
) -> Stateful<Div> {
    let hover = p.c(Token::Muted);
    div()
        .id(id)
        .size(px(box_size))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(px(if box_size < 26.0 { 6.0 } else { 8.0 }))
        .cursor_pointer()
        .hover(move |d| d.bg(hover))
        .child(crate::ui::icon(glyph, glyph_size, color))
}

/// `Empty` in a dashed box: an icon tile, a title and one line under it.
pub(super) fn empty_box(
    glyph: &str,
    title: impl Into<SharedString>,
    hint: impl Into<SharedString>,
    p: &crate::theme::Palette,
) -> Div {
    div()
        .py(px(40.0))
        .px(px(24.0))
        .rounded(px(12.0))
        .border_1()
        .border_dashed()
        .border_color(p.c(Token::Border))
        .flex()
        .flex_col()
        .items_center()
        .gap(px(8.0))
        .child(
            div()
                .size(px(32.0))
                .mb(px(4.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(8.0))
                .bg(p.c(Token::Muted))
                .child(crate::ui::icon(glyph, 16.0, p.c(Token::Foreground))),
        )
        .child(
            div()
                .text_size(px(TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .child(title.into()),
        )
        .child(div().text_size(px(TEXT_SM)).muted(p).child(hint.into()))
}

/// A shared model-picker row (drawn as an outline button) restyled as a menu row, for the
/// pickers that open in a popover.
pub(super) fn as_menu_row(view: Stateful<Div>) -> Stateful<Div> {
    view.border_color(gpui_kit::transparent_black())
        .bg(gpui_kit::transparent_black())
        .rounded(px(6.0))
        .font_weight(FontWeight::NORMAL)
        .text_size(px(TEXT_SM))
}

/// A form field's label (`Label`: 14px medium).
pub(super) fn field_label(text: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(TEXT_SM))
        .line_height(px(20.0))
        .font_weight(FontWeight::MEDIUM)
        .child(text.into())
}

/// A moment in the viewer's own time zone (what `toLocaleString` prints).
pub(super) fn local_time(ms: i64) -> String {
    let zone = iana_time_zone::get_timezone()
        .ok()
        .and_then(|z| z.parse::<chrono_tz::Tz>().ok())
        .unwrap_or(chrono_tz::UTC);
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&zone).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "—".into())
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
        self.sync_skill_placeholders(window, cx);
        let english = self.english();
        if let Some(s) = self.settings.as_mut()
            && s.personalization.placeholder_english != Some(english)
        {
            s.personalization.placeholder_english = Some(english);
            let placeholder = trs!(english, "personalization.placeholder");
            s.personalization.editor.update(cx, |state, cx| {
                state.set_placeholder(placeholder, window, cx)
            });
        }
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
        let mut pane = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
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
                                    .line_height(px(20.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(trs!(english, "personalization.agent_instructions")),
                            )
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .line_height(px(20.0))
                                    .muted(p)
                                    .child(trs!(
                                        english,
                                        "personalization.appended_after_the_system_prompt"
                                    )),
                            ),
                    )
                    .child(
                        primary_button("save-personalization", p)
                            .child(if busy {
                                trs!(english, "personalization.saving")
                            } else {
                                trs!(english, "personalization.save")
                            })
                            .when(!enabled, |b| b.opacity(0.5))
                            .when(enabled, |b| {
                                b.on_click(cx.listener(|this, _, _, cx| {
                                    this.save_personalization(false, cx)
                                }))
                            }),
                    ),
            )
            .child(
                Textarea::new(&s.editor)
                    .bg(p.c(Token::Card))
                    .text_size(px(TEXT_SM))
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
