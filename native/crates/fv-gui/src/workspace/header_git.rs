//! The conversation header's repository chip: branch, and either the line totals or a tick when
//! the tree is clean. It is the Electron header's `GitStatusPopover` trigger; clicking it opens the
//! Git pane, where staging, committing and review live (pull/push have no server method yet).

use super::Workspace;
use super::gpui::prelude::*;
use super::gpui::{AnyElement, Context, FontWeight, IntoElement, Window, div, px};
use crate::ui::{self, TEXT_XS, icon};
use fv_protocol::methods::WorkspaceGitStatus;
use fv_protocol::types::{CwdParams, GitStatus};
use fv_theme::Token;
use std::time::{Duration, Instant};

/// How often the chip re-reads the repository while its conversation is on screen. The agent
/// changes files outside any request the window makes, so there is nothing to subscribe to.
const REFRESH: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(super) struct HeaderGit {
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
            chip.on_click(cx.listener(|this, _, window, cx| this.open_git_tab(window, cx)))
                .into_any_element(),
        )
    }
}
