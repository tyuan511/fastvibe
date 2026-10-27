//! Skills settings use the same server catalog the model receives, including collisions and
//! per-project precedence. Reading an instruction does not execute any of its commands.

use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::*;

use super::Workspace;
use super::settings::{Section, card, outline_button};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS};

fn request_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

pub struct SkillSettings {
    session: u64,
    pub catalog: Option<SkillListResponse>,
    pub preview: Option<SkillReadResponse>,
    pub reading: Option<u64>,
    pub notice: Option<String>,
    pub busy: bool,
    pub confirm_remove: Option<String>,
    pub name: Entity<InputState>,
    pub description: Entity<InputState>,
    pub body: Entity<TextareaState>,
    pub import_path: Entity<InputState>,
    pub query: Entity<InputState>,
    folder_context: Option<(Option<String>, Vec<String>)>,
    /// Requests for another project's catalog must not paint this project's settings.
    generation: u64,
}

impl SkillSettings {
    pub fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            session: request_id(),
            catalog: None,
            preview: None,
            reading: None,
            notice: None,
            busy: false,
            confirm_remove: None,
            name: cx
                .new(|cx| InputState::new(window, cx).placeholder("名称 / Name, e.g. review-code")),
            description: cx.new(|cx| {
                InputState::new(window, cx).placeholder("何时使用 / When to use this skill")
            }),
            body: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(4, 12)
                    .placeholder("技能指令 / Skill instructions")
            }),
            import_path: cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("包含 SKILL.md 的文件夹 / Folder containing SKILL.md")
            }),
            query: cx.new(|cx| {
                InputState::new(window, cx).placeholder("搜索技能名称或说明 / Search skills")
            }),
            folder_context: None,
            generation: 0,
        }
    }
}

impl Workspace {
    pub(super) fn skill_cwd(&self) -> Option<String> {
        self.selected
            .as_deref()
            .and_then(|id| self.project_root_for(id))
            .or_else(|| self.draft_project.clone())
    }

    pub(super) fn skill_other_folders(&self) -> Vec<String> {
        let project = self
            .selected
            .as_deref()
            .and_then(|id| self.views.get(id))
            .and_then(|v| v.thread.project.as_deref())
            .or(self.draft_project.as_deref());
        self.projects
            .iter()
            .find(|p| Some(p.path.as_str()) == project)
            .map(|p| {
                let mut folders = p.folders.clone();
                let worktree = self
                    .selected
                    .as_deref()
                    .and_then(|id| self.views.get(id))
                    .is_some_and(|v| v.thread.worktree.is_some());
                if !worktree {
                    folders.insert(0, p.path.clone());
                }
                folders
            })
            .unwrap_or_default()
    }

    pub(super) fn refresh_skills(&mut self, cx: &mut Context<Self>) {
        let cwd = self.skill_cwd();
        let other_folders = self.skill_other_folders();
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self
            .settings
            .as_mut()
            .filter(|s| s.section == Section::Skills)
        else {
            return;
        };
        s.skills.generation = request_id();
        let folder_context = (cwd.clone(), other_folders.clone());
        if s.skills.folder_context.as_ref() != Some(&folder_context) {
            s.skills.catalog = None;
            s.skills.preview = None;
            s.skills.reading = None;
            s.skills.folder_context = Some(folder_context);
        }
        let generation = s.skills.generation;
        let call = b.call::<SkillList>(SkillListParams { cwd, other_folders });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Some(s) = this.settings.as_mut()
                    && s.skills.generation == generation
                {
                    match result {
                        Ok(r) => s.skills.catalog = Some(r),
                        Err(e) => s.skills.notice = Some(format!("无法读取技能：{e}")),
                    }
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn read_skill(&mut self, name: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let cwd = self.skill_cwd();
        let request = request_id();
        if let Some(s) = self.settings.as_mut() {
            s.skills.reading = Some(request);
            s.skills.preview = None;
        }
        let call = b.call::<SkillRead>(SkillNameParams {
            cwd,
            other_folders: self.skill_other_folders(),
            name: name.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Some(s) = this.settings.as_mut()
                    && s.skills.reading == Some(request)
                {
                    s.skills.reading = None;
                    match result {
                        Ok(r) => s.skills.preview = Some(r),
                        Err(e) => s.skills.notice = Some(format!("无法打开技能：{e}")),
                    }
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn create_skill(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.skills.busy {
            return;
        }
        let params = SkillCreateParams {
            name: s.skills.name.read(cx).value().trim().to_string(),
            description: s.skills.description.read(cx).value().trim().to_string(),
            body: s.skills.body.read(cx).value().to_string(),
        };
        let session = s.skills.session;
        s.skills.busy = true;
        s.skills.notice = None;
        let call = b.call::<SkillCreate>(params);
        cx.spawn(async move |this, cx| {
            let result = call.await.map_err(|e| e.to_string());
            this.update(cx, |this, cx| this.finish_skill_change(session, result, cx))
                .ok();
        })
        .detach();
        cx.notify();
    }

    fn import_skill(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.skills.busy {
            return;
        }
        let path = s.skills.import_path.read(cx).value().trim().to_string();
        let session = s.skills.session;
        s.skills.busy = true;
        s.skills.notice = None;
        let call = b.call::<SkillImport>(SkillImportParams { path });
        cx.spawn(async move |this, cx| {
            let result = call.await.map_err(|e| e.to_string());
            this.update(cx, |this, cx| this.finish_skill_change(session, result, cx))
                .ok();
        })
        .detach();
        cx.notify();
    }

    fn pick_skill_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = &self.settings else {
            return;
        };
        let session = s.skills.session;
        let window_handle = window.window_handle();
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(
                if self.app_settings.language == UiLanguage::English {
                    "Choose skill folder"
                } else {
                    "选择技能文件夹"
                }
                .into(),
            ),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.first() else {
                return;
            };
            let path = path.display().to_string();
            let input = this
                .update(cx, |this, _| {
                    this.settings
                        .as_ref()
                        .filter(|s| s.skills.session == session)
                        .map(|s| s.skills.import_path.clone())
                })
                .ok()
                .flatten();
            if let Some(input) = input {
                let _ = cx.update_window(window_handle, |_, window, cx| {
                    input.update(cx, |state, cx| state.set_value(path, window, cx));
                });
            }
        })
        .detach();
    }

    fn remove_skill(&mut self, name: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let cwd = self.skill_cwd();
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.skills.busy {
            return;
        }
        let session = s.skills.session;
        s.skills.busy = true;
        s.skills.confirm_remove = None;
        s.skills.preview = None;
        let call = b.call::<SkillRemove>(SkillNameParams {
            cwd,
            name,
            other_folders: self.skill_other_folders(),
        });
        cx.spawn(async move |this, cx| {
            let result = call.await.map_err(|e| e.to_string());
            this.update(cx, |this, cx| this.finish_skill_change(session, result, cx))
                .ok();
        })
        .detach();
        cx.notify();
    }

    fn finish_skill_change(
        &mut self,
        session: u64,
        result: Result<Empty, String>,
        cx: &mut Context<Self>,
    ) {
        if let Some(s) = self.settings.as_mut()
            && s.skills.session == session
        {
            s.skills.busy = false;
            s.skills.notice = Some(match result {
                Ok(_) => {
                    if self.app_settings.language == UiLanguage::English {
                        "Skill updated".into()
                    } else {
                        "技能已更新".into()
                    }
                }
                Err(e) => {
                    if self.app_settings.language == UiLanguage::English {
                        format!("Could not update skill: {e}")
                    } else {
                        format!("无法更新技能：{e}")
                    }
                }
            });
        }
        self.refresh_skills(cx);
        cx.notify();
    }

    pub(super) fn skills_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(settings) = &self.settings else {
            return div().into_any_element();
        };
        let s = &settings.skills;
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let mut pane = div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(if english { "Skills are loaded for the current project. Enter /skill:name at the start of a chat to select one." } else { "按当前项目加载技能。在对话开头输入 /skill:名称 可指定使用。" }),
            )
            .child(Input::new(&s.query))
            .child(
                outline_button("refresh-skills", p)
                    .child(if english { "Refresh" } else { "刷新" })
                    .on_click(cx.listener(|this, _, _, cx| this.refresh_skills(cx))),
            );
        if let Some(notice) = &s.notice {
            pane = pane.child(
                div()
                    .text_size(px(TEXT_SM))
                    .child(SharedString::from(notice.clone())),
            );
        }
        let query = s.query.read(cx).value().to_lowercase();
        if let Some(catalog) = &s.catalog {
            let mut list = card(p).p(px(12.0)).flex().flex_col().gap(px(12.0));
            for skill in catalog.skills.iter().filter(|skill| {
                query.is_empty()
                    || skill.name.to_lowercase().contains(&query)
                    || skill.description.to_lowercase().contains(&query)
            }) {
                let name = skill.name.clone();
                let remove = name.clone();
                let scope = match skill.scope {
                    SkillScope::Project => {
                        if english {
                            "Project"
                        } else {
                            "项目"
                        }
                    }
                    SkillScope::Managed => {
                        if english {
                            "Private"
                        } else {
                            "私有"
                        }
                    }
                    SkillScope::Global => {
                        if english {
                            "Global"
                        } else {
                            "全局"
                        }
                    }
                    SkillScope::Builtin => {
                        if english {
                            "Built-in"
                        } else {
                            "内置"
                        }
                    }
                };
                let mut row = div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div().flex().items_center().justify_between().child(
                            outline_button(SharedString::from(format!("skill-{name}")), p)
                                .child(SharedString::from(format!("{name} · {scope}")))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.read_skill(name.clone(), cx)
                                })),
                        ),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .child(SharedString::from(skill.description.clone())),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(SharedString::from(skill.path.clone())),
                    );
                if skill.manual_only {
                    row = row.child(div().text_size(px(TEXT_XS)).muted(p).child(if english {
                        "Used only when selected"
                    } else {
                        "仅在指定时使用"
                    }));
                }
                if skill.removable {
                    row = row.child(
                        outline_button(SharedString::from(format!("remove-{remove}")), p)
                            .child(if english { "Delete" } else { "删除" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(s) = this.settings.as_mut() {
                                    s.skills.confirm_remove = Some(remove.clone());
                                }
                                cx.notify();
                            })),
                    );
                }
                list = list.child(row);
            }
            if catalog.skills.is_empty() {
                list = list.child(div().text_size(px(TEXT_SM)).muted(p).child(if english {
                    "No skills yet. Create one or import a local folder."
                } else {
                    "还没有技能。可以创建技能，或从本地文件夹导入。"
                }));
            }
            pane = pane.child(list);
            for message in &catalog.diagnostics {
                pane = pane.child(
                    div()
                        .text_size(px(TEXT_XS))
                        .text_color(p.c(Token::Warning))
                        .child(SharedString::from(message.clone())),
                );
            }
        } else {
            pane = pane.child(div().text_size(px(TEXT_SM)).child(if english {
                "Loading skills…"
            } else {
                "正在加载技能…"
            }));
        }
        if let Some(name) = &s.confirm_remove {
            let name = name.clone();
            pane = pane.child(
                card(p)
                    .p(px(12.0))
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(SharedString::from(if english {
                        format!("Delete skill {name} and all its resources? This cannot be undone.")
                    } else {
                        format!("删除技能 {name} 及其全部资源？无法恢复。")
                    }))
                    .child(
                        outline_button("confirm-remove-skill", p)
                            .child(if english {
                                "Confirm delete"
                            } else {
                                "确认删除"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.remove_skill(name.clone(), cx)
                            })),
                    )
                    .child(
                        outline_button("cancel-remove-skill", p)
                            .child(if english { "Cancel" } else { "取消" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(s) = this.settings.as_mut() {
                                    s.skills.confirm_remove = None;
                                }
                                cx.notify();
                            })),
                    ),
            );
        }
        if let Some(preview) = &s.preview {
            pane = pane.child(
                card(p)
                    .p(px(16.0))
                    .text_size(px(TEXT_SM))
                    .child(SharedString::from(preview.content.clone())),
            );
        }
        pane.child(
            card(p)
                .p(px(16.0))
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(if english {
                    "Create skill"
                } else {
                    "创建技能"
                })
                .child(Input::new(&s.name))
                .child(Input::new(&s.description))
                .child(Textarea::new(&s.body))
                .child(
                    outline_button("create-skill", p)
                        .child(if s.busy {
                            if english {
                                "Saving…"
                            } else {
                                "正在保存…"
                            }
                        } else if english {
                            "Create"
                        } else {
                            "创建"
                        })
                        .on_click(cx.listener(|this, _, _, cx| this.create_skill(cx))),
                ),
        )
        .child(
            card(p)
                .p(px(16.0))
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(if english {
                    "Import skill"
                } else {
                    "导入技能"
                })
                .child(Input::new(&s.import_path))
                .child(
                    outline_button("pick-skill-folder", p)
                        .child(if english {
                            "Choose folder"
                        } else {
                            "选择文件夹"
                        })
                        .on_click(
                            cx.listener(|this, _, window, cx| this.pick_skill_folder(window, cx)),
                        ),
                )
                .child(
                    outline_button("import-skill", p)
                        .child(if english { "Import" } else { "导入" })
                        .on_click(cx.listener(|this, _, _, cx| this.import_skill(cx))),
                ),
        )
        .into_any_element()
    }
}
