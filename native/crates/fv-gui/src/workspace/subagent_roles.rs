//! Explicit role saves, guarded against stale reads, concurrent editors and late responses.
use super::model_menu::{PickerRow, picker_row_view, picker_rows, provider_groups};
use super::{
    Workspace,
    personalization::{outline_sm, primary_button, select_trigger},
    settings::{
        Section, checkbox, dialog_card, dialog_head, menu_item, outline_button, popover, switch,
    },
};
use crate::ui::px;
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon, truncate};
use fv_protocol::{
    methods::*,
    subagents::*,
    types::{Empty, ThinkingLevel, UiLanguage},
};
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    component::input::{Input, InputState, Textarea, TextareaState},
    *,
};
use std::collections::HashSet;

fn ticket() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
#[derive(Default)]
pub(super) struct RoleSettings {
    saved: Option<SubagentRolesResponse>,
    editor: Option<Editor>,
    loading: bool,
    dirty: bool,
    epoch: u64,
    busy: bool,
    error: Option<String>,
    notice: Option<String>,
    confirm_delete: Option<String>,
}
struct Editor {
    session: u64,
    expected: Option<SubagentRole>,
    id: Entity<InputState>,
    name: Entity<InputState>,
    description: Entity<InputState>,
    prompt: Entity<TextareaState>,
    model: Option<String>,
    thinking: Option<ThinkingLevel>,
    read_only: bool,
    tools: Option<HashSet<String>>,
    model_menu: bool,
    thinking_menu: bool,
    /// Which provider is unfolded under `model_menu`. The role editor's list lives in the form,
    /// so its second level opens beneath its provider rather than beside it.
    model_open: Option<String>,
}
fn field(label: &str, window: &mut Window, cx: &mut App, value: &str) -> Entity<InputState> {
    let input = cx.new(|cx| InputState::new(window, cx).placeholder(label.to_string()));
    input.update(cx, |state, cx| {
        state.set_value(value.to_string(), window, cx)
    });
    input
}
impl Editor {
    fn new(role: Option<SubagentRole>, english: bool, window: &mut Window, cx: &mut App) -> Self {
        let current = role.clone().unwrap_or_else(|| SubagentRole {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            system_prompt: String::new(),
            model: None,
            thinking: None,
            read_only: false,
            tools: None,
            builtin: false,
        });
        let prompt = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(4, 12)
                .placeholder(trs!(
                    english,
                    "subagent_roles.role_responsibilities_working_style_and"
                ))
        });
        prompt.update(cx, |state, cx| {
            state.set_value(current.system_prompt.clone(), window, cx)
        });
        Self {
            session: ticket(),
            expected: role,
            id: field(
                trs!(english, "subagent_roles.role_id_letters_numbers_or"),
                window,
                cx,
                &current.id,
            ),
            name: field(
                trs!(english, "subagent_roles.display_name"),
                window,
                cx,
                &current.name,
            ),
            description: field(
                trs!(english, "subagent_roles.description_shown_when_the_main"),
                window,
                cx,
                &current.description,
            ),
            prompt,
            model: current.model,
            thinking: current.thinking,
            read_only: current.read_only,
            tools: current.tools.map(|v| v.into_iter().collect()),
            model_menu: false,
            thinking_menu: false,
            model_open: None,
        }
    }
    fn value(&self, cx: &App) -> SubagentRole {
        let mut tools = self
            .tools
            .as_ref()
            .map(|v| v.iter().cloned().collect::<Vec<_>>());
        if let Some(tools) = &mut tools {
            tools.sort();
        }
        SubagentRole {
            id: self
                .expected
                .as_ref()
                .map(|r| r.id.clone())
                .unwrap_or_else(|| self.id.read(cx).value().trim().into()),
            name: self.name.read(cx).value().trim().into(),
            description: self.description.read(cx).value().trim().into(),
            system_prompt: self.prompt.read(cx).value().to_string(),
            model: self.model.clone(),
            thinking: self.thinking,
            read_only: self.read_only,
            tools,
            // Whether the role was built in belongs to the server; a save never changes it.
            builtin: self.expected.as_ref().is_some_and(|role| role.builtin),
        }
    }
}
impl Workspace {
    pub(super) fn refresh_roles(&mut self, cx: &mut Context<Self>) {
        if !self
            .settings
            .as_ref()
            .is_some_and(|s| s.section == Section::Subagents)
        {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let s = &mut self.subagent_roles;
        if s.loading {
            s.dirty = true;
            return;
        }
        s.loading = true;
        let epoch = s.epoch;
        cx.spawn(async move |this, cx| {
            let result = backend.call::<SubagentRoleList>(Empty {}).await;
            let _ = this.update(cx, |this, cx| {
                let s = &mut this.subagent_roles;
                s.loading = false;
                if s.epoch == epoch {
                    match result {
                        Ok(saved) => s.saved = Some(saved),
                        Err(e) => s.error = Some(e.to_string()),
                    }
                } else {
                    s.dirty = true;
                }
                if std::mem::take(&mut s.dirty) {
                    this.refresh_roles(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn edit_role(
        &mut self,
        role: Option<SubagentRole>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.subagent_roles.busy {
            return;
        }
        let english = self.app_settings.language == UiLanguage::English;
        self.subagent_roles.editor = Some(Editor::new(role, english, window, cx));
        self.subagent_roles.error = None;
        self.subagent_roles.notice = None;
        self.subagent_roles.confirm_delete = None;
        cx.notify();
    }
    fn save_role(&mut self, cx: &mut Context<Self>) {
        if self.subagent_roles.busy {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(editor) = self.subagent_roles.editor.as_ref() else {
            return;
        };
        let role = editor.value(cx);
        let expected = editor.expected.clone();
        let session = editor.session;
        self.subagent_roles.busy = true;
        self.subagent_roles.epoch = ticket();
        self.subagent_roles.error = None;
        self.subagent_roles.notice = None;
        let submitted = role.clone();
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<SubagentRoleUpsert>(SubagentRoleUpsertParams { role, expected })
                .await;
            let _ = this.update(cx, |this, cx| {
                let s = &mut this.subagent_roles;
                s.busy = false;
                s.epoch = ticket();
                match result {
                    Ok(saved) => {
                        s.saved = Some(saved);
                        s.notice = Some(if this.app_settings.language == UiLanguage::English {
                            "Role saved. Existing subtasks continue using their original configuration."
                        } else {
                            "角色已保存。已创建的子任务继续使用原配置。"
                        }.into());
                        // Never replace the fields: typing or selections made during the save stay.
                        if let Some(e) = s.editor.as_mut().filter(|e| e.session == session) {
                            e.expected = Some(submitted);
                        }
                    }
                    Err(e) => s.error = Some(if this.app_settings.language == UiLanguage::English {
                        format!("Save failed; draft kept: {e}")
                    } else {
                        format!("保存失败，草稿已保留：{e}")
                    }),
                }
                this.refresh_roles(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn delete_role(&mut self, role: SubagentRole, cx: &mut Context<Self>) {
        if self.subagent_roles.busy {
            return;
        }
        if self.subagent_roles.confirm_delete.as_deref() != Some(&role.id) {
            self.subagent_roles.confirm_delete = Some(role.id);
            cx.notify();
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        self.subagent_roles.busy = true;
        self.subagent_roles.epoch = ticket();
        self.subagent_roles.error = None;
        cx.spawn(async move |this, cx| {
            let id = role.id.clone();
            let result = backend
                .call::<SubagentRoleDelete>(SubagentRoleDeleteParams { expected: role })
                .await;
            let _ = this.update(cx, |this, cx| {
                let s = &mut this.subagent_roles;
                s.busy = false;
                s.epoch = ticket();
                s.confirm_delete = None;
                match result {
                    Ok(saved) => {
                        s.saved = Some(saved);
                        if s.editor
                            .as_ref()
                            .and_then(|e| e.expected.as_ref())
                            .is_some_and(|r| r.id == id)
                        {
                            s.editor = None;
                        }
                    }
                    Err(e) => s.error = Some(e.to_string()),
                }
                this.refresh_roles(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    /// 设置 → 子 Agent below the switches: a heading with Refresh / Add, then the roles as
    /// `Item` cards (or the dashed empty box), and the editor when one is open.
    pub(super) fn roles_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let s = &self.subagent_roles;
        let english = self.english();
        let tile = || {
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
                .child(icon("bot", 20.0, p.c(Token::Primary)))
        };
        let header = div()
            .pb(px(20.0))
            .border_b_1()
            .border_color(p.c(Token::Border))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(16.0))
            .child(
                div()
                    .flex()
                    .min_w_0()
                    .items_center()
                    .gap(px(12.0))
                    .child(tile())
                    .child(
                        div()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(truncate(trs!(english, "subagent_roles.header"))),
                            )
                            .child(
                                div()
                                    .mt(px(4.0))
                                    .text_size(px(TEXT_XS))
                                    .muted(p)
                                    .child(truncate(trs!(english, "subagent_roles.fallback"))),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .gap(px(8.0))
                    .child(
                        outline_sm("role-refresh", p)
                            .gap(px(4.0))
                            .when(s.loading || s.busy, |d| d.opacity(0.5))
                            .child(icon("refresh01", 14.0, p.c(Token::Foreground)))
                            .child(trs!(english, "subagent_roles.refresh"))
                            .on_click(cx.listener(|this, _, _, cx| this.refresh_roles(cx))),
                    )
                    .child(
                        primary_button("role-add", p)
                            .child(icon("add01", 14.0, p.c(Token::PrimaryForeground)))
                            .child(trs!(english, "subagent_roles.new_role"))
                            .on_click(
                                cx.listener(|this, _, window, cx| this.edit_role(None, window, cx)),
                            ),
                    ),
            );
        let mut pane = div().flex().flex_col().gap(px(28.0)).child(header);
        if let Some(error) = &s.error {
            pane = pane.child(
                div()
                    .text_size(px(TEXT_SM))
                    .text_color(p.c(Token::Destructive))
                    .child(error.clone()),
            );
        }
        if let Some(notice) = &s.notice {
            pane = pane.child(div().text_size(px(TEXT_SM)).muted(p).child(notice.clone()));
        }
        let fixture;
        let saved = match &s.saved {
            Some(saved) => Some(saved),
            None if cfg!(feature = "capture") && self.backend.is_none() => {
                fixture = capture_roles();
                Some(&fixture)
            }
            None => None,
        };
        let Some(saved) = saved else {
            return pane
                .child(
                    div()
                        .text_size(px(TEXT_SM))
                        .muted(p)
                        .child(trs!(english, "subagent_roles.loading_roles")),
                )
                .into_any_element();
        };
        if saved.roles.is_empty() {
            return pane
                .child(
                    div()
                        .p(px(32.0))
                        .rounded(px(12.0))
                        .border_1()
                        .border_dashed()
                        .border_color(p.c(Token::Border))
                        .flex()
                        .justify_center()
                        .text_size(px(TEXT_SM))
                        .muted(p)
                        .child(trs!(english, "subagent_roles.empty")),
                )
                .into_any_element();
        }
        let mut list = div().flex().flex_col().gap(px(10.0));
        for role in &saved.roles {
            list = list.child(self.role_card(role, tile(), cx));
        }
        pane.child(
            div()
                .flex()
                .flex_col()
                .gap(px(12.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(TEXT_SM))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(trs!(english, "subagent_roles.role_templates")),
                        )
                        .child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(saved.roles.len().to_string()),
                        ),
                )
                .child(list),
        )
        .into_any_element()
    }

    /// One role as Electron's outline `Item`: icon tile, name + badge, description, tool chips,
    /// and on the right the model · reasoning button with edit and delete.
    fn role_card(&self, role: &SubagentRole, tile: Div, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let english = self.english();
        let confirm = self.subagent_roles.confirm_delete.as_deref() == Some(&role.id);
        let chip = |text: SharedString| {
            div()
                .px(px(6.0))
                .py(px(2.0))
                .rounded(px(6.0))
                .bg(p.c(Token::Muted).opacity(0.7))
                .text_size(px(TEXT_XS))
                .muted(p)
                .child(text)
        };
        let mut chips = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.0))
            .pt(px(4.0));
        if role.builtin {
            chips = chips.child(chip(trs!(english, "subagent_roles.builtin_chip").into()));
        }
        if role.read_only {
            chips = chips.child(chip(trs!(english, "subagent_roles.read_only_chip").into()));
        }
        match &role.tools {
            None => chips = chips.child(chip(trs!(english, "subagent_roles.all_tools").into())),
            Some(tools) => {
                for tool in tools {
                    chips = chips.child(chip(tool.clone().into()));
                }
            }
        }
        let model = role
            .model
            .as_ref()
            .map(|id| {
                self.models
                    .iter()
                    .find(|m| &m.label == id)
                    .map(|m| format!("{}/{}", m.provider_name, m.model.id))
                    .unwrap_or_else(|| id.clone())
            })
            .unwrap_or_else(|| trs!(english, "subagent_roles.inherit_parent_model").into());
        let thinking = role
            .thinking
            .map(|level| super::composer::thinking_label_in(level, english))
            .unwrap_or(trs!(english, "subagent_roles.inherit_thinking_level"));
        let edit = role.clone();
        let edit2 = role.clone();
        let remove = role.clone();
        let destructive = p.c(Token::Destructive);
        let hover = p.c(Token::Muted);
        div()
            .p(px(12.0))
            .flex()
            .items_start()
            .gap(px(12.0))
            .rounded(px(10.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Card).opacity(0.8))
            .child(div().mt(px(2.0)).child(tile))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex()
                            .min_w_0()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .min_w_0()
                                    .text_size(px(16.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(truncate(role.name.clone())),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .px(px(8.0))
                                    .py(px(2.0))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(p.c(Token::Border))
                                    .text_size(px(TEXT_XS))
                                    .child(role.id.clone()),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .muted(p)
                            .child(truncate(role.description.clone())),
                    )
                    .child(chips),
            )
            .child(if role.builtin {
                // A built-in ships with the app: it is shown, never edited or deleted here.
                // The same model · reasoning line stays as plain text so the row reads like
                // its editable neighbours without promising a click that cannot save.
                div()
                    .flex_none()
                    .self_center()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .max_w(px(256.0))
                    .px(px(12.0))
                    .py(px(6.0))
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(p.c(Token::Border))
                    .text_size(px(TEXT_SM))
                    .child(truncate(format!("{model} · {thinking}")).muted(p))
                    .child(chip(trs!(english, "subagent_roles.builtin_chip").into()))
            } else {
                div()
                    .flex_none()
                    .self_center()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .id(SharedString::from(format!("role-config-{}", role.id)))
                            .max_w(px(256.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .px(px(12.0))
                            .py(px(6.0))
                            .rounded(px(8.0))
                            .border_1()
                            .border_color(p.c(Token::Border))
                            .bg(p.c(Token::Background))
                            .cursor_pointer()
                            .text_size(px(TEXT_SM))
                            .child(truncate(format!("{model} · {thinking}")).muted(p))
                            .child(icon("arrow-right01", 16.0, p.c(Token::Primary)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.edit_role(Some(edit2.clone()), window, cx)
                            })),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("role-edit-{}", role.id)))
                            .size(px(28.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(8.0))
                            .cursor_pointer()
                            .hover(move |d| d.bg(hover))
                            .child(icon("edit02", 16.0, p.c(Token::Foreground)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.edit_role(Some(edit.clone()), window, cx)
                            })),
                    )
                    .child(if confirm {
                        outline_sm(SharedString::from(format!("role-remove-{}", role.id)), p)
                            .text_color(destructive)
                            .child(trs!(english, "subagent_roles.confirm_delete"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.delete_role(remove.clone(), cx)
                            }))
                    } else {
                        div()
                            .id(SharedString::from(format!("role-remove-{}", role.id)))
                            .size(px(28.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(8.0))
                            .cursor_pointer()
                            .hover(move |d| d.bg(hover))
                            .child(icon("delete02", 16.0, p.c(Token::MutedForeground)))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.delete_role(remove.clone(), cx)
                            }))
                    })
            })
    }

    /// The role editor, drawn as a dialog by `settings_dialogs` while it is open.
    pub(super) fn role_editor_dialog(&self, cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        let editor = self.subagent_roles.editor.as_ref()?;
        Some(self.role_editor(editor, cx))
    }

    pub(super) fn close_role_editor(&mut self) {
        self.subagent_roles.editor = None;
    }

    fn role_editor(&self, e: &Editor, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = &self.palette;
        let english = self.english();
        let saved = self.subagent_roles.saved.as_ref();
        let busy = self.subagent_roles.busy;
        let hover = p.c(Token::Muted);
        let conflict = e.expected.as_ref().is_some_and(|old| {
            saved.is_some_and(|s| s.roles.iter().find(|r| r.id == old.id) != Some(old))
        });
        let label = |text: &'static str| {
            div()
                .text_size(px(TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .child(text)
        };
        let hint = |text: SharedString| div().text_size(px(TEXT_XS)).muted(p).child(text);
        let field =
            |children: Vec<AnyElement>| div().flex().flex_col().gap(px(6.0)).children(children);
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .px(px(20.0))
            .pb(px(16.0));
        // The id is what the main agent passes to the tool; it is fixed once the role exists.
        body = body.child(match &e.expected {
            Some(role) => field(vec![
                label(trs!(english, "subagent_roles.role_id")).into_any_element(),
                div()
                    .text_size(px(TEXT_SM))
                    .child(role.id.clone())
                    .into_any_element(),
            ]),
            None => field(vec![
                label(trs!(english, "subagent_roles.role_id")).into_any_element(),
                if busy {
                    div()
                        .text_size(px(TEXT_SM))
                        .child(e.id.read(cx).value().to_string())
                        .into_any_element()
                } else {
                    Input::new(&e.id).into_any_element()
                },
                hint(trs!(english, "subagent_roles.role_id_hint").into()).into_any_element(),
            ]),
        });
        body = body
            .child(field(vec![
                label(trs!(english, "subagent_roles.display_name")).into_any_element(),
                Input::new(&e.name).into_any_element(),
            ]))
            .child(field(vec![
                label(trs!(english, "subagent_roles.description")).into_any_element(),
                Input::new(&e.description).into_any_element(),
            ]));

        // 可用工具: one checkbox for "everything this host offers", then each tool.
        let all = e.tools.is_none();
        let available = saved
            .map(|s| {
                s.tools
                    .iter()
                    .filter(|t| !e.read_only || t.read_only_allowed)
                    .map(|t| t.name.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let check = |id: SharedString, on: bool, text: SharedString| {
            div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(6.0))
                .cursor_pointer()
                .text_size(px(TEXT_SM))
                .child(checkbox(on, p))
                .child(text)
        };
        let mut tools = div()
            .flex()
            .flex_wrap()
            .gap_x(px(16.0))
            .gap_y(px(8.0))
            .child(
                check(
                    "role-tools-all".into(),
                    all,
                    trs!(english, "subagent_roles.all_tools").into(),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(e) = &mut this.subagent_roles.editor {
                        e.tools = if all { Some(HashSet::new()) } else { None };
                    }
                    cx.notify();
                })),
            );
        for name in &available {
            let on = all || e.tools.as_ref().is_some_and(|t| t.contains(name));
            let name = name.clone();
            let everything = available.clone();
            tools = tools.child(
                check(
                    SharedString::from(format!("role-tool-{name}")),
                    on,
                    name.clone().into(),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(e) = &mut this.subagent_roles.editor {
                        let tools = e
                            .tools
                            .get_or_insert_with(|| everything.iter().cloned().collect());
                        if !tools.remove(&name) {
                            tools.insert(name.clone());
                        }
                    }
                    cx.notify();
                })),
            );
        }
        if let Some(selected) = &e.tools {
            for name in selected.iter().filter(|n| !available.contains(n)) {
                let name = name.clone();
                tools = tools.child(
                    check(
                        SharedString::from(format!("role-missing-{name}")),
                        true,
                        tr!(
                            english,
                            "subagent_roles.name_currently_unavailable_click_to",
                            name = name
                        )
                        .into(),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.subagent_roles.editor
                            && let Some(tools) = &mut e.tools
                        {
                            tools.remove(&name);
                        }
                        cx.notify();
                    })),
                );
            }
        }
        body = body.child(field(vec![
            div()
                .child(label(trs!(english, "subagent_roles.tools")))
                .child(
                    div()
                        .mt(px(4.0))
                        .child(hint(trs!(english, "subagent_roles.tools_hint").into())),
                )
                .into_any_element(),
            tools.into_any_element(),
        ]));

        let read_only = !e.read_only;
        body = body.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(16.0))
                .child(
                    div()
                        .min_w_0()
                        .child(label(trs!(english, "subagent_roles.read_only_workspace")))
                        .child(div().mt(px(2.0)).child(hint(
                            trs!(english, "subagent_roles.read_only_roles_use_restricted").into(),
                        ))),
                )
                .child(
                    switch("role-read-only".into(), e.read_only, p).on_click(cx.listener(
                        move |this, _, _, cx| {
                            let allowed = this
                                .subagent_roles
                                .saved
                                .as_ref()
                                .map(|s| {
                                    s.tools
                                        .iter()
                                        .filter(|t| t.read_only_allowed)
                                        .map(|t| t.name.clone())
                                        .collect::<HashSet<_>>()
                                })
                                .unwrap_or_default();
                            if let Some(e) = &mut this.subagent_roles.editor {
                                e.read_only = read_only;
                                if read_only && let Some(tools) = &mut e.tools {
                                    tools.retain(|n| allowed.contains(n));
                                }
                            }
                            cx.notify();
                        },
                    )),
                ),
        );

        // 模型与推理强度: two selects side by side.
        let model_label = e
            .model
            .as_ref()
            .map(|id| {
                self.models
                    .iter()
                    .find(|m| &m.label == id)
                    .map(|m| format!("{}/{}", m.provider_name, m.model.id))
                    .unwrap_or_else(|| id.clone())
            })
            .unwrap_or_else(|| trs!(english, "subagent_roles.inherit_parent_model").into());
        let mut model = div().relative().child(
            select_trigger("role-model", model_label, 240.0, p).on_click(cx.listener(
                |this, _, _, cx| {
                    if let Some(e) = &mut this.subagent_roles.editor {
                        e.model_menu = !e.model_menu;
                        e.thinking_menu = false;
                        if !e.model_menu {
                            e.model_open = None;
                        }
                    }
                    cx.notify();
                },
            )),
        );
        if e.model_menu {
            let inherit = e.model.is_none();
            let mut choices = div().flex().flex_col().child(
                menu_item("role-model-inherit".into(), inherit, hover)
                    .justify_between()
                    .child(trs!(english, "subagent_roles.inherit_parent_model"))
                    .when(inherit, |d| {
                        d.child(icon("tick02", 14.0, p.c(Token::Foreground)))
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(e) = &mut this.subagent_roles.editor {
                            e.model = None;
                            e.model_menu = false;
                        }
                        cx.notify();
                    })),
            );
            // A role picks one model out of every provider's, so the list folds by provider the
            // same way the composer's chip does.
            let open = e.model_open.clone();
            let current = e.model.clone();
            for row in picker_rows(
                &provider_groups(&self.models),
                open.as_deref(),
                current.as_deref(),
            ) {
                let view =
                    super::personalization::as_menu_row(picker_row_view("role-model", &row, p));
                choices = choices.child(match row {
                    PickerRow::Provider { id, .. } => {
                        view.on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) = &mut this.subagent_roles.editor {
                                e.model_open = if e.model_open.as_deref() == Some(id.as_str()) {
                                    None
                                } else {
                                    Some(id.clone())
                                };
                            }
                            cx.notify();
                        }))
                    }
                    PickerRow::Model { label, .. } => {
                        view.on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) = &mut this.subagent_roles.editor {
                                e.model = Some(label.clone());
                                e.model_menu = false;
                                e.model_open = None;
                            }
                            cx.notify();
                        }))
                    }
                });
            }
            model = model.child(crate::ui::float(
                popover(p)
                    .absolute()
                    .top(px(34.0))
                    .left(px(0.0))
                    .w(px(260.0))
                    .child(
                        div()
                            .id("role-model-list")
                            .max_h(px(260.0))
                            .overflow_y_scroll()
                            .child(choices),
                    ),
            ));
        }
        let thinking_label = e
            .thinking
            .map(|level| super::composer::thinking_label_in(level, english))
            .unwrap_or(trs!(english, "subagent_roles.inherit_thinking_level"));
        let mut thinking = div().relative().child(
            select_trigger("role-thinking", thinking_label, 160.0, p).on_click(cx.listener(
                |this, _, _, cx| {
                    if let Some(e) = &mut this.subagent_roles.editor {
                        e.thinking_menu = !e.thinking_menu;
                        e.model_menu = false;
                    }
                    cx.notify();
                },
            )),
        );
        if e.thinking_menu {
            let mut menu = popover(p)
                .absolute()
                .top(px(34.0))
                .left(px(0.0))
                .w(px(176.0));
            for (i, value) in [
                None,
                Some(ThinkingLevel::Minimal),
                Some(ThinkingLevel::Low),
                Some(ThinkingLevel::Medium),
                Some(ThinkingLevel::High),
                Some(ThinkingLevel::Xhigh),
                Some(ThinkingLevel::Max),
            ]
            .into_iter()
            .enumerate()
            {
                let text = value
                    .map(|level| super::composer::thinking_label_in(level, english))
                    .unwrap_or(trs!(english, "subagent_roles.inherit_thinking_level"));
                let active = e.thinking == value;
                menu = menu.child(
                    menu_item(
                        SharedString::from(format!("role-thinking-{i}")),
                        active,
                        hover,
                    )
                    .justify_between()
                    .child(text)
                    .when(active, |d| {
                        d.child(icon("tick02", 14.0, p.c(Token::Foreground)))
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.subagent_roles.editor {
                            e.thinking = value;
                            e.thinking_menu = false;
                        }
                        cx.notify();
                    })),
                );
            }
            thinking = thinking.child(crate::ui::float(menu));
        }
        body = body
            .child(field(vec![
                label(trs!(english, "subagent_roles.model_and_thinking")).into_any_element(),
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.0))
                    .child(model)
                    .child(thinking)
                    .into_any_element(),
            ]))
            .child(field(vec![
                label(trs!(english, "subagent_roles.prompt")).into_any_element(),
                div()
                    .max_h(px(240.0))
                    .child(
                        Textarea::new(&e.prompt)
                            .text_size(px(TEXT_SM))
                            .aria_label(trs!(english, "subagent_roles.prompt")),
                    )
                    .into_any_element(),
            ]));
        if conflict {
            body = body.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(trs!(
                        english,
                        "subagent_roles.this_role_changed_elsewhere_the"
                    )),
            );
        }
        dialog_card(p, 576.0)
            .id("role-editor-scroll")
            .max_h(px(640.0))
            .overflow_y_scroll()
            .child(dialog_head(
                if e.expected.is_some() {
                    trs!(english, "subagent_roles.edit_title")
                } else {
                    trs!(english, "subagent_roles.add_title")
                },
                trs!(english, "subagent_roles.form_desc"),
                p,
            ))
            .child(body)
            .child(
                div()
                    .px(px(16.0))
                    .py(px(12.0))
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .bg(p.c(Token::Muted).opacity(0.5))
                    .child(
                        outline_button("role-cancel", p)
                            .child(trs!(english, "subagent_roles.cancel"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.subagent_roles.editor = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        primary_button("role-save", p)
                            .h(px(32.0))
                            .when(busy, |d| d.opacity(0.5))
                            .child(if busy {
                                trs!(english, "subagent_roles.saving")
                            } else {
                                trs!(english, "subagent_roles.save")
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.save_role(cx))),
                    ),
            )
    }
}

/// What the capture harness draws in place of a host's answer: an empty list, or with
/// `FV_FIXTURE_SAMPLE=1` one role, so the card can be compared too.
fn capture_roles() -> SubagentRolesResponse {
    let tools = ["read", "grep", "find", "ls", "bash", "edit", "write"]
        .into_iter()
        .map(|name| SubagentToolChoice {
            name: name.into(),
            description: String::new(),
            read_only_allowed: !matches!(name, "bash" | "edit" | "write"),
        })
        .collect();
    let roles = if std::env::var_os("FV_FIXTURE_SAMPLE").is_some() {
        vec![
            SubagentRole {
                id: "reviewer".into(),
                name: "代码审查".into(),
                description: "审查改动，找出缺陷与遗漏的测试。".into(),
                system_prompt: String::new(),
                model: None,
                thinking: Some(ThinkingLevel::High),
                read_only: true,
                tools: Some(vec!["read".into(), "grep".into(), "find".into()]),
                builtin: false,
            },
            SubagentRole {
                id: "explorer".into(),
                name: "代码探索".into(),
                description: "Read-only investigation of the codebase. Use for specific, well-scoped questions.".into(),
                system_prompt: String::new(),
                model: None,
                thinking: None,
                read_only: true,
                tools: None,
                builtin: true,
            },
        ]
    } else {
        Vec::new()
    };
    SubagentRolesResponse { roles, tools }
}
