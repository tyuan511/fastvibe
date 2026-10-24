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

/// Which kind of tool a call is, from its name alone (`familyOf` in `tool-family.ts`, over
/// the tool names the native engine has).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Read,
    Edit,
    Terminal,
    Search,
    Web,
    Skill,
    Agent,
    Todo,
    Question,
    Mcp,
    Present,
    Other,
}

pub fn family_of(name: &str) -> Family {
    let key = name.trim().to_lowercase();
    match key.as_str() {
        "present" => Family::Present,
        "view_image" | "read" | "read_file" => Family::Read,
        "apply_patch" | "edit" | "write" => Family::Edit,
        "exec_command" | "write_stdin" | "bash" | "shell" => Family::Terminal,
        "web_search" => Family::Web,
        "tool_search" | "conversation_search" | "grep" | "search" => Family::Search,
        "update_plan" => Family::Todo,
        "request_user_input" => Family::Question,
        _ if key.starts_with("mcp") || key.contains("__") => Family::Mcp,
        _ if key.contains("skill") => Family::Skill,
        _ if key.starts_with("spawn_agent")
            || key.starts_with("send_input")
            || key.starts_with("wait_agent")
            || key.starts_with("close_agent")
            || key.starts_with("resume_agent")
            || key.starts_with("subagent") =>
        {
            Family::Agent
        }
        _ => Family::Other,
    }
}

/// The Hugeicons glyph a family's row opens with.
pub fn family_icon(f: Family, edits_file: bool) -> &'static str {
    match f {
        Family::Read => "file-text",
        Family::Edit if edits_file => "file-edit",
        Family::Edit => "file-edit",
        Family::Terminal => "square-terminal",
        Family::Search | Family::Web => "search01",
        Family::Skill => "sparkles",
        Family::Agent => "bot",
        Family::Todo => "list-checks",
        Family::Question => "message-question",
        Family::Mcp => "plug01",
        Family::Present => "image01",
        Family::Other => "wrench01",
    }
}

/// A call's row, as `describeTool` makes it: a category label, what it acted on, and a muted
/// context after that.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolView {
    pub family: Family,
    pub label: String,
    pub subject: String,
    pub context: String,
}

pub fn describe(name: &str, args: &serde_json::Value, running: bool) -> ToolView {
    let family = family_of(name);
    let field = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").trim();
    let label = |done: &str, live: &str| if running { live } else { done }.to_string();
    let (label, subject, context) = match family {
        Family::Terminal => (
            label("终端", "正在执行"),
            field("cmd").lines().next().unwrap_or(name).to_string(),
            String::new(),
        ),
        Family::Edit => {
            let files = patch_changes(field("input"));
            let (subject, context) = match files.as_slice() {
                [one] => {
                    let (n, d) = split_path(&one.path);
                    (n.to_string(), d.to_string())
                }
                [] => (name.to_string(), String::new()),
                many => (format!("{} 个文件", many.len()), String::new()),
            };
            (label("编辑", "正在编辑"), subject, context)
        }
        Family::Read => {
            let (n, d) = split_path(field("path"));
            (
                label("读取", "正在读取"),
                if n.is_empty() {
                    name.to_string()
                } else {
                    n.to_string()
                },
                d.to_string(),
            )
        }
        Family::Search => (
            label("搜索", "正在搜索"),
            ["query", "pattern", "path"]
                .iter()
                .map(|k| field(k))
                .find(|v| !v.is_empty())
                .unwrap_or(name)
                .to_string(),
            String::new(),
        ),
        Family::Web => (
            label("网络搜索", "正在搜索网页"),
            if field("query").is_empty() {
                name.to_string()
            } else {
                field("query").to_string()
            },
            String::new(),
        ),
        Family::Todo => (label("待办", "正在更新待办"), String::new(), String::new()),
        Family::Question => (label("询问", "正在询问"), String::new(), String::new()),
        Family::Agent => (
            label("子智能体", "子智能体运行中"),
            name.to_string(),
            String::new(),
        ),
        Family::Skill => (
            label("技能", "正在运行技能"),
            name.to_string(),
            String::new(),
        ),
        Family::Present => (label("展示", "正在展示"), name.to_string(), String::new()),
        Family::Mcp => (
            label("工具调用", "正在调用"),
            name.to_string(),
            String::new(),
        ),
        Family::Other => (
            label("工具调用", "正在运行"),
            name.to_string(),
            String::new(),
        ),
    };
    ToolView {
        family,
        label,
        subject,
        context,
    }
}

/// What stays on its own line and breaks a run of tool calls.
fn folds_into_run(name: &str) -> bool {
    !matches!(
        family_of(name),
        Family::Question | Family::Todo | Family::Agent | Family::Present
    ) && !name.starts_with("dag_")
}

/// One stretch of a turn's process: a lone item, or several settled calls folded into a row.
#[derive(Debug, PartialEq)]
pub enum Part<'a> {
    Item(&'a Item),
    Run(Vec<&'a Item>),
}

/// `collapseToolRuns`: consecutive settled calls between two stretches of prose fold into one
/// row. A call still running stands on its own below the fold (and breaks the batch), so the
/// row only ever counts what has landed; a single call stays a row. A thought splits the batch
/// as prose does (folding thoughts in is a setting this app does not have). A part nobody
/// would see (a blank thought or reply) does not split anything.
pub fn fold_runs<'a>(items: &[&'a Item], streaming_tail: bool) -> Vec<Part<'a>> {
    let mut out = Vec::new();
    let mut pending: Vec<&'a Item> = Vec::new();
    fn flush<'a>(pending: &mut Vec<&'a Item>, out: &mut Vec<Part<'a>>) {
        match pending.len() {
            0 => {}
            1 => out.push(Part::Item(pending[0])),
            _ => out.push(Part::Run(std::mem::take(pending))),
        }
        pending.clear();
    }
    let last = items.len().saturating_sub(1);
    for (i, item) in items.iter().enumerate() {
        let live = streaming_tail && i == last;
        match item {
            Item::Reasoning { text, .. } if text.trim().is_empty() && !live => continue,
            Item::AgentMessage { text, .. } if text.trim().is_empty() && !live => continue,
            Item::ToolCall { name, output, .. } if output.is_some() && folds_into_run(name) => {
                pending.push(item);
            }
            other => {
                flush(&mut pending, &mut out);
                out.push(Part::Item(other));
            }
        }
    }
    flush(&mut pending, &mut out);
    out
}

/// A piece of a folded row's settled line: plain words, or the name of a file / query.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Piece {
    Text(String),
    Name(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Category {
    Command,
    Read,
    Write,
    Search,
    Tool,
}

/// `runSummary`: each category once, in the order it first appeared; one call names the file or
/// query, several say how many; a failed call is not counted (its row says so when opened).
pub fn run_summary(items: &[&Item]) -> Vec<Piece> {
    let mut order: Vec<(Category, Vec<&Item>)> = Vec::new();
    for item in items {
        let Item::ToolCall { name, is_error, .. } = item else {
            continue;
        };
        if *is_error {
            continue;
        }
        let category = match family_of(name) {
            Family::Terminal => Category::Command,
            Family::Read => Category::Read,
            Family::Edit => Category::Write,
            Family::Search | Family::Web => Category::Search,
            _ => Category::Tool,
        };
        match order.iter_mut().find(|(c, _)| *c == category) {
            Some((_, v)) => v.push(item),
            None => order.push((category, vec![item])),
        }
    }
    let mut pieces = Vec::new();
    for (n, (category, batch)) in order.iter().enumerate() {
        let count = batch.len();
        // 「已」covers the whole line: later clauses leave it off.
        let lead = |s: &str| {
            if n == 0 {
                s.to_string()
            } else {
                s.trim_start_matches('已').to_string()
            }
        };
        if n > 0 {
            pieces.push(Piece::Text("，".into()));
        }
        let named = match (category, batch.as_slice()) {
            (Category::Command, _) => None,
            (
                _,
                [
                    Item::ToolCall {
                        name, arguments, ..
                    },
                ],
            ) => {
                let v = describe(name, arguments, false);
                Some(v.subject)
            }
            _ => None,
        };
        match (category, named) {
            (Category::Command, _) => {
                pieces.push(Piece::Text(lead(&format!("已运行 {count} 个命令"))))
            }
            (Category::Read, Some(s)) => {
                pieces.push(Piece::Text(lead("已读取 ")));
                pieces.push(Piece::Name(s));
            }
            (Category::Read, None) => {
                pieces.push(Piece::Text(lead(&format!("已读取 {count} 个文件"))))
            }
            (Category::Write, Some(s)) => {
                pieces.push(Piece::Text(lead("已写入 ")));
                pieces.push(Piece::Name(s));
            }
            (Category::Write, None) => {
                pieces.push(Piece::Text(lead(&format!("已写入 {count} 个文件"))))
            }
            (Category::Search, Some(s)) => {
                pieces.push(Piece::Text(lead("已搜索 ")));
                pieces.push(Piece::Name(s));
            }
            (Category::Search, None) => {
                pieces.push(Piece::Text(lead(&format!("已搜索 {count} 次"))))
            }
            (Category::Tool, Some(s)) => {
                pieces.push(Piece::Text(lead("已调用 ")));
                pieces.push(Piece::Name(s));
            }
            (Category::Tool, None) => {
                pieces.push(Piece::Text(lead(&format!("已调用 {count} 个工具"))))
            }
        }
    }
    pieces
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
