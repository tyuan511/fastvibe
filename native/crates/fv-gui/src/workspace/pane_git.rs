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

use crate::ui::px;
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
/// Prefer the worktree, then the index; otherwise show the first current change.
fn transcript_change(status: &GitStatus, absolute: &str) -> Option<(String, DiffSource)> {
    let path = std::path::Path::new(absolute)
        .strip_prefix(&status.cwd)
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let rows = rows_of(status);
    for exact in [true, false] {
        for group in [Group::Conflicted, Group::Unstaged, Group::Staged] {
            if let Some(row) = rows.iter().find(|row| {
                row.group == group && (!exact || path.as_deref() == Some(row.path.as_str()))
            }) {
                return Some((row.path.clone(), group.source()));
            }
        }
    }
    None
}

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
            Group::Conflicted => "合并冲突",
            Group::Staged => "已暂存",
            Group::Unstaged => "变更",
        }
    }

    fn label_for(self, english: bool) -> &'static str {
        if !english {
            return self.label();
        }
        match self {
            Group::Conflicted => "Merge conflicts",
            Group::Staged => "Staged",
            Group::Unstaged => "Changes",
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

/// Same inset as `git-change-list.tsx`: `paddingLeft: 6 + depth * 14`.
const TREE_BASE: f32 = 6.0;
const TREE_STEP: f32 = 14.0;
/// The chevron slot every tree row keeps (`w-3`), and the row's own gap (`gap-1.5`).
const TREE_CHEVRON: f32 = 12.0;
const ROW_GAP: f32 = 6.0;
/// Every row draws a 2px left rule (the selection's), directories as well as files.
#[cfg(test)]
const TREE_FILE_BORDER: f32 = 2.0;

fn tree_pad(depth: usize) -> f32 {
    TREE_BASE + depth as f32 * TREE_STEP
}

/// Where a tree icon starts, measured from the row's left edge. Both kinds of row carry the
/// border, the inset and the chevron slot, so a file's icon lands on its folder's at one depth.
/// Nothing on screen reads it; it is the invariant, stated once, that `git_state`'s test checks.
#[cfg(test)]
fn tree_icon_x(depth: usize, file: bool) -> f32 {
    let _ = file;
    TREE_FILE_BORDER + tree_pad(depth) + TREE_CHEVRON + ROW_GAP
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

/// Every file under a tree node, in order: what staging a folder stages.
fn collect_paths(node: &TreeNode, out: &mut Vec<String>) {
    match node {
        TreeNode::File(row) => out.push(row.path.clone()),
        TreeNode::Directory { children, .. } => {
            for child in children {
                collect_paths(child, out);
            }
        }
    }
}

/// The group a directory's rows belong to; a tree is built per group, so the first file says.
fn first_group(node: &TreeNode) -> Option<Group> {
    match node {
        TreeNode::File(row) => Some(row.group),
        TreeNode::Directory { children, .. } => children.iter().find_map(first_group),
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
        // Empty, as Electron's mock: the capture shows the hint naming the branch.
        let _ = &editor;
        view.status = fixture_status(&cwd);
        view.message = String::new();
        view.show_history = true;
        // The default capture is Electron's `?pane=git`: the pane at its default width, unified.
        // `FV_FIXTURE_GIT=split` maximizes it for side-by-side, which the default width refuses
        // (two 150px columns are not readable).
        self.side_pane_width = Some(super::pane::DEFAULT_WIDTH);
        if std::env::var("FV_FIXTURE_GIT").is_ok_and(|v| v == "split") {
            self.side_pane_maximized = true;
            view.split = true;
        }
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

    /// A later turn may have staged, committed or reverted the transcript's file.
    pub(super) fn review_transcript_file(
        &mut self,
        absolute: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let roots = self.project_roots_for(&id);
        let root = roots
            .iter()
            .filter(|root| std::path::Path::new(&absolute).starts_with(root))
            .max_by_key(|root| root.len())
            .or_else(|| roots.first())
            .cloned();
        let Some(root) = root else { return };
        self.git_views.entry(id).or_default().select(&root);
        self.open_git_tab(window, cx);
        let (Some(target), Some(backend)) = (self.git_target(), self.backend.clone()) else {
            return;
        };
        let epoch = self.git_repo_mut(&target).unwrap().begin_status();
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<WorkspaceGitStatus>(CwdParams {
                    cwd: target.cwd.clone(),
                })
                .await;
            this.update(cx, |this, cx| {
                if this.git_target().as_ref() != Some(&target) {
                    return;
                }
                let english = this.english();
                let Some(view) = this.git_repo_mut(&target) else {
                    return;
                };
                if !view.accepts_status(epoch) {
                    return;
                }
                match result {
                    Ok(status) => {
                        let choice = transcript_change(&status, &absolute);
                        view.status = Some(status);
                        view.notice = None;
                        if choice.is_none() {
                            view.clear_patch();
                        }
                        if let Some((path, source)) = choice {
                            this.load_git_diff(path, source, None, cx);
                        }
                    }
                    Err(error) => {
                        view.notice = Some(tr!(
                            english,
                            "pane_git.could_not_read_the_git",
                            error = error
                        ))
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
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
                    .placeholder(trs!(self.english(), "pane_git.commit_message"))
            });
            editor.update(cx, |state, cx| state.set_value(text, window, cx));
            let owner = target.clone();
            cx.subscribe_in(
                &editor,
                window,
                move |this, source, event: &InputEvent, _, cx| {
                    if matches!(
                        event,
                        InputEvent::PressEnter {
                            secondary: true,
                            ..
                        }
                    ) {
                        // ⌘Enter commits, exactly as the hint says.
                        this.git_commit(&owner, false, cx);
                        return;
                    }
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
        // The hint names the branch a ⌘Enter commits to, and turns into a progress line while a
        // message is being written.
        let english = self.english();
        let hint = self.git_repo_mut(&target).map(|view| {
            let branch = view
                .status
                .as_ref()
                .and_then(|s| s.branch.clone())
                .unwrap_or_else(|| "HEAD".into());
            // `@min-[13rem]/commit-input`: below 208px the hint would wrap, so it is the label.
            let width = if view.tree_width > 0.0 {
                view.tree_width
            } else {
                224.0
            };
            let roomy = width - 16.0 >= 208.0;
            match (view.generating, roomy, english) {
                (true, _, false) => "正在生成提交信息…".to_string(),
                (true, _, true) => "Generating commit message…".to_string(),
                (false, true, false) => format!("提交信息（⌘Enter 提交到 {branch}）"),
                (false, true, true) => format!("Message (⌘Enter to commit on {branch})"),
                (false, false, false) => "提交信息".to_string(),
                (false, false, true) => "Commit message".to_string(),
            }
        });
        if let Some(hint) = hint
            && let Some(view) = self.git_repo_mut(&target)
            && view.hint_shown != hint
            && let Some(editor) = view.editor.clone()
        {
            // The hint is drawn over the field by the commit box, on one truncated line: the
            // editor's own placeholder wraps, and a two-line empty field is twice as tall.
            if view.hint_shown.is_empty() {
                editor.update(cx, |state, cx| state.set_placeholder("", window, cx));
            }
            view.hint_shown = hint;
        }
        let generated = self
            .git_repo_mut(&target)
            .and_then(|view| view.generated.take().zip(view.editor.clone()));
        if let Some(((expected, message), editor)) = generated
            && editor.read(cx).value().as_ref() == expected
        {
            if let Some(view) = self.git_repo_mut(&target) {
                view.message = message.clone();
            }
            editor.update(cx, |state, cx| state.set_value(message, window, cx));
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
                let english = this.english();
                if let Some(view) = this.git_repo_mut(&target)
                    && view.accepts_status(epoch)
                {
                    match result {
                        Ok(status) => {
                            view.status = Some(status);
                            view.notice = None;
                        }
                        Err(error) => {
                            view.notice = Some(tr!(
                                english,
                                "pane_git.could_not_read_the_git",
                                error = error
                            ))
                        }
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
                let english = this.english();
                if let Some(view) = this.git_repo_mut(&target) {
                    view.finish_patch(
                        epoch,
                        result
                            .map(|patch| (path, source, patch.text))
                            .map_err(|error| {
                                tr!(
                                    english,
                                    "pane_git.could_not_read_this_change",
                                    error = error
                                )
                            }),
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
        let view = self.git_repo_mut(&target).unwrap();
        let scope = if view.history_current {
            HistoryScope::Current
        } else {
            HistoryScope::All
        };
        let Some(epoch) = view.begin_history(skip, tips.as_deref()) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<WorkspaceGitHistory>(GitHistoryParams {
                    cwd: target.cwd.clone(),
                    skip: Some(skip),
                    scope,
                    tips,
                })
                .await;
            this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(view) = this.git_repo_mut(&target) {
                    view.finish_history(
                        epoch,
                        skip,
                        result.map_err(|error| {
                            tr!(english, "pane_git.could_not_read_the_commit", error = error)
                        }),
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

    /// Stage everything, write a message if there is none, commit, and push when asked — the
    /// one path Electron's `performGitCommit` takes for 提交 and 提交并推送 alike.
    fn git_commit(&mut self, target: &GitTarget, push: bool, cx: &mut Context<Self>) {
        if !self.git_target_is_current(target) {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let conversation = target.conversation.clone();
        let view = self.git_repo_mut(target).unwrap();
        view.commit_menu = false;
        let draft = view
            .editor
            .as_ref()
            .map(|editor| editor.read(cx).value().to_string())
            .unwrap_or_else(|| view.message.clone());
        view.message = draft.clone();
        let message = draft.trim().to_string();
        if !view.begin_write() {
            cx.notify();
            return;
        }
        view.generating = message.is_empty();
        let target = target.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result: Result<(GitStatus, Option<String>), String> = async {
                backend
                    .call::<WorkspaceGitStage>(GitPathsParams {
                        cwd: target.cwd.clone(),
                        paths: Vec::new(),
                        all: true,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                let message = if message.is_empty() {
                    backend
                        .call::<WorkspaceGitGenerateCommitMessage>(GitGenerateCommitMessageParams {
                            cwd: target.cwd.clone(),
                            conversation_id: conversation,
                            include_unstaged: false,
                        })
                        .await
                        .map_err(|e| e.to_string())?
                        .message
                } else {
                    message
                };
                let committed = backend
                    .call::<WorkspaceGitCommit>(GitCommitParams {
                        cwd: target.cwd.clone(),
                        message,
                        amend: false,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                if !push {
                    return Ok((committed, None));
                }
                match backend
                    .call::<WorkspaceGitPush>(CwdParams {
                        cwd: target.cwd.clone(),
                    })
                    .await
                {
                    Ok(status) => Ok((status, None)),
                    Err(error) => Ok((committed, Some(error.to_string()))),
                }
            }
            .await;
            this.update(cx, |this, cx| {
                let english = this.english();
                let current = this.git_target_is_current(&target);
                let mut refresh_history = false;
                if let Some(view) = this.git_repo_mut(&target) {
                    view.end_write();
                    view.generating = false;
                    match result {
                        Ok((status, push_error)) => {
                            view.status = Some(status);
                            view.notice = push_error.map(|error| {
                                if english {
                                    format!("Commit succeeded, but push failed: {error}")
                                } else {
                                    format!("提交已完成，但推送失败：{error}")
                                }
                            });
                            // Keep anything typed while the commit was running.
                            let editor_text = view
                                .editor
                                .as_ref()
                                .map(|editor| editor.read(cx).value().to_string());
                            view.committed_message(&draft, editor_text.as_deref());
                            view.invalidate_history();
                            refresh_history = current && view.show_history;
                        }
                        Err(error) => {
                            view.notice =
                                Some(tr!(english, "pane_git.commit_failed_error", error = error))
                        }
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

    /// AI 生成提交信息: describe the whole tree into the editor, unless the draft changed meanwhile.
    fn git_generate(&mut self, target: &GitTarget, cx: &mut Context<Self>) {
        if !self.git_target_is_current(target) {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let view = self.git_repo_mut(target).unwrap();
        if view.generating || view.write_busy {
            return;
        }
        let original = view
            .editor
            .as_ref()
            .map(|editor| editor.read(cx).value().to_string())
            .unwrap_or_else(|| view.message.clone());
        view.generating = true;
        let target = target.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<WorkspaceGitGenerateCommitMessage>(GitGenerateCommitMessageParams {
                    cwd: target.cwd.clone(),
                    conversation_id: target.conversation.clone(),
                    include_unstaged: true,
                })
                .await;
            this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(view) = this.git_repo_mut(&target) {
                    view.generating = false;
                    match result {
                        Ok(generated) => view.generated = Some((original, generated.message)),
                        Err(error) => {
                            view.notice = Some(if english {
                                format!("Could not generate a commit message: {error}")
                            } else {
                                format!("生成提交信息失败：{error}")
                            })
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 拉取 / 推送 from the pane's header: the status that comes back replaces the one drawn, and a
    /// failure is the pane's notice, as every other write here.
    fn git_sync(&mut self, target: &GitTarget, push: bool, cx: &mut Context<Self>) {
        if !self.git_target_is_current(target) {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let view = self.git_repo_mut(target).unwrap();
        if !view.begin_write() {
            cx.notify();
            return;
        }
        let target = target.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let params = CwdParams {
                cwd: target.cwd.clone(),
            };
            let result = if push {
                backend.call::<WorkspaceGitPush>(params).await
            } else {
                backend.call::<WorkspaceGitPull>(params).await
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
                this.load_git_history(0, None, cx);
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
                .child(trs!(english, "pane_git.this_chat_has_no_working"))
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
        let selector_count = roots.len();
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
                    .aria_label(tr!(
                        english,
                        "pane_git.git_repository_folder",
                        folder = folder
                    ))
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
        // The switcher exists only when there is something to switch between.
        let several = selector_count >= 2;
        div()
            .size_full()
            .flex()
            .flex_col()
            .when(several, |d| d.child(selector))
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
                    trs!(english, "pane_git.reading_git_status").into()
                })))
                .child(
                    icon_button_xs("git-status-retry", "refresh", &p)
                        .aria_label(trs!(english, "pane_git.reload_git_status"))
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
                .child(
                    div()
                        .text_size(px(TEXT_SM))
                        .child(trs!(english, "pane_git.this_directory_is_not_a")),
                )
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
        let view_history_current = view.history_current;
        let selected_revision = view.selected_revision.clone();
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
        // `min-w-[120px] max-w-[75%]`, as Electron's list column.
        .clamp(120.0, (self.pane_content_width * 0.75).max(120.0));
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
            // `GitChangeGroup`: a muted band, the title, a count pill, and the group's one write.
            list = list.child(
                div()
                    .id(SharedString::from(group_key))
                    .h(px(32.0))
                    .flex_none()
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .bg(p.c(Token::Muted))
                    .border_b_1()
                    .border_color(p.c(Token::Border).opacity(0.4))
                    .text_size(px(TEXT_XS))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(ui::chevron(open, 12.0, p.c(Token::Foreground)))
                            .child(ui::truncate(group.label_for(english)))
                            .child(div().flex_1())
                            .child(
                                div()
                                    .min_w(px(20.0))
                                    .px(px(6.0))
                                    .py(px(2.0))
                                    .rounded_full()
                                    .bg(p.c(Token::Foreground).opacity(0.07))
                                    .flex()
                                    .justify_center()
                                    .text_size(px(10.0))
                                    .line_height(px(10.0))
                                    .font_weight(FontWeight::NORMAL)
                                    .text_color(p.c(Token::MutedForeground))
                                    .child(grouped.len().to_string()),
                            ),
                    )
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
                                trs!(english, "pane_git.unstage_all")
                            } else {
                                trs!(english, "pane_git.stage_all")
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
                        list = list.child(self.git_row(
                            row,
                            selected == Some(row.path.as_str()),
                            None,
                            cx,
                        ));
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
                    .child(trs!(english, "pane_git.no_uncommitted_changes")),
            );
        }
        let commit = self.git_commit_box(
            &conversation,
            &message,
            status.changed > 0 && !write_busy,
            cx,
        );
        let history_current = view_history_current;
        let history_branch = history.as_ref().and_then(|h| h.branch.clone());
        let history_button = |id: &'static str, glyph: &'static str, label: &'static str| {
            icon_button_xs(id, glyph, &p)
                .aria_label(label)
                .tooltip(move |window, cx| Tooltip::new(label).build(window, cx))
        };
        // `GitHistoryPanel`'s header: the fold, the branch scope, 定位 HEAD and its own refresh.
        let set_scope = |current: bool| {
            move |this: &mut Self, _: &ClickEvent, _: &mut Window, cx: &mut Context<Self>| {
                if let Some(view) = this
                    .selected
                    .as_ref()
                    .and_then(|id| this.git_views.get_mut(id))
                {
                    view.history_current = current;
                    view.show_history = true;
                }
                this.load_git_history(0, None, cx);
                cx.notify();
            }
        };
        let mut history_column = div()
            .flex_none()
            .border_t_1()
            .border_color(p.c(Token::Border))
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(32.0))
                    .flex_none()
                    .px(px(6.0))
                    .flex()
                    .items_center()
                    .gap(px(2.0))
                    .bg(p.c(Token::Muted))
                    .border_b_1()
                    .border_color(p.c(Token::Border).opacity(0.4))
                    .child(
                        div()
                            .id("git-history-toggle")
                            .h(px(28.0))
                            .flex_1()
                            .min_w_0()
                            .px(px(2.0))
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .text_size(px(TEXT_XS))
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .child(ui::chevron(history_open, 12.0, p.c(Token::Foreground)))
                            .child(ui::truncate(trs!(english, "pane_git.commit_history")))
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
                    )
                    .child(
                        div()
                            .id("git-history-scope")
                            .h(px(24.0))
                            .max_w(px(112.0))
                            .px(px(4.0))
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .rounded(px(6.0))
                            .text_size(px(11.0))
                            .cursor_pointer()
                            .hover(|d| d.bg(p.c(Token::Accent)))
                            .aria_label(if english {
                                "History branch scope"
                            } else {
                                "历史分支范围"
                            })
                            .child(icon("git-branch", 12.0, p.c(Token::Foreground)))
                            .child(ui::truncate(match (history_current, english) {
                                (false, false) => "全部分支".to_string(),
                                (false, true) => "All branches".to_string(),
                                (true, _) => history_branch.clone().unwrap_or_else(|| {
                                    if english {
                                        "Current branch"
                                    } else {
                                        "当前分支"
                                    }
                                    .to_string()
                                }),
                            }))
                            .on_click(cx.listener(set_scope(!history_current))),
                    )
                    .child(
                        history_button(
                            "git-history-head",
                            "target01",
                            if english {
                                "Locate HEAD"
                            } else {
                                "定位当前提交 HEAD"
                            },
                        )
                        .on_click(cx.listener(set_scope(true))),
                    )
                    .child(
                        history_button(
                            "git-history-refresh",
                            "refresh",
                            if english {
                                "Refresh commit history"
                            } else {
                                "刷新提交历史"
                            },
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(view) = this
                                .selected
                                .as_ref()
                                .and_then(|id| this.git_views.get_mut(id))
                            {
                                view.show_history = true;
                            }
                            this.load_git_history(0, None, cx);
                            cx.notify();
                        })),
                    ),
            );
        if history_open {
            history_column = history_column
                .h(relative(0.36))
                .child(self.git_history_panel(history, selected_revision, cx));
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
            let english_header = english;
            let untracked = status
                .files
                .iter()
                .any(|f| f.path == path && f.index == "?");
            let absolute = if path.starts_with('/') {
                path.clone()
            } else {
                format!("{}/{}", target.cwd.trim_end_matches('/'), path)
            };
            let local = std::path::Path::new(&target.cwd).is_dir();
            let header_button = |id: &'static str, glyph: &'static str, label: &'static str| {
                let label = SharedString::from(label);
                icon_button_xs(id, glyph, &p)
                    .aria_label(label.clone())
                    .tooltip(move |window, cx| Tooltip::new(label.clone()).build(window, cx))
            };
            let stage_label = if source == DiffSource::Staged {
                if english_header {
                    "Unstage"
                } else {
                    "取消暂存"
                }
            } else if english_header {
                "Stage"
            } else {
                "暂存"
            };
            let discard_target = target.clone();
            let discard_path = path.clone();
            let open_path = absolute.clone();
            let open_name = name.clone();
            let reveal_path = absolute.clone();
            // `DiffPane`'s header: the file, its counts, and what can be done to it.
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
                    }))
                    .when(
                        source == DiffSource::Staged || source == DiffSource::Unstaged,
                        |d| {
                            let stage_path = path.clone();
                            d.child(
                                header_button(
                                    "git-diff-stage",
                                    if source == DiffSource::Staged {
                                        "minus-sign"
                                    } else {
                                        "add01"
                                    },
                                    stage_label,
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.git_paths_call(
                                            &patch_target,
                                            Some(source != DiffSource::Staged),
                                            vec![stage_path.clone()],
                                            false,
                                            cx,
                                        )
                                    },
                                )),
                            )
                        },
                    )
                    .when(source == DiffSource::Unstaged, |d| {
                        d.child(
                            header_button(
                                "git-diff-discard",
                                "delete02",
                                if english_header { "Discard" } else { "丢弃" },
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    if !this.git_target_is_current(&discard_target) {
                                        return;
                                    }
                                    let action = if untracked {
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
                        )
                    })
                    .child(
                        header_button(
                            "git-diff-open",
                            "file01",
                            if english_header {
                                "Open current file"
                            } else {
                                "打开当前文件"
                            },
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.open_in_pane(open_path.clone(), open_name.clone(), window, cx);
                            },
                        )),
                    )
                    .when(local, |d| {
                        d.child(
                            header_button(
                                "git-diff-reveal",
                                "folder01",
                                if english_header {
                                    "Show in Finder"
                                } else {
                                    "在访达中显示"
                                },
                            )
                            .on_click(move |_, _, cx| {
                                cx.reveal_path(std::path::Path::new(&reveal_path));
                            }),
                        )
                    }),
            );
            // The mode toggle and the change counter with its arrows, as `DiffPane`'s second row.
            detail = detail.child(
                div()
                    .min_h(px(32.0))
                    .flex_none()
                    .px(px(8.0))
                    .py(px(4.0))
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
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .hover(|d| d.bg(p.c(Token::Muted)))
                            .child(match (split, english_header) {
                                (true, false) => "并排对比",
                                (true, true) => "Side by side",
                                (false, false) => "合并视图",
                                (false, true) => "Unified diff",
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
                    .child(div().flex_1())
                    .children((hunk_count > 0).then(|| {
                        div()
                            .text_size(px(10.0))
                            .text_color(p.c(Token::MutedForeground))
                            .child(format!("{hunk}/{hunk_count}"))
                    }))
                    .child(
                        header_button(
                            "git-previous-hunk",
                            "arrow-up02",
                            if english_header {
                                "Previous change"
                            } else {
                                "上一处变更"
                            },
                        )
                        .when(hunk_count == 0, |d| d.opacity(0.5))
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
                        header_button(
                            "git-next-hunk",
                            "arrow-down02",
                            if english_header {
                                "Next change"
                            } else {
                                "下一处变更"
                            },
                        )
                        .when(hunk_count == 0, |d| d.opacity(0.5))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if this.git_target_is_current(&next_target)
                                && let Some(view) = this.git_repo_mut(&next_target)
                                && view.navigation.step(hunk_count, true)
                            {
                                cx.notify();
                            }
                        })),
                    ),
            );
            // Side by side names the two versions it compares, above the columns.
            if split {
                let (left, right) = match (source, english_header) {
                    (DiffSource::Unstaged, false) => ("暂存区", "工作区"),
                    (DiffSource::Unstaged, true) => ("Index", "Working tree"),
                    (DiffSource::Staged, false) => ("HEAD", "暂存区"),
                    (DiffSource::Staged, true) => ("HEAD", "Index"),
                    (DiffSource::LastTurn, false) => ("HEAD", "工作区"),
                    (DiffSource::LastTurn, true) => ("HEAD", "Working tree"),
                    (DiffSource::Branch, false) => ("基准版本", "HEAD"),
                    (DiffSource::Branch, true) => ("Base version", "HEAD"),
                };
                let cell = |text: &'static str| {
                    div()
                        .flex_1()
                        .flex_basis(px(0.0))
                        .min_w_0()
                        .px(px(12.0))
                        .py(px(4.0))
                        .child(text)
                };
                detail = detail.child(
                    div()
                        .flex_none()
                        .flex()
                        .border_b_1()
                        .border_color(p.c(Token::Border))
                        .bg(p.c(Token::Muted).opacity(0.3))
                        .text_size(px(10.0))
                        .text_color(p.c(Token::MutedForeground))
                        .child(cell(left).border_r_1().border_color(p.c(Token::Border)))
                        .child(cell(right)),
                );
            }
            detail = detail.child(
                div()
                    .id("git-diff")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
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
                        trs!(english, "pane_git.reading_diff")
                    } else if rows.is_empty() {
                        trs!(english, "pane_git.no_uncommitted_changes")
                    } else {
                        trs!(english, "pane_git.select_a_file_to_view")
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
                            trs!(english, "pane_git.expand_file_tree")
                        } else {
                            trs!(english, "pane_git.collapse_file_tree")
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
                    .child({
                        let pull_target = target.clone();
                        let label = if english { "Pull" } else { "拉取" };
                        icon_button_xs("git-pull", "arrow-down02", &p)
                            .aria_label(label)
                            .tooltip(move |window, cx| Tooltip::new(label).build(window, cx))
                            .when(write_busy, |d| d.opacity(0.5))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.git_sync(&pull_target, false, cx)
                            }))
                    })
                    .child({
                        let push_target = target.clone();
                        let label = if english { "Push" } else { "推送" };
                        icon_button_xs("git-push", "arrow-up02", &p)
                            .aria_label(label)
                            .tooltip(move |window, cx| Tooltip::new(label).build(window, cx))
                            .when(write_busy, |d| d.opacity(0.5))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.git_sync(&push_target, true, cx)
                            }))
                    })
                    .child(
                        icon_button_xs(
                            "git-tree-toggle",
                            if tree { "list" } else { "folder-tree" },
                            &p,
                        )
                        .aria_label(match (tree, english) {
                            (true, false) => "切换为列表",
                            (true, true) => "Switch to list",
                            (false, false) => "切换为目录树",
                            (false, true) => "Switch to tree",
                        })
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
                            .aria_label(trs!(english, "pane_git.refresh"))
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
        match node {
            TreeNode::Directory { children, .. } => {
                let open = match node {
                    TreeNode::Directory { path, .. } => !collapsed.contains(path),
                    TreeNode::File(_) => false,
                };
                let mut rows = vec![self.git_list_row(node, false, Some(depth), open, cx)];
                if open {
                    for child in children {
                        rows.extend(self.git_tree_rows(child, depth + 1, selected, collapsed, cx));
                    }
                }
                rows
            }
            TreeNode::File(row) => {
                vec![self.git_list_row(
                    node,
                    selected == Some(row.path.as_str()),
                    Some(depth),
                    false,
                    cx,
                )]
            }
        }
    }

    /// One row of the flat list.
    fn git_row(
        &self,
        row: &Row,
        selected: bool,
        depth: Option<usize>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.git_list_row(&TreeNode::File(row.clone()), selected, depth, false, cx)
    }

    /// One row of `git-change-list.tsx`: the chevron slot (tree only), the icon, the name (the
    /// flat list adds its folder), a fixed-width action slot that hover fills — so hover never
    /// shifts the name — and the status column (a directory's is its file count).
    ///
    /// `depth` is set only in the tree.
    fn git_list_row(
        &self,
        node: &TreeNode,
        selected: bool,
        depth: Option<usize>,
        open: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let Some(target) = self.git_target() else {
            return div().into_any_element();
        };
        let tree = depth.is_some();
        let (id, name, group, letter, paths, directory_key) = match node {
            TreeNode::Directory { name, path, .. } => {
                let mut files = Vec::new();
                collect_paths(node, &mut files);
                let group = first_group(node).unwrap_or(Group::Unstaged);
                (
                    format!("git-dir-{path}"),
                    name.clone(),
                    group,
                    String::new(),
                    files,
                    Some(path.clone()),
                )
            }
            TreeNode::File(row) => (
                format!("git-{:?}-{}", row.group, row.path),
                row.path.rsplit('/').next().unwrap_or(&row.path).to_string(),
                row.group,
                row.letter.clone(),
                vec![row.path.clone()],
                None,
            ),
        };
        let directory = directory_key.is_some();
        let parent = match node {
            TreeNode::File(row) if !tree => {
                row.path.rsplit_once('/').map(|(dir, _)| dir.to_string())
            }
            _ => None,
        };
        let tone = match letter.as_str() {
            "?" | "A" => p.c(Token::Success),
            "D" | "U" => p.c(Token::Destructive),
            "M" | "T" => p.c(Token::Warning),
            "R" | "C" => p.c(Token::Info),
            _ => p.c(Token::MutedForeground).opacity(0.65),
        };
        let status = if directory {
            paths.len().to_string()
        } else if letter == "?" {
            "U".to_string()
        } else {
            letter.clone()
        };
        let icon_name = name.rsplit('/').next().unwrap_or(&name).to_string();
        let icon_path = if directory {
            crate::file_icons::folder_path(&icon_name, open, !p.is_dark())
        } else {
            crate::file_icons::path(&icon_name, !p.is_dark())
        };
        let staging = group != Group::Staged;
        let editable = group != Group::Conflicted;
        let stage_label = match (directory, staging, english) {
            (true, true, false) => format!("暂存目录下 {} 个文件", paths.len()),
            (true, true, true) => format!("Stage {} files in folder", paths.len()),
            (true, false, false) => format!("取消目录下 {} 个文件的暂存", paths.len()),
            (true, false, true) => format!("Unstage {} files in folder", paths.len()),
            (false, true, false) => format!("暂存 {name}"),
            (false, true, true) => format!("Stage {name}"),
            (false, false, false) => format!("取消暂存 {name}"),
            (false, false, true) => format!("Unstage {name}"),
        };
        let group_name = SharedString::from(format!("{id}-row"));
        let guides = depth.unwrap_or(0);
        let stage_target = target.clone();
        let stage_paths = paths.clone();
        let deleted = letter == "D";
        div()
            .group(group_name.clone())
            .id(SharedString::from(id))
            .relative()
            .h(px(28.0))
            .flex_none()
            .pl(px(tree_pad(guides)))
            .pr(px(8.0))
            .flex()
            .items_center()
            .gap(px(ROW_GAP))
            .text_size(px(TEXT_XS))
            .border_l_2()
            .border_color(if selected {
                p.c(Token::Primary)
            } else {
                gpui::transparent_black()
            })
            .when(selected, |d| d.bg(p.c(Token::Primary).opacity(0.1)))
            .hover({
                let fill = if selected {
                    p.c(Token::Primary).opacity(0.15)
                } else {
                    p.c(Token::Foreground).opacity(0.05)
                };
                move |d| d.bg(fill)
            })
            .when(guides > 0, |d| {
                let mut lines = div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(10.0))
                    .flex()
                    .opacity(0.4);
                for _ in 0..guides {
                    lines = lines.child(
                        div()
                            .w(px(TREE_STEP))
                            .h_full()
                            .border_l_1()
                            .border_color(p.c(Token::Border).opacity(0.7)),
                    );
                }
                d.child(lines)
            })
            .when(tree, |d| {
                d.child(
                    div()
                        .w(px(TREE_CHEVRON))
                        .flex_none()
                        .flex()
                        .items_center()
                        .when(directory, |d| {
                            d.child(ui::chevron(open, TREE_CHEVRON, p.c(Token::Foreground)))
                        }),
                )
            })
            .child(img(icon_path).size(px(16.0)).flex_none())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_baseline()
                    .gap(px(8.0))
                    .child(
                        div()
                            .min_w_0()
                            .when(directory, |d| {
                                d.text_color(p.c(Token::Foreground).opacity(0.85))
                            })
                            .when(deleted, |d| {
                                d.text_color(p.c(Token::MutedForeground)).line_through()
                            })
                            .child(ui::truncate(name.clone())),
                    )
                    .children(parent.map(|parent| {
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(11.0))
                            .text_color(p.c(Token::MutedForeground).opacity(0.7))
                            .child(ui::truncate(parent))
                    })),
            )
            .when(editable, |d| {
                d.child(
                    div()
                        .w(px(24.0))
                        .flex_none()
                        .flex()
                        .justify_end()
                        .invisible()
                        .group_hover(group_name.clone(), |d| d.visible())
                        .child(
                            icon_button_xs(
                                "git-stage",
                                if staging { "add01" } else { "minus-sign" },
                                p,
                            )
                            .aria_label(SharedString::from(stage_label.clone()))
                            .tooltip(move |window, cx| {
                                Tooltip::new(stage_label.clone()).build(window, cx)
                            })
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    // A staged row goes back to the worktree; an unstaged one goes
                                    // into the index.
                                    cx.stop_propagation();
                                    this.git_paths_call(
                                        &stage_target,
                                        Some(staging),
                                        stage_paths.clone(),
                                        false,
                                        cx,
                                    );
                                },
                            )),
                        ),
                )
            })
            .child(
                div()
                    .w(px(16.0))
                    .flex_none()
                    .flex()
                    .justify_end()
                    .font_family(crate::assets::MONO_FONT)
                    .text_size(px(11.0))
                    .text_color(tone)
                    .child(SharedString::from(status)),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.git_target_is_current(&target) {
                    return;
                }
                let Some(conversation) = this.selected.clone() else {
                    return;
                };
                if let Some(key) = &directory_key {
                    if let Some(view) = this.git_views.get_mut(&conversation)
                        && !view.collapsed.remove(key)
                    {
                        view.collapsed.insert(key.clone());
                    }
                    cx.notify();
                    return;
                }
                let path = paths[0].clone();
                if let Some(view) = this.git_views.get_mut(&conversation) {
                    view.selected = Some(path.clone());
                }
                this.load_git_diff(path, group.source(), None, cx);
            }))
            .into_any_element()
    }

    /// A patch, drawn by the one diff renderer: real line numbers from the diff itself, wrapped
    /// lines, and the side-by-side mode the reader can switch to. Electron's `DiffView` with
    /// `hideFileHeaders`: the pane's own header already names the file, so `diff --git`,
    /// `index`, `---` and `+++` are not drawn again. Every line wraps; nothing scrolls sideways.
    fn git_patch_view(&self, text: &str) -> AnyElement {
        use super::diff::RowKind;
        let p = &self.palette;
        let mut doc = super::diff::parse(text);
        doc.rows.retain(|row| {
            row.kind != RowKind::Meta
                || !["diff --git ", "index ", "--- ", "+++ "]
                    .iter()
                    .any(|head| row.text.starts_with(head))
        });
        let view = self.selected.as_ref().and_then(|id| self.git_views.get(id));
        let split = self.pane_content_width >= super::pane::SPLIT_MIN_WIDTH
            && view.is_some_and(|view| view.split);
        let hunk = view.map(|view| view.navigation.current).unwrap_or(0);
        let anchor = view.map(|view| view.navigation.anchor.clone());
        // Hunks are numbered from 1, the same way the 跳转 control counts them.
        let mut lines = div().w_full().flex().flex_col();
        if split {
            for row in super::diff::split(&doc.rows) {
                let selected = row
                    .header
                    .as_ref()
                    .is_some_and(|header| header.kind == RowKind::Hunk && header.hunk == hunk);
                let row = self.diff_split_row(&row, doc.number_width, p);
                lines = if selected {
                    lines.child(
                        div()
                            .id("git-target-hunk-split")
                            .w_full()
                            .anchor_scroll(anchor.clone())
                            .child(row),
                    )
                } else {
                    lines.child(row)
                };
            }
        } else {
            for row in &doc.rows {
                let selected = row.kind == RowKind::Hunk && row.hunk == hunk;
                let row = super::diff::row(row, doc.number_width, p);
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
        }
        div()
            .id(if split {
                "git-diff-split"
            } else {
                "git-diff-unified"
            })
            .w_full()
            .text_size(px(TEXT_XS))
            .line_height(px(20.0))
            .font_family(crate::assets::MONO_FONT)
            .child(lines)
            .into_any_element()
    }

    /// One row of the side-by-side view: a header spans both columns, everything else is a pair.
    fn diff_split_row(
        &self,
        row: &super::diff::SplitRow,
        width: usize,
        p: &crate::theme::Palette,
    ) -> AnyElement {
        use super::diff::RowKind;
        if let Some(header) = &row.header {
            let (bg, _, fg) = super::diff::row_style(header.kind, p);
            return div()
                .w_full()
                .px(px(12.0))
                .py(px(2.0))
                .when_some(bg, |d, bg| d.bg(bg))
                .when_some(fg, |d, fg| d.text_color(fg))
                .child(SharedString::from(header.text.clone()))
                .into_any_element();
        }
        let half = |row: Option<&super::diff::DiffRow>,
                    other: Option<&super::diff::DiffRow>,
                    right: bool|
         -> Div {
            let cell = div()
                .flex_1()
                .flex_basis(px(0.0))
                .min_w_0()
                .flex()
                .border_l_2()
                .when(!right, |d| d.border_r_1());
            // An empty half stays empty rather than being filled with a neighbour: the alignment
            // is the information.
            let Some(row) = row else {
                return cell
                    .border_color(p.c(Token::Border))
                    .bg(p.c(Token::Muted).opacity(0.4));
            };
            let (bg, rule, _) = super::diff::row_style(row.kind, p);
            // The rule is drawn on the left edge only; the left half's right border is the
            // column divider, which the theme's border colour draws.
            let cell = cell
                .border_color(rule.unwrap_or(gpui::transparent_black()))
                .when_some(bg, |d, bg| d.bg(bg));
            let changed = matches!(row.kind, RowKind::Added | RowKind::Removed);
            let text: AnyElement = match other.filter(|_| changed) {
                Some(other) => {
                    let (start, end) = super::diff::changed_range(&row.text, &other.text);
                    let mark = if row.kind == RowKind::Added {
                        p.c(Token::Success).opacity(0.25)
                    } else {
                        p.c(Token::Destructive).opacity(0.25)
                    };
                    gpui::StyledText::new(SharedString::from(row.text.clone()))
                        .with_highlights([(
                            start..end,
                            gpui::HighlightStyle {
                                background_color: Some(mark),
                                ..Default::default()
                            },
                        )])
                        .into_any_element()
                }
                None => SharedString::from(if row.text.is_empty() {
                    " ".to_string()
                } else {
                    row.text.clone()
                })
                .into_any_element(),
            };
            cell.when(width > 0, |d| {
                d.child(
                    super::diff::number(
                        if right {
                            row.new_number
                        } else {
                            row.old_number
                        },
                        width,
                        p.c(Token::MutedForeground).opacity(0.6),
                    )
                    .border_r_1()
                    .border_color(p.c(Token::Border)),
                )
            })
            .child(div().flex_1().min_w_0().px(px(8.0)).child(text))
        };
        div()
            .w_full()
            .flex()
            .child(half(row.left.as_ref(), row.right.as_ref(), false))
            .child(half(row.right.as_ref(), row.left.as_ref(), true))
            .into_any_element()
    }

    /// The commit box (`git-commit-form.tsx`): a one-line message that grows, the AI button
    /// inside its right edge, and a split 提交 button whose ⌄ offers 提交并推送.
    fn git_commit_box(
        &mut self,
        conversation: &str,
        _message: &str,
        has_changes: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.palette.clone();
        let english = self.english();
        let target = self.git_target();
        let view = self.git_views.get(conversation);
        let text_state = view.and_then(|v| v.editor.clone());
        let generating = view.is_some_and(|v| v.generating);
        let busy = view.is_some_and(|v| v.write_busy);
        let menu_open = view.is_some_and(|v| v.commit_menu);
        let hint = view
            .filter(|v| v.generating || v.message.is_empty())
            .map(|v| v.hint_shown.clone())
            .filter(|hint| !hint.is_empty());
        let editor = text_state.map(|editor| {
            let generate_target = target.clone();
            let label: SharedString = if english {
                "Generate commit message with AI".into()
            } else {
                "AI 生成提交信息".into()
            };
            div()
                .relative()
                .min_h(px(32.0))
                .pl(px(10.0))
                .pr(px(36.0))
                .py(px(1.0))
                .flex()
                .flex_col()
                .justify_center()
                .rounded(px(8.0))
                .border_1()
                .border_color(p.c(Token::Input))
                .text_size(px(TEXT_XS))
                .child(
                    Textarea::new(&editor)
                        .appearance(false)
                        .bordered(false)
                        .text_size(px(TEXT_XS)),
                )
                .children(hint.map(|hint| {
                    div()
                        .absolute()
                        .left(px(10.0))
                        .right(px(36.0))
                        .top_0()
                        .bottom_0()
                        .flex()
                        .items_center()
                        .text_size(px(TEXT_XS))
                        .text_color(p.c(Token::MutedForeground))
                        .child(ui::truncate(hint))
                }))
                .child(
                    div().absolute().top(px(3.0)).right(px(3.0)).child(
                        div()
                            .id("git-generate")
                            .size(px(24.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.0))
                            .cursor_pointer()
                            .hover(|d| d.bg(p.c(Token::Accent)))
                            .when(!has_changes || busy, |d| d.opacity(0.5))
                            .aria_label(label.clone())
                            .tooltip(move |window, cx| {
                                Tooltip::new(label.clone()).build(window, cx)
                            })
                            .child(if generating {
                                ui::spinner("git-generating", 14.0, p.c(Token::MutedForeground))
                                    .into_any_element()
                            } else {
                                icon("sparkles", 16.0, p.c(Token::MutedForeground))
                                    .into_any_element()
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if has_changes && let Some(target) = &generate_target {
                                    this.git_generate(target, cx);
                                }
                            })),
                    ),
                )
        });
        let can_commit = has_changes && !busy;
        let commit_target = target.clone();
        let toggle_target = target.clone();
        let fg = p.c(Token::PrimaryForeground);
        let button = div()
            .relative()
            .h(px(32.0))
            .w_full()
            .flex()
            .rounded(px(6.0))
            .bg(p.c(Token::Primary))
            .text_color(fg)
            .text_size(px(TEXT_XS))
            .font_weight(FontWeight::MEDIUM)
            .child(
                div()
                    .id("git-commit")
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(6.0))
                    .cursor_pointer()
                    .when(!can_commit, |d| d.opacity(0.5))
                    .child(if busy && !generating {
                        ui::spinner("git-committing", 14.0, fg).into_any_element()
                    } else {
                        icon("tick02", 14.0, fg).into_any_element()
                    })
                    .child(text::git_commit(self.app_settings.language))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if can_commit && let Some(target) = &commit_target {
                            this.git_commit(target, false, cx);
                        }
                    })),
            )
            .child(
                div()
                    .id("git-commit-options")
                    .w(px(32.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_l_1()
                    .border_color(fg.opacity(0.25))
                    .cursor_pointer()
                    .aria_label(if english {
                        "More commit actions"
                    } else {
                        "更多提交操作"
                    })
                    .child(icon("arrow-down01", 16.0, fg))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(target) = &toggle_target
                            && this.git_target_is_current(target)
                            && let Some(view) = this.git_repo_mut(target)
                        {
                            view.commit_menu = !view.commit_menu;
                            cx.notify();
                        }
                    })),
            )
            .when(menu_open, |d| {
                let item = |id: &'static str, label: &'static str, push: bool| {
                    let target = target.clone();
                    div()
                        .id(id)
                        .h(px(30.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .rounded(px(6.0))
                        .text_size(px(TEXT_SM))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(p.c(Token::PopoverForeground))
                        .cursor_pointer()
                        .when(!has_changes, |d| d.opacity(0.5))
                        .hover(|d| d.bg(p.c(Token::Accent)))
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(target) = &target {
                                if has_changes {
                                    this.git_commit(target, push, cx);
                                } else if let Some(view) = this.git_repo_mut(target) {
                                    view.commit_menu = false;
                                    cx.notify();
                                }
                            }
                        }))
                };
                d.child(ui::float(
                    div()
                        .absolute()
                        .top(px(37.0))
                        .right_0()
                        .min_w(px(176.0))
                        .p(px(4.0))
                        .rounded(px(10.0))
                        .bg(p.overlay())
                        .border_1()
                        .border_color(p.c(Token::Border))
                        .shadow_md()
                        .flex()
                        .flex_col()
                        .child(crate::ui::backdrop(10.0, 28.0, 1.8))
                        .child(item(
                            "git-menu-commit",
                            if english { "Commit" } else { "提交" },
                            false,
                        ))
                        .child(item(
                            "git-menu-commit-push",
                            if english {
                                "Commit & Push"
                            } else {
                                "提交并推送"
                            },
                            true,
                        )),
                ))
            });
        div()
            .flex_none()
            .border_b_1()
            .border_color(p.c(Token::Border))
            .p(px(8.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .children(editor)
            .child(button)
            .into_any_element()
    }

    /// The graph, one commit per row, with its parents' lines kept (`git-history.tsx`).
    fn git_history_panel(
        &self,
        history: Option<GitHistory>,
        selected_revision: Option<String>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
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
            return div()
                .flex_1()
                .flex()
                .justify_center()
                .p(px(12.0))
                .child(ui::spinner(
                    "git-history-loading",
                    14.0,
                    p.c(Token::MutedForeground),
                ))
                .into_any_element();
        };
        // Each row owns its commit: a click handler outlives this call, and a borrow of the page
        // cannot travel with it. What the "more" row needs is taken first.
        let count = history.commits.len() as u32;
        let has_more = history.has_more;
        let tips = history.tips.clone();
        let shape: Vec<(String, Vec<String>)> = history
            .commits
            .iter()
            .map(|c| (c.hash.clone(), c.parents.clone()))
            .collect();
        let (graph, columns) = state::layout_graph(&shape);
        let colors = [
            p.c(Token::Info),
            p.c(Token::Chart2),
            p.c(Token::Chart3),
            p.c(Token::Chart4),
            p.c(Token::Chart5),
            p.c(Token::Primary),
        ];
        let background = p.c(Token::Background);
        let empty = history.commits.is_empty();
        let mut rows = div().flex().flex_col().pb(px(4.0));
        for (commit, row) in history.commits.into_iter().zip(graph) {
            let target = target.clone();
            let selected = selected_revision.as_deref() == Some(commit.hash.as_str());
            let mut refs: Vec<GitReference> = commit.refs.clone();
            refs.sort_by_key(|r| {
                (
                    !r.current,
                    match r.kind {
                        GitRefKind::Local => 0,
                        GitRefKind::Remote => 1,
                        GitRefKind::Tag => 2,
                    },
                )
            });
            let mut badges = div().flex_none().flex().items_center().gap(px(4.0));
            if commit.is_head && !refs.iter().any(|r| r.current) {
                badges = badges.child(
                    div()
                        .px(px(4.0))
                        .rounded(px(4.0))
                        .bg(p.c(Token::Primary).opacity(0.15))
                        .text_color(p.c(Token::Primary))
                        .font_weight(FontWeight::MEDIUM)
                        .child("HEAD"),
                );
            }
            let hidden = refs.len().saturating_sub(2);
            for reference in refs.iter().take(2) {
                let (bg, fg, glyph) = if reference.current {
                    (p.c(Token::Info), gpui::white(), "target01")
                } else {
                    match reference.kind {
                        GitRefKind::Remote => (
                            p.c(Token::Chart2).opacity(0.15),
                            p.c(Token::Chart2),
                            "cloud",
                        ),
                        GitRefKind::Tag => (
                            p.c(Token::Warning).opacity(0.15),
                            p.c(Token::Warning),
                            "tag01",
                        ),
                        GitRefKind::Local => (
                            p.c(Token::Info).opacity(0.1),
                            p.c(Token::Info),
                            "git-branch",
                        ),
                    }
                };
                // A remote that only mirrors a local branch on the same row is its cloud alone.
                let mirror = reference.kind == GitRefKind::Remote
                    && refs.iter().any(|local| {
                        local.kind == GitRefKind::Local
                            && reference.name.ends_with(&format!("/{}", local.name))
                    });
                badges = badges.child(
                    div()
                        .max_w(px(112.0))
                        .px(px(4.0))
                        .py(px(2.0))
                        .rounded(px(4.0))
                        .flex()
                        .items_center()
                        .gap(px(2.0))
                        .bg(bg)
                        .text_color(fg)
                        .line_height(px(12.0))
                        .child(icon(glyph, 12.0, fg))
                        .when(!mirror, |d| d.child(ui::truncate(reference.name.clone()))),
                );
            }
            if hidden > 0 {
                badges = badges.child(div().muted(p).child(format!("+{hidden}")));
            }
            let has_refs = !refs.is_empty();
            let lanes = row.clone();
            let head = commit.is_head;
            let step = if columns > 6 { 14.0 } else { 18.0 };
            let graph_width = 22.0 + (columns.saturating_sub(1)) as f32 * step;
            let palette_colors = colors;
            let cell = canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    let ox = f32::from(bounds.origin.x);
                    let oy = f32::from(bounds.origin.y);
                    let x = |column: usize| ox + 11.0 + column as f32 * step;
                    let pt = |x: f32, y: f32| point(gpui_kit::px(x), gpui_kit::px(y));
                    let color = |i: usize| palette_colors[i % palette_colors.len()];
                    let radius = if head { 6.0 } else { 4.0 };
                    let cy = oy + 14.0;
                    for edge in &lanes.edges {
                        let (from, to) = (x(edge.from), x(edge.to));
                        let mut path = PathBuilder::stroke(gpui_kit::px(2.0));
                        match edge.kind {
                            state::EdgeKind::In => {
                                path.move_to(pt(from, oy));
                                // A hollow HEAD ring keeps the lane out of its middle.
                                path.line_to(pt(from, if head { cy - radius - 1.2 } else { cy }));
                            }
                            state::EdgeKind::Through => {
                                path.move_to(pt(from, oy));
                                path.cubic_bezier_to(
                                    pt(to, oy + 28.0),
                                    pt(from, oy + 14.0),
                                    pt(to, oy + 14.0),
                                );
                            }
                            state::EdgeKind::Out => {
                                let start = if head && edge.from == edge.to {
                                    cy + radius + 1.2
                                } else {
                                    cy
                                };
                                path.move_to(pt(from, start));
                                path.cubic_bezier_to(
                                    pt(to, oy + 28.0),
                                    pt(from, oy + 23.0),
                                    pt(to, oy + 20.0),
                                );
                            }
                        }
                        if let Ok(path) = path.build() {
                            window.paint_path(path, color(edge.color));
                        }
                    }
                    let circle = |r: f32| {
                        let cx = x(lanes.column);
                        (0..=32)
                            .map(|i| {
                                let a = i as f32 / 32.0 * std::f32::consts::TAU;
                                pt(cx + r * a.cos(), cy + r * a.sin())
                            })
                            .collect::<Vec<_>>()
                    };
                    let dot = color(lanes.color);
                    if head {
                        let mut ring = PathBuilder::stroke(gpui_kit::px(2.25));
                        ring.add_polygon(&circle(radius), true);
                        if let Ok(path) = ring.build() {
                            window.paint_path(path, dot);
                        }
                    } else {
                        let mut fill = PathBuilder::fill();
                        fill.add_polygon(&circle(radius), true);
                        if let Ok(path) = fill.build() {
                            window.paint_path(path, dot);
                        }
                    }
                    if lanes
                        .edges
                        .iter()
                        .filter(|e| e.kind == state::EdgeKind::Out)
                        .count()
                        > 1
                    {
                        let mut merge = PathBuilder::fill();
                        merge.add_polygon(&circle(1.6), true);
                        if let Ok(path) = merge.build() {
                            window.paint_path(path, if head { dot } else { background });
                        }
                    }
                },
            )
            .w(px(graph_width))
            .h(px(28.0))
            .flex_none();
            rows = rows.child(
                div()
                    .id(SharedString::from(format!("commit-{}", commit.hash)))
                    .h(px(28.0))
                    .flex_none()
                    .pl(px(4.0))
                    .pr(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .text_size(px(TEXT_XS))
                    .cursor_pointer()
                    .border_l_2()
                    .border_color(if selected {
                        p.c(Token::Primary)
                    } else {
                        gpui::transparent_black()
                    })
                    .when(selected, |d| d.bg(p.c(Token::Primary).opacity(0.1)))
                    .hover({
                        let fill = p.c(Token::Foreground).opacity(0.05);
                        move |d| d.bg(fill)
                    })
                    .tooltip({
                        let short: String = commit.hash.chars().take(7).collect();
                        let text = format!(
                            "{}\n{} · {}\n{}",
                            commit.subject, commit.author, commit.date, short
                        );
                        move |window, cx| Tooltip::new(text.clone()).build(window, cx)
                    })
                    .child(cell)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_baseline()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .min_w_0()
                                    .when(head, |d| d.font_weight(FontWeight::MEDIUM))
                                    .child(ui::truncate(commit.subject.clone())),
                            )
                            .when(!has_refs, |d| {
                                d.child(
                                    div()
                                        .max_w(px(64.0))
                                        .flex_none()
                                        .text_size(px(11.0))
                                        .text_color(p.c(Token::MutedForeground).opacity(0.7))
                                        .child(ui::truncate(commit.author.clone())),
                                )
                            }),
                    )
                    .child(badges)
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
                .h(px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(TEXT_XS))
                .cursor_pointer()
                .hover(|d| d.bg(p.c(Token::Muted)))
                .child(if english {
                    "Load earlier commits"
                } else {
                    "加载更早的提交"
                })
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
            .when(empty, |d| {
                d.child(
                    div()
                        .p(px(12.0))
                        .text_size(px(TEXT_XS))
                        .muted(p)
                        .child(if english {
                            "No commits yet"
                        } else {
                            "还没有提交记录"
                        }),
                )
            })
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
                trs!(english, "pane_git.discard_these_changes"),
                trs!(english, "pane_git.files_will_return_to_their"),
                trs!(english, "pane_git.discard"),
            ),
            GitAction::DeleteUntracked => (
                trs!(english, "pane_git.delete_these_untracked_files"),
                trs!(english, "pane_git.they_are_not_in_git"),
                trs!(english, "pane_git.delete"),
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
                    .child(crate::ui::backdrop(14.0, 28.0, 1.8))
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
                                    .child(trs!(english, "pane_git.cancel"))
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

#[cfg(test)]
mod transcript_selection_tests {
    use super::{DiffSource, GitFileChange, GitStatus, state, transcript_change};

    #[test]
    fn transcript_review_chooses_the_current_layer_and_falls_back() {
        let mut status = GitStatus {
            cwd: "/repo/sub".into(),
            files: vec![
                GitFileChange {
                    path: "other.rs".into(),
                    index: " ".into(),
                    worktree: "M".into(),
                },
                GitFileChange {
                    path: "nested/a.rs".into(),
                    index: "M".into(),
                    worktree: " ".into(),
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            transcript_change(&status, "/repo/sub/nested/a.rs"),
            Some(("nested/a.rs".into(), DiffSource::Staged))
        );
        status.files[1].worktree = "M".into();
        assert_eq!(
            transcript_change(&status, "/repo/sub/nested/a.rs"),
            Some(("nested/a.rs".into(), DiffSource::Unstaged))
        );
        assert_eq!(
            transcript_change(&status, "/repo/sub/committed.rs"),
            Some(("nested/a.rs".into(), DiffSource::Unstaged))
        );
        status.files.clear();
        assert_eq!(transcript_change(&status, "/repo/sub/committed.rs"), None);
    }

    #[test]
    fn a_clean_review_cannot_be_overwritten_by_a_pending_old_patch() {
        let mut view = state::GitRepoView::default();
        let epoch = view.begin_patch("old.rs", DiffSource::Unstaged, None);
        view.clear_patch();
        view.finish_patch(
            epoch,
            Ok(("old.rs".into(), DiffSource::Unstaged, "old diff".into())),
        );
        assert!(view.patch.is_none());
        assert!(view.selected.is_none());
        assert!(!view.patch_loading);
    }
}
