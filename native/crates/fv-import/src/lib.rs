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

/// Scan the current OpenCode SQLite store. The database is opened read-only while OpenCode may
/// still be running; a locked or missing store simply produces no candidates.
pub fn scan_opencode(db_path: &Path) -> Result<Vec<Candidate>, ImportError> {
    if !db_path.is_file() {
        return Ok(Vec::new());
    }
    let connection = match open_import_db(db_path) {
        Ok(connection) => connection,
        Err(_) => return Ok(Vec::new()),
    };
    let mut query = connection.prepare(
        "SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC",
    )?;
    let mut candidates = Vec::new();
    for row in query.query_map([], |row| {
        let id: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        let cwd: Option<String> = row.get(2)?;
        let created: i64 = row.get(3)?;
        let updated: i64 = row.get(4)?;
        Ok((id, title, cwd, created, updated))
    })? {
        let (id, title, cwd, created, updated) = row?;
        let message_count: usize = connection.query_row(
            "SELECT COUNT(*) FROM message WHERE session_id = ?1 AND role IN ('user','assistant')",
            [&id],
            |row| row.get::<_, i64>(0),
        )? as usize;
        if message_count == 0 {
            continue;
        }
        candidates.push(Candidate {
            source: "opencode".into(),
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

pub fn read_opencode(db_path: &Path, session_id: &str) -> Result<ImportedSession, ImportError> {
    let connection = open_import_db(db_path)?;
    let (title, cwd, created, updated): (String, Option<String>, i64, i64) = connection
        .query_row(
            "SELECT COALESCE(title,''), directory, time_created, time_updated FROM session WHERE id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let mut messages = Vec::new();
    let mut timestamps = Vec::new();
    let mut skipped = Vec::new();
    let mut message_query = connection.prepare(
        "SELECT id, time_created, role, data FROM message WHERE session_id = ?1 ORDER BY time_created, id",
    )?;
    for row in message_query.query_map([session_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })? {
        let (message_id, at, role, data) = row?;
        let data =
            serde_json::from_str::<Value>(&data).unwrap_or(Value::Object(Default::default()));
        let mut parts = connection
            .prepare("SELECT data FROM part WHERE message_id = ?1 ORDER BY time_created, rowid")?;
        let parts = parts
            .query_map([&message_id], |row| row.get::<_, String>(0))?
            .filter_map(Result::ok)
            .filter_map(|part| serde_json::from_str::<Value>(&part).ok())
            .collect::<Vec<_>>();
        let at = sql_time(at);
        match role.as_str() {
            "user" => {
                let text = parts
                    .iter()
                    .filter(|part| {
                        part.get("type").and_then(Value::as_str) == Some("text")
                            && part.get("synthetic").and_then(Value::as_bool) != Some(true)
                    })
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if !text.trim().is_empty() {
                    messages.push(Message::User { text });
                    timestamps.push(at);
                }
            }
            "assistant" => {
                let mut content = Vec::new();
                for part in &parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("text")
                            if part.get("synthetic").and_then(Value::as_bool) != Some(true) =>
                        {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                content.push(ContentBlock::Text { text: text.into() });
                            }
                        }
                        Some("reasoning") => {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                content.push(ContentBlock::Thinking {
                                    text: text.into(),
                                    signature: None,
                                });
                            }
                        }
                        Some("tool") => {
                            let state = part.get("state").and_then(Value::as_object);
                            let id = part
                                .get("callID")
                                .and_then(Value::as_str)
                                .unwrap_or("imported-call");
                            let name = part
                                .get("tool")
                                .and_then(Value::as_str)
                                .unwrap_or("imported_tool");
                            let arguments = state
                                .and_then(|state| state.get("input"))
                                .cloned()
                                .unwrap_or(Value::Object(Default::default()));
                            content.push(ContentBlock::ToolCall {
                                id: id.into(),
                                name: name.into(),
                                arguments,
                            });
                            if let Some(state) = state {
                                let status = state.get("status").and_then(Value::as_str);
                                if matches!(status, Some("completed") | Some("error")) {
                                    messages.push(Message::Assistant(AssistantMessage {
                                        duration_ms: None,
                                        content: content.clone(),
                                        stop: StopReason::ToolUse,
                                        usage: opencode_usage(data.get("tokens")),
                                        model: data
                                            .get("modelID")
                                            .and_then(Value::as_str)
                                            .map(str::to_string),
                                    }));
                                    timestamps.push(at);
                                    messages.push(Message::ToolResult {
                                        call_id: id.into(),
                                        name: name.into(),
                                        content: state
                                            .get("output")
                                            .map(value_text)
                                            .unwrap_or_default(),
                                        is_error: status == Some("error"),
                                    });
                                    timestamps.push(at);
                                    content.clear();
                                }
                            }
                        }
                        Some("compaction") | Some("patch") | Some("file") | Some("subtask")
                        | Some("agent") => skipped.push("structural OpenCode part".into()),
                        _ => {}
                    }
                }
                if !content.is_empty() {
                    messages.push(Message::Assistant(AssistantMessage {
                        duration_ms: None,
                        content,
                        stop: StopReason::Stop,
                        usage: opencode_usage(data.get("tokens")),
                        model: data
                            .get("modelID")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }));
                    timestamps.push(at);
                }
            }
            _ => skipped.push("system OpenCode message".into()),
        }
    }
    let candidate = Candidate {
        source: "opencode".into(),
        source_id: session_id.into(),
        title,
        cwd,
        created_at: sql_time(created),
        updated_at: sql_time(updated),
        message_count: messages.len(),
        bytes: std::fs::metadata(db_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    };
    Ok(ImportedSession {
        candidate,
        messages,
        timestamps,
        skipped,
    })
}

/// zcode uses the same session/message/part SQLite shape as OpenCode. Its database is kept in a
/// separate application directory, so the source label is rewritten after the shared reader.
pub fn scan_zcode(db_path: &Path) -> Result<Vec<Candidate>, ImportError> {
    let mut candidates = scan_opencode(db_path)?;
    for candidate in &mut candidates {
        candidate.source = "zcode".into();
    }
    Ok(candidates)
}

pub fn read_zcode(db_path: &Path, session_id: &str) -> Result<ImportedSession, ImportError> {
    let mut imported = read_opencode(db_path, session_id)?;
    imported.candidate.source = "zcode".into();
    Ok(imported)
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

fn opencode_usage(value: Option<&Value>) -> Usage {
    let Some(value) = value.and_then(Value::as_object) else {
        return Usage::default();
    };
    Usage {
        input_tokens: value.get("input").and_then(Value::as_u64).unwrap_or(0),
        output_tokens: value.get("output").and_then(Value::as_u64).unwrap_or(0),
        cache_read_tokens: value
            .get("cache")
            .and_then(|cache| cache.get("read"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_write_tokens: value
            .get("cache")
            .and_then(|cache| cache.get("write"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
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
        connection
            .execute_batch(
                "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
                 CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, role TEXT, data TEXT);
                 CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES ('s1','OpenCode demo','/tmp/app',1000,2000)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES ('m1','s1',1000,'user','{}'),('m2','s1',2000,'assistant','{\"modelID\":\"model\",\"tokens\":{\"input\":2}}')",
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
        let imported = read_opencode(&db_path, "s1").unwrap();
        assert_eq!(imported.messages.len(), 2);
        assert!(
            matches!(&imported.messages[1], Message::Assistant(message) if message.content.len() == 2 && message.usage.input_tokens == 2)
        );
        assert_eq!(
            read_zcode(&db_path, "s1").unwrap().candidate.source,
            "zcode"
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
