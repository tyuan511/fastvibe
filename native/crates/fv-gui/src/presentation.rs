//! How a turn is laid out on screen, worked out from its items alone (no window code, so it
//! is testable). The rules are the Electron transcript's:
//!
//! - A settled turn that thought or called tools and then answered folds the process behind
//!   one "用时 …" row; the answer after the last process item stays on screen.
//! - A turn still running, one that stopped on a tool call, and a failed one show everything.
//! - The files a turn changed are listed once, under the answer.

use fv_protocol::types::Item;

/// One file a turn's patches touched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, PartialEq)]
pub struct TurnLayout<'a> {
    pub user: Option<&'a Item>,
    /// Shown before the fold (nothing, today: kept for a model switch divider).
    pub head: Vec<&'a Item>,
    /// Folded behind "用时 …" when `folded` is true, else shown in place.
    pub process: Vec<&'a Item>,
    pub answer: Vec<&'a Item>,
    pub folded: bool,
    pub changes: Vec<FileChange>,
}

fn is_process(item: &Item) -> bool {
    matches!(item, Item::Reasoning { .. } | Item::ToolCall { .. })
}

fn reads_as_answer(item: &Item) -> bool {
    matches!(item, Item::AgentMessage { text, .. } if !text.trim().is_empty())
}

pub fn layout(items: &[Item], running: bool) -> TurnLayout<'_> {
    let user = items.iter().find(|i| matches!(i, Item::UserMessage { .. }));
    let rest: Vec<&Item> = items
        .iter()
        .filter(|i| !matches!(i, Item::UserMessage { .. }))
        .collect();
    let cut = rest.iter().rposition(|i| is_process(i)).map(|i| i + 1);
    let failed = rest.iter().any(|i| matches!(i, Item::Error { .. }));
    let (process, answer) = match cut {
        Some(cut) => (rest[..cut].to_vec(), rest[cut..].to_vec()),
        None => (Vec::new(), rest.clone()),
    };
    let folded =
        !running && !failed && !process.is_empty() && answer.iter().any(|i| reads_as_answer(i));
    let changes = changed_files(items);
    if folded {
        TurnLayout {
            user,
            head: Vec::new(),
            process,
            answer,
            folded,
            changes,
        }
    } else {
        TurnLayout {
            user,
            head: Vec::new(),
            process: Vec::new(),
            answer: rest,
            folded,
            changes,
        }
    }
}

/// The files the turn's `apply_patch` calls changed, in first-touched order, with the lines
/// each added and removed. A failed call changed nothing.
pub fn changed_files(items: &[Item]) -> Vec<FileChange> {
    let mut out: Vec<FileChange> = Vec::new();
    for item in items {
        let Item::ToolCall {
            name,
            arguments,
            is_error,
            output,
            ..
        } = item
        else {
            continue;
        };
        if name != "apply_patch" || *is_error || output.is_none() {
            continue;
        }
        let Some(patch) = arguments.get("input").and_then(|v| v.as_str()) else {
            continue;
        };
        for change in patch_changes(patch) {
            match out.iter_mut().find(|c| c.path == change.path) {
                Some(c) => {
                    c.added += change.added;
                    c.removed += change.removed;
                }
                None => out.push(change),
            }
        }
    }
    out
}

/// Parse codex's patch format into per-file line counts.
pub fn patch_changes(patch: &str) -> Vec<FileChange> {
    let mut out: Vec<FileChange> = Vec::new();
    let mut current: Option<usize> = None;
    let mut adding_whole_file = false;
    for line in patch.lines() {
        let header = ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
            .iter()
            .find_map(|h| line.strip_prefix(h).map(|p| (*h, p.trim())));
        if let Some((kind, path)) = header {
            out.push(FileChange {
                path: path.to_string(),
                added: 0,
                removed: 0,
            });
            current = Some(out.len() - 1);
            adding_whole_file = kind == "*** Add File: ";
            continue;
        }
        if let Some(to) = line.strip_prefix("*** Move to: ")
            && let Some(i) = current
        {
            out[i].path = to.trim().to_string();
            continue;
        }
        if line.starts_with("***") || line.starts_with("@@") {
            continue;
        }
        let Some(i) = current else { continue };
        if line.starts_with('+') {
            out[i].added += 1;
        } else if line.starts_with('-') && !adding_whole_file {
            out[i].removed += 1;
        }
    }
    out
}

/// `name` and the directory it is in, split the way the Electron file rows show them.
pub fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[i + 1..], &path[..i]),
        None => (path, ""),
    }
}

/// The one-line description of a tool call, as the transcript's collapsed row says it.
pub fn tool_title(name: &str, args: &serde_json::Value, running: bool) -> (String, String) {
    let field = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let verb = |done: &str, live: &str| if running { live } else { done }.to_string();
    match name {
        "exec_command" => (
            verb("已运行", "正在运行"),
            field("cmd").lines().next().unwrap_or("").to_string(),
        ),
        "apply_patch" => {
            let files = patch_changes(field("input"));
            let detail = match files.as_slice() {
                [one] => split_path(&one.path).0.to_string(),
                many => format!("{} 个文件", many.len()),
            };
            (verb("已编辑", "正在编辑"), detail)
        }
        "view_image" => (
            verb("已查看", "正在查看"),
            split_path(field("path")).0.to_string(),
        ),
        "update_plan" => (verb("已更新计划", "正在更新计划"), String::new()),
        "request_user_input" => (verb("已提问", "正在提问"), String::new()),
        "tool_search" => (
            verb("已搜索工具", "正在搜索工具"),
            field("query").to_string(),
        ),
        other => (verb("已调用", "正在调用"), other.to_string()),
    }
}

/// `3 分钟 41 秒`, the app's one duration format (`formatDuration` in `lib/time.ts`): each
/// unit that is not zero, and seconds whenever nothing else would be said.
pub fn format_duration(ms: u64) -> String {
    let total = (ms + 500) / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    let mut parts = Vec::new();
    if h > 0 {
        parts.push(format!("{h} 小时"));
    }
    if m > 0 {
        parts.push(format!("{m} 分钟"));
    }
    if s > 0 || parts.is_empty() {
        parts.push(format!("{s} 秒"));
    }
    parts.join(" ")
}
