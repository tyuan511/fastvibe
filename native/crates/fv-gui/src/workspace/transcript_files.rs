//! File actions shared by tool subjects, folded summaries and turn changes.
use super::Workspace;
use crate::conversation_resources::resolve;
use fv_theme::Token;
use gpui_kit::component::menu::{ContextMenuExt, PopupMenuItem};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::*;

impl Workspace {
    pub(super) fn transcript_path(&self, thread_id: &str, path: &str) -> Option<String> {
        let cwd = self.project_root_for(thread_id);
        resolve(path, cwd.as_deref())
    }

    /// Left click previews (or reviews a turn change); hovering names the path and the
    /// context menu always offers the same three file actions. A child link must not
    /// toggle its fold.
    pub(super) fn file_actions(
        &self,
        thread_id: &str,
        element: Stateful<Div>,
        path: &str,
        review: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(path) = self.transcript_path(thread_id, path) else {
            return element.into_any_element();
        };
        let click_path = path.clone();
        let thread_id = thread_id.to_string();
        let title = path.rsplit('/').next().unwrap_or(&path).to_string();
        let preview_title = title.clone();
        let weak = cx.entity().downgrade();
        let menu_owner = weak.clone();
        let english = self.english();
        let local = self.ssh_host.is_none();
        let tooltip_path = path.clone();
        element
            .cursor_pointer()
            .tooltip(move |window, cx| Tooltip::new(tooltip_path.clone()).build(window, cx))
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                _ = weak.update(cx, |this, cx| {
                    if review {
                        this.review_transcript_file_for(&thread_id, click_path.clone(), window, cx);
                    } else {
                        this.open_in_pane(click_path.clone(), title.clone(), window, cx);
                    }
                });
            })
            .context_menu(move |menu, _, _| {
                let owner = menu_owner.clone();
                let preview_path = path.clone();
                let title = preview_title.clone();
                let reveal_path = path.clone();
                let copy_path = path.clone();
                menu.item(
                    PopupMenuItem::new(super::static_text(english, "transcript.path_preview"))
                        .on_click(move |_, window, cx| {
                            _ = owner.update(cx, |this, cx| {
                                this.open_in_pane(preview_path.clone(), title.clone(), window, cx)
                            });
                        }),
                )
                .item(
                    PopupMenuItem::new(super::static_text(english, "mod.show_in_file_manager"))
                        .on_click(move |_, _, cx| {
                            if local {
                                cx.reveal_path(std::path::Path::new(&reveal_path));
                            }
                        }),
                )
                .item(
                    PopupMenuItem::new(super::static_text(english, "transcript.path_copy"))
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_path.clone()))
                        }),
                )
            })
            .into_any_element()
    }

    pub(super) fn file_link(
        &self,
        thread_id: &str,
        id: String,
        path: &str,
        label: String,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.file_actions(
            thread_id,
            div()
                .id(SharedString::from(id))
                .min_w_0()
                .font_family(crate::assets::MONO_FONT)
                .text_color(self.palette.c(Token::Primary))
                .underline()
                .child(crate::ui::truncate(label)),
            path,
            false,
            cx,
        )
    }
}

#[cfg(test)]
mod owner_tests {
    use super::Workspace;
    use crate::theme::Palette;
    use gpui_kit::gpui;
    use gpui_kit::{AppContext, Context, Render, TestAppContext, Window, div};

    struct Host;
    impl Render for Host {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl gpui_kit::IntoElement {
            div()
        }
    }

    #[gpui::test]
    fn child_paths_and_git_reviews_use_child_worktree_without_navigating_parent(
        cx: &mut TestAppContext,
    ) {
        cx.update(gpui_kit::init);
        let host = cx.add_window(|_, _| Host);
        host.update(cx, |_, window, cx| {
            let workspace = cx.new(|cx| {
                Workspace::fixture(
                    Palette::new(fv_theme::Preferences::default().resolve(false, false)),
                    crate::fixture::theme_conversation(),
                    window,
                    cx,
                )
            });
            workspace.update(cx, |this, cx| {
                let parent = this.selected.clone().unwrap();
                let mut child = this.views[&parent].thread.clone();
                child.id = "child".into();
                child.cwd = Some("/worktrees/child".into());
                let mut parent_thread = child.clone();
                parent_thread.id = parent.clone();
                parent_thread.cwd = Some("/projects/parent".into());
                this.views.get_mut(&parent).unwrap().thread = parent_thread;
                this.threads.push(child);
                assert_eq!(
                    this.transcript_path("child", "src/main.rs").as_deref(),
                    Some("/worktrees/child/src/main.rs")
                );
                assert_eq!(
                    this.transcript_path(&parent, "src/main.rs").as_deref(),
                    Some("/projects/parent/src/main.rs")
                );
                assert_eq!(
                    this.transcript_path("child", "/other/file.rs").as_deref(),
                    Some("/other/file.rs")
                );
                let attached = "Inspect this\n\n<fastvibe-attachments>\n- images/chart.png\n- /shared/data.csv\n</fastvibe-attachments>";
                assert_eq!(fv_core::strip_attachment_block(attached), "Inspect this");
                let files: Vec<_> = fv_core::attachment_paths(attached).into_iter()
                    .filter_map(|path| this.transcript_path("child", &path)).collect();
                assert_eq!(files, ["/worktrees/child/images/chart.png", "/shared/data.csv"]);
                assert!(this.attachment_row(&files, "child-message", cx).is_some());
                this.review_transcript_file_for(
                    "child",
                    "/worktrees/child/src/main.rs".into(),
                    window,
                    cx,
                );
                assert_eq!(this.selected.as_deref(), Some(parent.as_str()));
                assert_eq!(this.git_views[&parent].repository(), "/worktrees/child");
                assert_eq!(this.git_cwd().as_deref(), Some("/worktrees/child"));
                this.review_transcript_file("/projects/parent/src/main.rs".into(), window, cx);
                assert_eq!(this.git_cwd().as_deref(), Some("/projects/parent"));
            });
        })
        .unwrap();
    }
}
