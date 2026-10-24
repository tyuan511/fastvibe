//! 创建项目 / 编辑项目, after `components/project-folders-dialog.tsx`: a name and an ordered list
//! of folders, the first being the primary one. The project's conversations are listed under
//! it, and the agent may work in every folder.

use fv_protocol::methods::{ProjectCreate, ProjectUpdate};
use fv_protocol::types::{ProjectCreateParams, ProjectUpdateParams};
use fv_theme::Token;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::settings::{dialog_card, dialog_foot, dialog_head, modal};
use super::transcript::project_name;
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon};

pub struct ProjectDialog {
    /// The project being edited, by its primary folder as it is now; `None` when creating.
    pub editing: Option<String>,
    pub name: Entity<InputState>,
    pub name_touched: bool,
    /// The folders as they should be, the first being the primary one.
    pub folders: Vec<String>,
    pub busy: bool,
    pub error: Option<String>,
}

impl Workspace {
    /// Open the dialog empty (creating), or filled in with `editing`'s name and folders.
    pub(super) fn open_project_dialog(
        &mut self,
        editing: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (name, folders) = match editing
            .as_ref()
            .and_then(|path| self.projects.iter().find(|p| &p.path == path))
        {
            Some(p) => (
                p.name.clone(),
                std::iter::once(p.path.clone())
                    .chain(p.folders.iter().cloned())
                    .collect(),
            ),
            None => (String::new(), Vec::new()),
        };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("项目名称"));
        input.update(cx, |st, cx| st.set_value(name, window, cx));
        cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change)
                && let Some(d) = &mut this.project_dialog
            {
                d.name_touched = true;
                cx.notify();
            }
        })
        .detach();
        // `set_value` above fires Change; that is not the user typing.
        self.project_dialog = Some(ProjectDialog {
            editing,
            name: input,
            name_touched: false,
            folders,
            busy: false,
            error: None,
        });
        self.close_menus(cx);
        cx.notify();
    }

    /// 添加文件夹: the system's folder picker, any number of folders at once.
    fn pick_folders(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: true,
            prompt: Some("添加文件夹".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            this.update(cx, |this, cx| {
                if let Some(d) = &mut this.project_dialog {
                    for path in paths {
                        let path = path.display().to_string();
                        if !d.folders.contains(&path) {
                            d.folders.push(path);
                        }
                    }
                    d.error = None;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 创建项目 / 确认.
    fn save_project(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(d) = &mut self.project_dialog else {
            return;
        };
        if d.busy || d.folders.is_empty() {
            return;
        }
        d.busy = true;
        d.error = None;
        let name = {
            let n = d.name.read(cx).value().trim().to_string();
            (!n.is_empty()).then_some(n)
        };
        let folders = d.folders.clone();
        let editing = d.editing.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = match editing {
                Some(path) => {
                    b.call::<ProjectUpdate>(ProjectUpdateParams {
                        path,
                        name,
                        folders,
                    })
                    .await
                }
                None => {
                    b.call::<ProjectCreate>(ProjectCreateParams { name, folders })
                        .await
                }
            };
            this.update(cx, |this, cx| {
                match result {
                    Ok(project) => {
                        this.project_dialog = None;
                        // The new chat page starts in it, so the next message lands there.
                        this.selected = None;
                        this.draft_project = Some(project.path);
                        this.refresh_projects(cx);
                    }
                    Err(e) => {
                        if let Some(d) = &mut this.project_dialog {
                            d.busy = false;
                            d.error = Some(format!("无法保存项目：{e}"));
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Dev only: fill the dialog in as a person would, from `name|folder|folder…`.
    #[cfg(feature = "capture")]
    pub fn script_project(&mut self, spec: &str, window: &mut Window, cx: &mut Context<Self>) {
        let mut parts = spec.split('|');
        let name = parts.next().unwrap_or("").to_string();
        let folders: Vec<String> = parts.map(str::to_string).collect();
        self.open_project_dialog(None, window, cx);
        if let Some(d) = &mut self.project_dialog {
            d.folders = folders;
            d.name.update(cx, |st, cx| st.set_value(name, window, cx));
        }
        cx.notify();
    }

    /// Dev only: press 创建项目.
    #[cfg(feature = "capture")]
    pub fn script_save_project(&mut self, cx: &mut Context<Self>) {
        self.save_project(cx);
    }

    pub(super) fn project_dialog_view(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let d = self.project_dialog.as_ref()?;
        let p = &self.palette;
        let hover = p.c(Token::Muted);
        let editing = d.editing.is_some();
        // Said only while the name is blank: that is when it matters.
        let placeholder_hint = d
            .folders
            .first()
            .filter(|_| d.name.read(cx).value().trim().is_empty())
            .map(|f| project_name(f).to_string());

        let mut rows = div()
            .rounded(px(10.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .overflow_hidden()
            .flex()
            .flex_col();
        for (i, folder) in d.folders.iter().enumerate() {
            let group = SharedString::from(format!("folder-{i}"));
            let (primary_of, remove_of) = (folder.clone(), folder.clone());
            rows = rows.child(
                div()
                    .group(group.clone())
                    .px(px(12.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_SM))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .child(icon("folder01", 16.0, p.c(Token::MutedForeground)))
                    .child(
                        ui::truncate(project_name(folder).to_string())
                            .flex_1()
                            .text_color(p.c(Token::Foreground)),
                    )
                    .child(if i == 0 {
                        div()
                            .flex_none()
                            .px(px(6.0))
                            .py(px(2.0))
                            .rounded_full()
                            .bg(p.c(Token::Muted))
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child("主")
                            .into_any_element()
                    } else {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.0))
                            .invisible()
                            .group_hover(group, |s| s.visible())
                            .child(
                                div()
                                    .id(SharedString::from(format!("primary-{i}")))
                                    .px(px(8.0))
                                    .h(px(24.0))
                                    .flex()
                                    .items_center()
                                    .rounded(px(6.0))
                                    .cursor_pointer()
                                    .text_size(px(TEXT_XS))
                                    .hover(move |d| d.bg(hover))
                                    .child("设为主文件夹")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if let Some(d) = &mut this.project_dialog {
                                            d.folders.retain(|f| f != &primary_of);
                                            d.folders.insert(0, primary_of.clone());
                                        }
                                        cx.notify();
                                    })),
                            )
                            .child(
                                ui::icon_button_xs(
                                    SharedString::from(format!("remove-folder-{i}")),
                                    "cancel01",
                                    p,
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        if let Some(d) = &mut this.project_dialog {
                                            d.folders.retain(|f| f != &remove_of);
                                        }
                                        cx.notify();
                                    },
                                )),
                            )
                            .into_any_element()
                    }),
            );
        }
        rows = rows.child(
            div()
                .id("add-folder")
                .px(px(12.0))
                .py(px(8.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .cursor_pointer()
                .text_size(px(TEXT_SM))
                .muted(p)
                .hover(move |d| d.bg(hover))
                .child(icon("add01", 16.0, p.c(Token::MutedForeground)))
                .child("添加文件夹")
                .on_click(cx.listener(|this, _, _, cx| this.pick_folders(cx))),
        );

        let body = dialog_card(p, 448.0)
            .child(dialog_head(
                if editing {
                    "编辑项目"
                } else {
                    "创建项目"
                },
                "",
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
                        div()
                            .px(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .rounded(px(10.0))
                            .border_1()
                            .border_color(p.c(Token::Border))
                            .child(icon("folder01", 16.0, p.c(Token::MutedForeground)))
                            .child(
                                div()
                                    .flex_1()
                                    .child(Input::new(&d.name).appearance(false).bordered(false)),
                            ),
                    )
                    .when_some(placeholder_hint.filter(|_| !editing), |col, hint| {
                        col.child(
                            div()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(SharedString::from(format!("不填则用「{hint}」"))),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(div().text_size(px(TEXT_SM)).muted(p).child("源文件夹"))
                            .child(rows),
                    )
                    .when_some(d.error.clone(), |col, e| {
                        col.child(
                            div()
                                .text_size(px(TEXT_SM))
                                .text_color(p.c(Token::Destructive))
                                .child(SharedString::from(e)),
                        )
                    }),
            )
            .child(dialog_foot(
                p,
                cx,
                |this, cx| {
                    this.project_dialog = None;
                    cx.notify();
                },
                if editing { "确认" } else { "创建项目" },
                |this, _, cx| this.save_project(cx),
                d.folders.is_empty() || d.busy,
            ));
        Some(modal(body, p, cx, |this| this.project_dialog = None))
    }
}
