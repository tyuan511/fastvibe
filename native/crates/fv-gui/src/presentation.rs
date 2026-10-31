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
    layout_refs(&items.iter().collect::<Vec<_>>(), running)
}

/// Borrow projected tool items alongside the original prose/media without copying payloads.
pub fn layout_refs<'a>(items: &[&'a Item], running: bool) -> TurnLayout<'a> {
    let user = items
        .iter()
        .copied()
        .find(|i| matches!(i, Item::UserMessage { .. }));
    let rest: Vec<&Item> = items
        .iter()
        .copied()
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
    let changes = changed_files_iter(items.iter().copied());
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
    changed_files_iter(items.iter())
}

fn changed_files_iter<'a>(items: impl Iterator<Item = &'a Item>) -> Vec<FileChange> {
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
        if line == "*** End Patch" {
            current = None;
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
    Browser,
    Computer,
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
        "browser" => Family::Browser,
        "computer" => Family::Computer,
        "view_image" | "read" | "read_file" => Family::Read,
        "apply_patch" | "edit" | "write" | "write_file" | "edit_file" | "create_file" => {
            Family::Edit
        }
        "exec_command" | "write_stdin" | "bash" | "shell" => Family::Terminal,
        "web_search" => Family::Web,
        "tool_search" | "conversation_search" | "grep" | "grep_files" | "search" => Family::Search,
        "update_plan" => Family::Todo,
        "request_user_input" | "request_user_input_async" | "send_message_to_user_async" => {
            Family::Question
        }
        _ if key.starts_with("mcp")
            || key.contains("__")
            || [
                "list_mcp_resources",
                "list_mcp_resource_templates",
                "read_mcp_resource",
            ]
            .contains(&key.as_str()) =>
        {
            Family::Mcp
        }
        _ if key.contains("skill") => Family::Skill,
        _ if key.starts_with("spawn_agent")
            || key.starts_with("followup_task")
            || ["send_message", "send_input", "wait_agent", "close_agent"]
                .contains(&key.as_str())
            || key.starts_with("interrupt_agent")
            || key.starts_with("wait_agent")
            || key.starts_with("list_agents")
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
        Family::Browser => "globe02",
        Family::Computer => "computer",
        Family::Skill => "sparkles",
        Family::Agent => "bot",
        Family::Todo => "list-checks",
        Family::Question => "message-question",
        Family::Mcp => "plug01",
        Family::Present => "image01",
        Family::Other => "wrench01",
    }
}

/// A tool's actual file target, never a session id, URL, or search query.
pub fn tool_path(name: &str, args: &serde_json::Value) -> Option<String> {
    if name == "apply_patch" {
        let files = patch_changes(args.get("input")?.as_str()?);
        return (files.len() == 1).then(|| files[0].path.clone());
    }
    if !matches!(family_of(name), Family::Read | Family::Edit) {
        return None;
    }
    [
        "path",
        "file_path",
        "filePath",
        "filepath",
        "filename",
        "file",
        "target_file",
        "target",
    ]
    .into_iter()
    .filter_map(|key| args.get(key).and_then(|v| v.as_str()))
    .map(str::trim)
    .find(|path| !path.is_empty())
    .map(str::to_string)
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

pub fn describe(name: &str, args: &serde_json::Value, running: bool, english: bool) -> ToolView {
    let family = family_of(name);
    let field = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").trim();
    // A label is a done form and a live form, `tool.<key>` and `tool.<key>_live`.
    let label = |key: &'static str| -> String {
        let key = if running {
            format!("presentation.tool_{key}_live")
        } else {
            format!("presentation.tool_{key}")
        };
        crate::workspace::static_text(english, &key).to_string()
    };
    if name == "code_mode" {
        return ToolView {
            family,
            label: label("code_mode"),
            subject: "JavaScript".into(),
            context: String::new(),
        };
    }
    if name == "wait" {
        return ToolView {
            family,
            label: if args
                .get("terminate")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                label("wait_terminate")
            } else {
                label("wait")
            },
            subject: field("cell_id").chars().take(8).collect(),
            context: String::new(),
        };
    }
    let (label, subject, context) = match family {
        Family::Terminal => (
            label("terminal"),
            terminal_command(name, args).to_string(),
            String::new(),
        ),
        Family::Edit | Family::Read => {
            let path = tool_path(name, args);
            let (subject, context) = if let Some(path) = &path {
                let (name, directory) = split_path(path);
                (name.to_string(), directory.to_string())
            } else {
                let files = patch_changes(field("input"));
                if files.is_empty() {
                    (name.to_string(), String::new())
                } else {
                    (
                        tr!(english, "presentation.files", count = files.len()),
                        String::new(),
                    )
                }
            };
            (
                label(if family == Family::Read {
                    "read"
                } else {
                    "edit"
                }),
                subject,
                context,
            )
        }
        Family::Search => (
            label("search"),
            ["query", "pattern", "path"]
                .iter()
                .map(|k| field(k))
                .find(|v| !v.is_empty())
                .unwrap_or(name)
                .to_string(),
            String::new(),
        ),
        Family::Web => {
            let action = args.get("action").filter(|v| v.is_object()).unwrap_or(args);
            let subject = action
                .get("query")
                .or_else(|| action.get("url"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| {
                    action.get("queries").and_then(|v| v.as_array()).map(|v| {
                        v.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                })
                .unwrap_or_else(|| name.to_string());
            (label("web"), subject, String::new())
        }
        Family::Browser | Family::Computer => (
            label(if family == Family::Browser {
                "browser"
            } else {
                "computer"
            }),
            field("action").to_string(),
            field("url").to_string(),
        ),
        Family::Todo => (label("todo"), String::new(), String::new()),
        Family::Question => (label("question"), String::new(), String::new()),
        Family::Agent => (
            label("agent"),
            name.to_string(),
            field("target").to_string(),
        ),
        Family::Skill => (label("skill"), name.to_string(), String::new()),
        Family::Present => (label("present"), name.to_string(), String::new()),
        Family::Mcp => (label("mcp"), name.to_string(), String::new()),
        Family::Other => (label("other"), name.to_string(), String::new()),
    };
    ToolView {
        family,
        label,
        subject,
        context,
    }
}

/// The command argument as sent by native and compatibility terminal tools.
pub fn terminal_command<'a>(name: &'a str, args: &'a serde_json::Value) -> &'a str {
    args.as_str()
        .into_iter()
        .chain(
            ["command", "cmd", "script", "parsed_cmd"]
                .into_iter()
                .filter_map(|key| args.get(key).and_then(|v| v.as_str())),
        )
        .map(str::trim)
        .find(|text| !text.is_empty())
        .unwrap_or(name)
}

/// Remove only the shell's display wrapper; the inner script remains literal.
pub fn unwrap_shell_command(command: &str) -> &str {
    let command = command.trim();
    let Some(shell_end) = command.find(char::is_whitespace) else {
        return command;
    };
    let shell = command[..shell_end].to_ascii_lowercase();
    if !["sh", "bash", "zsh", "/bin/sh", "/bin/bash", "/bin/zsh"].contains(&shell.as_str()) {
        return command;
    }
    let rest = command[shell_end..].trim_start();
    let Some(script) = rest
        .strip_prefix("-lc")
        .filter(|s| s.starts_with(char::is_whitespace))
    else {
        return command;
    };
    let script = script.trim();
    if script.is_empty() {
        return command;
    }
    script
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .or_else(|| script.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
        .unwrap_or(script)
        .trim()
}

/// Match the transcript's 4,000 UTF-16-unit output cap without cutting a character.
pub fn terminal_output(output: &str) -> String {
    let output = output.trim();
    let mut units = 0;
    let end = output.char_indices().find_map(|(index, ch)| {
        units += ch.len_utf16();
        (units > 4000).then_some(index)
    });
    match end {
        Some(end) => format!("{}\n…", &output[..end]),
        None => output.to_string(),
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
/// as prose does, unless 折叠思考内容 (`collapse_thinking`) folds a finished one into the batch
/// it sits in — and only into a batch that has a call, so two lone thoughts keep their rows. A
/// thought still being written always stands on its own line. A part nobody would see (a blank
/// thought or reply) does not split anything.
pub fn fold_runs<'a>(
    items: &[&'a Item],
    streaming_tail: bool,
    collapse_thinking: bool,
) -> Vec<Part<'a>> {
    let mut out = Vec::new();
    let mut pending: Vec<&'a Item> = Vec::new();
    fn flush<'a>(pending: &mut Vec<&'a Item>, out: &mut Vec<Part<'a>>) {
        let calls = pending
            .iter()
            .filter(|i| matches!(i, Item::ToolCall { .. }))
            .count();
        if pending.len() > 1 && calls > 0 {
            out.push(Part::Run(std::mem::take(pending)));
        } else {
            out.extend(pending.drain(..).map(Part::Item));
        }
        pending.clear();
    }
    let last = items.len().saturating_sub(1);
    for (i, item) in items.iter().enumerate() {
        let live = streaming_tail && i == last;
        match item {
            Item::Reasoning { text, .. } if text.trim().is_empty() && !live => continue,
            Item::AgentMessage { text, .. } if text.trim().is_empty() && !live => continue,
            Item::ToolCall { name, output, .. }
                if output.is_some()
                    && !crate::terminal_transcript::active(item)
                    && folds_into_run(name) =>
            {
                pending.push(item);
            }
            Item::Reasoning { .. } if collapse_thinking && !live => pending.push(item),
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
    /// A file the call read or wrote.
    Path(String),
    /// A query or a tool name.
    Name(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Category {
    Think,
    Command,
    Read,
    Write,
    Search,
    Tool,
}

/// `runSummary`: each category once, in the order it first appeared; one call names the file or
/// query, several say how many; a failed call is not counted (its row says so when opened).
pub fn run_summary(items: &[&Item], english: bool) -> Vec<Piece> {
    let mut order: Vec<(Category, Vec<&Item>)> = Vec::new();
    for item in items {
        if matches!(item, Item::Reasoning { .. }) {
            match order.iter_mut().find(|(c, _)| *c == Category::Think) {
                Some((_, v)) => v.push(item),
                None => order.push((Category::Think, vec![item])),
            }
            continue;
        }
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
        if n > 0 {
            pieces.push(Piece::Text(
                trs!(english, "presentation.run_separator").into(),
            ));
        }
        // 「已」/ a capital covers the whole line: later clauses use the `_later` wording.
        let word = |base: &str| -> &'static str {
            let key = if n == 0 {
                format!("presentation.run_{base}")
            } else {
                format!("presentation.run_{base}_later")
            };
            crate::workspace::static_text(english, &key)
        };
        let counted = |base: &str| -> String {
            let key = if n == 0 {
                format!("presentation.run_{base}")
            } else {
                format!("presentation.run_{base}_later")
            };
            let template = crate::workspace::static_text(english, &key);
            template.replace("%{count}", &count.to_string())
        };
        let named = match (category, batch.as_slice()) {
            (Category::Command | Category::Think, _) => None,
            (
                _,
                [
                    Item::ToolCall {
                        name, arguments, ..
                    },
                ],
            ) => Some(describe(name, arguments, false, english).subject),
            _ => None,
        };
        match (category, named) {
            (Category::Think, _) => pieces.push(Piece::Text(counted(if count == 1 {
                "thought_one"
            } else {
                "thought"
            }))),
            (Category::Command, _) => {
                let base = if count == 1 { "ran_one" } else { "ran" };
                pieces.push(Piece::Text(counted(base)))
            }
            (Category::Read, Some(s)) => {
                pieces.push(Piece::Text(word("read_named").into()));
                pieces.push(Piece::Path(match batch.first() {
                    Some(Item::ToolCall {
                        name, arguments, ..
                    }) => tool_path(name, arguments).unwrap_or(s),
                    _ => s,
                }));
            }
            (Category::Read, None) => pieces.push(Piece::Text(counted("read"))),
            (Category::Write, Some(s)) => {
                pieces.push(Piece::Text(word("write_named").into()));
                pieces.push(Piece::Path(match batch.first() {
                    Some(Item::ToolCall {
                        name, arguments, ..
                    }) => tool_path(name, arguments).unwrap_or(s),
                    _ => s,
                }));
            }
            (Category::Write, None) => pieces.push(Piece::Text(counted("write"))),
            (Category::Search, Some(s)) => {
                pieces.push(Piece::Text(word("search_named").into()));
                pieces.push(Piece::Name(s));
            }
            (Category::Search, None) => pieces.push(Piece::Text(counted("search"))),
            (Category::Tool, Some(s)) => {
                pieces.push(Piece::Text(word("tool_named").into()));
                pieces.push(Piece::Name(s));
            }
            (Category::Tool, None) => pieces.push(Piece::Text(counted("tool"))),
        }
    }
    pieces
}

/// `3 分钟 41 秒` / `3m 41s`, the app's one duration format (`formatDuration` in `lib/time.ts`):
/// each unit that is not zero, and seconds whenever nothing else would be said.
pub fn format_duration(ms: u64, english: bool) -> String {
    let total = (ms + 500) / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    let mut parts = Vec::new();
    if h > 0 {
        parts.push(tr!(english, "presentation.duration_hours", n = h));
    }
    if m > 0 {
        parts.push(tr!(english, "presentation.duration_minutes", n = m));
    }
    if s > 0 || parts.is_empty() {
        parts.push(tr!(english, "presentation.duration_seconds", n = s));
    }
    parts.join(" ")
}
