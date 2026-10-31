//! Per-repository Git state. Requests carry a repository and generation; a later click,
//! refresh or write must not be overwritten by an older read.
use super::GitAction;
use fv_protocol::types::{DiffSource, GitHistory, GitStatus};
use gpui_kit::component::input::TextareaState;
use gpui_kit::{Entity, ScrollAnchor, ScrollHandle, point, px};
use std::collections::{HashMap, HashSet};
use std::ops::{Deref, DerefMut};

pub struct GitView {
    /// A side-chat file can use a different worktree while the parent pane stays selected.
    pub transcript_owner: Option<String>,
    repository: String,
    repositories: HashMap<String, GitRepoView>,
}
impl Default for GitView {
    fn default() -> Self {
        Self {
            transcript_owner: None,
            repository: String::new(),
            repositories: HashMap::from([(String::new(), GitRepoView::default())]),
        }
    }
}
impl GitView {
    pub fn set_transcript_owner(&mut self, owner: Option<String>) {
        if self.transcript_owner == owner {
            return;
        }
        self.transcript_owner = owner;
        for repository in self.repositories.values_mut() {
            repository.invalidate_reads();
            repository.invalidate_history();
        }
    }

    pub fn repository(&self) -> &str {
        &self.repository
    }
    pub fn select(&mut self, repository: &str) -> bool {
        if self.repository == repository {
            return false;
        }
        // The pre-selection slot also holds capture fixtures. Give it its real repository
        // rather than losing an editor or status that was prepared before the first draw.
        if self.repository.is_empty() && self.repositories.len() == 1 {
            let initial = self.repositories.remove("").unwrap_or_default();
            self.repositories.insert(repository.to_string(), initial);
        } else {
            self.repositories.entry(repository.to_string()).or_default();
        }
        self.repository = repository.to_string();
        true
    }
    pub fn for_repository(&mut self, repository: &str) -> Option<&mut GitRepoView> {
        self.repositories.get_mut(repository)
    }
}
impl Deref for GitView {
    type Target = GitRepoView;
    fn deref(&self) -> &Self::Target {
        &self.repositories[&self.repository]
    }
}
impl DerefMut for GitView {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.repositories
            .get_mut(&self.repository)
            .expect("selected repository exists")
    }
}

pub struct DiffNavigation {
    pub current: usize,
    pub scroll: ScrollHandle,
    pub anchor: ScrollAnchor,
    pub pending: bool,
}
impl Default for DiffNavigation {
    fn default() -> Self {
        let scroll = ScrollHandle::new();
        Self {
            current: 0,
            anchor: ScrollAnchor::for_handle(scroll.clone()),
            scroll,
            pending: false,
        }
    }
}
impl DiffNavigation {
    fn reset(&mut self) {
        self.current = 0;
        self.scroll.set_offset(point(px(0.0), px(0.0)));
        self.pending = false;
    }
    pub fn step(&mut self, count: usize, next: bool) -> bool {
        if count == 0 {
            self.current = 0;
            return false;
        }
        self.current = if next {
            self.current % count + 1
        } else if self.current <= 1 {
            count
        } else {
            self.current - 1
        };
        self.pending = true;
        true
    }
}

#[derive(Default)]
pub struct GitRepoView {
    pub status: Option<GitStatus>,
    pub patch: Option<(String, DiffSource, String)>,
    pub selected: Option<String>,
    pub selected_source: Option<DiffSource>,
    pub selected_revision: Option<String>,
    pub history: Option<GitHistory>,
    pub message: String,
    pub editor: Option<Entity<TextareaState>>,
    pub clear_editor: Option<String>,
    pub notice: Option<String>,
    pub pending: Option<(GitAction, Vec<String>)>,
    pub show_history: bool,
    /// The history's branch scope: every branch (Electron's default) or only the current one.
    pub history_current: bool,
    /// AI 生成提交信息 is running; the editor says so instead of its hint.
    pub generating: bool,
    /// A generated message waiting for the editor: `(what the editor held when asked, message)`.
    /// It lands only if the draft is still what it was, so typing meanwhile wins.
    pub generated: Option<(String, String)>,
    /// The commit button's ⌄ menu (提交 / 提交并推送) is open.
    pub commit_menu: bool,
    /// The placeholder last handed to the editor, so it is only set when it changes.
    pub hint_shown: String,
    pub split: bool,
    pub collapsed: HashSet<String>,
    pub flat: bool,
    pub tree_width: f32,
    pub tree_hidden: bool,
    pub tree_scroll: ScrollHandle,
    pub history_scroll: ScrollHandle,
    pub navigation: DiffNavigation,
    pub status_loading: bool,
    pub history_loading: bool,
    pub patch_loading: bool,
    pub write_busy: bool,
    status_epoch: u64,
    patch_epoch: u64,
    history_epoch: u64,
}
impl GitRepoView {
    pub fn begin_status(&mut self) -> u64 {
        self.status_epoch = self.status_epoch.wrapping_add(1);
        self.status_loading = true;
        self.status_epoch
    }
    pub fn accepts_status(&mut self, epoch: u64) -> bool {
        if self.status_epoch != epoch {
            return false;
        }
        self.status_loading = false;
        true
    }
    pub fn begin_patch(&mut self, path: &str, source: DiffSource, revision: Option<String>) -> u64 {
        self.patch_epoch = self.patch_epoch.wrapping_add(1);
        let same = self.selected.as_deref() == Some(path)
            && self.selected_source == Some(source)
            && self.selected_revision == revision
            && self.patch.is_some();
        self.selected = Some(path.to_string());
        self.selected_source = Some(source);
        self.selected_revision = revision;
        if !same {
            self.patch = None;
            self.navigation.reset();
        }
        self.patch_loading = true;
        self.patch_epoch
    }
    pub fn finish_patch(
        &mut self,
        epoch: u64,
        result: Result<(String, DiffSource, String), String>,
    ) {
        if self.patch_epoch != epoch {
            return;
        }
        self.patch_loading = false;
        match result {
            Ok((path, source, text)) => {
                if !self
                    .patch
                    .as_ref()
                    .is_some_and(|old| old.0 == path && old.1 == source && old.2 == text)
                {
                    self.navigation.reset();
                }
                self.patch = Some((path, source, text));
                self.notice = None;
            }
            Err(error) => self.notice = Some(error),
        }
    }
    pub fn begin_history(&mut self, skip: u32, tips: Option<&[String]>) -> Option<u64> {
        if skip > 0
            && (self.history_loading
                || self.history.as_ref().is_none_or(|history| {
                    history.commits.len() != skip as usize || Some(history.tips.as_slice()) != tips
                }))
        {
            return None;
        }
        self.history_epoch = self.history_epoch.wrapping_add(1);
        self.history_loading = true;
        Some(self.history_epoch)
    }
    pub fn finish_history(&mut self, epoch: u64, skip: u32, result: Result<GitHistory, String>) {
        if self.history_epoch != epoch {
            return;
        }
        self.history_loading = false;
        match result {
            Ok(page) if skip == 0 => self.history = Some(page),
            Ok(page) => {
                if let Some(history) = &mut self.history
                    && history.commits.len() == skip as usize
                    && history.tips == page.tips
                {
                    history.commits.extend(page.commits);
                    history.has_more = page.has_more;
                }
            }
            Err(error) => self.notice = Some(error),
        }
    }
    fn invalidate_reads(&mut self) {
        self.status_epoch = self.status_epoch.wrapping_add(1);
        self.status_loading = false;
        self.clear_patch();
    }
    pub fn clear_patch(&mut self) {
        self.patch_epoch = self.patch_epoch.wrapping_add(1);
        self.patch_loading = false;
        self.patch = None;
        self.selected = None;
        self.selected_source = None;
        self.selected_revision = None;
        self.navigation.reset();
    }
    pub fn begin_write(&mut self) -> bool {
        if self.write_busy {
            self.notice = Some("该仓库正在处理另一个操作，请稍后再试。".into());
            return false;
        }
        self.write_busy = true;
        self.invalidate_reads();
        self.notice = None;
        true
    }
    pub fn end_write(&mut self) {
        self.write_busy = false;
        self.invalidate_reads();
    }
    pub fn invalidate_history(&mut self) {
        self.history_epoch = self.history_epoch.wrapping_add(1);
        self.history_loading = false;
        self.history = None;
    }

    pub fn committed_message(&mut self, submitted: &str, editor_text: Option<&str>) {
        if self.message == submitted && editor_text.is_none_or(|current| current == submitted) {
            self.message.clear();
            self.clear_editor = Some(submitted.to_string());
        }
    }
    pub fn take_editor_clear(&mut self, current: &str) -> bool {
        let Some(expected) = self.clear_editor.take() else {
            return false;
        };
        if expected == current {
            self.message.clear();
            return true;
        }
        self.message = current.to_string();
        false
    }
}

/// How one lane crosses a history row (`lib/git-graph.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeKind {
    /// A lane passing by: from the row's top to its bottom, moving column if it must.
    Through,
    /// The lane that arrives at this commit, from the top to its dot.
    In,
    /// A line from this commit's dot to one of its parents' lanes.
    Out,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraphEdge {
    pub from: usize,
    pub to: usize,
    pub color: usize,
    pub kind: EdgeKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphRow {
    pub column: usize,
    pub color: usize,
    pub edges: Vec<GraphEdge>,
}

/// One lane per pending ancestor; only real parent hashes make edges — Electron's
/// `layoutGitGraph`, so a root commit draws no line to unrelated history.
pub fn layout_graph(commits: &[(String, Vec<String>)]) -> (Vec<GraphRow>, usize) {
    let mut lanes: Vec<(String, usize)> = Vec::new();
    let mut next_color = 0;
    let mut columns = 1;
    let mut rows = Vec::new();
    for (hash, parents) in commits {
        let found = lanes.iter().position(|(lane, _)| lane == hash);
        let incoming = found.is_some();
        let column = found.unwrap_or_else(|| {
            lanes.push((hash.clone(), next_color));
            next_color += 1;
            lanes.len() - 1
        });
        let before = lanes.clone();
        let color = before[column].1;
        lanes.remove(column);
        let mut unique: Vec<&String> = Vec::new();
        for parent in parents {
            if !unique.contains(&parent) {
                unique.push(parent);
            }
        }
        for (index, parent) in unique.iter().enumerate() {
            if !lanes.iter().any(|(lane, _)| lane == *parent) {
                let lane_color = if index == 0 {
                    color
                } else {
                    next_color += 1;
                    next_color - 1
                };
                let at = (column + index).min(lanes.len());
                lanes.insert(at, ((*parent).clone(), lane_color));
            }
        }
        let mut edges = Vec::new();
        for (index, (lane, lane_color)) in before.iter().enumerate() {
            if index == column {
                continue;
            }
            if let Some(target) = lanes.iter().position(|(next, _)| next == lane) {
                edges.push(GraphEdge {
                    from: index,
                    to: target,
                    color: *lane_color,
                    kind: EdgeKind::Through,
                });
            }
        }
        if incoming {
            edges.push(GraphEdge {
                from: column,
                to: column,
                color,
                kind: EdgeKind::In,
            });
        }
        for parent in unique {
            if let Some(target) = lanes.iter().position(|(lane, _)| lane == parent) {
                edges.push(GraphEdge {
                    from: column,
                    to: target,
                    color: lanes[target].1,
                    kind: EdgeKind::Out,
                });
            }
        }
        columns = columns.max(before.len()).max(lanes.len());
        rows.push(GraphRow {
            column,
            color,
            edges,
        });
    }
    (rows, columns)
}

#[cfg(test)]
mod tests {
    use super::{DiffNavigation, EdgeKind, GitRepoView, GitView, layout_graph};

    #[test]
    fn changing_transcript_owner_invalidates_reads_even_for_the_same_repository() {
        let mut view = GitView::default();
        view.select("/shared/repository");
        let status = view.begin_status();
        let patch = view.begin_patch("file.rs", fv_protocol::types::DiffSource::Unstaged, None);
        view.set_transcript_owner(Some("child".into()));
        assert_eq!(view.repository(), "/shared/repository");
        assert!(!view.accepts_status(status));
        assert_ne!(view.patch_epoch, patch);
        assert!(!view.status_loading && !view.patch_loading);
        let current = view.begin_status();
        view.set_transcript_owner(Some("child".into()));
        assert!(
            view.accepts_status(current),
            "unchanged owner keeps current reads"
        );
    }

    #[test]
    fn a_merge_opens_a_second_lane_and_a_root_draws_nothing_below() {
        let c = |h: &str, p: &[&str]| (h.to_string(), p.iter().map(|s| s.to_string()).collect());
        let (rows, columns) = layout_graph(&[c("m", &["a", "b"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(columns, 2);
        assert_eq!(rows[0].column, 0);
        assert_eq!(
            rows[0]
                .edges
                .iter()
                .filter(|e| e.kind == EdgeKind::Out)
                .count(),
            2
        );
        assert_eq!(rows[1].column, 1);
        // The root ends its lane: nothing goes out of it.
        assert!(rows[2].edges.iter().all(|e| e.kind != EdgeKind::Out));
    }
    use fv_protocol::types::{DiffSource, GitCommit, GitHistory};
    const PATCH: &str = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n-before\n+after\n";
    fn page(hash: &str, tip: &str) -> GitHistory {
        GitHistory {
            commits: vec![GitCommit {
                hash: hash.into(),
                parents: vec![],
                subject: hash.into(),
                author: "test".into(),
                date: "".into(),
                body: "".into(),
                refs: vec![],
                is_head: false,
            }],
            has_more: true,
            tips: vec![tip.into()],
            head: Some(tip.into()),
            branch: Some("main".into()),
        }
    }
    #[test]
    fn refreshing_history_rejects_inflight_old_pages_and_duplicate_load_more_clicks() {
        let mut view = GitView::default();
        let first = view.begin_history(0, None).unwrap();
        view.finish_history(first, 0, Ok(page("a", "tip-a")));
        let older = view.begin_history(1, Some(&["tip-a".into()])).unwrap();
        assert!(view.begin_history(1, Some(&["tip-a".into()])).is_none());
        let refreshed = view.begin_history(0, None).unwrap();
        view.finish_history(refreshed, 0, Ok(page("x", "tip-x")));
        view.finish_history(older, 1, Ok(page("b", "tip-a")));
        assert_eq!(view.history.as_ref().unwrap().commits.len(), 1);
        assert_eq!(view.history.as_ref().unwrap().commits[0].hash, "x");
        assert!(view.begin_history(1, Some(&["tip-a".into()])).is_none());
        let next = view.begin_history(1, Some(&["tip-x".into()])).unwrap();
        view.finish_history(next, 1, Ok(page("y", "tip-x")));
        assert_eq!(view.history.as_ref().unwrap().commits.len(), 2);
    }
    #[test]
    fn commit_completion_and_deferred_editor_clearing_preserve_newer_text() {
        let mut view = GitRepoView {
            message: "submitted".into(),
            ..Default::default()
        };
        view.committed_message("submitted", Some("new typing before change event"));
        assert!(view.clear_editor.is_none());
        view.committed_message("submitted", Some("submitted"));
        assert!(view.message.is_empty());
        assert!(!view.take_editor_clear("typed after completion"));
        assert_eq!(view.message, "typed after completion");
        view.message = "submitted".into();
        view.committed_message("submitted", Some("submitted"));
        assert!(view.take_editor_clear("submitted"));
        assert!(view.message.is_empty());
    }
    #[test]
    fn repository_switches_keep_drafts_and_late_results_with_their_owner() {
        let mut view = GitView::default();
        view.select("/one");
        view.message = "first draft".into();
        let ticket = view.begin_patch("same.txt", DiffSource::Staged, None);
        view.select("/two");
        view.message = "second draft".into();
        view.for_repository("/one").unwrap().finish_patch(
            ticket,
            Ok(("same.txt".into(), DiffSource::Staged, PATCH.into())),
        );
        assert!(view.patch.is_none());
        assert_eq!(view.message, "second draft");
        view.select("/one");
        assert_eq!(view.message, "first draft");
        assert!(view.patch.is_some());
        assert_eq!(view.navigation.current, 0);
    }
    #[test]
    fn background_refresh_keeps_navigation_only_when_the_diff_has_not_changed() {
        let mut view = GitView::default();
        let first = view.begin_patch("a", DiffSource::Staged, None);
        view.finish_patch(first, Ok(("a".into(), DiffSource::Staged, PATCH.into())));
        view.navigation.step(2, false);
        assert_eq!(view.navigation.current, 2);
        let refresh = view.begin_patch("a", DiffSource::Staged, None);
        assert!(view.patch.is_some());
        view.finish_patch(refresh, Ok(("a".into(), DiffSource::Staged, PATCH.into())));
        assert_eq!(view.navigation.current, 2);
        let changed = view.begin_patch("a", DiffSource::Staged, None);
        view.finish_patch(
            changed,
            Ok(("a".into(), DiffSource::Staged, format!("{PATCH}+changed\n"))),
        );
        assert_eq!(view.navigation.current, 0);
    }
    #[test]
    fn older_file_reads_and_reads_started_before_a_write_cannot_restore_a_stale_patch() {
        let mut view = GitView::default();
        let first = view.begin_patch("first", DiffSource::Staged, None);
        let last = view.begin_patch("second", DiffSource::Unstaged, None);
        view.finish_patch(
            last,
            Ok(("second".into(), DiffSource::Unstaged, PATCH.into())),
        );
        view.finish_patch(
            first,
            Ok(("first".into(), DiffSource::Staged, PATCH.into())),
        );
        assert_eq!(view.patch.as_ref().unwrap().0, "second");
        let status = view.begin_status();
        assert!(view.begin_write());
        assert!(!view.begin_write());
        assert!(!view.accepts_status(status));
        view.end_write();
        view.finish_patch(
            last,
            Ok(("second".into(), DiffSource::Unstaged, PATCH.into())),
        );
        assert!(view.patch.is_none());
    }
    #[test]
    fn hunk_navigation_cycles_like_the_electron_view_and_empty_diffs_do_not_jump() {
        let mut navigation = DiffNavigation::default();
        assert!(!navigation.step(0, true));
        assert!(!navigation.pending);
        assert!(navigation.step(2, true));
        assert_eq!(navigation.current, 1);
        navigation.step(2, true);
        assert_eq!(navigation.current, 2);
        navigation.step(2, true);
        assert_eq!(navigation.current, 1);
        navigation.step(2, false);
        assert_eq!(navigation.current, 2);
        navigation.step(2, false);
        assert_eq!(navigation.current, 1);
        navigation.current = 0;
        navigation.step(2, false);
        assert_eq!(navigation.current, 2);
    }

    #[test]
    fn tree_file_icon_lines_up_with_the_folder_at_the_same_depth() {
        // This file is `pane_git::state`; the inset lives on the parent module.
        for depth in 0..8 {
            assert_eq!(
                super::super::tree_icon_x(depth, true),
                super::super::tree_icon_x(depth, false),
                "depth {depth}"
            );
            if depth > 0 {
                // A child sits one step (14px) to the right of its parent folder's icon.
                assert_eq!(
                    super::super::tree_icon_x(depth, true)
                        - super::super::tree_icon_x(depth - 1, false),
                    super::super::TREE_STEP
                );
            }
        }
    }
}
