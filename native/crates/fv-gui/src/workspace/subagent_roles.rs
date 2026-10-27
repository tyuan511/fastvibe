//! Explicit role saves, guarded against stale reads, concurrent editors and late responses.
use super::{
    Workspace,
    settings::{Section, card, outline_button, switch},
};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS};
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
        });
        let prompt = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(4, 12)
                .placeholder(if english {
                    "Role responsibilities, working style, and completion requirements"
                } else {
                    "角色的职责、工作方式与完成要求"
                })
        });
        prompt.update(cx, |state, cx| {
            state.set_value(current.system_prompt.clone(), window, cx)
        });
        Self {
            session: ticket(),
            expected: role,
            id: field(
                if english {
                    "Role ID (letters, numbers, - or _)"
                } else {
                    "角色 ID（字母、数字、- 或 _）"
                },
                window,
                cx,
                &current.id,
            ),
            name: field(
                if english {
                    "Display name"
                } else {
                    "显示名称"
                },
                window,
                cx,
                &current.name,
            ),
            description: field(
                if english {
                    "Description shown when the main Agent chooses a role"
                } else {
                    "供主 Agent 选择角色时参考的说明"
                },
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
    pub(super) fn roles_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let s = &self.subagent_roles;
        let english = self.app_settings.language == UiLanguage::English;
        let mut pane=card(p).p(px(16.0)).gap(px(12.0)).text_size(px(TEXT_SM))
            .child(div().flex().items_center().justify_between().child(if english { "Role templates" } else { "角色模板" })
                .child(outline_button("role-add",p).child(if english { "New role" } else { "新建角色" }).on_click(cx.listener(|this,_,window,cx|this.edit_role(None,window,cx)))))
            .child(div().text_size(px(TEXT_XS)).muted(p).child(if english { "Roles can define instructions, model, thinking level, and tool scope. Editing or deleting a template does not affect existing subtasks; the main Agent can choose a role by ID." } else { "角色可指定说明、模型、思考强度和工具范围。修改或删除模板不影响已有子任务；主 Agent 创建任务时可按角色 ID 选择。" }));
        if let Some(saved) = &s.saved {
            for role in &saved.roles {
                let edit = role.clone();
                let remove = role.clone();
                let confirm = s.confirm_delete.as_deref() == Some(&role.id);
                pane = pane.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(format!(
                                    "{} · {}{}",
                                    role.name,
                                    role.id,
                                    if role.read_only {
                                        if english {
                                            " · read-only"
                                        } else {
                                            " · 只读"
                                        }
                                    } else {
                                        ""
                                    }
                                ))
                                .child(
                                    div()
                                        .text_size(px(TEXT_XS))
                                        .muted(p)
                                        .child(role.description.clone()),
                                ),
                        )
                        .child(
                            outline_button(SharedString::from(format!("role-edit-{}", role.id)), p)
                                .child(if english { "Edit" } else { "编辑" })
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.edit_role(Some(edit.clone()), window, cx)
                                })),
                        )
                        .child(
                            outline_button(
                                SharedString::from(format!("role-remove-{}", role.id)),
                                p,
                            )
                            .child(if confirm {
                                if english {
                                    "Confirm delete"
                                } else {
                                    "确认删除"
                                }
                            } else {
                                if english { "Delete" } else { "删除" }
                            })
                            .on_click(cx.listener(
                                move |this, _, _, cx| this.delete_role(remove.clone(), cx),
                            )),
                        ),
                );
            }
        } else {
            pane = pane.child(div().muted(p).child(if english {
                "Loading roles…"
            } else {
                "正在读取角色…"
            }));
        }
        if let Some(error) = &s.error {
            pane = pane.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(error.clone()),
            );
        }
        if let Some(notice) = &s.notice {
            pane = pane.child(div().text_size(px(TEXT_XS)).muted(p).child(notice.clone()));
        }
        if let Some(editor) = &s.editor {
            pane = pane.child(self.role_editor(editor, cx));
        }
        pane.into_any_element()
    }
    fn role_editor(&self, e: &Editor, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let saved = self.subagent_roles.saved.as_ref();
        let busy = self.subagent_roles.busy;
        let conflict = e.expected.as_ref().is_some_and(|old| {
            saved.is_some_and(|s| s.roles.iter().find(|r| r.id == old.id) != Some(old))
        });
        let mut form = div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .border_t_1()
            .border_color(p.c(Token::Border))
            .pt(px(12.0));
        if let Some(role) = &e.expected {
            form = form.child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                format!("Role ID: {}", role.id)
            } else {
                format!("角色 ID：{}", role.id)
            }));
        } else if busy {
            form = form.child(format!("角色 ID：{}", e.id.read(cx).value()));
        } else {
            form = form.child(Input::new(&e.id));
        }
        form = form
            .child(Input::new(&e.name))
            .child(Input::new(&e.description))
            .child(
                div()
                    .max_h(px(240.0))
                    .child(Textarea::new(&e.prompt).aria_label("角色说明")),
            );
        let label = e
            .model
            .as_ref()
            .map(|id| {
                self.models
                    .iter()
                    .find(|m| &m.label == id)
                    .map(|m| format!("{} / {}", m.provider_name, m.model.id))
                    .unwrap_or_else(|| id.clone())
            })
            .unwrap_or_else(|| {
                if english {
                    "Inherit parent model".into()
                } else {
                    "继承父任务模型".into()
                }
            });
        form = form.child(
            outline_button("role-model", p)
                .child(label)
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(e) = &mut this.subagent_roles.editor {
                        e.model_menu = !e.model_menu;
                    }
                    cx.notify();
                })),
        );
        if e.model_menu {
            let mut choices = div()
                .id("role-model-list")
                .max_h(px(180.0))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(4.0));
            for (i, (value, label)) in std::iter::once((
                None,
                if english {
                    "Inherit parent model".to_string()
                } else {
                    "继承父任务模型".to_string()
                },
            ))
            .chain(self.models.iter().map(|m| {
                (
                    Some(m.label.clone()),
                    format!("{} / {}", m.provider_name, m.model.id),
                )
            }))
            .enumerate()
            {
                choices = choices.child(
                    outline_button(SharedString::from(format!("role-model-choice-{i}")), p)
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) = &mut this.subagent_roles.editor {
                                e.model = value.clone();
                                e.model_menu = false;
                            }
                            cx.notify();
                        })),
                );
            }
            form = form.child(choices);
        }
        let mut thinking = div().flex().flex_wrap().gap(px(4.0));
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
            let label = value
                .map(super::composer::thinking_label)
                .unwrap_or(if english {
                    "Inherit thinking level"
                } else {
                    "继承思考强度"
                });
            thinking = thinking.child(
                outline_button(SharedString::from(format!("role-thinking-{i}")), p)
                    .when(e.thinking == value, |d| d.bg(p.c(Token::Accent)))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(e) = &mut this.subagent_roles.editor {
                            e.thinking = value;
                        }
                        cx.notify();
                    })),
            );
        }
        let read_only = !e.read_only;
        form = form.child(thinking).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(if english {
                    "Read-only workspace"
                } else {
                    "只读工作区"
                })
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
        if e.read_only {
            form = form.child(div().text_size(px(TEXT_XS)).muted(p).child(
                if english { "Read-only roles use restricted local tools only; MCP and further delegation are unavailable, and filesystem restrictions cannot be lifted." } else { "只读角色仅使用受限的本机工具，不提供 MCP 或继续委派；不能申请解除文件系统限制。" },
            ));
        }
        let all = e.tools.is_none();
        form = form.child(
            outline_button("role-tools-mode", p)
                .child(if all {
                    if english {
                        "Tools: inherit all available"
                    } else {
                        "工具：继承全部可用工具"
                    }
                } else {
                    if english {
                        "Tools: selected only"
                    } else {
                        "工具：仅选中的工具"
                    }
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(e) = &mut this.subagent_roles.editor {
                        e.tools = if all { Some(HashSet::new()) } else { None };
                    }
                    cx.notify();
                })),
        );
        if let Some(selected) = &e.tools {
            let mut tools = div()
                .id("role-tools-list")
                .max_h(px(200.0))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(4.0));
            let available = saved
                .map(|s| {
                    s.tools
                        .iter()
                        .filter(|t| !e.read_only || t.read_only_allowed)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for tool in available {
                let name = tool.name.clone();
                let checked = selected.contains(&name);
                tools = tools.child(
                    outline_button(SharedString::from(format!("role-tool-{name}")), p)
                        .child(format!("{} {}", if checked { "✓" } else { "○" }, name))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) = &mut this.subagent_roles.editor
                                && let Some(tools) = &mut e.tools
                                && !tools.remove(&name)
                            {
                                tools.insert(name.clone());
                            }
                            cx.notify();
                        })),
                );
            }
            for name in selected
                .iter()
                .filter(|name| !saved.is_some_and(|s| s.tools.iter().any(|t| &t.name == *name)))
            {
                let name = name.clone();
                tools = tools.child(
                    outline_button(SharedString::from(format!("role-missing-{name}")), p)
                        .child(if english {
                            format!("✓ {name} (currently unavailable; click to remove)")
                        } else {
                            format!("✓ {name}（当前不可用，点击移除）")
                        })
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
            form = form.child(tools);
        }
        if conflict {
            form = form.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(if english { "This role changed elsewhere. The draft is kept; click Edit again to load the latest version." } else { "此角色已在别处更改。草稿仍保留；重新点“编辑”可载入最新版本。" }),
            );
        }
        form.child(
            div()
                .flex()
                .gap(px(8.0))
                .child(
                    outline_button("role-save", p)
                        .when(busy, |d| d.opacity(0.5))
                        .child(if busy {
                            if english {
                                "Saving…"
                            } else {
                                "正在保存…"
                            }
                        } else {
                            if english { "Save role" } else { "保存角色" }
                        })
                        .on_click(cx.listener(|this, _, _, cx| this.save_role(cx))),
                )
                .child(
                    outline_button("role-cancel", p)
                        .child(if english { "Close editor" } else { "收起" })
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.subagent_roles.editor = None;
                            cx.notify();
                        })),
                ),
        )
    }
}
