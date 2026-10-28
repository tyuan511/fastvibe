//! Skills settings use the same server catalog the model receives, including collisions and
//! per-project precedence. Reading an instruction does not execute any of its commands.

use crate::ui::px;
use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::personalization::{
    BadgeKind, badge, empty_box, field_label, ghost_icon, item_card, item_tile, outline_sm,
    primary_button,
};
use super::settings::{Section, card, dialog_head, menu_item, outline_button, popover};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon, truncate};

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
    /// The 添加技能 form is open.
    creating: bool,
    /// The ⋯ menu beside the search is open.
    menu: bool,
    /// The language the placeholders were last written in.
    placeholder_english: Option<bool>,
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
            name: cx.new(|cx| InputState::new(window, cx)),
            description: cx.new(|cx| InputState::new(window, cx)),
            body: cx.new(|cx| TextareaState::new(window, cx).auto_grow(6, 12)),
            import_path: cx.new(|cx| InputState::new(window, cx)),
            query: cx.new(|cx| InputState::new(window, cx)),
            folder_context: None,
            creating: false,
            menu: false,
            placeholder_english: None,
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
                let english = this.english();
                if let Some(s) = this.settings.as_mut()
                    && s.skills.generation == generation
                {
                    match result {
                        Ok(r) => s.skills.catalog = Some(r),
                        Err(e) => {
                            s.skills.notice =
                                Some(tr!(english, "skills.could_not_read_skills_e", e = e))
                        }
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
                let english = this.english();
                if let Some(s) = this.settings.as_mut()
                    && s.skills.reading == Some(request)
                {
                    s.skills.reading = None;
                    match result {
                        Ok(r) => s.skills.preview = Some(r),
                        Err(e) => {
                            s.skills.notice =
                                Some(tr!(english, "skills.could_not_open_the_skill", e = e))
                        }
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
                // Electron's 导入文件夹 imports what was picked; there is no second step.
                this.update(cx, |this, cx| this.import_skill(cx)).ok();
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
            if result.is_ok() {
                s.skills.creating = false;
            }
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

    /// Keep the inputs' placeholders in the interface language (they are made before it is known).
    pub(super) fn sync_skill_placeholders(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let english = self.english();
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.skills.placeholder_english == Some(english) {
            return;
        }
        s.skills.placeholder_english = Some(english);
        let k = &s.skills;
        for (input, key) in [
            (&k.name, "skills.name_placeholder"),
            (&k.description, "skills.description_placeholder"),
            (&k.import_path, "skills.import_placeholder"),
            (&k.query, "skills.search"),
        ] {
            input.update(cx, |state, cx| {
                state.set_placeholder(trs!(english, key), window, cx)
            });
        }
        k.body.update(cx, |state, cx| {
            state.set_placeholder(trs!(english, "skills.instructions_placeholder"), window, cx)
        });
    }

    pub(super) fn skills_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(settings) = &self.settings else {
            return div().into_any_element();
        };
        let s = &settings.skills;
        let p = &self.palette;
        let english = self.english();
        let fg = p.c(Token::Foreground);
        let fixture;
        let catalog = match &s.catalog {
            Some(catalog) => Some(catalog),
            None if cfg!(feature = "capture") && self.backend.is_none() => {
                fixture = capture_skills();
                Some(&fixture)
            }
            None => None,
        };
        let count = catalog.map(|c| c.skills.len()).unwrap_or(0);
        let mut more = div().relative().child(
            outline_button("skills-more", p)
                .size(px(28.0))
                .px_0()
                .justify_center()
                .child(icon("more-horizontal", 16.0, fg))
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(s) = this.settings.as_mut() {
                        s.skills.menu = !s.skills.menu;
                    }
                    cx.notify();
                })),
        );
        if s.menu {
            more = more.child(crate::ui::float(
                popover(p)
                    .absolute()
                    .top(px(32.0))
                    .right(px(0.0))
                    .w(px(176.0))
                    .child(
                        menu_item("skills-import-folder".into(), false, p.c(Token::Muted))
                            .when(s.busy, |d| d.opacity(0.5))
                            .child(icon("folder01", 16.0, fg))
                            .child(trs!(english, "skills.import_folder"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                if let Some(s) = this.settings.as_mut() {
                                    s.skills.menu = false;
                                }
                                this.pick_skill_folder(window, cx);
                                cx.notify();
                            })),
                    ),
            ));
        }
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.0))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(tr!(english, "skills.installed", count = count)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .w(px(224.0))
                            .h(px(32.0))
                            .px(px(10.0))
                            .flex()
                            .items_center()
                            .rounded_full()
                            .border_1()
                            .border_color(p.c(Token::Input))
                            .child(Input::new(&s.query).appearance(false).prefix(icon(
                                "search01",
                                16.0,
                                p.c(Token::MutedForeground),
                            ))),
                    )
                    .child(more)
                    .child(
                        outline_button("refresh-skills", p)
                            .size(px(28.0))
                            .px_0()
                            .justify_center()
                            .when(s.busy, |d| d.opacity(0.5))
                            .child(icon("refresh01", 16.0, fg))
                            .on_click(cx.listener(|this, _, _, cx| this.refresh_skills(cx))),
                    )
                    .child(
                        primary_button("create-skill-open", p)
                            .when(s.busy, |d| d.opacity(0.5))
                            .child(icon("add01", 14.0, p.c(Token::PrimaryForeground)))
                            .child(trs!(english, "skills.new"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(s) = this.settings.as_mut() {
                                    s.skills.creating = true;
                                }
                                cx.notify();
                            })),
                    ),
            );
        let mut pane = div().flex().flex_col().gap(px(16.0)).child(header);
        if let Some(notice) = &s.notice {
            pane = pane.child(
                div()
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(SharedString::from(notice.clone())),
            );
        }
        if s.creating {
            pane = pane.child(self.skill_create_card(cx));
        }
        let query = s.query.read(cx).value().to_lowercase();
        let Some(catalog) = catalog else {
            return pane
                .child(
                    div()
                        .text_size(px(TEXT_SM))
                        .muted(p)
                        .child(trs!(english, "skills.loading_skills")),
                )
                .into_any_element();
        };
        let visible: Vec<_> = catalog
            .skills
            .iter()
            .filter(|skill| {
                query.is_empty()
                    || skill.name.to_lowercase().contains(&query)
                    || skill.description.to_lowercase().contains(&query)
            })
            .collect();
        if visible.is_empty() {
            pane = pane.child(if catalog.skills.is_empty() {
                empty_box(
                    "magic-wand02",
                    trs!(english, "skills.none"),
                    trs!(english, "skills.empty_hint"),
                    p,
                )
            } else {
                empty_box(
                    "magic-wand02",
                    trs!(english, "skills.none_match"),
                    trs!(english, "skills.try_other"),
                    p,
                )
            });
        } else {
            let mut list = div().flex().flex_col().gap(px(10.0));
            for skill in visible {
                list = list.child(self.skill_card(skill, cx));
            }
            pane = pane.child(list);
        }
        for message in &catalog.diagnostics {
            pane = pane.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Warning))
                    .child(SharedString::from(message.clone())),
            );
        }
        if let Some(preview) = &s.preview {
            pane = pane.child(
                card(p)
                    .p(px(16.0))
                    .gap(px(8.0))
                    .child(
                        div().flex().items_center().justify_end().child(
                            ghost_icon(
                                "close-skill-preview",
                                "cancel01",
                                24.0,
                                12.0,
                                p.c(Token::MutedForeground),
                                p,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(s) = this.settings.as_mut() {
                                    s.skills.preview = None;
                                }
                                cx.notify();
                            })),
                        ),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .child(SharedString::from(preview.content.clone())),
                    ),
            );
        }
        pane.into_any_element()
    }

    /// One skill as Electron's `SkillCard`. Clicking it reads the instructions underneath.
    fn skill_card(&self, skill: &SkillInfo, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.english();
        let Some(settings) = &self.settings else {
            return div().into_any_element();
        };
        let s = &settings.skills;
        let scope = match skill.scope {
            SkillScope::Project => trs!(english, "skills.project"),
            SkillScope::Managed => trs!(english, "skills.private"),
            SkillScope::Global => trs!(english, "skills.global"),
            SkillScope::Builtin => trs!(english, "skills.built_in"),
        };
        let name = skill.name.clone();
        let remove = name.clone();
        let confirm = s.confirm_remove.as_deref() == Some(&name);
        let fg = p.c(Token::Foreground);
        let mut card = item_card(p)
            .id(SharedString::from(format!("skill-{name}")))
            .cursor_pointer()
            .child(div().mt(px(2.0)).child(item_tile("magic-wand02", 16.0, p)))
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
                                    .child(truncate(skill.name.clone())),
                            )
                            .child(badge(BadgeKind::Secondary, None, scope, p))
                            .when(skill.manual_only, |d| {
                                d.child(badge(
                                    BadgeKind::Outline,
                                    None,
                                    trs!(english, "skills.used_only_when_selected"),
                                    p,
                                ))
                            }),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .muted(p)
                            .child(truncate(skill.description.clone())),
                    ),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.read_skill(name.clone(), cx)));
        if skill.removable {
            card = card.child(div().flex_none().self_center().child(if confirm {
                let cancel = remove.clone();
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        outline_sm(SharedString::from(format!("confirm-remove-{remove}")), p)
                            .text_color(p.c(Token::Destructive))
                            .child(trs!(english, "skills.confirm_delete"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                this.remove_skill(remove.clone(), cx)
                            })),
                    )
                    .child(
                        ghost_icon(
                            SharedString::from(format!("cancel-remove-{cancel}")),
                            "cancel01",
                            24.0,
                            12.0,
                            p.c(Token::MutedForeground),
                            p,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            if let Some(s) = this.settings.as_mut() {
                                s.skills.confirm_remove = None;
                            }
                            cx.notify();
                        })),
                    )
            } else {
                div().child(
                    ghost_icon(
                        SharedString::from(format!("remove-{remove}")),
                        "delete02",
                        24.0,
                        12.0,
                        fg,
                        p,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        if let Some(s) = this.settings.as_mut() {
                            s.skills.confirm_remove = Some(remove.clone());
                        }
                        cx.notify();
                    })),
                )
            }));
        }
        card.into_any_element()
    }

    /// Electron's 添加技能 dialog, drawn in the pane.
    fn skill_create_card(&self, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let english = self.english();
        let Some(settings) = &self.settings else {
            return div();
        };
        let s = &settings.skills;
        let field = |label: &'static str| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(field_label(label))
        };
        card(p)
            .child(dialog_head(
                trs!(english, "skills.dialog_title"),
                trs!(english, "skills.dialog_desc"),
                p,
            ))
            .child(
                div()
                    .px(px(20.0))
                    .pb(px(16.0))
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .child(
                        field(trs!(english, "skills.name"))
                            .child(Input::new(&s.name))
                            .child(
                                div()
                                    .text_size(px(TEXT_XS))
                                    .muted(p)
                                    .child(trs!(english, "skills.name_hint")),
                            ),
                    )
                    .child(
                        field(trs!(english, "skills.description"))
                            .child(Input::new(&s.description)),
                    )
                    .child(
                        field(trs!(english, "skills.instructions"))
                            .child(Textarea::new(&s.body).text_size(px(TEXT_SM))),
                    ),
            )
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
                        outline_button("cancel-create-skill", p)
                            .child(trs!(english, "skills.cancel"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(s) = this.settings.as_mut() {
                                    s.skills.creating = false;
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        primary_button("create-skill", p)
                            .h(px(32.0))
                            .when(s.busy, |d| d.opacity(0.5))
                            .child(if s.busy {
                                trs!(english, "skills.saving")
                            } else {
                                trs!(english, "skills.add")
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.create_skill(cx))),
                    ),
            )
    }
}

/// What the capture harness draws without a host: the three skills the Electron mock lists.
fn capture_skills() -> SkillListResponse {
    let skill = |name: &str, description: &str, scope, removable| SkillInfo {
        name: name.into(),
        description: description.into(),
        path: String::new(),
        scope,
        removable,
        manual_only: false,
    };
    SkillListResponse {
        skills: vec![
            skill(
                "frontend-design",
                "Create distinctive, production-grade frontend interfaces with high design quality.",
                SkillScope::Global,
                true,
            ),
            skill(
                "excalidraw",
                "Generate architecture diagrams as .excalidraw files from codebase analysis.",
                SkillScope::Global,
                true,
            ),
            skill(
                "changelog",
                "Turn a changelog markdown into a short branded video.",
                SkillScope::Project,
                false,
            ),
        ],
        diagnostics: Vec::new(),
    }
}
