//! 创建项目 / 编辑项目, after `components/project-folders-dialog.tsx`: a name and an ordered list
//! of folders, the first being the primary one. The project's conversations are listed under
//! it, and the agent may work in every folder.

use crate::ui::px;
use fv_protocol::methods::{ProjectCreate, ProjectUpdate};
use fv_protocol::types::{ProjectCreateParams, ProjectUpdateParams, UiLanguage};
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::settings::{dialog_card, modal};
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
    pub remote_folder: Entity<InputState>,
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
        // The placeholder is drawn by the dialog: it names the primary folder once there is one,
        // which is what an empty name will become.
        let input = cx.new(|cx| InputState::new(window, cx));
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
            remote_folder: cx.new(|cx| {
                InputState::new(window, cx).placeholder(trs!(self.english(), "ssh.remote_folder"))
            }),
        });
        self.close_menus(cx);
        cx.notify();
    }

    /// 添加文件夹: the system's folder picker, any number of folders at once.
    pub(super) fn pick_folders(&mut self, cx: &mut Context<Self>) {
        if self.ssh_host.is_some() {
            let english = self.english();
            if let Some(d) = self.project_dialog.as_mut() {
                let path = d.remote_folder.read(cx).value().trim().to_string();
                if !path.starts_with('/') || path.chars().any(char::is_control) {
                    d.error = Some(trs!(english, "ssh.invalid_folder").into());
                } else if !d.folders.contains(&path) {
                    d.folders.push(path);
                    d.error = None;
                }
            }
            cx.notify();
            return;
        }
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: true,
            prompt: Some(
                if self.app_settings.language == UiLanguage::English {
                    "Add folders"
                } else {
                    "添加文件夹"
                }
                .into(),
            ),
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
        let previous_primary = editing.clone();
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
                        if let Some(previous) = &previous_primary {
                            if this.draft_project.as_ref() == Some(previous) {
                                this.draft_project = Some(project.path.clone());
                            }
                            if let Some(id) = this.selected.clone() {
                                this.load_view(id, cx);
                            }
                        } else {
                            this.new_chat(Some(project.path), cx);
                        }
                        this.refresh_projects(cx);
                    }
                    Err(e) => {
                        if let Some(d) = &mut this.project_dialog {
                            d.busy = false;
                            d.error = Some(if this.app_settings.language == UiLanguage::English {
                                format!("Could not save project: {e}")
                            } else {
                                format!("无法保存项目：{e}")
                            });
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
        let english = self.app_settings.language == UiLanguage::English;
        let hover = p.c(Token::Muted);
        let editing = d.editing.is_some();
        // `placeholder`: the primary folder's name, which is what a blank name becomes.
        let placeholder = d
            .folders
            .first()
            .filter(|_| d.name.read(cx).value().is_empty())
            .map(|f| project_name(f).to_string())
            .or_else(|| {
                d.name
                    .read(cx)
                    .value()
                    .is_empty()
                    .then(|| trs!(english, "projects.name_placeholder").to_string())
            });

        let mut rows = div()
            .rounded(px(10.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .overflow_hidden()
            .flex()
            .flex_col();
        for (i, folder) in d.folders.iter().enumerate() {
            let group = SharedString::from(format!("folder-{i}"));
            let missing = self.ssh_host.is_none() && !std::path::Path::new(folder).exists();
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
                            .text_color(if missing {
                                p.c(Token::Destructive)
                            } else {
                                p.c(Token::Foreground)
                            }),
                    )
                    .when(missing, |d| {
                        d.child(
                            div()
                                .flex_none()
                                .text_size(px(TEXT_XS))
                                .text_color(p.c(Token::Destructive))
                                .child(trs!(english, "projects.missing")),
                        )
                    })
                    .child(if i == 0 {
                        div()
                            .flex_none()
                            .px(px(6.0))
                            .py(px(2.0))
                            .rounded_full()
                            .bg(p.c(Token::Muted))
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(trs!(english, "projects.main"))
                            .into_any_element()
                    } else {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.0))
                            // Collapsed, not merely hidden: the label is wide enough to leave a
                            // blank at the end of every row.
                            .w(px(0.0))
                            .overflow_hidden()
                            .invisible()
                            .group_hover(group, |s| s.visible().w_auto())
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
                                    .child(trs!(english, "projects.make_primary_folder"))
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
        if self.ssh_host.is_some() {
            rows = rows.child(
                div()
                    .px(px(12.))
                    .py(px(8.))
                    .child(crate::ui::input(&d.remote_folder)),
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
                .child(trs!(
                    english,
                    if self.ssh_host.is_some() {
                        "ssh.add_folder"
                    } else {
                        "projects.add_folder"
                    }
                ))
                .on_click(cx.listener(|this, _, _, cx| this.pick_folders(cx))),
        );

        let disabled = d.folders.is_empty() || d.busy;
        let body = dialog_card(p, 448.0)
            .p(px(16.0))
            .gap(px(16.0))
            .text_size(px(TEXT_SM))
            .child(
                div()
                    .text_size(px(16.0))
                    .line_height(px(16.0))
                    .font_weight(FontWeight::MEDIUM)
                    .child(if editing {
                        trs!(english, "projects.edit_project")
                    } else {
                        trs!(english, "projects.create_project")
                    }),
            )
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
                            .relative()
                            .flex_1()
                            .min_w_0()
                            .child(crate::ui::input(&d.name).appearance(false).bordered(false))
                            .when_some(placeholder, |d, text| {
                                d.child(
                                    div()
                                        .absolute()
                                        .inset_0()
                                        .flex()
                                        .items_center()
                                        .text_size(px(TEXT_SM))
                                        .muted(p)
                                        .child(ui::truncate(text)),
                                )
                            }),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .muted(p)
                            .child(trs!(english, "projects.source_folders")),
                    )
                    .child(rows),
            )
            .when_some(d.error.clone(), |col, e| {
                col.child(
                    div()
                        .text_size(px(TEXT_SM))
                        .text_color(p.c(Token::Destructive))
                        .child(SharedString::from(e)),
                )
            })
            // `DialogFooter`: a muted strip across the bottom, 取消 ghost, the action solid.
            .child(
                div()
                    .mx(px(-16.0))
                    .mb(px(-16.0))
                    .p(px(16.0))
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .bg(p.c(Token::Muted).opacity(0.5))
                    .rounded_b(px(16.0))
                    .child(
                        div()
                            .id("project-cancel")
                            .h(px(32.0))
                            .px(px(10.0))
                            .flex()
                            .items_center()
                            .rounded(px(8.0))
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .hover(move |d| d.bg(hover))
                            .child(trs!(english, "projects.cancel"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.project_dialog = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("project-confirm")
                            .h(px(32.0))
                            .px(px(10.0))
                            .flex()
                            .items_center()
                            .rounded(px(8.0))
                            .bg(p.c(Token::Primary))
                            .text_color(p.c(Token::PrimaryForeground))
                            .font_weight(FontWeight::MEDIUM)
                            .when(disabled, |d| d.opacity(0.5))
                            .when(!disabled, |d| d.cursor_pointer())
                            .child(if editing {
                                trs!(english, "projects.confirm")
                            } else {
                                trs!(english, "projects.create_project")
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !disabled {
                                    this.save_project(cx)
                                }
                            })),
                    ),
            );
        Some(modal(body, p, cx, |this| this.project_dialog = None))
    }
}
