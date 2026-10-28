//! Read-only import adapters for conversations written by other coding agents.
//!
//! Adapters deliberately stop at FastVibe's engine messages. Persistence, catalog registration,
//! duplicate detection and UI selection remain separate so a scan can never mutate a source.

use fv_core::{AssistantMessage, ContentBlock, Message, StopReason, Usage};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub source: String,
    pub source_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImportedSession {
    pub candidate: Candidate,
    pub messages: Vec<Message>,
    pub timestamps: Vec<i64>,
    pub skipped: Vec<String>,
}

#[derive(Debug)]
pub enum ImportError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    InvalidPath(String),
}
impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::Sqlite(e) => write!(f, "{e}"),
            Self::InvalidPath(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for ImportError {}
impl From<std::io::Error> for ImportError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<rusqlite::Error> for ImportError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// Scan Claude Code's `projects/*/*.jsonl` files without parsing full transcripts.
pub fn scan_claude(root: &Path) -> Result<Vec<Candidate>, ImportError> {
    let mut out = Vec::new();
    let dirs = match std::fs::read_dir(root) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for dir in dirs
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    {
        for file in std::fs::read_dir(dir.path())?.flatten() {
            let path = file.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(candidate) = summarize_claude(&path)? {
                out.push(candidate);
            }
        }
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.updated_at));
    Ok(out)
}

fn summarize_claude(path: &Path) -> Result<Option<Candidate>, ImportError> {
    let meta = std::fs::metadata(path)?;
    let mut cwd = None;
    let mut title = None;
    let mut first_user = None;
    let mut created = 0;
    let mut updated = 0;
    let mut count = 0;
    for value in lines(path)? {
        let Ok(value) = value else { continue };
        let typ = value.get("type").and_then(Value::as_str).unwrap_or("");
        let at = timestamp(value.get("timestamp"));
        if created == 0 && at > 0 {
            created = at;
        }
        updated = updated.max(at);
        if cwd.is_none() {
            cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        if typ == "custom-title" {
            title = value
                .get("customTitle")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if typ == "user" && value.get("isMeta").and_then(Value::as_bool) != Some(true) {
            let text = message_text(
                value
                    .get("message")
                    .and_then(Value::as_object)
                    .and_then(|m| m.get("content")),
            );
            if !text.trim().is_empty() && first_user.is_none() {
                first_user = Some(text);
            }
            count += 1;
        } else if typ == "assistant"
            && value.get("isSidechain").and_then(Value::as_bool) != Some(true)
        {
            count += 1;
        }
    }
    let source_id = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string();
    Some(Candidate {
        source: "claude-code".into(),
        source_id,
        title: title.or(first_user).unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        }),
        cwd,
        created_at: created,
        updated_at: updated.max(
            meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        ),
        message_count: count,
        bytes: meta.len(),
    })
    .filter(|c| c.message_count > 0)
    .map(Ok)
    .transpose()
}

/// Read one Claude Code JSONL transcript and translate only conversation-bearing entries.
pub fn read_claude(path: &Path) -> Result<ImportedSession, ImportError> {
    let candidate = summarize_claude(path)?
        .ok_or_else(|| ImportError::InvalidPath("no conversation entries".into()))?;
    let mut messages = Vec::new();
    let mut timestamps = Vec::new();
    let mut skipped = Vec::new();
    let mut assistant_by_id: HashMap<String, usize> = HashMap::new();
    for value in lines(path)? {
        let Ok(value) = value else {
            skipped.push("invalid JSON line".into());
            continue;
        };
        let typ = value.get("type").and_then(Value::as_str).unwrap_or("");
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            skipped.push("sidechain item".into());
            continue;
        }
        let message = value.get("message").and_then(Value::as_object);
        match typ {
            "user" if value.get("isMeta").and_then(Value::as_bool) != Some(true) => {
                let content = message.and_then(|m| m.get("content"));
                let mut text = message_text(content);
                let mut results = Vec::new();
                if let Some(parts) = content.and_then(Value::as_array) {
                    for part in parts.iter().filter_map(Value::as_object) {
                        if part.get("type").and_then(Value::as_str) == Some("tool_result") {
                            let call_id = part
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or("imported-call");
                            results.push(Message::ToolResult {
                                call_id: call_id.into(),
                                name: "imported_tool".into(),
                                content: tool_result_text(part.get("content")),
                                is_error: part
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            });
                        }
                    }
                }
                text = strip_synthetic(&text);
                if !text.trim().is_empty() {
                    messages.push(Message::User { text });
                    timestamps.push(timestamp(value.get("timestamp")));
                }
                for result in results {
                    messages.push(result);
                    timestamps.push(timestamp(value.get("timestamp")));
                }
            }
            "assistant" => {
                let Some(message) = message else { continue };
                let id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let index = if id.is_empty() {
                    messages.len()
                } else if let Some(index) = assistant_by_id.get(&id) {
                    *index
                } else {
                    let index = messages.len();
                    messages.push(Message::Assistant(AssistantMessage {
                        duration_ms: None,
                        content: Vec::new(),
                        stop: StopReason::Stop,
                        usage: usage(message.get("usage")),
                        model: message
                            .get("model")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }));
                    timestamps.push(timestamp(value.get("timestamp")));
                    if !id.is_empty() {
                        assistant_by_id.insert(id, index);
                    }
                    index
                };
                let Message::Assistant(assistant) = &mut messages[index] else {
                    continue;
                };
                for part in message
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_object)
                {
                    match part.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                assistant
                                    .content
                                    .push(ContentBlock::Text { text: text.into() });
                            }
                        }
                        Some("thinking") => {
                            if let Some(text) = part.get("thinking").and_then(Value::as_str) {
                                assistant.content.push(ContentBlock::Thinking {
                                    text: text.into(),
                                    signature: None,
                                });
                            }
                        }
                        Some("tool_use") => assistant.content.push(ContentBlock::ToolCall {
                            id: part
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("imported-call")
                                .into(),
                            name: part
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("imported_tool")
                                .into(),
                            arguments: part
                                .get("input")
                                .cloned()
                                .unwrap_or(Value::Object(Default::default())),
                        }),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(ImportedSession {
        candidate,
        messages,
        timestamps,
        skipped,
    })
}

/// Scan pi coding agent's `<encoded-cwd>/*.jsonl` session files.
pub fn scan_pi(root: &Path) -> Result<Vec<Candidate>, ImportError> {
    let mut out = Vec::new();
    let dirs = match std::fs::read_dir(root) {
        Ok(dirs) => dirs,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(error) => return Err(error.into()),
    };
    for dir in dirs
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
    {
        for file in std::fs::read_dir(dir.path())?.flatten() {
            let path = file.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(candidate) = summarize_pi(&path)? {
                out.push(candidate);
            }
        }
    }
    out.sort_by_key(|candidate| std::cmp::Reverse(candidate.updated_at));
    Ok(out)
}

/// Read a pi transcript and convert visible messages into the engine model.
pub fn read_pi(path: &Path) -> Result<ImportedSession, ImportError> {
    let candidate = summarize_pi(path)?
        .ok_or_else(|| ImportError::InvalidPath("no pi conversation entries".into()))?;
    let mut messages = Vec::new();
    let mut timestamps = Vec::new();
    let mut skipped = Vec::new();
    let mut model = None;
    let mut tool_names: HashMap<String, String> = HashMap::new();
    for value in lines(path)? {
        let Ok(value) = value else {
            skipped.push("invalid JSON line".into());
            continue;
        };
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let at = timestamp(value.get("timestamp"));
        match kind {
            "session" | "session_info" | "thinking_level_change" | "label" => {}
            "model_change" => {
                model = value
                    .get("modelId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            "compaction" | "branch_summary" => skipped.push(format!("skipped {kind}")),
            "custom" | "custom_message" => {
                let text = strip_synthetic(&message_text(value.get("content")));
                if !text.is_empty() {
                    messages.push(Message::User { text });
                    timestamps.push(at);
                }
            }
            "message" => {
                let Some(message) = value.get("message").and_then(Value::as_object) else {
                    continue;
                };
                match message.get("role").and_then(Value::as_str) {
                    Some("user") => {
                        let text = strip_synthetic(&message_text(message.get("content")));
                        if !text.is_empty() {
                            messages.push(Message::User { text });
                            timestamps.push(at);
                        }
                    }
                    Some("toolResult") => {
                        let call_id = message
                            .get("toolCallId")
                            .and_then(Value::as_str)
                            .unwrap_or("imported-call");
                        messages.push(Message::ToolResult {
                            call_id: call_id.into(),
                            name: message
                                .get("toolName")
                                .and_then(Value::as_str)
                                .or_else(|| tool_names.get(call_id).map(String::as_str))
                                .unwrap_or("imported_tool")
                                .into(),
                            content: tool_result_text(message.get("content")),
                            is_error: message
                                .get("isError")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        });
                        timestamps.push(at);
                    }
                    Some("assistant") => {
                        let mut content = Vec::new();
                        for part in message
                            .get("content")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_object)
                        {
                            match part.get("type").and_then(Value::as_str) {
                                Some("thinking") => {
                                    if let Some(text) = part
                                        .get("thinking")
                                        .and_then(Value::as_str)
                                        .or_else(|| part.get("text").and_then(Value::as_str))
                                    {
                                        content.push(ContentBlock::Thinking {
                                            text: text.into(),
                                            signature: None,
                                        });
                                    }
                                }
                                Some("text") => {
                                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                                        content.push(ContentBlock::Text { text: text.into() });
                                    }
                                }
                                Some("toolCall") | Some("tool_use") => {
                                    let id = part
                                        .get("id")
                                        .or_else(|| part.get("toolCallId"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("imported-call")
                                        .to_string();
                                    let name = part
                                        .get("name")
                                        .or_else(|| part.get("toolName"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("imported_tool")
                                        .to_string();
                                    tool_names.insert(id.clone(), name.clone());
                                    content.push(ContentBlock::ToolCall {
                                        id,
                                        name,
                                        arguments: part
                                            .get("arguments")
                                            .or_else(|| part.get("input"))
                                            .cloned()
                                            .unwrap_or(Value::Object(Default::default())),
                                    });
                                }
                                _ => {}
                            }
                        }
                        let usage = usage(message.get("usage"));
                        messages.push(Message::Assistant(AssistantMessage {
                            duration_ms: None,
                            content,
                            stop: StopReason::Stop,
                            usage,
                            model: message
                                .get("model")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .or_else(|| model.clone()),
                        }));
                        timestamps.push(at);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    Ok(ImportedSession {
        candidate,
        messages,
        timestamps,
        skipped,
    })
}

/// Scan Codex CLI rollout files below `sessions/` and `archived_sessions/`.
pub fn scan_codex(root: &Path) -> Result<Vec<Candidate>, ImportError> {
    let mut files = Vec::new();
    collect_jsonl(root, &mut files)?;
    let mut candidates = Vec::new();
    for path in files {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-"))
            && let Some(candidate) = summarize_codex(&path)?
        {
            candidates.push(candidate);
        }
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.updated_at));
    Ok(candidates)
}

pub fn read_codex(path: &Path) -> Result<ImportedSession, ImportError> {
    let candidate = summarize_codex(path)?
        .ok_or_else(|| ImportError::InvalidPath("no Codex conversation entries".into()))?;
    let mut messages = Vec::new();
    let mut timestamps = Vec::new();
    let mut skipped = Vec::new();
    let mut pending_thinking = Vec::new();
    let mut model = None;
    for value in lines(path)? {
        let Ok(value) = value else {
            skipped.push("invalid JSON line".into());
            continue;
        };
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let at = timestamp(value.get("timestamp"));
        if kind == "session_meta" || kind == "turn_context" || kind == "world_state" {
            if kind == "turn_context" {
                model = value
                    .get("payload")
                    .and_then(|payload| payload.get("model"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(model);
            }
            continue;
        }
        if kind == "event_msg" {
            let payload = value.get("payload");
            let event_kind = payload
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str);
            if event_kind == Some("token_count")
                && let Some(last) = payload
                    .and_then(|payload| payload.get("info"))
                    .and_then(|info| info.get("last_token_usage"))
            {
                let usage_value = Usage {
                    input_tokens: last
                        .get("input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    output_tokens: last
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    cache_read_tokens: last
                        .get("cached_input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    cache_write_tokens: last
                        .get("cache_write_input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                };
                if let Some(Message::Assistant(assistant)) = messages
                    .iter_mut()
                    .rev()
                    .find(|message| matches!(message, Message::Assistant(_)))
                {
                    assistant.usage = usage_value;
                }
            }
            continue;
        }
        if matches!(
            kind,
            "compacted" | "context_compacted" | "token_usage_record"
        ) {
            skipped.push(format!("skipped {kind}"));
            continue;
        }
        if kind != "response_item" {
            continue;
        }
        let Some(payload) = value.get("payload").and_then(Value::as_object) else {
            continue;
        };
        let item_kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match item_kind {
            "message" => match payload.get("role").and_then(Value::as_str) {
                Some("user") => {
                    let text = message_text(payload.get("content"));
                    if text.trim().is_empty() || is_codex_injected(&text) {
                        if !text.trim().is_empty() {
                            skipped.push("injected user message".into());
                        }
                        continue;
                    }
                    pending_thinking.clear();
                    messages.push(Message::User { text });
                    timestamps.push(at);
                }
                Some("assistant") => {
                    let text = message_text(payload.get("content"));
                    let mut content = pending_thinking
                        .drain(..)
                        .map(|text| ContentBlock::Thinking {
                            text,
                            signature: None,
                        })
                        .collect::<Vec<_>>();
                    if !text.trim().is_empty() {
                        content.push(ContentBlock::Text { text });
                    }
                    if !content.is_empty() {
                        messages.push(Message::Assistant(AssistantMessage {
                            duration_ms: None,
                            content,
                            stop: StopReason::Stop,
                            usage: Usage::default(),
                            model: payload
                                .get("model")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .or_else(|| model.clone()),
                        }));
                        timestamps.push(at);
                    }
                }
                _ => skipped.push("system/developer message".into()),
            },
            "reasoning" => {
                if let Some(summary) = payload.get("summary") {
                    let text = message_text(Some(summary));
                    if !text.trim().is_empty() {
                        pending_thinking.push(text);
                    }
                }
            }
            "function_call" | "custom_tool_call" => {
                let id = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("imported-call");
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("imported_tool");
                let arguments = payload
                    .get("arguments")
                    .or_else(|| payload.get("input"))
                    .cloned()
                    .and_then(|value| {
                        value
                            .as_str()
                            .map(|text| {
                                serde_json::from_str(text).unwrap_or(Value::String(text.into()))
                            })
                            .or(Some(value))
                    })
                    .unwrap_or(Value::Object(Default::default()));
                messages.push(Message::Assistant(AssistantMessage {
                    duration_ms: None,
                    content: vec![ContentBlock::ToolCall {
                        id: id.into(),
                        name: name.into(),
                        arguments,
                    }],
                    stop: StopReason::ToolUse,
                    usage: Usage::default(),
                    model: model.clone(),
                }));
                timestamps.push(at);
            }
            "function_call_output" | "custom_tool_call_output" => {
                let id = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("imported-call");
                messages.push(Message::ToolResult {
                    call_id: id.into(),
                    name: "imported_tool".into(),
                    content: tool_result_text(payload.get("output")),
                    is_error: false,
                });
                timestamps.push(at);
            }
            _ => skipped.push(format!("unknown response item {item_kind}")),
        }
    }
    Ok(ImportedSession {
        candidate,
        messages,
        timestamps,
        skipped,
    })
}

/// Which store an opencode-shaped SQLite database belongs to. Both keep `session` /
/// `message` / `part` with each row's content as JSON text in `data`, and **neither has a
/// `role` column** — the role lives inside that JSON, so every query below reads it with
/// `json_extract` instead of naming a column the store does not have.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SqliteStore {
    Opencode,
    Zcode,
}

impl SqliteStore {
    fn source(self) -> &'static str {
        match self {
            Self::Opencode => "opencode",
            Self::Zcode => "zcode",
        }
    }
}

/// One `message` row with the `part` rows that belong to it.
struct RawMessage {
    at: i64,
    duration_ms: Option<u64>,
    data: Value,
    parts: Vec<Value>,
}

/// What one store's reader produced, before it becomes an [`ImportedSession`].
struct Assembled {
    messages: Vec<Message>,
    timestamps: Vec<i64>,
    skipped: Vec<String>,
    title: String,
}

#[derive(Default)]
struct SkippedCounts {
    system_prompts: usize,
    system_messages: usize,
    synthetic: usize,
    injected: usize,
    hidden: usize,
    structural: usize,
    compaction: usize,
    patch: usize,
    files: usize,
    subtask: usize,
    agent: usize,
    empty_user: usize,
    empty_assistant: usize,
    unknown: usize,
}

/// Scan the current OpenCode SQLite store. The database is opened read-only while OpenCode may
/// still be running; a locked or missing store simply produces no candidates.
pub fn scan_opencode(db_path: &Path) -> Result<Vec<Candidate>, ImportError> {
    scan_sqlite_store(db_path, SqliteStore::Opencode)
}

pub fn read_opencode(db_path: &Path, session_id: &str) -> Result<ImportedSession, ImportError> {
    read_sqlite_store(db_path, session_id, SqliteStore::Opencode)
}

/// zcode uses the same session/message/part SQLite shape as OpenCode, with two differences that
/// matter: `sequence` is the real order (zcode backfills `time_created` when it rewrites a
/// message), and `semantics.transcriptVisibility` says which messages the user actually saw.
pub fn scan_zcode(db_path: &Path) -> Result<Vec<Candidate>, ImportError> {
    scan_sqlite_store(db_path, SqliteStore::Zcode)
}

pub fn read_zcode(db_path: &Path, session_id: &str) -> Result<ImportedSession, ImportError> {
    read_sqlite_store(db_path, session_id, SqliteStore::Zcode)
}

fn scan_sqlite_store(db_path: &Path, store: SqliteStore) -> Result<Vec<Candidate>, ImportError> {
    if !db_path.is_file() {
        return Ok(Vec::new());
    }
    let connection = match open_import_db(db_path) {
        Ok(connection) => connection,
        Err(_) => return Ok(Vec::new()),
    };
    let counts = message_counts(&connection, store)?;
    let mut query = connection.prepare(
        "SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC",
    )?;
    let mut candidates = Vec::new();
    for row in query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })? {
        let (id, title, cwd, created, updated) = row?;
        let message_count = counts.get(&id).copied().unwrap_or(0);
        if message_count == 0 {
            continue;
        }
        candidates.push(Candidate {
            source: store.source().into(),
            source_id: id.clone(),
            title: title.filter(|title| !title.trim().is_empty()).unwrap_or(id),
            cwd,
            created_at: sql_time(created),
            updated_at: sql_time(updated),
            message_count,
            bytes: 0,
        });
    }
    Ok(candidates)
}

/// How many messages a session would actually import, per session.
fn message_counts(
    connection: &rusqlite::Connection,
    store: SqliteStore,
) -> Result<HashMap<String, usize>, ImportError> {
    let mut counts = HashMap::new();
    match store {
        // Every row of an OpenCode `message` table is a user or assistant message, so the plain
        // group count is exact and answers from the session index.
        SqliteStore::Opencode => {
            let mut query = connection
                .prepare("SELECT session_id, COUNT(*) FROM message GROUP BY session_id")?;
            for row in query.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })? {
                let (id, count) = row?;
                counts.insert(id, count as usize);
            }
        }
        // zcode stores its own injections and model-only sidechain turns as ordinary messages,
        // so the count has to reproduce the keep-rule of the reader; counting raw rows would
        // overstate a session by about a tenth.
        SqliteStore::Zcode => {
            let mut query = connection.prepare(
                "SELECT m.session_id, COUNT(*) FROM message m
                  WHERE json_extract(m.data, '$.role') IN ('user','assistant')
                    AND coalesce(json_extract(m.data, '$.semantics.kind'), '') <> 'timeline_event'
                    AND coalesce(json_extract(m.data, '$.semantics.transcriptVisibility'),
                         coalesce(json_extract(m.data, '$.metadata.visibility'), 'visible')) = 'visible'
                    AND EXISTS (SELECT 1 FROM part p
                                 WHERE p.message_id = m.id
                                   AND json_extract(p.data, '$.type') IN ('text','reasoning','tool')
                                   AND (json_extract(p.data, '$.type') <> 'text'
                                        OR length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0))
                  GROUP BY m.session_id",
            )?;
            for row in query.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })? {
                let (id, count) = row?;
                counts.insert(id, count as usize);
            }
        }
    }
    Ok(counts)
}

fn read_sqlite_store(
    db_path: &Path,
    session_id: &str,
    store: SqliteStore,
) -> Result<ImportedSession, ImportError> {
    let connection = open_import_db(db_path)?;
    let (title, cwd, created, updated): (String, Option<String>, i64, i64) = connection.query_row(
        "SELECT COALESCE(title,''), directory, time_created, time_updated FROM session WHERE id = ?1",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    // zcode's `session` table has no `model` column at all; only OpenCode records the session's
    // model, as a JSON string.
    let session_model = match store {
        SqliteStore::Opencode => connection
            .query_row(
                "SELECT model FROM session WHERE id = ?1",
                [session_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
            .and_then(|model| opencode_model_label(&model)),
        SqliteStore::Zcode => None,
    };
    let message_order =
        if store == SqliteStore::Zcode && table_has_column(&connection, "message", "sequence") {
            "sequence, time_created, id"
        } else {
            "time_created, id"
        };
    let part_order =
        if store == SqliteStore::Zcode && table_has_column(&connection, "part", "sequence") {
            "sequence, time_created, rowid"
        } else {
            "time_created, rowid"
        };
    let mut raw = Vec::new();
    {
        let mut message_query = connection.prepare(&format!(
            "SELECT id, time_created, data FROM message WHERE session_id = ?1 ORDER BY {message_order}"
        ))?;
        let mut part_query = connection.prepare(&format!(
            "SELECT data FROM part WHERE message_id = ?1 ORDER BY {part_order}"
        ))?;
        for row in message_query.query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })? {
            let (message_id, at, data) = row?;
            let data = serde_json::from_str::<Value>(&data).unwrap_or(Value::Null);
            let parts = part_query
                .query_map([&message_id], |row| row.get::<_, String>(0))?
                .filter_map(Result::ok)
                .filter_map(|part| serde_json::from_str::<Value>(&part).ok())
                .collect::<Vec<_>>();
            let duration_ms = data
                .get("time")
                .and_then(|time| {
                    let created = time.get("created").and_then(Value::as_i64)?;
                    let completed = time.get("completed").and_then(Value::as_i64)?;
                    u64::try_from(completed - created).ok()
                })
                .filter(|duration| *duration > 0);
            raw.push(RawMessage {
                at: sql_time(at),
                duration_ms,
                data,
                parts,
            });
        }
    }
    let assembled = assemble_sqlite_store(store, &raw, session_model.as_deref());
    if assembled.messages.is_empty() {
        return Err(ImportError::InvalidPath(
            "该会话没有可导入的对话内容".into(),
        ));
    }
    let candidate = Candidate {
        source: store.source().into(),
        source_id: session_id.into(),
        title: if title.trim().is_empty() {
            assembled.title
        } else {
            title
        },
        cwd,
        created_at: sql_time(created),
        updated_at: sql_time(updated),
        message_count: assembled.messages.len(),
        bytes: std::fs::metadata(db_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    };
    Ok(ImportedSession {
        candidate,
        messages: assembled.messages,
        timestamps: assembled.timestamps,
        skipped: assembled.skipped,
    })
}

/// `PRAGMA table_info` rather than an assumption: a database written before zcode's `sequence`
/// migration has no such column, and `rowid` — insertion order — is the closest thing to the
/// truth it can offer. Ordering by `time_created` instead would look plausible and be wrong.
fn table_has_column(connection: &rusqlite::Connection, table: &str, column: &str) -> bool {
    let Ok(mut statement) = connection.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(1)) else {
        return false;
    };
    rows.filter_map(Result::ok).any(|name| name == column)
}

fn assemble_sqlite_store(
    store: SqliteStore,
    raw: &[RawMessage],
    session_model: Option<&str>,
) -> Assembled {
    let mut messages = Vec::new();
    let mut timestamps = Vec::new();
    let mut counts = SkippedCounts::default();
    let mut first_user = String::new();

    for message in raw {
        let role = message
            .data
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role == "system" {
            counts.system_messages += 1;
            continue;
        }
        if role != "user" && role != "assistant" {
            continue;
        }
        if store == SqliteStore::Zcode {
            // zcode's own injections (`todo_reminder`, `system_reminder`, …) and its
            // model-only sidechain turns are ordinary messages; the agent's own UI hides them,
            // so importing them would put text into the chat that the user never wrote.
            if !zcode_visible(&message.data) {
                if role == "user" {
                    counts.injected += 1;
                } else {
                    counts.hidden += 1;
                }
                continue;
            }
            // A `timeline_event` row carries zcode's own transcript markers (the model-change
            // divider among them) and has no content of its own.
            if role == "assistant"
                && message
                    .data
                    .get("semantics")
                    .and_then(|semantics| semantics.get("kind"))
                    .and_then(Value::as_str)
                    == Some("timeline_event")
            {
                continue;
            }
        }

        if role == "user" {
            let mut texts = Vec::new();
            for part in &message.parts {
                match part_kind(part) {
                    "text" => {
                        if part_synthetic(part) {
                            counts.synthetic += 1;
                            continue;
                        }
                        if let Some(text) = part.get("text").and_then(Value::as_str)
                            && !text.trim().is_empty()
                        {
                            texts.push(text.trim().to_string());
                        }
                    }
                    // A file part is a path reference, not inline bytes, so an attachment
                    // cannot become a `ToolImages` block; it is counted and reported.
                    "file" | "image" => counts.files += 1,
                    other => count_structural_part(other, &mut counts, store),
                }
            }
            let text = texts.join("\n\n");
            if text.is_empty() {
                counts.empty_user += 1;
                continue;
            }
            if first_user.is_empty() {
                first_user = text.clone();
            }
            messages.push(Message::User { text });
            timestamps.push(message.at);
            continue;
        }

        let usage = sqlite_usage(store, message.data.get("tokens"), &message.parts);
        let model = sqlite_model(store, &message.data, session_model);
        let mut content = Vec::new();
        let mut pending: Vec<(String, String)> = Vec::new();
        // Whether a round trip of this message was already written. A message holding only
        // closed tool calls ends with an empty `content`, and that is not an empty answer.
        let mut written = false;
        for part in &message.parts {
            match part_kind(part) {
                "text" => {
                    if part_synthetic(part) {
                        counts.synthetic += 1;
                        continue;
                    }
                    if let Some(text) = part.get("text").and_then(Value::as_str)
                        && !text.trim().is_empty()
                    {
                        content.push(ContentBlock::Text { text: text.into() });
                    }
                }
                "reasoning" => {
                    if let Some(text) = part.get("text").and_then(Value::as_str)
                        && !text.trim().is_empty()
                    {
                        content.push(ContentBlock::Thinking {
                            text: text.into(),
                            signature: None,
                        });
                    }
                }
                "tool" => {
                    let state = part.get("state");
                    let id = part
                        .get("callID")
                        .and_then(Value::as_str)
                        .unwrap_or("imported-call")
                        .to_string();
                    let name = part
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or("imported_tool")
                        .to_string();
                    let arguments = state
                        .and_then(|state| state.get("input"))
                        .cloned()
                        .unwrap_or(Value::Object(Default::default()));
                    content.push(ContentBlock::ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        arguments,
                    });
                    let status = state
                        .and_then(|state| state.get("status"))
                        .and_then(Value::as_str);
                    if matches!(status, Some("completed") | Some("error")) {
                        // A tool result has to follow the assistant message that made the call,
                        // so the round trip is closed here and the rest of the parts continue in
                        // a new message.
                        messages.push(Message::Assistant(AssistantMessage {
                            duration_ms: message.duration_ms,
                            content: content.clone(),
                            stop: StopReason::ToolUse,
                            usage: usage.clone(),
                            model: model.clone(),
                        }));
                        timestamps.push(message.at);
                        written = true;
                        messages.push(Message::ToolResult {
                            call_id: id,
                            name,
                            content: tool_output_text(state, status),
                            is_error: status == Some("error"),
                        });
                        timestamps.push(message.at);
                        content.clear();
                    } else {
                        pending.push((id, name));
                    }
                }
                other => count_structural_part(other, &mut counts, store),
            }
        }

        if content.is_empty() {
            // OpenCode keeps a failed round trip as a note instead of dropping it, so a turn
            // that errored out does not vanish from the imported transcript. A round trip that
            // did run — it recorded usage — is kept as well: OpenCode writes the answer into
            // `step-start` / `step-finish` and leaves the message with no text parts at all,
            // and dropping those silently loses most of a long session's replies.
            let failure = message.data.get("error").filter(|error| !error.is_null());
            let ran = usage.input_tokens > 0 || usage.output_tokens > 0;
            if failure.is_some() || (store == SqliteStore::Opencode && ran && !written) {
                let text = match failure {
                    Some(error) => format!("（该回合请求失败：{}）", error_text(error)),
                    // Only the reasoning and the calls survive as content; the answer itself
                    // was not written as a text part.
                    None => "（该回合只记录了思考与工具调用）".to_string(),
                };
                messages.push(Message::Assistant(AssistantMessage {
                    duration_ms: message.duration_ms,
                    content: vec![ContentBlock::Text { text }],
                    stop: StopReason::Stop,
                    usage,
                    model,
                }));
                timestamps.push(message.at);
            } else {
                counts.empty_assistant += 1;
            }
            continue;
        }

        let stop = if pending.is_empty() {
            StopReason::Stop
        } else {
            StopReason::ToolUse
        };
        messages.push(Message::Assistant(AssistantMessage {
            duration_ms: message.duration_ms,
            content,
            stop,
            usage,
            model,
        }));
        timestamps.push(message.at);
        // A call that never came back — the run was interrupted — still needs a result, or the
        // next request is rejected for a dangling tool call.
        for (id, name) in pending {
            messages.push(Message::ToolResult {
                call_id: id,
                name,
                content: "（该工具调用在原 agent 中没有返回结果，运行被中断）".into(),
                is_error: true,
            });
            timestamps.push(message.at);
        }
    }

    Assembled {
        messages,
        timestamps,
        skipped: skipped_notes(store, &counts),
        title: first_user
            .chars()
            .take(60)
            .collect::<String>()
            .trim()
            .to_string(),
    }
}

fn part_kind(part: &Value) -> &str {
    part.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn part_synthetic(part: &Value) -> bool {
    part.get("synthetic").and_then(Value::as_bool) == Some(true)
}

/// `semantics.transcriptVisibility`, with the older `metadata.visibility` as a fallback. A
/// message that predates the field was shown.
fn zcode_visible(data: &Value) -> bool {
    let value = data
        .get("semantics")
        .and_then(|semantics| semantics.get("transcriptVisibility"))
        .and_then(Value::as_str)
        .or_else(|| {
            data.get("metadata")
                .and_then(|metadata| metadata.get("visibility"))
                .and_then(Value::as_str)
        });
    matches!(value, None | Some("visible"))
}

fn count_structural_part(kind: &str, counts: &mut SkippedCounts, store: SqliteStore) {
    match kind {
        // Bracketing round trips and zcode's own separators; they carry no content.
        "step-start" | "step-finish" | "timeline" => {
            if store == SqliteStore::Zcode {
                counts.structural += 1;
            }
        }
        // A compaction marker is deliberately not written as a compaction entry: the engine
        // builds the sent context from one, which would hide everything before it.
        "compaction" => counts.compaction += 1,
        "patch" => counts.patch += 1,
        "file" | "image" => counts.files += 1,
        "subtask" => counts.subtask += 1,
        "agent" => counts.agent += 1,
        "" => {}
        _ => counts.unknown += 1,
    }
}

fn skipped_notes(store: SqliteStore, counts: &SkippedCounts) -> Vec<String> {
    let mut skipped = Vec::new();
    let mut note = |count: usize, text: String| {
        if count > 0 {
            skipped.push(format!("已跳过 {count} {text}"));
        }
    };
    match store {
        SqliteStore::Opencode => {
            note(
                counts.system_prompts,
                "条系统提示词（assistant.system）".into(),
            );
            note(counts.system_messages, "条系统消息".into());
            note(counts.synthetic, "段注入文本（synthetic part）".into());
            note(counts.compaction, "个压缩标记（保留完整历史）".into());
            note(counts.patch, "个文件变更汇总（patch part）".into());
            note(counts.files, "个附件引用（只记录路径，无法内联）".into());
            note(counts.subtask, "条子任务调用（subtask part）".into());
            note(counts.agent, "条 agent 引用".into());
            note(counts.empty_user, "条无正文的用户消息".into());
            note(counts.empty_assistant, "条空 assistant 消息".into());
            note(counts.unknown, "个未知 part".into());
        }
        SqliteStore::Zcode => {
            note(
                counts.injected,
                "条 zcode 自身注入的用户消息（回忆提醒等）".into(),
            );
            note(
                counts.hidden,
                "条仅供模型可见的回复（子 agent / 分支上下文）".into(),
            );
            note(counts.system_messages, "条系统消息".into());
            note(
                counts.structural,
                "个结构性 part（step-start / step-finish / timeline）".into(),
            );
            note(counts.compaction, "个压缩标记（保留完整历史）".into());
            note(counts.files, "个附件或图片引用".into());
            note(counts.empty_user, "条无正文的用户消息".into());
            note(counts.empty_assistant, "条空消息".into());
            note(counts.unknown, "个未知 part".into());
        }
    }
    skipped
}

/// A tool part carries its own output, so a result never becomes a separate part.
fn tool_output_text(state: Option<&Value>, status: Option<&str>) -> String {
    let output = state.and_then(|state| state.get("output"));
    if status == Some("error") {
        let message = state
            .and_then(|state| state.get("error"))
            .map(error_text)
            .filter(|text| !text.is_empty())
            .or_else(|| output.map(value_text).filter(|text| !text.is_empty()));
        return message.unwrap_or_else(|| "工具调用失败".into());
    }
    output.map(value_text).unwrap_or_default()
}

fn error_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    for key in ["message", "name"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    value_text(value)
}

/// OpenCode's `session.model` is a JSON string such as
/// `{"id":"kimi-k2.6","providerID":"opencode-go","variant":"default"}`.
fn opencode_model_label(raw: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    let model = value
        .get("id")
        .or_else(|| value.get("modelID"))
        .or_else(|| value.get("model"))
        .and_then(Value::as_str)?
        .trim();
    if model.is_empty() {
        return None;
    }
    let provider = value
        .get("providerID")
        .or_else(|| value.get("provider"))
        .and_then(Value::as_str)
        .unwrap_or("opencode");
    Some(format!("{provider}/{model}"))
}

/// The model label a usage record is grouped by, so it has to be `provider/model`: zcode's
/// `providerID` is an internal UUID with no readable name, so every zcode model is attributed
/// to the literal provider `zcode`.
fn sqlite_model(store: SqliteStore, data: &Value, session_model: Option<&str>) -> Option<String> {
    let model = data
        .get("modelID")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty());
    match store {
        SqliteStore::Opencode => match model {
            Some(model) => Some(format!(
                "{}/{}",
                data.get("providerID")
                    .and_then(Value::as_str)
                    .unwrap_or("opencode"),
                model
            )),
            None => session_model.map(str::to_string),
        },
        SqliteStore::Zcode => model.map(|model| format!("zcode/{model}")),
    }
}

/// `tokens` with the store's own convention applied. zcode records OpenAI's raw usage, where
/// `input` already contains the cached tokens, so the cache counts are subtracted back out;
/// OpenCode's `input` excludes them. A message with no `tokens` falls back to its
/// `step-finish` part, which is the only other place the round trip records usage.
fn sqlite_usage(store: SqliteStore, tokens: Option<&Value>, parts: &[Value]) -> Usage {
    let usage = sqlite_usage_of(store, tokens);
    if usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_read_tokens == 0
        && usage.cache_write_tokens == 0
        && let Some(tokens) = parts
            .iter()
            .find(|part| part_kind(part) == "step-finish")
            .and_then(|part| part.get("tokens"))
    {
        return sqlite_usage_of(store, Some(tokens));
    }
    usage
}

fn sqlite_usage_of(store: SqliteStore, tokens: Option<&Value>) -> Usage {
    let Some(tokens) = tokens else {
        return Usage::default();
    };
    let cache = tokens.get("cache");
    let cache_read = cache
        .and_then(|cache| cache.get("read"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write = cache
        .and_then(|cache| cache.get("write"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let input = tokens.get("input").and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: match store {
            SqliteStore::Opencode => input,
            SqliteStore::Zcode => input.saturating_sub(cache_read.saturating_add(cache_write)),
        },
        output_tokens: tokens.get("output").and_then(Value::as_u64).unwrap_or(0),
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
    }
}

fn open_import_db(path: &Path) -> Result<rusqlite::Connection, ImportError> {
    Ok(rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?)
}

fn sql_time(value: i64) -> i64 {
    if value > 0 && value < 1_000_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn value_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn collect_jsonl(root: &Path, files: &mut Vec<std::path::PathBuf>) -> Result<(), ImportError> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            collect_jsonl(&path, files)?;
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
    Ok(())
}

fn summarize_codex(path: &Path) -> Result<Option<Candidate>, ImportError> {
    let meta = std::fs::metadata(path)?;
    let mut cwd = None;
    let mut first_user = None;
    let mut created = 0;
    let mut updated = 0;
    let mut count = 0;
    for value in lines(path)? {
        let Ok(value) = value else { continue };
        let at = timestamp(value.get("timestamp"));
        if created == 0 && at > 0 {
            created = at;
        }
        updated = updated.max(at);
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "session_meta" {
            cwd = value
                .get("payload")
                .and_then(|payload| payload.get("cwd"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(cwd);
        }
        if kind != "response_item" {
            continue;
        }
        let Some(payload) = value.get("payload").and_then(Value::as_object) else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = message_text(payload.get("content"));
        if role == "user"
            && first_user.is_none()
            && !is_codex_injected(&text)
            && !text.trim().is_empty()
        {
            first_user = Some(text.clone());
        }
        if role == "assistant" || (role == "user" && !is_codex_injected(&text)) {
            count += 1;
        }
    }
    Some(Candidate {
        source: "codex".into(),
        source_id: path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .display()
            .to_string(),
        title: first_user.unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        }),
        cwd,
        created_at: created,
        updated_at: updated.max(
            meta.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0),
        ),
        message_count: count,
        bytes: meta.len(),
    })
    .filter(|candidate| candidate.message_count > 0)
    .map(Ok)
    .transpose()
}

fn is_codex_injected(text: &str) -> bool {
    [
        "<permissions instructions>",
        "<recommended_plugins>",
        "<multi_agent_mode>",
        "<environment_context>",
        "<world_state>",
        "# AGENTS.md instructions",
        "<INSTRUCTIONS>",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn summarize_pi(path: &Path) -> Result<Option<Candidate>, ImportError> {
    let meta = std::fs::metadata(path)?;
    let mut cwd = None;
    let mut title = None;
    let mut first_user = None;
    let mut created = 0;
    let mut updated = 0;
    let mut count = 0;
    for value in lines(path)? {
        let Ok(value) = value else { continue };
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let at = timestamp(value.get("timestamp"));
        if created == 0 && at > 0 {
            created = at;
        }
        updated = updated.max(at);
        if kind == "session" {
            cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
        } else if kind == "session_info" {
            title = value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string);
        } else if kind == "message"
            && value
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                .is_some_and(|role| role == "user" || role == "assistant")
        {
            let message = value.get("message").and_then(Value::as_object);
            let text = message_text(message.and_then(|message| message.get("content")));
            if first_user.is_none()
                && message
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str)
                    == Some("user")
                && !text.trim().is_empty()
            {
                first_user = Some(text);
            }
            count += 1;
        } else if kind == "custom" || kind == "custom_message" {
            count += 1;
        }
    }
    let source_id = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string();
    Some(Candidate {
        source: "pi".into(),
        source_id,
        title: title.or(first_user).unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        }),
        cwd,
        created_at: created,
        updated_at: updated.max(
            meta.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0),
        ),
        message_count: count,
        bytes: meta.len(),
    })
    .filter(|candidate| candidate.message_count > 0)
    .map(Ok)
    .transpose()
}

fn lines(
    path: &Path,
) -> Result<impl Iterator<Item = Result<Value, serde_json::Error>>, ImportError> {
    let reader = BufReader::new(File::open(path)?);
    Ok(reader.lines().map(|line| {
        line.map_err(serde_json::Error::io)
            .and_then(|line| serde_json::from_str(&line))
    }))
}
fn timestamp(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_str)
        .and_then(chrono_like)
        .or_else(|| value.and_then(Value::as_i64))
        .unwrap_or(0)
}
fn chrono_like(value: &str) -> Option<i64> {
    value.parse::<i64>().ok().or_else(|| {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|date| date.timestamp_millis())
    })
}
fn message_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}
fn tool_result_text(value: Option<&Value>) -> String {
    message_text(value)
}
fn strip_synthetic(text: &str) -> String {
    text.replace("<system-reminder>", "")
        .replace("</system-reminder>", "")
        .trim()
        .into()
}
fn usage(value: Option<&Value>) -> Usage {
    let Some(value) = value else {
        return Usage::default();
    };
    Usage {
        input_tokens: value
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_read_tokens: value
            .get("cache_read_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_write_tokens: value
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn claude_blocks_group_by_message_id_and_skip_meta() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, r#"{{"type":"user","cwd":"/tmp/app","timestamp":"1000","message":{{"content":"hello"}}}}"#).unwrap();
        writeln!(
            file,
            r#"{{"type":"user","isMeta":true,"message":{{"content":"hidden"}}}}"#
        )
        .unwrap();
        writeln!(file, r#"{{"type":"assistant","timestamp":"2000","message":{{"id":"m1","model":"x","content":[{{"type":"thinking","thinking":"reason"}}]}}}}"#).unwrap();
        writeln!(file, r#"{{"type":"assistant","message":{{"id":"m1","content":[{{"type":"text","text":"answer"}},{{"type":"tool_use","id":"c1","name":"read","input":{{"path":"a"}}}}]}}}}"#).unwrap();
        writeln!(file, r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"c1","content":"ok"}}]}}}}"#).unwrap();
        let imported = read_claude(&path).unwrap();
        assert_eq!(imported.messages.len(), 3);
        assert!(matches!(&imported.messages[1], Message::Assistant(a) if a.content.len() == 3));
        assert!(
            matches!(&imported.messages[2], Message::ToolResult { call_id, .. } if call_id == "c1")
        );
    }

    #[test]
    fn scan_claude_uses_title_and_rfc3339_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("projects").join("demo");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"custom-title","customTitle":"Imported demo","timestamp":"2026-10-27T00:00:00Z"}"#, "\n",
                r#"{"type":"user","message":{"content":"hello"},"timestamp":"2026-10-27T00:00:01Z"}"#, "\n",
            ),
        )
        .unwrap();
        let candidates = scan_claude(&dir.path().join("projects")).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].title, "Imported demo");
        assert!(candidates[0].updated_at > candidates[0].created_at);
        assert_eq!(candidates[0].source, "claude-code");
    }

    #[test]
    fn pi_preserves_tool_call_result_and_skips_compaction_markers() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("encoded-cwd");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join("session.jsonl");
        let lines = [
            r#"{"type":"session","id":"s1","cwd":"/tmp/pi","timestamp":"2026-10-27T00:00:00Z"}"#,
            r#"{"type":"session_info","name":"Pi import"}"#,
            r#"{"type":"message","timestamp":"2026-10-27T00:00:01Z","message":{"role":"user","content":"hello"}}"#,
            r#"{"type":"message","timestamp":"2026-10-27T00:00:02Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"reason"},{"type":"text","text":"answer"},{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"a"}}],"usage":{"input":3,"output":2}}}"#,
            r#"{"type":"message","timestamp":"2026-10-27T00:00:03Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":"ok"}}"#,
            r#"{"type":"compaction","timestamp":"2026-10-27T00:00:04Z"}"#,
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let imported = read_pi(&path).unwrap();
        assert_eq!(imported.candidate.title, "Pi import");
        assert_eq!(imported.messages.len(), 3);
        assert_eq!(imported.messages.len(), imported.timestamps.len());
        assert!(
            matches!(&imported.messages[1], Message::Assistant(message) if message.content.len() == 3)
        );
        assert!(
            matches!(&imported.messages[2], Message::ToolResult { call_id, content, .. } if call_id == "c1" && content == "ok")
        );
        assert_eq!(imported.skipped.len(), 1);
    }

    #[test]
    fn codex_ignores_event_mirrors_and_injected_context() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-test.jsonl");
        let lines = [
            r#"{"type":"session_meta","timestamp":"2026-10-27T00:00:00Z","payload":{"cwd":"/tmp/codex"}}"#,
            r#"{"type":"response_item","timestamp":"2026-10-27T00:00:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>hidden</environment_context>"}]}}"#,
            r#"{"type":"response_item","timestamp":"2026-10-27T00:00:02Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}"#,
            r#"{"type":"response_item","timestamp":"2026-10-27T00:00:03Z","payload":{"type":"reasoning","summary":[{"text":"think"}]}}"#,
            r#"{"type":"response_item","timestamp":"2026-10-27T00:00:04Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}}"#,
            r#"{"type":"event_msg","timestamp":"2026-10-27T00:00:05Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5,"output_tokens":2}}}}"#,
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let imported = read_codex(&path).unwrap();
        assert_eq!(imported.candidate.title, "hello");
        assert_eq!(imported.messages.len(), 2);
        assert!(
            matches!(&imported.messages[1], Message::Assistant(message) if message.content.len() == 2 && message.usage.input_tokens == 5)
        );
        assert_eq!(imported.timestamps.len(), imported.messages.len());
    }

    #[test]
    fn opencode_reads_parts_from_a_read_only_sqlite_store() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("opencode.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        // The real store has no `role` column on `message`: the role lives in the `data` JSON.
        // A fake schema that adds one keeps the reader green while every real install fails
        // with `no such column: role`, which is exactly what happened once.
        connection
            .execute_batch(
                "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, model TEXT);
                 CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
                 CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES ('s1','OpenCode demo','/tmp/app',1000,2000,'{\"id\":\"model\",\"providerID\":\"gateway\"}')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES ('m1','s1',1000,'{\"role\":\"user\"}'),('m2','s1',2000,'{\"role\":\"assistant\",\"modelID\":\"model\",\"tokens\":{\"input\":2}}')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES ('p1','m1',1000,'{\"type\":\"text\",\"text\":\"hello\"}'),('p2','m2',2000,'{\"type\":\"reasoning\",\"text\":\"think\"}'),('p3','m2',2001,'{\"type\":\"text\",\"text\":\"answer\"}')",
                [],
            )
            .unwrap();
        drop(connection);
        let candidates = scan_opencode(&db_path).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].message_count, 2);
        let imported = read_opencode(&db_path, "s1").unwrap();
        assert_eq!(imported.messages.len(), 2);
        assert!(
            matches!(&imported.messages[1], Message::Assistant(message) if message.content.len() == 2 && message.usage.input_tokens == 2)
        );
        assert_eq!(imported.candidate.title, "OpenCode demo");
        assert_eq!(
            read_zcode(&db_path, "s1").unwrap().candidate.source,
            "zcode"
        );
    }

    #[test]
    fn opencode_closes_tool_round_trips_and_keeps_failed_ones() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("opencode.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, model TEXT);
                 CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
                 CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES ('s1','Tools','/tmp/app',1000,2000,NULL)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES
                   ('m1','s1',1000,'{\"role\":\"user\"}'),
                   ('m2','s1',2000,'{\"role\":\"assistant\",\"tokens\":{\"input\":1,\"output\":2,\"cache\":{\"read\":3,\"write\":4}}}'),
                   ('m3','s1',3000,'{\"role\":\"assistant\",\"error\":{\"message\":\"rate limited\"}}')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES
                   ('p1','m1',1000,'{\"type\":\"text\",\"text\":\"run it\"}'),
                   ('p2','m2',2000,'{\"type\":\"tool\",\"callID\":\"c1\",\"tool\":\"bash\",\"state\":{\"status\":\"completed\",\"input\":{\"cmd\":\"ls\"},\"output\":\"a\\nb\"}}'),
                   ('p3','m2',2001,'{\"type\":\"text\",\"text\":\"done\"}')",
                [],
            )
            .unwrap();
        drop(connection);
        let imported = read_opencode(&db_path, "s1").unwrap();
        // user, assistant(tool call), tool result, assistant(answer), assistant(failure)
        assert_eq!(imported.messages.len(), 5);
        assert!(
            matches!(&imported.messages[1], Message::Assistant(message) if message.stop == StopReason::ToolUse)
        );
        assert!(
            matches!(&imported.messages[2], Message::ToolResult { content, is_error, .. } if content == "a\nb" && !is_error)
        );
        assert!(
            matches!(&imported.messages[3], Message::Assistant(message) if message.stop == StopReason::Stop)
        );
        assert!(
            matches!(&imported.messages[4], Message::Assistant(message) if matches!(&message.content[0], ContentBlock::Text { text } if text.contains("rate limited")))
        );
        assert_eq!(imported.timestamps.len(), imported.messages.len());
        assert!(matches!(&imported.messages[1], Message::Assistant(message)
            if message.usage.input_tokens == 1
                && message.usage.output_tokens == 2
                && message.usage.cache_read_tokens == 3
                && message.usage.cache_write_tokens == 4));
    }

    #[test]
    fn zcode_reads_sequence_order_and_hides_model_only_turns() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("db.sqlite");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
                 CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
                 CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES ('s1','zcode demo','/tmp/app',1000,2000)",
                [],
            )
            .unwrap();
        // `sequence` is the real order: the later `time_created` is on the message that comes
        // first, which is what zcode does when it rewrites a row.
        connection
            .execute(
                "INSERT INTO message VALUES
                   ('m1','s1',2000,2000,'{\"role\":\"user\"}',1),
                   ('m0','s1',3000,3000,'{\"role\":\"assistant\",\"semantics\":{\"kind\":\"timeline_event\",\"transcriptVisibility\":\"visible\"},\"modelID\":\"glm\",\"tokens\":{\"input\":10,\"output\":4,\"cache\":{\"read\":6,\"write\":0}}}',0),
                   ('m2','s1',4000,4000,'{\"role\":\"assistant\",\"semantics\":{\"kind\":\"assistant_response\",\"transcriptVisibility\":\"visible\"},\"modelID\":\"glm\",\"tokens\":{\"input\":10,\"output\":4,\"cache\":{\"read\":6,\"write\":0}}}',2),
                   ('m3','s1',5000,5000,'{\"role\":\"assistant\",\"semantics\":{\"kind\":\"assistant_response\",\"transcriptVisibility\":\"hidden\"},\"modelID\":\"glm\"}',3),
                   ('m4','s1',6000,6000,'{\"role\":\"user\",\"semantics\":{\"transcriptVisibility\":\"hidden\"}}',4)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES
                   ('p1','m1','s1',2000,2000,'{\"type\":\"text\",\"text\":\"question\"}',0),
                   ('p2','m2','s1',4000,4000,'{\"type\":\"text\",\"text\":\"answer\"}',0),
                   ('p3','m3','s1',5000,5000,'{\"type\":\"text\",\"text\":\"sidechain\"}',0),
                   ('p4','m4','s1',6000,6000,'{\"type\":\"text\",\"text\":\"reminder\"}',0)",
                [],
            )
            .unwrap();
        drop(connection);
        let candidates = scan_zcode(&db_path).unwrap();
        assert_eq!(candidates.len(), 1);
        // m1 (user) and m2 (visible assistant); m0 is a timeline event, m3 and m4 are hidden.
        assert_eq!(candidates[0].message_count, 2);
        let imported = read_zcode(&db_path, "s1").unwrap();
        assert_eq!(imported.messages.len(), 2);
        assert!(matches!(&imported.messages[0], Message::User { text } if text == "question"));
        // zcode's `tokens.input` already contains the cached tokens, so they are subtracted.
        assert!(matches!(&imported.messages[1], Message::Assistant(message)
            if message.usage.input_tokens == 4
                && message.usage.cache_read_tokens == 6
                && message.model.as_deref() == Some("zcode/glm")));
        assert!(
            imported
                .skipped
                .iter()
                .any(|note| note.contains("仅供模型可见"))
        );
        assert!(
            imported
                .skipped
                .iter()
                .any(|note| note.contains("自身注入"))
        );
    }

    #[test]
    fn optional_sqlite_sources_are_empty_when_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            scan_opencode(&dir.path().join("missing.db"))
                .unwrap()
                .is_empty()
        );
        assert!(
            scan_zcode(&dir.path().join("missing.db"))
                .unwrap()
                .is_empty()
        );
    }
}
