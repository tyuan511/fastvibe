//! Composer skills: one canonical command, an atomic input badge, and a scoped catalog.

use crate::ui::px;
use fv_protocol::methods::SkillList;
use fv_protocol::types::{SkillInfo, SkillListParams, SkillListResponse};
use fv_theme::Token;
use gpui_kit::component::input::InlineTokenContext;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use crate::skill_draft;
use crate::theme::Palette;
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon};

pub(super) fn bindings() -> [KeyBinding; 7] {
    [
        KeyBinding::new("up", super::MentionUp, Some("MentionOpen > Input")),
        KeyBinding::new("down", super::MentionDown, Some("MentionOpen > Input")),
        KeyBinding::new("escape", super::MentionDismiss, Some("MentionOpen > Input")),
        KeyBinding::new("tab", super::AcceptSkill, Some("SkillOpen > Input")),
        KeyBinding::new(
            "tab",
            super::AcceptSuggestion,
            Some("EmptyComposer > Input"),
        ),
        KeyBinding::new("up", super::HistoryPrev, Some("HistoryComposer > Input")),
        KeyBinding::new("down", super::HistoryNext, Some("HistoryComposer > Input")),
    ]
}

#[derive(Default)]
pub(super) struct Picker {
    pub query: Option<String>,
    dismissed: Option<String>,
    scope: Option<SkillListParams>,
    generation: u64,
    catalog: Option<SkillListResponse>,
    busy: bool,
    error: Option<String>,
    index: usize,
    /// A token annotation undone without changing its text must not immediately reapply itself.
    seen_value: String,
}

impl Picker {
    fn reset_scope(&mut self, scope: SkillListParams) {
        self.generation = self.generation.wrapping_add(1);
        self.scope = Some(scope);
        self.catalog = None;
        self.error = None;
        self.busy = false;
        self.index = 0;
    }

    fn complete(&mut self, generation: u64, result: Result<SkillListResponse, String>) -> bool {
        if self.generation != generation {
            return false;
        }
        self.busy = false;
        self.index = 0;
        match result {
            Ok(catalog) => self.catalog = Some(catalog),
            Err(error) => self.error = Some(error),
        }
        true
    }

    fn hits(&self) -> Vec<&SkillInfo> {
        match (&self.catalog, &self.query) {
            // Eight rows at most, as in Electron: the list sits in the layout, so an unbounded
            // one would push the composer up the window.
            (Some(catalog), Some(query)) => skill_draft::matching(&catalog.skills, query)
                .into_iter()
                .take(8)
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn open(&self) -> bool {
        self.query.is_some()
    }
}

pub(super) fn badge(name: &str, palette: &Palette) -> Div {
    div()
        .flex_none()
        .max_w(px(280.0))
        .h(px(22.0))
        .px(px(6.0))
        .flex()
        .items_center()
        .gap(px(4.0))
        .rounded(px(6.0))
        .bg(palette.c(Token::Warning).opacity(0.1))
        .text_color(palette.c(Token::Warning))
        .text_size(px(TEXT_XS))
        .line_height(px(18.0))
        .child(icon("sparkles", 12.0, palette.c(Token::Warning)))
        .child(ui::truncate(format!("技能 {name}")))
}

/// A token keeps its source text for native copy, undo and send. Removing its close button
/// uses the current token identity and UTF-16 range, so a stale rendered badge edits nothing.
pub(super) fn input_badge(
    token: &InlineTokenContext,
    palette: &Palette,
    input: Entity<gpui_kit::component::input::TextareaState>,
) -> AnyElement {
    // A source command moved into the middle of prose is ordinary text, matching the server's
    // leading-command rule. Never show an active skill badge for a command it will not load.
    if token.range().start != 0 {
        return div().child(token.token().text().clone()).into_any_element();
    }
    let name = token.token().id().strip_prefix("skill:").unwrap_or("");
    let range = token.range();
    let id = token.token().id().clone();
    let removable = !token.is_readonly() && !token.is_disabled();
    badge(name, palette)
        .when(removable, |d| {
            d.child(
                div()
                    .id(SharedString::from(format!("remove-{id}")))
                    .size(px(16.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .child(icon("cancel01", 10.0, palette.c(Token::Warning)))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |_, window, cx| {
                        cx.stop_propagation();
                        input.update(cx, |state, cx| {
                            if !state
                                .tokens()
                                .iter()
                                .any(|span| span.range() == range && span.token().id() == &id)
                            {
                                return;
                            }
                            let value = state.value().to_string();
                            let end = range.end + usize::from(value[range.end..].starts_with(' '));
                            let utf16 = value[..range.start].encode_utf16().count()
                                ..value[..end].encode_utf16().count();
                            state.replace_text_in_range(Some(utf16), "", window, cx);
                            state.focus(window, cx);
                        });
                    }),
            )
        })
        .into_any_element()
}

impl Workspace {
    pub(super) fn composer_focus(&mut self, focused: bool, cx: &mut Context<Self>) {
        self.skill_picker.dismissed = (!focused).then(|| self.input.read(cx).value().to_string());
        self.refresh_skill_picker(cx);
        cx.notify();
    }

    pub(super) fn composer_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.input.read(cx).value().to_string();
        if self.skill_picker.seen_value != value {
            self.skill_picker.seen_value = value.clone();
            self.skill_picker.dismissed = None;
            if let Some(mark) = skill_draft::invocation(&value)
                && mark.command_end < value.len()
                && self.input.read(cx).tokens().is_empty()
            {
                let range = self.input.read(cx).selected_range();
                if range.is_empty() {
                    let position = self.input.read(cx).cursor_position();
                    self.input.update(cx, |state, cx| {
                        if state
                            .replace_range_with_token(
                                0..mark.command_end,
                                skill_draft::token(mark.name),
                                window,
                                cx,
                            )
                            .is_ok()
                        {
                            state.set_cursor_position(position, window, cx);
                        }
                    });
                }
            }
        }
        self.refresh_skill_picker(cx);
        self.refresh_mentions(cx);
        cx.notify();
    }

    pub(super) fn invalidate_skill_picker(&mut self, cx: &mut Context<Self>) {
        self.skill_picker.scope = None;
        self.refresh_skill_picker(cx);
    }

    pub(super) fn refresh_skill_picker(&mut self, cx: &mut Context<Self>) {
        let scope = SkillListParams {
            cwd: self.skill_cwd(),
            other_folders: self.skill_other_folders(),
        };
        let value = self.input.read(cx).value().to_string();
        let query = if self.skill_picker.dismissed.as_deref() == Some(&value)
            || !self.input.read(cx).tokens().is_empty()
        {
            None
        } else {
            skill_draft::query(&value, self.input.read(cx).cursor())
        };
        let picker = &mut self.skill_picker;
        let opening = picker.query.is_none() && query.is_some();
        if picker.query != query {
            picker.query = query;
            picker.index = 0;
        }
        if opening || picker.scope.as_ref() != Some(&scope) {
            picker.reset_scope(scope.clone());
        }
        if picker.query.is_none()
            || picker.busy
            || picker.catalog.is_some()
            || picker.error.is_some()
        {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        picker.busy = true;
        let generation = picker.generation;
        cx.spawn(async move |this, cx| {
            let result = backend.call::<SkillList>(scope.clone()).await;
            let _ = this.update(cx, |this, cx| {
                let current_scope = SkillListParams {
                    cwd: this.skill_cwd(),
                    other_folders: this.skill_other_folders(),
                };
                if current_scope != scope {
                    return;
                }
                if this.skill_picker.complete(
                    generation,
                    result.map_err(|e| {
                        tr!(
                            this.english(),
                            "skill_picker.could_not_read_skills_e",
                            e = e
                        )
                    }),
                ) {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Enter/Tab while the palette is visible always belongs to it, even while loading or empty.
    pub(super) fn accept_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.refresh_skill_picker(cx);
        if !self.skill_picker.open() {
            return false;
        }
        let hits = self.skill_picker.hits();
        if let Some(skill) = hits.get(self.skill_picker.index).copied() {
            let name = skill.name.clone();
            let value = self.input.read(cx).value().to_string();
            if skill_draft::query(&value, self.input.read(cx).cursor()) != self.skill_picker.query {
                self.refresh_skill_picker(cx);
                return true;
            }
            let result = self.input.update(cx, |state, cx| {
                state.replace_range_with_token(
                    0..value.len(),
                    skill_draft::token(&name),
                    window,
                    cx,
                )?;
                state.insert(" ", window, cx);
                Ok::<_, gpui_kit::component::input::InlineTokenError>(())
            });
            if let Err(e) = result {
                self.fail(
                    tr!(
                        self.english(),
                        "skill_picker.could_not_select_the_skill",
                        e = e
                    ),
                    cx,
                );
            }
            self.refresh_skill_picker(cx);
            cx.notify();
        }
        true
    }

    pub(super) fn move_skill(&mut self, delta: i32, cx: &mut Context<Self>) {
        let count = self.skill_picker.hits().len();
        if count > 0 {
            self.skill_picker.index =
                (self.skill_picker.index as i32 + delta).rem_euclid(count as i32) as usize;
            cx.notify();
        }
    }

    pub(super) fn dismiss_skill(&mut self, cx: &mut Context<Self>) {
        self.skill_picker.dismissed = Some(self.input.read(cx).value().to_string());
        self.skill_picker.query = None;
        cx.notify();
    }

    pub(super) fn skill_panel(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.skill_picker.open() {
            return None;
        }
        let p = &self.palette;
        let picker = &self.skill_picker;
        let hits = picker.hits();
        // The composer's slash palette: an `overlay-surface` list of `px-3 py-2` rows, each a
        // glyph, the bold `/command` and its description on one line.
        let mut rows = div().flex().flex_col();
        let message = picker.error.clone().or_else(|| {
            if picker.catalog.is_none() {
                Some(trs!(self.english(), "skill_picker.loading_skills").into())
            } else if hits.is_empty() {
                Some(trs!(self.english(), "skill_picker.no_matching_skills").into())
            } else {
                None
            }
        });
        if let Some(message) = message {
            rows = rows.child(
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(message),
            );
        }
        for (index, skill) in hits.iter().enumerate() {
            let hover = p.c(Token::Muted).opacity(0.6);
            let hint = skill.description.clone();
            rows = rows.child(
                div()
                    .id(SharedString::from(format!("skill-choice-{index}")))
                    .px(px(12.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_SM))
                    .line_height(px(20.0))
                    .cursor_pointer()
                    .when(index == picker.index, |d| d.bg(p.c(Token::Muted)))
                    .when(index != picker.index, |d| d.hover(move |d| d.bg(hover)))
                    .child(icon("magic-wand02", 14.0, p.c(Token::MutedForeground)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_baseline()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .flex_none()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(format!("/skill:{}", skill.name)),
                            )
                            .when(!hint.is_empty(), |d| {
                                d.child(ui::truncate(hint).flex_1().text_size(px(TEXT_XS)).muted(p))
                            }),
                    )
                    // Preserve the input caret until the command has been applied.
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.skill_picker.index = index;
                        this.accept_skill(window, cx);
                    })),
            );
        }
        Some(
            super::settings::popover(p)
                .p(px(0.0))
                .mb(px(8.0))
                .overflow_hidden()
                .child(rows)
                .into_any_element(),
        )
    }
}

impl Workspace {
    /// Dev only (`--fixture skills`): the `/` palette open over a few skills, with no server.
    pub fn show_skill_picker_fixture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pending_fixture_draft = None;
        self.input.update(cx, |state, cx| {
            state.focus(window, cx);
            state.set_value("/", window, cx);
            let end = gpui_kit::component::input::RopeExt::offset_to_position(state.text(), 1);
            state.set_cursor_position(end, window, cx);
        });
        self.composer_changed(window, cx);
        let skill = |name: &str, description: &str| SkillInfo {
            name: name.into(),
            description: description.into(),
            path: format!("/skills/{name}/SKILL.md"),
            scope: fv_protocol::types::SkillScope::Project,
            removable: false,
            manual_only: false,
        };
        self.skill_picker.query = Some(String::new());
        self.skill_picker.catalog = Some(SkillListResponse {
            skills: vec![
                skill("office", "读写 Word / Excel / PowerPoint 文档"),
                skill("browser-use", "操作侧栏浏览器完成网页任务"),
                skill("skill-creator", "创建、修改技能并评估效果"),
                skill("find-skills", "从社区搜索并安装技能"),
            ],
            diagnostics: Vec::new(),
        });
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::Picker;
    use fv_protocol::types::{SkillInfo, SkillListParams, SkillListResponse, SkillScope};

    fn scope(cwd: &str) -> SkillListParams {
        SkillListParams {
            cwd: Some(cwd.into()),
            other_folders: vec![format!("{cwd}/extra")],
        }
    }

    fn catalog(name: &str) -> SkillListResponse {
        SkillListResponse {
            skills: vec![SkillInfo {
                name: name.into(),
                description: name.into(),
                path: format!("/{name}/SKILL.md"),
                scope: SkillScope::Project,
                removable: false,
                manual_only: false,
            }],
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn a_late_catalog_never_replaces_the_new_project_or_a_refreshed_catalog() {
        let mut picker = Picker {
            query: Some(String::new()),
            ..Default::default()
        };
        picker.reset_scope(scope("/a"));
        let old = picker.generation;
        picker.reset_scope(scope("/b"));
        let current = picker.generation;
        assert!(!picker.complete(old, Ok(catalog("wrong"))));
        assert!(picker.hits().is_empty());
        assert!(picker.complete(current, Ok(catalog("correct"))));
        assert_eq!(picker.hits()[0].name, "correct");
        picker.reset_scope(scope("/b"));
        assert!(!picker.complete(current, Err("stale failure".into())));
        assert!(picker.error.is_none());
        assert!(picker.complete(picker.generation, Ok(catalog("edited"))));
        assert_eq!(picker.hits()[0].name, "edited");
    }

    #[test]
    fn a_skill_palette_owns_tab_arrows_and_escape_only_in_its_context() {
        use super::super::{
            AcceptSkill, AcceptSuggestion, Dismiss, MentionDismiss, MentionDown, MentionUp,
        };
        use gpui_kit::component::input::{Escape, IndentInline, MoveDown, MoveUp};
        use gpui_kit::{Action, KeyBinding, KeyContext, Keymap, Keystroke};
        let mut map = Keymap::default();
        map.add_bindings([
            KeyBinding::new("escape", Escape, Some("Input")),
            KeyBinding::new("up", MoveUp, Some("Input")),
            KeyBinding::new("down", MoveDown, Some("Input")),
            KeyBinding::new("tab", IndentInline, Some("Input")),
        ]);
        map.add_bindings([KeyBinding::new("escape", Dismiss, None)]);
        map.add_bindings(super::bindings());
        let root = KeyContext::parse("Workspace").unwrap();
        let palette = KeyContext::parse("FilledComposer MentionOpen SkillOpen").unwrap();
        let input = KeyContext::parse("Input").unwrap();
        for (key, action) in [
            ("tab", AcceptSkill.name()),
            ("up", MentionUp.name()),
            ("down", MentionDown.name()),
            ("escape", MentionDismiss.name()),
        ] {
            let stroke = [Keystroke::parse(key).unwrap()];
            let (bindings, pending) =
                map.bindings_for_input(&stroke, &[root.clone(), palette.clone(), input.clone()]);
            assert!(!pending);
            assert_eq!(bindings[0].action().name(), action, "{key}");
            let outside = map
                .bindings_for_input(&stroke, &[root.clone(), input.clone()])
                .0;
            if key == "escape" {
                assert_eq!(outside[0].action().name(), Dismiss.name());
            } else {
                assert_ne!(outside[0].action().name(), action);
            }
        }
        let empty = KeyContext::parse("EmptyComposer").unwrap();
        let stroke = [Keystroke::parse("tab").unwrap()];
        let accepted = map.bindings_for_input(&stroke, &[root, empty, input]).0;
        assert_eq!(accepted[0].action().name(), AcceptSuggestion.name());
    }
}
