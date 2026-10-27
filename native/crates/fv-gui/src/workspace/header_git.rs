//! The conversation header's repository chip: branch, and either the line totals or a tick when
//! the tree is clean. It is the Electron header's `GitStatusPopover` trigger; clicking it opens the
//! Git pane, where staging, committing and review live (pull/push have no server method yet).

use super::Workspace;
use super::gpui::prelude::*;
use super::gpui::{
    AnyElement, ClickEvent, Context, Entity, FontWeight, IntoElement, Pixels, Point, Window, div,
    point, px,
};
use super::{settings, sidebar_actions};
use crate::ui::{self, TEXT_SM, TEXT_XS, icon, icon_button_xs};
use fv_protocol::methods::{
    WorkspaceGitCommit, WorkspaceGitPull, WorkspaceGitPush, WorkspaceGitStage, WorkspaceGitStatus,
};
use fv_protocol::types::{CwdParams, GitCommitParams, GitPathsParams, GitStatus, UiLanguage};
use fv_theme::Token;
use gpui_kit::component::input::{Textarea, TextareaState};
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
}

#[derive(Default)]
pub(super) struct HeaderGit {
    /// Where the popover is open, if it is.
    pub(super) menu_at: Option<Point<Pixels>>,
    input: Option<Entity<TextareaState>>,
    /// Set once a commit went through; `render` empties the field (it needs the window).
    clear_input: bool,
    busy: Option<Busy>,
    error: Option<String>,
    /// The repository the status below belongs to.
    cwd: Option<String>,
    status: Option<GitStatus>,
    loaded_at: Option<Instant>,
    /// Bumped by every request so an answer for a repository left behind is ignored.
    epoch: u64,
    polling: bool,
}

impl Workspace {
    fn header_git_cwd(&self) -> Option<String> {
        let id = self.selected.as_ref()?;
        self.project_roots_for(id).into_iter().next()
    }

    /// Called from `render`: follow the selected conversation, and start the refresh loop once.
    pub(super) fn sync_header_git(&mut self, cx: &mut Context<Self>) {
        let cwd = self.header_git_cwd();
        if self.header_git.cwd != cwd {
            self.header_git.cwd = cwd.clone();
            self.header_git.status = None;
            self.header_git.loaded_at = None;
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
        if std::mem::take(&mut self.header_git.clear_input)
            && let Some(input) = &self.header_git.input
        {
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
        if self.header_git.input.is_none() {
            let english = self.app_settings.language == UiLanguage::English;
            self.header_git.input = Some(cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(1, 4)
                    .placeholder(trs!(english, "header_git.commit_message"))
            }));
        }
        // The agent may have changed files since the last tick.
        self.load_header_git(cx);
        cx.notify();
    }

    /// Pull, push, or commit (everything, as the Git pane's button does), then optionally push.
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
            .input
            .as_ref()
            .map(|input| input.read(cx).value().trim().to_string())
            .unwrap_or_default();
        let commits = matches!(action, Busy::Commit | Busy::CommitPush);
        if commits && message.is_empty() {
            self.header_git.error = Some(trs!(english, "header_git.write_a_message").to_string());
            cx.notify();
            return;
        }
        self.header_git.busy = Some(action);
        self.header_git.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let call_cwd = || CwdParams { cwd: cwd.clone() };
            // The second half is a push that failed after the commit had already gone in.
            let result: Result<(GitStatus, Option<String>), String> = async {
                match action {
                    Busy::Pull => backend
                        .call::<WorkspaceGitPull>(call_cwd())
                        .await
                        .map(|status| (status, None))
                        .map_err(|e| e.to_string()),
                    Busy::Push => backend
                        .call::<WorkspaceGitPush>(call_cwd())
                        .await
                        .map(|status| (status, None))
                        .map_err(|e| e.to_string()),
                    Busy::Commit | Busy::CommitPush => {
                        backend
                            .call::<WorkspaceGitStage>(GitPathsParams {
                                cwd: cwd.clone(),
                                paths: Vec::new(),
                                all: true,
                            })
                            .await
                            .map_err(|e| e.to_string())?;
                        let committed = backend
                            .call::<WorkspaceGitCommit>(GitCommitParams {
                                cwd: cwd.clone(),
                                message,
                                amend: false,
                            })
                            .await
                            .map_err(|e| e.to_string())?;
                        if action == Busy::Commit {
                            return Ok((committed, None));
                        }
                        match backend.call::<WorkspaceGitPush>(call_cwd()).await {
                            Ok(status) => Ok((status, None)),
                            Err(error) => Ok((committed, Some(error.to_string()))),
                        }
                    }
                }
            }
            .await;
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
                            this.header_git.clear_input = true;
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
        let field = self.header_git.input.as_ref().map(|input| {
            div()
                .min_h(px(32.0))
                .px(px(8.0))
                .py(px(6.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .text_size(px(TEXT_XS))
                .child(Textarea::new(input).appearance(false).bordered(false))
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
        self.toggle_header_git_menu(point(px(430.0), px(36.0)), window, cx);
    }

    /// The capture fixture has no server to ask, so the chip is given a status by hand.
    pub(super) fn fixture_header_git(&mut self, changed: u32) {
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
                this.toggle_header_git_menu(point(at.x - px(12.0), at.y + px(18.0)), window, cx)
            }))
            .into_any_element(),
        )
    }
}
