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
    pub skipped: Vec<String>,
}

#[derive(Debug)]
pub enum ImportError {
    Io(std::io::Error),
    InvalidPath(String),
}
impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
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
                }
                messages.extend(results);
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
        skipped,
    })
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
}
