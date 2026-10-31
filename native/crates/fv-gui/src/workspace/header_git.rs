//! The conversation header's repository chip: branch, and either the line totals or a tick when
//! the tree is clean. It is the Electron header's `GitStatusPopover` trigger; clicking it opens the
//! Git pane, where staging, committing and review live (pull/push have no server method yet).

use super::Workspace;
use super::gpui::prelude::*;
use super::gpui::{
    AnyElement, ClickEvent, Context, Entity, FontWeight, IntoElement, Pixels, Point, Window, div,
    point,
};
use super::{pane_git::run_git_commit, settings, sidebar_actions};
use crate::ui::px;
use crate::ui::{self, TEXT_SM, TEXT_XS, icon, icon_button_xs};
use fv_protocol::methods::{
    WorkspaceGitGenerateCommitMessage, WorkspaceGitPull, WorkspaceGitPush, WorkspaceGitStatus,
};
use fv_protocol::types::{CwdParams, GitGenerateCommitMessageParams, GitStatus, UiLanguage};
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, InputState};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How often the chip re-reads the repository while its conversation is on screen. The agent
/// changes files outside any request the window makes, so there is nothing to subscribe to.
const REFRESH: Duration = Duration::from_secs(5);

/// What the popover is waiting on; one at a time.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Busy {
    Pull,
    Push,
    Commit,
    CommitPush,
    /// Writing a commit subject with the model.
    Generate,
}

#[derive(Default)]
pub(super) struct HeaderGit {
    /// Where the popover is open, if it is.
    pub(super) menu_at: Option<Point<Pixels>>,
    /// One editor per repository. Switching repositories must retain each draft independently.
    inputs: HashMap<String, Entity<InputState>>,
    /// Set once a commit went through; `render` empties the field (it needs the window).
    clear_input: Option<(String, String)>,
    /// A subject the model wrote, waiting for `render` to put it in the matching field.
    pending_message: Option<(String, String, u64)>,
    /// The draft snapshot used by the in-flight generation, keyed by repository and ticket.
    generation: Option<(String, String, u64)>,
    busy: Option<Busy>,
    error: Option<String>,
    /// The repository the status below belongs to.
    pub(super) cwd: Option<String>,
    pub(super) status: Option<GitStatus>,
    loaded_at: Option<Instant>,
    /// Bumped by every request so an answer for a repository left behind is ignored.
    epoch: u64,
    generation_epoch: u64,
    polling: bool,
}

impl Workspace {
    fn header_git_cwd(&self) -> Option<String> {
        // A new conversation has no folder of its own yet: the chosen project is where it will run.
        let Some(id) = self.selected.as_ref() else {
            return self.draft_project.clone();
        };
        self.project_roots_for(id).into_iter().next()
    }

    /// Called from `render`: follow the selected conversation, and start the refresh loop once.
    pub(super) fn sync_header_git(&mut self, cx: &mut Context<Self>) {
        let cwd = self.header_git_cwd();
        if self.header_git.cwd != cwd {
            self.header_git.cwd = cwd.clone();
            self.header_git.status = None;
            self.header_git.loaded_at = None;
            self.header_git.generation_epoch = self.header_git.generation_epoch.wrapping_add(1);
            self.header_git.busy = None;
            self.header_git.pending_message = None;
            if cwd.is_some() {
                self.load_header_git(cx);
            }
        }
        if !self.header_git.polling {
            self.header_git.polling = true;
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(REFRESH).await;
                    let alive = this
                        .update(cx, |this, cx| {
                            let stale = this
                                .header_git
                                .loaded_at
                                .is_none_or(|at| at.elapsed() >= REFRESH);
                            if this.header_git.cwd.is_some() && stale {
                                this.load_header_git(cx);
                            }
                            this.refresh_resource_repositories(cx);
                        })
                        .is_ok();
                    if !alive {
                        break;
                    }
                }
            })
            .detach();
        }
    }

    fn load_header_git(&mut self, cx: &mut Context<Self>) {
        let (Some(cwd), Some(backend)) = (self.header_git.cwd.clone(), self.backend.clone()) else {
            return;
        };
        self.header_git.epoch = self.header_git.epoch.wrapping_add(1);
        self.header_git.loaded_at = Some(Instant::now());
        let epoch = self.header_git.epoch;
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<WorkspaceGitStatus>(CwdParams { cwd: cwd.clone() })
                .await;
            this.update(cx, |this, cx| {
                if this.header_git.epoch != epoch || this.header_git.cwd.as_deref() != Some(&cwd) {
                    return;
                }
                // A failed read keeps the last good status: a chip that blinks away every
                // time git is busy is worse than one a few seconds old.
                if let Ok(status) = result {
                    this.header_git.status = Some(status);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Called from `render`, which has the window the field needs.
    pub(super) fn sync_header_git_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cwd) = self.header_git.cwd.clone() else {
            return;
        };
        let Some(input) = self.header_git.inputs.get(&cwd).cloned() else {
            return;
        };
        if let Some((message_cwd, message, ticket)) = self.header_git.pending_message.take() {
            if message_cwd == cwd
                && self
                    .header_git
                    .generation
                    .as_ref()
                    .is_some_and(|generation| generation.2 == ticket)
                && input.read(cx).value().as_ref()
                    == self
                        .header_git
                        .generation
                        .as_ref()
                        .map(|g| g.1.as_str())
                        .unwrap_or_default()
            {
                self.header_git.clear_input = None;
                input.update(cx, |state, cx| state.set_value(message, window, cx));
            }
        } else if self
            .header_git
            .clear_input
            .as_ref()
            .is_some_and(|(clear_cwd, expected)| {
                clear_cwd == &cwd && input.read(cx).value().as_ref() == expected
            })
        {
            self.header_git.clear_input = None;
            input.update(cx, |state, cx| state.set_value("", window, cx));
        }
    }

    fn toggle_header_git_menu(
        &mut self,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.header_git.menu_at.take().is_some() {
            cx.notify();
            return;
        }
        self.close_menus(cx);
        self.header_git.menu_at = Some(at);
        self.header_git.error = None;
        let Some(cwd) = self.header_git.cwd.clone() else {
            return;
        };
        if !self.header_git.inputs.contains_key(&cwd) {
            let english = self.app_settings.language == UiLanguage::English;
            let input = cx.new(|cx| {
                InputState::new(window, cx).placeholder(trs!(english, "header_git.commit_message"))
            });
            self.header_git.inputs.insert(cwd.clone(), input.clone());
            let owner = cwd.clone();
            cx.subscribe_in(
                &input,
                window,
                move |this, source, event: &InputEvent, _, cx| {
                    let current = this.header_git.cwd.as_deref() == Some(owner.as_str())
                        && this
                            .header_git
                            .inputs
                            .get(&owner)
                            .is_some_and(|editor| editor.entity_id() == source.entity_id());
                    if !current {
                        return;
                    }
                    if matches!(event, InputEvent::PressEnter { .. }) {
                        if this
                            .header_git
                            .status
                            .as_ref()
                            .is_some_and(|s| s.changed > 0)
                        {
                            this.run_header_git(Busy::Commit, cx);
                        }
                        return;
                    }
                    if matches!(event, InputEvent::Change) {
                        this.header_git.pending_message = None;
                        this.header_git.generation_epoch =
                            this.header_git.generation_epoch.wrapping_add(1);
                        cx.notify();
                    }
                },
            )
            .detach();
        }
        // The agent may have changed files since the last tick.
        self.load_header_git(cx);
        cx.notify();
    }

    /// Have the conversation's model write the subject for everything that has changed.
    fn generate_header_git(&mut self, cx: &mut Context<Self>) {
        if self.header_git.busy.is_some() {
            return;
        }
        let (Some(cwd), Some(conversation), Some(backend)) = (
            self.header_git.cwd.clone(),
            self.selected.clone(),
            self.backend.clone(),
        ) else {
            return;
        };
        let input = self.header_git.inputs.get(&cwd).cloned();
        let original = input
            .as_ref()
            .map(|input| input.read(cx).value().to_string())
            .unwrap_or_default();
        self.header_git.generation_epoch = self.header_git.generation_epoch.wrapping_add(1);
        let ticket = self.header_git.generation_epoch;
        self.header_git.generation = Some((cwd.clone(), original.clone(), ticket));
        self.header_git.busy = Some(Busy::Generate);
        self.header_git.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<WorkspaceGitGenerateCommitMessage>(GitGenerateCommitMessageParams {
                    cwd: cwd.clone(),
                    conversation_id: conversation,
                    include_unstaged: true,
                })
                .await;
            this.update(cx, |this, cx| {
                let current = this.header_git.cwd.as_deref() == Some(&cwd)
                    && this
                        .header_git
                        .generation
                        .as_ref()
                        .is_some_and(|generation| {
                            generation.0 == cwd
                                && generation.1 == original
                                && generation.2 == ticket
                        });
                if !current {
                    return;
                }
                this.header_git.busy = None;
                match result {
                    Ok(reply) => {
                        this.header_git.pending_message =
                            Some((cwd.clone(), reply.message, ticket));
                    }
                    Err(error) => this.header_git.error = Some(error.to_string()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Pull, push, or commit (everything, as the Git pane's button does), then optionally push.
    /// An empty message is written by the model once everything is staged.
    fn run_header_git(&mut self, action: Busy, cx: &mut Context<Self>) {
        if self.header_git.busy.is_some() {
            return;
        }
        let (Some(cwd), Some(backend)) = (self.header_git.cwd.clone(), self.backend.clone()) else {
            return;
        };
        let english = self.app_settings.language == UiLanguage::English;
        let message = self
            .header_git
            .inputs
            .get(&cwd)
            .map(|input| input.read(cx).value().to_string())
            .unwrap_or_default();
        let commits = matches!(action, Busy::Commit | Busy::CommitPush);
        let conversation = self.selected.clone();
        self.header_git.busy = Some(action);
        self.header_git.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = match action {
                Busy::Pull => backend
                    .call::<WorkspaceGitPull>(CwdParams { cwd: cwd.clone() })
                    .await
                    .map(|status| (status, None))
                    .map_err(|error| error.to_string()),
                Busy::Push => backend
                    .call::<WorkspaceGitPush>(CwdParams { cwd: cwd.clone() })
                    .await
                    .map(|status| (status, None))
                    .map_err(|error| error.to_string()),
                Busy::Generate => unreachable!("generation has its own path"),
                Busy::Commit | Busy::CommitPush => {
                    run_git_commit(
                        backend,
                        cwd.clone(),
                        conversation,
                        message.clone(),
                        action == Busy::CommitPush,
                    )
                    .await
                }
            };
            this.update(cx, |this, cx| {
                this.header_git.busy = None;
                if this.header_git.cwd.as_deref() != Some(&cwd) {
                    return;
                }
                match result {
                    Ok((status, push_error)) => {
                        this.header_git.status = Some(status);
                        this.header_git.loaded_at = Some(Instant::now());
                        if commits {
                            this.header_git.clear_input = Some((cwd.clone(), message.clone()));
                        }
                        match push_error {
                            Some(error) => {
                                this.header_git.error = Some(tr!(
                                    english,
                                    "header_git.committed_push_failed",
                                    error = error
                                ))
                            }
                            None => {
                                this.header_git.menu_at = None;
                                this.sidebar_notice = Some(
                                    match action {
                                        Busy::Pull => trs!(english, "header_git.pulled"),
                                        Busy::Push => trs!(english, "header_git.pushed"),
                                        Busy::Commit => trs!(english, "header_git.committed"),
                                        Busy::CommitPush => {
                                            trs!(english, "header_git.committed_and_pushed")
                                        }
                                        Busy::Generate => "",
                                    }
                                    .to_string(),
                                );
                            }
                        }
                        // An open Git pane shows the same repository.
                        this.load_git_status(cx);
                    }
                    Err(error) => this.header_git.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn header_git_menu_view(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let at = self.header_git.menu_at?;
        let status = self
            .header_git
            .status
            .as_ref()
            .filter(|s| s.is_repository)?;
        let branch = status.branch.clone()?;
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let at = sidebar_actions::popup_origin(at, 320.0, 280.0, window);
        let busy = self.header_git.busy;
        let hover = p.c(Token::Accent);
        let muted = p.c(Token::MutedForeground);

        let sync_button =
            |id: &'static str, glyph: &'static str, label: &'static str, kind: Busy| {
                let working = busy == Some(kind);
                let button = if working {
                    ui::icon_button_xs(id, "loading03", p)
                } else {
                    icon_button_xs(id, glyph, p)
                };
                button
                    .aria_label(label)
                    .when(busy.is_some() && !working, |d| d.opacity(0.4))
                    .on_click(cx.listener(move |this, _, _, cx| this.run_header_git(kind, cx)))
            };
        let title = div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(icon("git-branch", 14.0, muted))
            .child(
                ui::truncate(branch)
                    .flex_1()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::SEMIBOLD),
            )
            .child(
                div()
                    .flex()
                    .gap(px(2.0))
                    .child(sync_button(
                        "header-git-pull",
                        "arrow-down02",
                        trs!(english, "header_git.pull"),
                        Busy::Pull,
                    ))
                    .child(sync_button(
                        "header-git-push",
                        "arrow-up02",
                        trs!(english, "header_git.push"),
                        Busy::Push,
                    )),
            );
        let summary = div()
            .id("header-git-summary")
            .flex()
            .items_center()
            .gap(px(8.0))
            .py(px(4.0))
            .pl(px(22.0))
            .pr(px(4.0))
            .rounded(px(6.0))
            .text_size(px(TEXT_XS))
            .text_color(muted)
            .cursor_pointer()
            .hover(move |d| d.bg(hover))
            .child(if status.changed > 0 {
                tr!(english, "header_git.changed_count", count = status.changed)
            } else {
                trs!(english, "header_git.clean").to_string()
            })
            .when(status.changed > 0, |d| {
                d.child(
                    div()
                        .text_color(p.c(Token::Success))
                        .child(format!("+{}", status.additions)),
                )
                .child(
                    div()
                        .text_color(p.c(Token::Destructive))
                        .child(format!("-{}", status.deletions)),
                )
            })
            .when(status.staged > 0, |d| {
                d.child(div().ml_auto().child(tr!(
                    english,
                    "header_git.staged_count",
                    count = status.staged
                )))
            })
            .when(status.behind > 0, |d| {
                d.child(format!("↓{}", status.behind))
            })
            .when(status.ahead > 0, |d| d.child(format!("↑{}", status.ahead)))
            .on_click(cx.listener(|this, _, window, cx| {
                this.header_git.menu_at = None;
                this.open_git_tab(window, cx);
            }));
        let can_commit = status.changed > 0 && busy.is_none();
        let commit_button = |id: &'static str, label: &'static str, kind: Busy, primary: bool| {
            let working = busy == Some(kind);
            div()
                .id(id)
                .flex_1()
                .h(px(28.0))
                .flex()
                .items_center()
                .justify_center()
                .gap(px(6.0))
                .rounded(px(8.0))
                .text_size(px(TEXT_XS))
                .cursor_pointer()
                .when(primary, |d| {
                    d.bg(p.c(Token::Primary))
                        .text_color(p.c(Token::PrimaryForeground))
                })
                .when(!primary, |d| {
                    d.border_1()
                        .border_color(p.c(Token::Border))
                        .hover(move |d| d.bg(hover))
                })
                .when(!can_commit, |d| d.opacity(0.5))
                .when(working, |d| {
                    d.child(icon("loading03", 14.0, p.c(Token::PrimaryForeground)))
                })
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if can_commit {
                        this.run_header_git(kind, cx)
                    }
                }))
        };
        let generating = busy == Some(Busy::Generate);
        let field = self
            .header_git
            .inputs
            .get(&self.header_git.cwd.clone()?)
            .map(|input| {
                div()
                    .relative()
                    .min_w_0()
                    .child(
                        ui::input(input)
                            .h_8()
                            .pr(px(32.0))
                            .bg(p.c(Token::Background))
                            .disabled(busy.is_some()),
                    )
                    .child(
                        div().absolute().right(px(4.0)).top(px(4.0)).child(
                            if generating {
                                icon_button_xs("header-git-generate", "loading03", p)
                            } else {
                                icon_button_xs("header-git-generate", "sparkles", p)
                            }
                            .aria_label(trs!(english, "header_git.generate"))
                            .when(busy.is_some() && !generating, |d| d.opacity(0.4))
                            .on_click(cx.listener(|this, _, _, cx| this.generate_header_git(cx))),
                        ),
                    )
            });
        // Electron's popover ends with the isolated checkout the conversation runs in, and a way
        // back to the project folder.
        let worktree_row = self
            .selected
            .as_ref()
            .and_then(|id| self.threads.iter().find(|t| &t.id == id))
            .and_then(|thread| {
                let worktree = thread.worktree.as_ref()?;
                let thread_id = thread.id.clone();
                Some(
                    div()
                        .pl(px(22.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            ui::truncate(tr!(english, "header_git.worktree", path = worktree.path))
                                .flex_1()
                                .text_size(px(TEXT_XS))
                                .text_color(muted),
                        )
                        .child(
                            div()
                                .id("header-git-unbind")
                                .flex_none()
                                .h(px(24.0))
                                .px(px(6.0))
                                .flex()
                                .items_center()
                                .rounded(px(6.0))
                                .text_size(px(TEXT_XS))
                                .cursor_pointer()
                                .hover(move |d| d.bg(hover))
                                .child(trs!(english, "header_git.unbind"))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.header_git.menu_at = None;
                                    this.unbind_worktree(thread_id.clone(), cx);
                                })),
                        ),
                )
            });
        let menu = settings::popover(p)
            .absolute()
            .left(at.x)
            .top(at.y)
            .w(px(320.0))
            .child(
                div()
                    .p(px(6.0))
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(title)
                    .child(summary)
                    .children(field)
                    .child(
                        div()
                            .flex()
                            .gap(px(6.0))
                            .child(commit_button(
                                "header-git-commit",
                                trs!(english, "header_git.commit"),
                                Busy::Commit,
                                true,
                            ))
                            .child(commit_button(
                                "header-git-commit-push",
                                trs!(english, "header_git.commit_and_push"),
                                Busy::CommitPush,
                                false,
                            )),
                    )
                    .children(worktree_row)
                    .children(self.header_git.error.clone().map(|error| {
                        div()
                            .text_size(px(TEXT_XS))
                            .text_color(p.c(Token::Destructive))
                            .child(error)
                    })),
            );
        Some(ui::float(menu).into_any_element())
    }

    /// Dev only: open the popover where the chip sits.
    pub fn show_header_git_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.toggle_header_git_menu(point(gpui_kit::px(430.0), gpui_kit::px(36.0)), window, cx);
    }

    /// The capture fixture has no server to ask, so the chip is given a status by hand.
    pub(super) fn fixture_header_git(&mut self, changed: u32) {
        // The conversation runs in its own checkout, so the popover has that row to show.
        if let Some(id) = self.selected.clone()
            && let Some(thread) = self.threads.iter_mut().find(|t| t.id == id)
        {
            thread.worktree = Some(fv_protocol::types::ThreadWorktree {
                path: "~/.fastvibe/wt/fastvibe-3f9a".into(),
                branch: "feat/native-header".into(),
            });
        }
        self.header_git.cwd = self.header_git_cwd();
        self.header_git.status = Some(GitStatus {
            cwd: self.header_git.cwd.clone().unwrap_or_default(),
            is_repository: true,
            branch: Some("feat/native-header".into()),
            ahead: 0,
            behind: 0,
            changed,
            staged: 0,
            additions: if changed > 0 { 8 } else { 0 },
            deletions: 0,
            files: Vec::new(),
        });
    }

    /// `None` outside a repository (and before the first answer), as in Electron.
    pub(super) fn header_git_chip(
        &self,
        _window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let status = self
            .header_git
            .status
            .as_ref()
            .filter(|s| s.is_repository)?;
        let branch = status.branch.clone()?;
        let p = &self.palette;
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        let label = tr!(
            english,
            "header_git.status",
            branch = branch,
            additions = status.additions,
            deletions = status.deletions
        );
        let hover = p.c(Token::Accent);
        let mut chip = div()
            .id("header-git")
            .flex_none()
            .h(px(28.0))
            .max_w(px(240.0))
            .px(px(6.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(px(TEXT_XS))
            .text_color(p.c(Token::MutedForeground))
            .cursor_pointer()
            .hover(move |d| d.bg(hover))
            .aria_label(label)
            .child(icon("git-branch", 14.0, p.c(Token::MutedForeground)))
            .child(ui::truncate(branch).font_weight(FontWeight::MEDIUM));
        chip = if status.changed > 0 {
            chip.child(
                div()
                    .flex_none()
                    .flex()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_color(p.c(Token::Success))
                            .child(format!("+{}", status.additions)),
                    )
                    .child(
                        div()
                            .text_color(p.c(Token::Destructive))
                            .child(format!("-{}", status.deletions)),
                    ),
            )
        } else {
            chip.child(icon("tick02", 12.0, p.c(Token::Success)))
        };
        Some(
            chip.on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                let at = event.position();
                this.toggle_header_git_menu(
                    point(at.x - gpui_kit::px(12.0), at.y + gpui_kit::px(18.0)),
                    window,
                    cx,
                )
            }))
            .into_any_element(),
        )
    }
}
