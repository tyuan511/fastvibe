//! Keyboard navigation for the workspace file tree.
//!
//! The renderer owns GPUI elements and the pane owns directory loading. This module only owns the
//! tree's visible-row rules so rendering and keyboard handling can share one ordering without
//! reaching into either UI implementation.

use std::collections::HashSet;

/// A directory or file supplied by the pane. Children may be empty while a directory is loading.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeNode {
    pub path: String,
    pub is_directory: bool,
    pub children: Vec<TreeNode>,
}

impl TreeNode {
    pub fn file(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            is_directory: false,
            children: Vec::new(),
        }
    }

    pub fn directory(path: impl Into<String>, children: Vec<TreeNode>) -> Self {
        Self {
            path: path.into(),
            is_directory: true,
            children,
        }
    }
}

/// One row in the currently visible preorder traversal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisibleTreeRow {
    pub path: String,
    pub depth: usize,
    pub is_directory: bool,
    pub expanded: bool,
}

/// Keys the pane forwards after it has decided that the tree has focus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeKey {
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    Enter,
    Space,
}

/// The operation the pane performs after navigation resolves a key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TreeAction {
    Focus(String),
    Toggle(String),
    Open(String),
}

/// Flatten roots in display order. A directory is included even when its children are not loaded;
/// the caller can therefore focus and expand a row before the async listing arrives.
pub fn visible_rows(roots: &[TreeNode], expanded: &HashSet<String>) -> Vec<VisibleTreeRow> {
    let mut rows = Vec::new();
    for root in roots {
        append_visible(root, 0, expanded, &mut rows);
    }
    rows
}

fn append_visible(
    node: &TreeNode,
    depth: usize,
    expanded: &HashSet<String>,
    rows: &mut Vec<VisibleTreeRow>,
) {
    let is_expanded = node.is_directory && expanded.contains(&node.path);
    rows.push(VisibleTreeRow {
        path: node.path.clone(),
        depth,
        is_directory: node.is_directory,
        expanded: is_expanded,
    });
    if is_expanded {
        for child in &node.children {
            append_visible(child, depth + 1, expanded, rows);
        }
    }
}

/// Resolve one key against the visible rows. `focused` is a path, so a directory listing refresh
/// can preserve focus when that path still exists. When no row is focused, Down starts at the first
/// row and Up starts at the last row; the other keys are inert.
pub fn action_for_key(
    rows: &[VisibleTreeRow],
    focused: Option<&str>,
    key: TreeKey,
) -> Option<TreeAction> {
    if rows.is_empty() {
        return None;
    }
    let index = focused.and_then(|path| rows.iter().position(|row| row.path == path));
    match key {
        TreeKey::Home => Some(TreeAction::Focus(rows[0].path.clone())),
        TreeKey::End => Some(TreeAction::Focus(rows.last()?.path.clone())),
        TreeKey::Up => {
            let next = index.map_or(rows.len() - 1, |index| index.saturating_sub(1));
            Some(TreeAction::Focus(rows[next].path.clone()))
        }
        TreeKey::Down => {
            let next = index.map_or(0, |index| (index + 1).min(rows.len() - 1));
            Some(TreeAction::Focus(rows[next].path.clone()))
        }
        TreeKey::Left => {
            let row = &rows[index?];
            if row.is_directory && row.expanded {
                Some(TreeAction::Toggle(row.path.clone()))
            } else {
                rows[..index?]
                    .iter()
                    .rev()
                    .find(|candidate| {
                        candidate.is_directory
                            && row.path.starts_with(&format!("{}/", candidate.path))
                    })
                    .map(|candidate| TreeAction::Focus(candidate.path.clone()))
            }
        }
        TreeKey::Right => {
            let row = &rows[index?];
            if row.is_directory && !row.expanded {
                Some(TreeAction::Toggle(row.path.clone()))
            } else if row.is_directory && row.expanded {
                let next = rows.get(index? + 1)?;
                (next.depth == row.depth + 1 && next.path.starts_with(&format!("{}/", row.path)))
                    .then(|| TreeAction::Focus(next.path.clone()))
            } else {
                None
            }
        }
        TreeKey::Enter | TreeKey::Space => {
            let row = &rows[index?];
            if row.is_directory {
                Some(TreeAction::Toggle(row.path.clone()))
            } else if key == TreeKey::Enter {
                Some(TreeAction::Open(row.path.clone()))
            } else {
                None
            }
        }
    }
}

/// Keep focus coherent after a listing refresh. A removed descendant moves to its nearest visible
/// directory, then to the first visible row; an unfocused tree stays unfocused until navigation.
pub fn retain_focus(rows: &[VisibleTreeRow], focused: Option<&str>) -> Option<String> {
    let focused = focused?;
    if rows.iter().any(|row| row.path == focused) {
        return Some(focused.to_string());
    }
    rows.iter()
        .rev()
        .find(|row| row.is_directory && focused.starts_with(&format!("{}/", row.path)))
        .or_else(|| rows.first())
        .map(|row| row.path.clone())
}

#[cfg(test)]
mod tests {
    use super::{TreeAction, TreeKey, TreeNode, action_for_key, retain_focus, visible_rows};
    use std::collections::HashSet;

    fn tree() -> Vec<TreeNode> {
        vec![
            TreeNode::directory(
                "/repo/src",
                vec![
                    TreeNode::file("/repo/src/lib.rs"),
                    TreeNode::directory(
                        "/repo/src/ui",
                        vec![TreeNode::file("/repo/src/ui/app.rs")],
                    ),
                ],
            ),
            TreeNode::file("/repo/README.md"),
        ]
    }

    #[test]
    fn flattening_is_preorder_and_hides_closed_descendants() {
        let rows = visible_rows(&tree(), &HashSet::from(["/repo/src".into()]));
        assert_eq!(
            rows.iter().map(|row| row.path.as_str()).collect::<Vec<_>>(),
            [
                "/repo/src",
                "/repo/src/lib.rs",
                "/repo/src/ui",
                "/repo/README.md"
            ]
        );
        assert_eq!(rows[1].depth, 1);
        assert!(!rows[2].expanded);
    }

    #[test]
    fn keyboard_navigation_handles_expand_collapse_and_open() {
        let rows = visible_rows(&tree(), &HashSet::from(["/repo/src".into()]));
        assert_eq!(
            action_for_key(&rows, Some("/repo/src"), TreeKey::Down),
            Some(TreeAction::Focus("/repo/src/lib.rs".into()))
        );
        assert_eq!(
            action_for_key(&rows, Some("/repo/src/lib.rs"), TreeKey::Left),
            Some(TreeAction::Focus("/repo/src".into()))
        );
        assert_eq!(
            action_for_key(&rows, Some("/repo/src/lib.rs"), TreeKey::Enter),
            Some(TreeAction::Open("/repo/src/lib.rs".into()))
        );
        assert_eq!(
            action_for_key(&rows, Some("/repo/src"), TreeKey::Right),
            Some(TreeAction::Focus("/repo/src/lib.rs".into()))
        );
        assert_eq!(
            action_for_key(&rows, Some("/repo/src"), TreeKey::Space),
            Some(TreeAction::Toggle("/repo/src".into()))
        );
    }

    #[test]
    fn focus_survives_refresh_only_when_the_row_remains_visible() {
        let rows = visible_rows(&tree(), &HashSet::from(["/repo/src".into()]));
        assert_eq!(
            retain_focus(&rows, Some("/repo/src/ui")),
            Some("/repo/src/ui".into())
        );
        assert_eq!(
            retain_focus(&rows, Some("/repo/src/ui/app.rs")),
            Some("/repo/src/ui".into())
        );
        assert_eq!(
            retain_focus(&rows, Some("/repo/missing.txt")),
            Some("/repo/src".into())
        );
    }
}
