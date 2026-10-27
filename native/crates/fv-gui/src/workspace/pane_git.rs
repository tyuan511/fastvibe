//! The 变更 tab: git's two layers, one file's patch, and the commit box — the Electron app's
//! `side-pane-git.tsx`, `git-change-list.tsx`, `git-history.tsx` and `git-commit-form.tsx`.
//!
//! The parts that are decisions rather than layout:
//!
//! - **Three groups, and a file can be in two of them.** Conflicts first, then staged, then
//!   unstaged. A file that is staged *and* further edited appears in both, because the two rows
//!   answer different questions — "what will be committed" and "what is not committed yet".
//! - **The patch is read from the group the row is in**, not from the row's name. Clicking a
//!   staged file shows `--cached`; clicking the same path under unstaged shows the worktree diff.
//!   Reading it from the name is how a staged edit's view comes back empty.
//! - **The commit button stages the whole tree first.** A commit action that leaves files out is
//!   the bug this was built to avoid; the call behind it still commits only the index, so a caller
//!   that staged a part on purpose gets what it staged.
//! - **Discarding asks, and says where the file goes.** A tracked file returns to the index (not
//!   to `HEAD` — the user may have staged something on purpose); an untracked file is deleted, and
//!   only the paths the status named are removed, never a directory recursively.
//! - **History's refs are drawn from git's own topology.** A merge has two parent lines; the graph
//!   does not invent a straight line through it.

use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::pane::{PaneTab, PaneTabKind, new_tab_id};
use super::{Workspace, text};
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon, icon_button_xs};

#[path = "git_state.rs"]
mod state;
pub use state::GitView;

#[derive(Clone, Debug, PartialEq, Eq)]
struct GitTarget {
    conversation: String,
    cwd: String,
}

/// Reading git for the capture fixture, which runs without a server.
///
/// The same commands the server's `git` module runs, so the screenshot shows a real change list
/// and a real patch rather than a shape somebody invented.
fn git_out(cwd: &str, args: &[&str]) -> String {
    std::process::Command::new("git")
        .args(["--no-optional-locks", "--literal-pathspecs", "-C", cwd])
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success() || o.status.code() == Some(1))
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

fn fixture_status(cwd: &str) -> Option<GitStatus> {
    let porcelain = git_out(
        cwd,
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    );
    let (header, rest) = porcelain.split_once('\0')?;
    if !header.starts_with("## ") {
        return None;
    }
    let branch = header[3..]
        .split("...")
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let mut files = Vec::new();
    let mut items = rest.split('\0');
    while let Some(record) = items.next() {
        if record.len() < 4 {
            continue;
        }
        let (index, worktree) = (record[0..1].to_string(), record[1..2].to_string());
        files.push(GitFileChange {
            path: record[3..].to_string(),
            index: index.clone(),
            worktree: worktree.clone(),
        });
        if matches!(index.as_str(), "R" | "C") || matches!(worktree.as_str(), "R" | "C") {
            let _ = items.next();
        }
    }
    let staged = files
        .iter()
        .filter(|f| f.index != " " && f.index != "?")
        .count() as u32;
    let (additions, deletions) = git_out(cwd, &["diff", "--numstat", "HEAD", "--"])
        .lines()
        .fold((0u32, 0u32), |(a, d), line| {
            let mut fields = line.split('\t');
            (
                a + fields.next().and_then(|n| n.parse().ok()).unwrap_or(0),
                d + fields.next().and_then(|n| n.parse().ok()).unwrap_or(0),
            )
        });
    Some(GitStatus {
        cwd: cwd.into(),
        is_repository: true,
        branch: (!branch.is_empty()).then_some(branch),
        ahead: 0,
        behind: 0,
        changed: files.len() as u32,
        staged,
        additions,
        deletions,
        files,
    })
}

fn fixture_patch(
    cwd: &str,
    path: &str,
    source: DiffSource,
) -> Option<(String, DiffSource, String)> {
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--unified=5"];
    if source == DiffSource::Staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    let text = git_out(cwd, &args);
    if text.trim().is_empty() {
        return None;
    }
    // The capture shows the first hunk that actually has added or removed lines: a file that grew
    // by 650 lines opens on a screen of context, which says nothing about how a change is drawn.
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|l| {
            (l.starts_with('+') && !l.starts_with("+++"))
                || (l.starts_with('-') && !l.starts_with("---"))
        })
        .unwrap_or(0)
        .saturating_sub(6);
    let shown = lines[start..lines.len().min(start + 60)].join("\n");
    Some((path.to_string(), source, shown))
}

fn fixture_history(cwd: &str) -> Option<GitHistory> {
    let out = git_out(
        cwd,
        &[
            "log",
            "--topo-order",
            "--max-count=8",
            "--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%B",
            "-z",
            "--",
        ],
    );
    let fields: Vec<&str> = out.split('\0').collect();
    let mut commits = Vec::new();
    for chunk in fields.chunks(6) {
        let [hash, parents, subject, author, date, body] = chunk else {
            continue;
        };
        if hash.is_empty() {
            continue;
        }
        commits.push(GitCommit {
            hash: hash.to_string(),
            parents: parents.split_whitespace().map(str::to_string).collect(),
            subject: subject.to_string(),
            author: author.to_string(),
            date: date.to_string(),
            body: body.trim_end().to_string(),
            refs: Vec::new(),
            is_head: commits.is_empty(),
        });
    }
    (!commits.is_empty()).then(|| GitHistory {
        commits,
        has_more: false,
        tips: Vec::new(),
        head: None,
        branch: None,
    })
}

/// The three writes that change the workspace, each with its own consequence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitAction {
    Discard,
    DeleteUntracked,
}

/// One row of the list, after grouping.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Row {
    path: String,
    /// `conflicted` / `staged` / `unstaged`, in that order.
    group: Group,
    /// git's letter for the row, which is what the badge shows.
    letter: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Group {
    Conflicted,
    Staged,
    Unstaged,
}

impl Group {
    fn label(self) -> &'static str {
        match self {
            Group::Conflicted => "冲突",
            Group::Staged => "已暂存",
            Group::Unstaged => "未暂存",
        }
    }

    fn label_for(self, english: bool) -> &'static str {
        if !english {
            return self.label();
        }
        match self {
            Group::Conflicted => "Conflicted",
            Group::Staged => "Staged",
            Group::Unstaged => "Unstaged",
        }
    }

    /// Which layer the patch for a row in this group is read from.
    fn source(self) -> DiffSource {
        match self {
            Group::Staged => DiffSource::Staged,
            // A conflict has both sides in the worktree; the worktree view is what the reader
            // needs to resolve it.
            Group::Conflicted | Group::Unstaged => DiffSource::Unstaged,
        }
    }
}

/// One node of the change list's tree: a directory whose single-child chains are folded into one
/// name, or a file.
///
/// **Compacting only uninterrupted chains** is the whole point: `native/crates/fv-gui/src` is one
/// row, while a directory that branches keeps its children as their own rows. A tree that compacted
/// past a branch would hide a row the reader needs.
#[derive(Clone, Debug, PartialEq)]
enum TreeNode {
    Directory {
        /// The compacted name: `native/crates/fv-gui/src`.
        name: String,
        path: String,
        children: Vec<TreeNode>,
    },
    File(Row),
}

/// Build the tree from the rows, so a deleted file still shows its directories (they exist only in
/// the diff).
fn build_tree(rows: &[Row]) -> Vec<TreeNode> {
    // The same path can be in two groups (staged and unstaged). The tree shows the file once, at
    // the first group it appears in, because a tree is about *where* things are.
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut roots: Vec<TreeNode> = Vec::new();
    for row in rows {
        if !seen.insert(row.path.as_str()) {
            continue;
        }
        let parts: Vec<&str> = row.path.split('/').collect();
        insert(&mut roots, &parts, row);
    }
    roots
}

fn insert(nodes: &mut Vec<TreeNode>, parts: &[&str], row: &Row) {
    if parts.len() <= 1 {
        nodes.push(TreeNode::File(row.clone()));
        return;
    }
    let name = parts[0].to_string();
    let path = name.clone();
    let slot = nodes.iter_mut().find_map(|node| match node {
        TreeNode::Directory { name: known, .. } if *known == name => Some(node),
        _ => None,
    });
    match slot {
        Some(TreeNode::Directory { children, .. }) => insert(children, &parts[1..], row),
        _ => {
            let mut children = Vec::new();
            insert(&mut children, &parts[1..], row);
            nodes.push(TreeNode::Directory {
                name,
                path,
                children,
            });
        }
    }
}

/// Fold a directory's single-child chains into one name.
fn compact(node: TreeNode) -> TreeNode {
    match node {
        TreeNode::File(row) => TreeNode::File(row),
        TreeNode::Directory {
            mut name,
            mut path,
            mut children,
        } => {
            children = children.into_iter().map(compact).collect();
            // Peel while the chain is unbroken. `std::mem::replace` so the loop can take the only
            // child without moving the vector it is inspecting.
            loop {
                if children.len() != 1 {
                    break;
                }
                let only = children.remove(0);
                match only {
                    TreeNode::Directory {
                        name: child_name,
                        path: child_path,
                        children: grand_children,
                    } => {
                        name = format!("{name}/{child_name}");
                        path = child_path;
                        children = grand_children;
                    }
                    other => {
                        children.push(other);
                        break;
                    }
                }
            }
            TreeNode::Directory {
                name,
                path,
                children,
            }
        }
    }
}

fn rows_of(status: &GitStatus) -> Vec<Row> {
    let mut rows = Vec::new();
    for file in &status.files {
        // A conflict is git's `U` on either side, or `AA`/`DD`.
        let conflicted = matches!(file.index.as_str(), "U")
            || matches!(file.worktree.as_str(), "U")
            || (file.index == "A" && file.worktree == "A")
            || (file.index == "D" && file.worktree == "D");
        if conflicted {
            rows.push(Row {
                path: file.path.clone(),
                group: Group::Conflicted,
                letter: "U".into(),
            });
            continue;
        }
        // A file can be in both layers: staged as it is now, and edited again since.
        if file.index != " " && file.index != "?" {
            rows.push(Row {
                path: file.path.clone(),
                group: Group::Staged,
                letter: file.index.clone(),
            });
        }
        if file.worktree != " " || file.index == "?" {
            rows.push(Row {
                path: file.path.clone(),
                group: Group::Unstaged,
                letter: if file.index == "?" {
                    "?".into()
                } else {
                    file.worktree.clone()
                },
            });
        }
    }
    // Conflicts first, then staged, then unstaged; alphabetical inside a group, as the Electron
    // list is.
    rows.sort_by(|a, b| {
        let order = |g: Group| match g {
            Group::Conflicted => 0,
            Group::Staged => 1,
            Group::Unstaged => 2,
        };
        order(a.group)
            .cmp(&order(b.group))
            .then_with(|| a.path.cmp(&b.path))
    });
    rows
}

impl Workspace {
    /// Dev only: open the 变更 tab on the conversation's directory and read git in-process.
    ///
    /// The fixture has no server, so the status and the patch come from the same code the
    /// server's handler runs — a fixture that stubbed its own git output would be drawing a
    /// change list nobody can have.
    pub fn open_git_for_fixture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        let Some(cwd) = self.project_root_for(&conversation) else {
            return;
        };
        self.side_pane_collapsed = false;
        let state = self.panes.entry(conversation.clone()).or_default();
        let id = super::pane::new_tab_id();
        state.tabs.push(PaneTab {
            id: id.clone(),
            kind: PaneTabKind::Git,
            title: text::pane_git(self.app_settings.language).to_string(),
        });
        state.activate(id);
        let editor = cx.new(|cx| {
            TextareaState::new(window, cx).auto_grow(1, 8).placeholder(
                if self.app_settings.language == UiLanguage::English {
                    "Commit message"
                } else {
                    "提交信息"
                },
            )
        });
        let container = self.git_views.entry(conversation).or_default();
        container.select(&cwd);
        let view: &mut state::GitRepoView = container;
        view.editor = Some(editor.clone());
        editor.update(cx, |state, cx| {
            state.set_value("feat(native): read git in the side pane", window, cx)
        });
        view.status = fixture_status(&cwd);
        view.message = "feat(native): read git in the side pane".into();
        view.show_history = false;
        // The fixture opens the pane wide enough for side-by-side, so that mode is what the capture
        // shows. At the default width the pane refuses it (two 150px columns are not readable), and
        // a fixture that forced it would be photographing a layout the app will not draw.
        self.side_pane_width = super::pane::DEFAULT_WIDTH;
        self.side_pane_maximized = true;
        view.split = true;
        if let Some(status) = &view.status
            && let Some(first) = status
                .files
                .iter()
                .find(|f| f.path.ends_with("types.rs"))
                .or_else(|| status.files.first())
        {
            let group = if first.index != " " && first.index != "?" {
                DiffSource::Staged
            } else {
                DiffSource::Unstaged
            };
            view.patch = fixture_patch(&cwd, &first.path, group);
            view.selected = Some(first.path.clone());
        }
        view.history = fixture_history(&cwd);
        let _ = cx;
    }

    /// Open the Git tab, retaining each repository's own editor and read state.
    pub(super) fn open_git_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(conversation), Some(cwd)) = (self.selected.clone(), self.git_cwd()) else {
            return;
        };
        self.git_views
            .entry(conversation.clone())
            .or_default()
            .select(&cwd);
        self.side_pane_collapsed = false;
        let pane = self.panes.entry(conversation.clone()).or_default();
        if let Some(tab) = pane.tabs.iter().find(|tab| tab.kind == PaneTabKind::Git) {
            pane.activate(tab.id.clone());
        } else {
            let id = new_tab_id();
            pane.tabs.push(PaneTab {
                id: id.clone(),
                kind: PaneTabKind::Git,
                title: text::pane_git(self.app_settings.language).to_string(),
            });
            pane.activate(id);
        }
        self.ensure_git_editor(window, cx);
        self.load_git_status(cx);
        cx.notify();
    }

    fn git_cwd(&self) -> Option<String> {
        let id = self.selected.as_ref()?;
        let roots = self.project_roots_for(id);
        self.git_views
            .get(id)
            .map(|view| view.repository())
            .filter(|root| roots.iter().any(|known| known == root))
            .map(str::to_string)
            .or_else(|| roots.first().cloned())
    }

    fn git_target(&self) -> Option<GitTarget> {
        let conversation = self.selected.clone()?;
        let cwd = self.git_cwd()?;
        (self.git_views.get(&conversation)?.repository() == cwd)
            .then_some(GitTarget { conversation, cwd })
    }
    fn git_target_is_current(&self, target: &GitTarget) -> bool {
        self.selected.as_deref() == Some(&target.conversation)
            && self.git_cwd().as_deref() == Some(&target.cwd)
            && self
                .git_views
                .get(&target.conversation)
                .is_some_and(|view| view.repository() == target.cwd)
    }
    fn git_repo_mut(&mut self, target: &GitTarget) -> Option<&mut state::GitRepoView> {
        self.git_views
            .get_mut(&target.conversation)?
            .for_repository(&target.cwd)
    }

    fn ensure_git_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.git_target() else {
            return;
        };
        let missing = self
            .git_repo_mut(&target)
            .is_some_and(|view| view.editor.is_none());
        if missing {
            let text = self.git_repo_mut(&target).unwrap().message.clone();
            let editor = cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(1, 8)
                    .placeholder("提交信息 / Commit message")
            });
            editor.update(cx, |state, cx| state.set_value(text, window, cx));
            let owner = target.clone();
            cx.subscribe_in(
                &editor,
                window,
                move |this, source, event: &InputEvent, _, cx| {
                    if !matches!(event, InputEvent::Change) {
                        return;
                    }
                    let value = source.read(cx).value().to_string();
                    if let Some(view) = this.git_repo_mut(&owner)
                        && view
                            .editor
                            .as_ref()
                            .is_some_and(|editor| editor.entity_id() == source.entity_id())
                    {
                        view.message = value;
                        cx.notify();
                    }
                },
            )
            .detach();
            self.git_repo_mut(&target).unwrap().editor = Some(editor);
        }
        let editor = self
            .git_repo_mut(&target)
            .and_then(|view| view.clear_editor.as_ref().and(view.editor.clone()));
        if let Some(editor) = editor {
            let current = editor.read(cx).value().to_string();
            if self
                .git_repo_mut(&target)
                .is_some_and(|view| view.take_editor_clear(&current))
            {
                editor.update(cx, |state, cx| state.set_value("", window, cx));
            }
        }
    }

    pub(super) fn load_git_status(&mut self, cx: &mut Context<Self>) {
        let (Some(target), Some(backend)) = (self.git_target(), self.backend.clone()) else {
            return;
        };
        let epoch = self.git_repo_mut(&target).unwrap().begin_status();
        let patch = self.git_repo_mut(&target).and_then(|view| {
            let (path, source, _) = view.patch.as_ref()?;
            (!view.write_busy).then(|| (path.clone(), *source, view.selected_revision.clone()))
        });
        if let Some((path, source, revision)) = patch {
            self.load_git_diff(path, source, revision, cx);
        }
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<WorkspaceGitStatus>(CwdParams {
                    cwd: target.cwd.clone(),
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(view) = this.git_repo_mut(&target)
                    && view.accepts_status(epoch)
                {
                    match result {
                        Ok(status) => {
                            view.status = Some(status);
                            view.notice = None;
                        }
                        Err(error) => view.notice = Some(format!("无法读取 Git 状态：{error}")),
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn load_git_diff(
        &mut self,
        path: String,
        source: DiffSource,
        revision: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let (Some(target), Some(backend)) = (self.git_target(), self.backend.clone()) else {
            return;
        };
        let epoch =
            self.git_repo_mut(&target)
                .unwrap()
                .begin_patch(&path, source, revision.clone());
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<WorkspaceGitDiff>(GitDiffParams {
                    cwd: target.cwd.clone(),
                    path: Some(path.clone()),
                    source,
                    revision,
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(view) = this.git_repo_mut(&target) {
                    view.finish_patch(
                        epoch,
                        result
                            .map(|patch| (path, source, patch.text))
                            .map_err(|error| format!("无法读取这个改动：{error}")),
                    );
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn load_git_history(
        &mut self,
        skip: u32,
        tips: Option<Vec<String>>,
        cx: &mut Context<Self>,
    ) {
        let (Some(target), Some(backend)) = (self.git_target(), self.backend.clone()) else {
            return;
        };
        let Some(epoch) = self
            .git_repo_mut(&target)
            .unwrap()
            .begin_history(skip, tips.as_deref())
        else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<WorkspaceGitHistory>(GitHistoryParams {
                    cwd: target.cwd.clone(),
                    skip: Some(skip),
                    scope: HistoryScope::All,
                    tips,
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(view) = this.git_repo_mut(&target) {
                    view.finish_history(
                        epoch,
                        skip,
                        result.map_err(|error| format!("无法读取提交历史：{error}")),
                    );
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn git_paths_call(
        &mut self,
        target: &GitTarget,
        stage: Option<bool>,
        paths: Vec<String>,
        all: bool,
        cx: &mut Context<Self>,
    ) {
        if !self.git_target_is_current(target) {
            return;
        }
        let (Some(stage), Some(backend)) = (stage, self.backend.clone()) else {
            return;
        };
        if !self.git_repo_mut(target).unwrap().begin_write() {
            cx.notify();
            return;
        }
        let target = target.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let params = GitPathsParams {
                cwd: target.cwd.clone(),
                paths,
                all,
            };
            let result = if stage {
                backend.call::<WorkspaceGitStage>(params).await
            } else {
                backend.call::<WorkspaceGitUnstage>(params).await
            };
            this.update(cx, |this, cx| {
                if let Some(view) = this.git_repo_mut(&target) {
                    view.end_write();
                    match result {
                        Ok(status) => {
                            view.status = Some(status);
                            view.notice = None;
                        }
                        Err(error) => view.notice = Some(error.to_string()),
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn git_commit(&mut self, target: &GitTarget, cx: &mut Context<Self>) {
        if !self.git_target_is_current(target) {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let view = self.git_repo_mut(target).unwrap();
        let draft = view
            .editor
            .as_ref()
            .map(|editor| editor.read(cx).value().to_string())
            .unwrap_or_else(|| view.message.clone());
        view.message = draft.clone();
        let message = draft.trim().to_string();
        if message.is_empty() {
            view.notice = Some("先写一句提交信息".into());
            cx.notify();
            return;
        }
        if !view.begin_write() {
            cx.notify();
            return;
        }
        let target = target.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = match backend
                .call::<WorkspaceGitStage>(GitPathsParams {
                    cwd: target.cwd.clone(),
                    paths: Vec::new(),
                    all: true,
                })
                .await
            {
                Ok(_) => {
                    backend
                        .call::<WorkspaceGitCommit>(GitCommitParams {
                            cwd: target.cwd.clone(),
                            message,
                            amend: false,
                        })
                        .await
                }
                Err(error) => Err(error),
            };
            this.update(cx, |this, cx| {
                let current = this.git_target_is_current(&target);
                let mut refresh_history = false;
                if let Some(view) = this.git_repo_mut(&target) {
                    view.end_write();
                    match result {
                        Ok(status) => {
                            view.status = Some(status);
                            view.notice = None;
                            // Keep anything typed while the commit was running.
                            let editor_text = view
                                .editor
                                .as_ref()
                                .map(|editor| editor.read(cx).value().to_string());
                            view.committed_message(&draft, editor_text.as_deref());
                            view.invalidate_history();
                            refresh_history = current && view.show_history;
                        }
                        Err(error) => view.notice = Some(format!("提交失败：{error}")),
                    }
                }
                if refresh_history {
                    this.load_git_history(0, None, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn run_git_action(&mut self, target: &GitTarget, cx: &mut Context<Self>) {
        if !self.git_target_is_current(target) {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let view = self.git_repo_mut(target).unwrap();
        let Some((action, paths)) = view.pending.clone() else {
            return;
        };
        if !view.begin_write() {
            cx.notify();
            return;
        }
        view.pending = None;
        let target = target.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let params = GitPathsParams {
                cwd: target.cwd.clone(),
                paths,
                all: false,
            };
            let result = match action {
                GitAction::Discard => backend.call::<WorkspaceGitDiscard>(params).await,
                GitAction::DeleteUntracked => {
                    backend.call::<WorkspaceGitDeleteUntracked>(params).await
                }
            };
            this.update(cx, |this, cx| {
                if let Some(view) = this.git_repo_mut(&target) {
                    view.end_write();
                    match result {
                        Ok(status) => {
                            view.status = Some(status);
                            view.notice = None;
                        }
                        Err(error) => view.notice = Some(error.to_string()),
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn git_body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let english = self.app_settings.language == UiLanguage::English;
        let Some(conversation) = self.selected.clone() else {
            return div().into_any_element();
        };
        let roots = self.project_roots_for(&conversation);
        let Some(root) = self.git_cwd() else {
            return div()
                .child(if english {
                    "This chat has no working directory"
                } else {
                    "这个对话没有工作目录"
                })
                .into_any_element();
        };
        let changed = self
            .git_views
            .entry(conversation)
            .or_default()
            .select(&root);
        self.ensure_git_editor(window, cx);
        if changed {
            self.load_git_status(cx);
        }
        if let Some(target) = self.git_target()
            && let Some(view) = self.git_repo_mut(&target)
            && view.navigation.pending
            && view.patch.is_some()
        {
            view.navigation.pending = false;
            view.navigation.anchor.scroll_to(window, cx);
        }
        let p = self.palette.clone();
        let mut selector = div()
            .id("git-repositories")
            .h(px(32.0))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(4.0))
            .px(px(6.0))
            .overflow_x_scroll()
            .border_b_1()
            .border_color(p.c(Token::Border));
        for (index, folder) in roots.into_iter().enumerate() {
            let selected = folder == root;
            let title = std::path::Path::new(&folder)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let tooltip = folder.clone();
            selector = selector.child(
                div()
                    .id(SharedString::from(format!("git-repo-{index}")))
                    .h(px(24.0))
                    .px(px(6.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .rounded(px(5.0))
                    .text_size(px(TEXT_XS))
                    .cursor_pointer()
                    .when(selected, |d| d.bg(p.c(Token::Accent)))
                    .hover(|d| d.bg(p.c(Token::Muted)))
                    .aria_label(if english {
                        format!("Git repository: {folder}")
                    } else {
                        format!("Git 仓库：{folder}")
                    })
                    .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
                    .child(icon("folder01", 12.0, p.c(Token::MutedForeground)))
                    .child(SharedString::from(title))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let Some(id) = this.selected.clone() else {
                            return;
                        };
                        this.git_views.entry(id).or_default().select(&folder);
                        this.open_git_tab(window, cx);
                        let history = this
                            .git_target()
                            .and_then(|target| this.git_repo_mut(&target))
                            .is_some_and(|view| view.show_history);
                        if history {
                            this.load_git_history(0, None, cx);
                        }
                    })),
            );
        }
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(selector)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .child(self.git_repository_body(cx)),
            )
            .into_any_element()
    }

    /// The 变更 tab's body.
    fn git_repository_body(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let p = self.palette.clone();
        let english = self.app_settings.language == UiLanguage::English;
        let Some(conversation) = self.selected.clone() else {
            return div().into_any_element();
        };
        if !self.git_views.contains_key(&conversation) {
            self.git_views
                .insert(conversation.clone(), GitView::default());
            self.load_git_status(cx);
            self.load_git_history(0, None, cx);
        }
        let Some(target) = self.git_target() else {
            return div().into_any_element();
        };
        let view = &self.git_views[&conversation];
        let Some(status) = view.status.clone() else {
            let error = view.notice.clone();
            return div()
                .flex_1()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(8.0))
                .child(SharedString::from(error.unwrap_or_else(|| {
                    if english {
                        "Reading Git status…".into()
                    } else {
                        "正在读取 Git 状态…".into()
                    }
                })))
                .child(
                    icon_button_xs("git-status-retry", "refresh", &p)
                        .aria_label(if english {
                            "Reload Git status"
                        } else {
                            "重新读取 Git 状态"
                        })
                        .on_click(cx.listener(|this, _, _, cx| this.load_git_status(cx))),
                )
                .into_any_element();
        };
        if !status.is_repository {
            return div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(8.0))
                .p(px(24.0))
                .child(icon("git-compare", 24.0, p.c(Token::MutedForeground)))
                .child(div().text_size(px(TEXT_SM)).child(if english {
                    "This directory is not a Git repository"
                } else {
                    "这个目录不在 Git 仓库里"
                }))
                .into_any_element();
        }
        let patch = view.patch.clone();
        let selected = view.selected.clone();
        let notice = view.notice.clone();
        let message = view.message.clone();
        let history = view.history.clone();
        let pending = view.pending.clone();
        let tree = !view.flat;
        let tree_hidden = view.tree_hidden;
        let history_open = view.show_history;
        let collapsed = view.collapsed.clone();
        let selected_source = view
            .selected_source
            .or_else(|| view.patch.as_ref().map(|(_, source, _)| *source));
        let diff_scroll = view.navigation.scroll.clone();
        let tree_scroll = view.tree_scroll.clone();
        let hunk = view.navigation.current;
        let patch_loading = view.patch_loading;
        let write_busy = view.write_busy;
        let list_width = if view.tree_width > 0.0 {
            view.tree_width
        } else {
            224.0
        }
        .clamp(120.0, (self.pane_content_width - 192.0).max(120.0));
        // Side by side needs two columns that can each hold a line of code; a narrow pane wraps
        // every line into a stack of words instead, so it keeps the unified view.
        let wide_enough = self.pane_content_width >= super::pane::SPLIT_MIN_WIDTH;
        let split = wide_enough && view.split;
        let rows = rows_of(&status);
        let mut list = div().flex().flex_col().pb(px(8.0));
        for group in [Group::Conflicted, Group::Staged, Group::Unstaged] {
            let grouped: Vec<Row> = rows.iter().filter(|r| r.group == group).cloned().collect();
            if grouped.is_empty() {
                continue;
            }
            let group_key = format!("group-{group:?}");
            let open = !collapsed.contains(&group_key);
            let group_paths: Vec<String> = grouped.iter().map(|r| r.path.clone()).collect();
            let key = group_key.clone();
            let group_target = target.clone();
            list = list.child(
                div()
                    .id(SharedString::from(group_key))
                    .h(px(28.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(px(TEXT_XS))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .child(ui::chevron(open, 12.0, p.c(Token::MutedForeground)))
                    .child(group.label_for(english))
                    .child(
                        div()
                            .text_color(p.c(Token::MutedForeground))
                            .child(grouped.len().to_string()),
                    )
                    .child(div().flex_1())
                    .when(group != Group::Conflicted, |d| {
                        d.child(
                            icon_button_xs(
                                SharedString::from(format!("git-all-{group:?}")),
                                if group == Group::Staged {
                                    "minus-sign"
                                } else {
                                    "add01"
                                },
                                &p,
                            )
                            .aria_label(if group == Group::Staged {
                                if english {
                                    "Unstage all"
                                } else {
                                    "取消暂存全部"
                                }
                            } else {
                                if english { "Stage all" } else { "暂存全部" }
                            })
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.git_paths_call(
                                        &group_target,
                                        Some(group != Group::Staged),
                                        group_paths.clone(),
                                        false,
                                        cx,
                                    );
                                },
                            )),
                        )
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(view) = this
                            .selected
                            .as_ref()
                            .and_then(|id| this.git_views.get_mut(id))
                            && !view.collapsed.remove(&key)
                        {
                            view.collapsed.insert(key.clone());
                        }
                        cx.notify();
                    })),
            );
            if open {
                let selected = if selected_source == Some(group.source()) {
                    selected.as_deref()
                } else {
                    None
                };
                if tree {
                    for node in build_tree(&grouped).into_iter().map(compact) {
                        list =
                            list.children(self.git_tree_rows(&node, 0, selected, &collapsed, cx));
                    }
                } else {
                    for row in &grouped {
                        list =
                            list.child(self.git_row(row, selected == Some(row.path.as_str()), cx));
                    }
                }
            }
        }
        if rows.is_empty() {
            list = list.child(
                div()
                    .px(px(12.0))
                    .py(px(32.0))
                    .text_size(px(TEXT_XS))
                    .muted(&p)
                    .child(if english {
                        "No uncommitted changes"
                    } else {
                        "没有未提交的改动"
                    }),
            );
        }
        let commit = self.git_commit_box(
            &conversation,
            &message,
            status.changed > 0 && !write_busy,
            cx,
        );
        let mut history_column = div()
            .flex_none()
            .border_t_1()
            .border_color(p.c(Token::Border))
            .flex()
            .flex_col()
            .child(
                div()
                    .id("git-history-toggle")
                    .h(px(32.0))
                    .flex_none()
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(px(TEXT_XS))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .child(ui::chevron(history_open, 12.0, p.c(Token::MutedForeground)))
                    .child(if english {
                        "Commit history"
                    } else {
                        "提交历史"
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(view) = this
                            .selected
                            .as_ref()
                            .and_then(|id| this.git_views.get_mut(id))
                        {
                            view.show_history = !view.show_history;
                        }
                        this.load_git_history(0, None, cx);
                        cx.notify();
                    })),
            );
        if history_open {
            history_column = history_column
                .h(relative(0.36))
                .child(self.git_history_panel(history, cx));
        }
        let sidebar = div()
            .w(px(list_width))
            .h_full()
            .flex_none()
            .relative()
            .flex()
            .flex_col()
            .child(commit)
            .child(
                div()
                    .id("git-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&tree_scroll)
                    .child(list),
            )
            .child(history_column)
            .child(
                div()
                    .id("git-tree-splitter")
                    .absolute()
                    .right_0()
                    .top_0()
                    .bottom_0()
                    .w(px(8.0))
                    .cursor_col_resize()
                    .role(Role::Splitter)
                    .aria_label("调整变更列表宽度")
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                            this.pane_tree_resize = Some(f32::from(e.position.x) - list_width);
                            window.prevent_default();
                            cx.stop_propagation();
                            cx.notify();
                        }),
                    ),
            );
        let mut detail = div().flex_1().min_w_0().h_full().flex().flex_col();
        if let Some((path, source, patch_text)) = patch {
            let patch_target = target.clone();
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let doc = super::diff::parse(&patch_text);
            let hunk_count = doc.hunks;
            let previous_target = target.clone();
            let next_target = target.clone();
            let split_target = target.clone();
            let additions = doc
                .rows
                .iter()
                .filter(|r| matches!(r.kind, super::diff::RowKind::Added))
                .count();
            let removals = doc
                .rows
                .iter()
                .filter(|r| matches!(r.kind, super::diff::RowKind::Removed))
                .count();
            detail = detail.child(
                div()
                    .h(px(36.0))
                    .flex_none()
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .child(
                        img(crate::file_icons::path(&name, !p.is_dark()))
                            .size(px(16.0))
                            .flex_none(),
                    )
                    .child(
                        ui::truncate(path.clone())
                            .flex_1()
                            .text_size(px(TEXT_XS))
                            .font_weight(FontWeight::MEDIUM),
                    )
                    .children((additions > 0).then(|| {
                        div()
                            .text_size(px(TEXT_XS))
                            .text_color(p.c(Token::Success))
                            .child(format!("+{additions}"))
                    }))
                    .children((removals > 0).then(|| {
                        div()
                            .text_size(px(TEXT_XS))
                            .text_color(p.c(Token::Destructive))
                            .child(format!("−{removals}"))
                    })),
            );
            detail = detail.child(
                div()
                    .h(px(32.0))
                    .flex_none()
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .child(
                        div()
                            .id("git-split-toggle")
                            .when(!wide_enough, |button| button.opacity(0.4))
                            .h(px(24.0))
                            .px(px(6.0))
                            .flex()
                            .items_center()
                            .rounded(px(6.0))
                            .text_size(px(11.0))
                            .cursor_pointer()
                            .hover(|d| d.bg(p.c(Token::Accent)))
                            .child(if split {
                                "并排差异"
                            } else {
                                "统一差异"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !wide_enough {
                                    return;
                                }
                                if this.git_target_is_current(&split_target)
                                    && let Some(view) = this.git_repo_mut(&split_target)
                                {
                                    view.split = !view.split;
                                    view.navigation.pending = view.navigation.current > 0;
                                }
                                cx.notify();
                            })),
                    )
                    .children((hunk_count > 0).then(|| {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .child(
                                icon_button_xs("git-previous-hunk", "arrow-up01", &p)
                                    .aria_label("上一个改动块")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if this.git_target_is_current(&previous_target)
                                            && let Some(view) = this.git_repo_mut(&previous_target)
                                            && view.navigation.step(hunk_count, false)
                                        {
                                            cx.notify();
                                        }
                                    })),
                            )
                            .child(
                                div()
                                    .text_size(px(TEXT_XS))
                                    .child(format!("{} / {hunk_count}", hunk)),
                            )
                            .child(
                                icon_button_xs("git-next-hunk", "arrow-down01", &p)
                                    .aria_label("下一个改动块")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if this.git_target_is_current(&next_target)
                                            && let Some(view) = this.git_repo_mut(&next_target)
                                            && view.navigation.step(hunk_count, true)
                                        {
                                            cx.notify();
                                        }
                                    })),
                            )
                    }))
                    .child(div().flex_1())
                    .when(
                        source == DiffSource::Staged || source == DiffSource::Unstaged,
                        |d| {
                            d.child(
                                icon_button_xs(
                                    "git-diff-stage",
                                    if source == DiffSource::Staged {
                                        "minus-sign"
                                    } else {
                                        "add01"
                                    },
                                    &p,
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.git_paths_call(
                                            &patch_target,
                                            Some(source != DiffSource::Staged),
                                            vec![path.clone()],
                                            false,
                                            cx,
                                        )
                                    },
                                )),
                            )
                        },
                    ),
            );
            detail = detail.child(
                div()
                    .id("git-diff")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .overflow_x_scroll()
                    .track_scroll(&diff_scroll)
                    .child(self.git_patch_view(&patch_text)),
            );
        } else {
            detail = detail.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .p(px(32.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(TEXT_XS))
                    .muted(&p)
                    .child(if patch_loading {
                        if english {
                            "Reading diff…"
                        } else {
                            "正在读取差异…"
                        }
                    } else if rows.is_empty() {
                        if english {
                            "No uncommitted changes"
                        } else {
                            "没有未提交的改动"
                        }
                    } else {
                        if english {
                            "Select a file to view its diff"
                        } else {
                            "选择一个文件查看差异"
                        }
                    }),
            );
        }
        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(36.0))
                    .flex_none()
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .border_b_1()
                    .border_color(p.c(Token::Border))
                    .child(
                        icon_button_xs(
                            "git-sidebar-toggle",
                            if tree_hidden {
                                "panel-left-close"
                            } else {
                                "panel-left-open"
                            },
                            &p,
                        )
                        .aria_label(if tree_hidden {
                            if english {
                                "Expand file tree"
                            } else {
                                "展开文件树"
                            }
                        } else {
                            if english {
                                "Collapse file tree"
                            } else {
                                "收起文件树"
                            }
                        })
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(view) = this
                                .selected
                                .as_ref()
                                .and_then(|id| this.git_views.get_mut(id))
                            {
                                view.tree_hidden = !view.tree_hidden;
                            }
                            cx.notify();
                        })),
                    )
                    .children(
                        write_busy
                            .then(|| ui::spinner("git-writing", 12.0, p.c(Token::MutedForeground))),
                    )
                    .child(icon("git-branch", 14.0, p.c(Token::MutedForeground)))
                    .child(
                        ui::truncate(status.branch.clone().unwrap_or_else(|| "HEAD".into()))
                            .flex_1()
                            .text_size(px(TEXT_XS))
                            .font_weight(FontWeight::MEDIUM),
                    )
                    .children((status.behind > 0).then(|| {
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(&p)
                            .child(format!("↓{}", status.behind))
                    }))
                    .children((status.ahead > 0).then(|| {
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(&p)
                            .child(format!("↑{}", status.ahead))
                    }))
                    .child(
                        icon_button_xs(
                            "git-tree-toggle",
                            if tree { "list" } else { "folder-tree" },
                            &p,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(view) = this
                                .selected
                                .as_ref()
                                .and_then(|id| this.git_views.get_mut(id))
                            {
                                view.flat = !view.flat;
                            }
                            cx.notify();
                        })),
                    )
                    .child(
                        icon_button_xs("git-refresh", "refresh", &p)
                            .aria_label(if english { "Refresh" } else { "刷新" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.load_git_status(cx);
                                this.load_git_history(0, None, cx);
                            })),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .children((!tree_hidden).then_some(sidebar))
                    .child(detail),
            )
            .children(notice.map(|notice| {
                div()
                    .px(px(10.0))
                    .py(px(6.0))
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Warning))
                    .child(SharedString::from(notice))
            }))
            .children(pending.map(|(action, paths)| self.git_confirm(action, &paths, cx)))
            .into_any_element()
    }

    /// A tree node and, when it is an open directory, everything under it.
    fn git_tree_rows(
        &self,
        node: &TreeNode,
        depth: usize,
        selected: Option<&str>,
        collapsed: &std::collections::HashSet<String>,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        match node {
            TreeNode::Directory {
                name,
                path,
                children,
            } => {
                let open = !collapsed.contains(path);
                let key = path.clone();
                let mut rows = vec![
                    div()
                        .id(SharedString::from(format!("git-dir-{path}")))
                        .h(px(24.0))
                        .px(px(8.0))
                        .pl(px(6.0 + depth as f32 * 14.0))
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .rounded(px(6.0))
                        .text_size(px(TEXT_XS))
                        .muted(p)
                        .cursor_pointer()
                        .hover(move |d| d.bg(hover))
                        .child(ui::chevron(open, 12.0, p.c(Token::MutedForeground)))
                        .child(
                            img(crate::file_icons::folder_path(
                                name.rsplit('/').next().unwrap_or(name),
                                open,
                                !p.is_dark(),
                            ))
                            .size(px(16.0))
                            .flex_none(),
                        )
                        .child(ui::truncate(name.clone()))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(conversation) = this.selected.clone()
                                && let Some(view) = this.git_views.get_mut(&conversation)
                            {
                                if !view.collapsed.remove(&key) {
                                    view.collapsed.insert(key.clone());
                                }
                                cx.notify();
                            }
                        }))
                        .into_any_element(),
                ];
                if open {
                    for child in children {
                        rows.extend(self.git_tree_rows(child, depth + 1, selected, collapsed, cx));
                    }
                }
                rows
            }
            TreeNode::File(row) => {
                // The row keeps its group letter: in the tree, `M` and `?` sit beside the same
                // directories, and which layer a change is in is not visible from the path.
                let _ = depth;
                vec![self.git_row(row, selected == Some(row.path.as_str()), cx)]
            }
        }
    }

    /// One row: its letter, its name, and the two writes it offers on hover.
    fn git_row(&self, row: &Row, selected: bool, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        let (path, group, letter) = (row.path.clone(), row.group, row.letter.clone());
        let (stage_path, stage_group) = (path.clone(), group);
        let (discard_path, discard_group) = (path.clone(), group);
        let Some(target) = self.git_target() else {
            return div().into_any_element();
        };
        let stage_target = target.clone();
        let discard_target = target.clone();
        let letter_color = match letter.as_str() {
            "?" | "A" => p.c(Token::Success),
            "D" => p.c(Token::Destructive),
            "U" => p.c(Token::Destructive),
            "M" | "T" => p.c(Token::Warning),
            _ => p.c(Token::MutedForeground),
        };
        div()
            .group(SharedString::from(format!("git-row-{group:?}-{path}")))
            .id(SharedString::from(format!("git-{group:?}-{path}")))
            .h(px(28.0))
            .flex_none()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(px(TEXT_XS))
            .cursor_pointer()
            .border_l_2()
            .border_color(if selected {
                p.c(Token::Primary)
            } else {
                p.c(Token::Primary).opacity(0.0)
            })
            .when(selected, |d| d.bg(p.c(Token::Primary).opacity(0.1)))
            .hover(move |d| d.bg(hover))
            .child(
                img(crate::file_icons::path(
                    path.rsplit('/').next().unwrap_or(&path),
                    !p.is_dark(),
                ))
                .size(px(16.0))
                .flex_none(),
            )
            .child(div().flex_1().min_w_0().child(ui::truncate(
                path.rsplit('/').next().unwrap_or(&path).to_string(),
            )))
            .child(
                div()
                    .w(px(16.0))
                    .flex_none()
                    .text_size(px(TEXT_XS))
                    .text_color(letter_color)
                    .child(SharedString::from(letter)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(2.0))
                    .invisible()
                    .group_hover(
                        SharedString::from(format!("git-row-{group:?}-{path}")),
                        |d| d.visible(),
                    )
                    .child(
                        icon_button_xs(
                            "git-stage",
                            if group == Group::Staged {
                                "minus-sign"
                            } else {
                                "add01"
                            },
                            p,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            // A staged row goes back to the worktree; an unstaged one goes
                            // into the index.
                            let staging = stage_group != Group::Staged;
                            cx.stop_propagation();
                            this.git_paths_call(
                                &stage_target,
                                Some(staging),
                                vec![stage_path.clone()],
                                false,
                                cx,
                            );
                        })),
                    )
                    .child(
                        icon_button_xs("git-discard", "delete02", p).on_click(cx.listener(
                            move |this, _, _, cx| {
                                // What discarding means depends on where the change lives, and
                                // the dialog says which: a tracked file returns to the index, an
                                // untracked one is deleted.
                                cx.stop_propagation();
                                if !this.git_target_is_current(&discard_target) {
                                    return;
                                }
                                let action = if discard_group == Group::Unstaged
                                    && this
                                        .git_views
                                        .get(&this.selected.clone().unwrap_or_default())
                                        .and_then(|v| v.status.as_ref())
                                        .and_then(|s| {
                                            s.files.iter().find(|f| f.path == discard_path).cloned()
                                        })
                                        .is_some_and(|f| f.index == "?")
                                {
                                    GitAction::DeleteUntracked
                                } else {
                                    GitAction::Discard
                                };
                                if let Some(conversation) = this.selected.clone()
                                    && let Some(view) = this.git_views.get_mut(&conversation)
                                {
                                    view.pending = Some((action, vec![discard_path.clone()]));
                                    cx.notify();
                                }
                            },
                        )),
                    ),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.git_target_is_current(&target) {
                    return;
                }
                if let Some(conversation) = this.selected.clone()
                    && let Some(view) = this.git_views.get_mut(&conversation)
                {
                    view.selected = Some(path.clone());
                }
                this.load_git_diff(path.clone(), group.source(), None, cx);
            }))
            .into_any_element()
    }

    /// A patch, drawn by the one diff renderer: real line numbers from the diff itself, wrapped
    /// lines, and the side-by-side mode the reader can switch to.
    fn git_patch_view(&self, text: &str) -> AnyElement {
        let p = &self.palette;
        let doc = super::diff::parse(text);
        let view = self.selected.as_ref().and_then(|id| self.git_views.get(id));
        let split = self.pane_content_width >= super::pane::SPLIT_MIN_WIDTH
            && view.is_some_and(|view| view.split);
        let hunk = view.map(|view| view.navigation.current).unwrap_or(0);
        let anchor = view.map(|view| view.navigation.anchor.clone());
        // Hunks are numbered from 1, the same way the 跳转 control counts them.
        let chunk: AnyElement = if split {
            let rows = super::diff::split(&doc.rows);
            let mut table = div().flex().flex_col().py(px(4.0)).min_w(px(720.0));
            for row in rows {
                let selected = row.header.as_ref().is_some_and(|header| {
                    header.kind == super::diff::RowKind::Hunk && header.hunk == hunk
                });
                let row = self.diff_split_row(&row, doc.number_width, p);
                table = if selected {
                    table.child(
                        div()
                            .id("git-target-hunk-split")
                            .w_full()
                            .anchor_scroll(anchor.clone())
                            .child(row),
                    )
                } else {
                    table.child(row)
                };
            }
            div()
                .id("git-diff-split")
                .w_full()
                .whitespace_nowrap()
                .text_size(px(TEXT_XS))
                .line_height(px(18.0))
                .font_family(crate::assets::MONO_FONT)
                .child(table)
                .into_any_element()
        } else {
            let mut lines = div().flex().flex_col().py(px(4.0)).min_w(px(480.0));
            for row in &doc.rows {
                let selected = row.kind == super::diff::RowKind::Hunk && row.hunk == hunk;
                let row = self.diff_row(row, doc.number_width, p);
                lines = if selected {
                    lines.child(
                        div()
                            .id("git-target-hunk-unified")
                            .w_full()
                            .anchor_scroll(anchor.clone())
                            .child(row),
                    )
                } else {
                    lines.child(row)
                };
            }
            div()
                .id("git-diff-unified")
                .w_full()
                .whitespace_nowrap()
                .text_size(px(TEXT_XS))
                .line_height(px(18.0))
                .font_family(crate::assets::MONO_FONT)
                .child(lines)
                .into_any_element()
        };
        chunk
    }

    /// The gutter's two number cells. Blank where the side has no line, exactly as a unified diff
    /// reads — a row whose number is invented is worse than no gutter.
    fn diff_gutter(
        &self,
        old: Option<u64>,
        new: Option<u64>,
        width: usize,
        p: &crate::theme::Palette,
    ) -> Div {
        if width == 0 {
            return div();
        }
        let cell = |value: Option<u64>| -> Div {
            let text = value.map(|n| n.to_string()).unwrap_or_default();
            div()
                .w(px(9.0 + width as f32 * 7.0))
                .flex_none()
                .pr(px(6.0))
                .text_color(p.c(Token::MutedForeground).opacity(0.45))
                .child(SharedString::from(text))
        };
        div().flex().flex_none().child(cell(old)).child(cell(new))
    }

    fn diff_row(
        &self,
        row: &super::diff::DiffRow,
        width: usize,
        p: &crate::theme::Palette,
    ) -> AnyElement {
        use super::diff::RowKind;
        let (bg, fg) = match row.kind {
            RowKind::Added => (
                Some(p.c(Token::Success).opacity(0.18)),
                Some(p.c(Token::Success)),
            ),
            RowKind::Removed => (
                Some(p.c(Token::Destructive).opacity(0.16)),
                Some(p.c(Token::Destructive)),
            ),
            RowKind::Hunk => (
                Some(p.c(Token::Muted).opacity(0.6)),
                Some(p.c(Token::MutedForeground)),
            ),
            RowKind::Meta | RowKind::Skip => (None, Some(p.c(Token::MutedForeground).opacity(0.7))),
            RowKind::Context => (None, None),
        };
        div()
            .w_full()
            .whitespace_nowrap()
            .flex()
            .when_some(bg, |d, bg| d.bg(bg))
            .child(self.diff_gutter(row.old_number, row.new_number, width, p))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .when_some(fg, |d, fg| d.text_color(fg))
                    .child(SharedString::from(format!("{}{}", row.marker, row.text))),
            )
            .into_any_element()
    }

    /// One row of the side-by-side view: a header spans both columns, everything else is a pair.
    fn diff_split_row(
        &self,
        row: &super::diff::SplitRow,
        width: usize,
        p: &crate::theme::Palette,
    ) -> AnyElement {
        if let Some(header) = &row.header {
            return self.diff_row(header, width, p);
        }
        let half = |row: Option<&super::diff::DiffRow>, right: bool| -> Div {
            let mut cell = div()
                .flex_1()
                .min_w_0()
                .px(px(4.0))
                .border_r_1()
                .border_color(p.c(Token::Border));
            // An empty half stays empty rather than being filled with a neighbour: the alignment
            // is the information.
            if let Some(row) = row {
                let bg = match row.kind {
                    super::diff::RowKind::Added => Some(p.c(Token::Success).opacity(0.18)),
                    super::diff::RowKind::Removed => Some(p.c(Token::Destructive).opacity(0.16)),
                    _ => None,
                };
                cell = cell.when_some(bg, |d, bg| d.bg(bg)).child(
                    div()
                        .flex()
                        .child(
                            div()
                                .w(px(9.0 + width as f32 * 7.0))
                                .flex_none()
                                .pr(px(6.0))
                                .text_color(p.c(Token::MutedForeground).opacity(0.45))
                                .child(SharedString::from(
                                    if right {
                                        row.new_number
                                    } else {
                                        row.old_number
                                    }
                                    .map(|n| n.to_string())
                                    .unwrap_or_default(),
                                )),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(SharedString::from(row.text.clone())),
                        ),
                );
            }
            cell
        };
        div()
            .w_full()
            .whitespace_nowrap()
            .flex()
            .child(half(row.left.as_ref(), false))
            .child(half(row.right.as_ref(), true))
            .into_any_element()
    }

    /// The commit box: the message, and the button that stages everything and commits.
    fn git_commit_box(
        &mut self,
        conversation: &str,
        message: &str,
        has_changes: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.palette.clone();
        let target = self.git_target();
        let text_state = self
            .git_views
            .get(conversation)
            .and_then(|v| v.editor.clone());
        let box_ = div()
            .flex_none()
            .border_b_1()
            .border_color(p.c(Token::Border))
            .p(px(8.0))
            .flex()
            .flex_col()
            .gap(px(8.0));
        let editor = text_state.map(|editor| {
            div()
                .min_h(px(32.0))
                .px(px(8.0))
                .py(px(6.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .text_size(px(TEXT_XS))
                .child(Textarea::new(&editor).appearance(false).bordered(false))
        });
        let can_commit = !message.trim().is_empty() && has_changes;
        let button = div()
            .id("git-commit")
            .h(px(32.0))
            .px(px(12.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.0))
            .bg(p.c(Token::Primary))
            .text_color(p.c(Token::PrimaryForeground))
            .text_size(px(TEXT_XS))
            .cursor_pointer()
            .when(!can_commit, |d| d.opacity(0.5))
            .gap(px(6.0))
            .child(icon("tick02", 14.0, p.c(Token::PrimaryForeground)))
            .child(text::git_commit(self.app_settings.language))
            .on_click(cx.listener(move |this, _, _, cx| {
                if can_commit && let Some(target) = &target {
                    this.git_commit(target, cx);
                }
            }));
        box_.children(editor).child(button).into_any_element()
    }

    /// The graph, one commit per row, with its parents' lines kept.
    fn git_history_panel(&self, history: Option<GitHistory>, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let scroll = self
            .selected
            .as_ref()
            .and_then(|id| self.git_views.get(id))
            .map(|view| view.history_scroll.clone())
            .unwrap_or_default();
        let Some(target) = self.git_target() else {
            return div().into_any_element();
        };
        let Some(history) = history else {
            return div().into_any_element();
        };
        // Each row owns its commit: a click handler outlives this call, and a borrow of the page
        // cannot travel with it. What the "more" row needs is taken first.
        let count = history.commits.len() as u32;
        let has_more = history.has_more;
        let tips = history.tips.clone();
        let mut rows = div().flex().flex_col();
        for commit in history.commits.into_iter() {
            let target = target.clone();
            let short: String = commit.hash.chars().take(7).collect();
            let mut refs = div().flex().items_center().gap(px(3.0));
            for reference in &commit.refs {
                refs = refs.child(
                    div()
                        .px(px(4.0))
                        .rounded(px(3.0))
                        .bg(if reference.current {
                            p.c(Token::Primary).opacity(0.15)
                        } else {
                            p.c(Token::Muted)
                        })
                        .text_size(px(10.0))
                        .child(SharedString::from(reference.name.clone())),
                );
            }
            rows = rows.child(
                div()
                    .id(SharedString::from(format!("commit-{}", commit.hash)))
                    .px(px(10.0))
                    .py(px(4.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(px(TEXT_XS))
                    .cursor_pointer()
                    .hover(move |d| d.bg(p.c(Token::Accent)))
                    .child(
                        div()
                            .w(px(52.0))
                            .flex_none()
                            .font_family(crate::assets::MONO_FONT)
                            .text_color(p.c(Token::MutedForeground))
                            .child(SharedString::from(short.clone())),
                    )
                    // A merge is drawn with both of its lines: the count is the graph's own
                    // statement about topology, not a decoration.
                    .when(commit.parents.len() > 1, |d| {
                        d.child(
                            div()
                                .flex_none()
                                .text_color(p.c(Token::Warning))
                                .child(SharedString::from(format!("⑂{}", commit.parents.len()))),
                        )
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(ui::truncate(commit.subject.clone())),
                    )
                    .child(refs)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.git_target_is_current(&target) {
                            return;
                        }
                        // Opening a commit shows what it changed, against its first parent.
                        let revision = commit.hash.clone();
                        this.load_git_diff(String::new(), DiffSource::Branch, Some(revision), cx);
                    })),
            );
        }
        let more = has_more.then(|| {
            let skip = count;
            let tips = tips.clone();
            div()
                .id("git-more")
                .px(px(10.0))
                .py(px(6.0))
                .text_size(px(TEXT_XS))
                .muted(p)
                .cursor_pointer()
                .child(if english { "Load more" } else { "加载更多" })
                .on_click(cx.listener(move |this, _, _, cx| {
                    if this.git_target_is_current(&target) {
                        this.load_git_history(skip, Some(tips.clone()), cx);
                    }
                }))
        });
        div()
            .id("git-history")
            .track_scroll(&scroll)
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .border_t_1()
            .border_color(p.c(Token::Border))
            .child(rows)
            .children(more)
            .into_any_element()
    }

    /// The confirm dialog for a write that cannot be undone.
    fn git_confirm(
        &self,
        action: GitAction,
        paths: &[String],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let target = self.git_target();
        let (title, body, confirm) = match action {
            GitAction::Discard => (
                if english {
                    "Discard these changes?"
                } else {
                    "丢弃这些改动？"
                },
                if english {
                    "Files will return to their staged contents; staged data is not affected."
                } else {
                    "文件会回到已暂存的内容；暂存区里的东西不受影响。"
                },
                if english { "Discard" } else { "丢弃" },
            ),
            GitAction::DeleteUntracked => (
                if english {
                    "Delete these untracked files?"
                } else {
                    "删除这些未跟踪的文件？"
                },
                if english {
                    "They are not in Git and cannot be recovered after deletion."
                } else {
                    "它们不在 Git 里，删掉之后无法恢复。"
                },
                if english { "Delete" } else { "删除" },
            ),
        };
        let names: Vec<&str> = paths.iter().map(String::as_str).take(5).collect();
        div()
            .absolute()
            .inset_0()
            .bg(p.c(Token::Background).opacity(0.85))
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .w(px(300.0))
                    .p(px(16.0))
                    .rounded(px(14.0))
                    .bg(p.overlay())
                    .border_1()
                    .border_color(p.c(Token::Border))
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .font_weight(FontWeight::MEDIUM)
                            .child(SharedString::from(title)),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(SharedString::from(body)),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .font_family(crate::assets::MONO_FONT)
                            .muted(p)
                            .child(SharedString::from(names.join("\n"))),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .id("git-cancel")
                                    .h(px(26.0))
                                    .px(px(10.0))
                                    .flex()
                                    .items_center()
                                    .rounded(px(6.0))
                                    .text_size(px(TEXT_XS))
                                    .cursor_pointer()
                                    .muted(p)
                                    .hover(move |d| d.bg(p.c(Token::Accent)))
                                    .child(if english { "Cancel" } else { "取消" })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if let Some(conversation) = this.selected.clone()
                                            && let Some(view) =
                                                this.git_views.get_mut(&conversation)
                                        {
                                            view.pending = None;
                                            cx.notify();
                                        }
                                    })),
                            )
                            .child(
                                div()
                                    .id("git-confirm")
                                    .h(px(26.0))
                                    .px(px(10.0))
                                    .flex()
                                    .items_center()
                                    .rounded(px(6.0))
                                    .bg(p.c(Token::Destructive))
                                    .text_color(p.c(Token::DestructiveForeground))
                                    .text_size(px(TEXT_XS))
                                    .cursor_pointer()
                                    .child(confirm)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if let Some(target) = &target {
                                            this.run_git_action(target, cx);
                                        }
                                    })),
                            ),
                    ),
            )
            .into_any_element()
    }
}
