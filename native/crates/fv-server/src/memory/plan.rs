use std::collections::BTreeMap;
use std::sync::OnceLock;

use fv_core::{ContentBlock, Message};
use regex::Regex;
use serde::{Deserialize, Serialize};

pub const HOUR: i64 = 3_600_000;
pub const DAY: i64 = 24 * HOUR;
pub const MIN_IDLE: i64 = 6 * HOUR;
pub const MAX_AGE: i64 = 10 * DAY;
pub const MAX_UNUSED: i64 = 30 * DAY;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub conversation_id: String,
    pub cwd: String,
    pub rollout_path: String,
    pub created_at: i64,
    pub source_updated_at: i64,
    pub generated_at: i64,
    pub raw_memory: String,
    pub rollout_summary: String,
    pub slug: String,
    pub usage_count: u64,
    pub last_usage: Option<i64>,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Ledger {
    pub outputs: BTreeMap<String, Output>,
    pub empty: BTreeMap<String, i64>,
    pub failures: BTreeMap<String, Failure>,
    pub baseline: BTreeMap<String, String>,
    pub last_run_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Failure {
    pub mtime: i64,
    pub attempts: u32,
    pub retry_after: i64,
}

impl Ledger {
    pub fn eligible(&self, id: &str, mtime: i64, now: i64) -> bool {
        let age = now.saturating_sub(mtime);
        (MIN_IDLE..=MAX_AGE).contains(&age)
            && !self
                .outputs
                .get(id)
                .is_some_and(|o| o.source_updated_at >= mtime)
            && !self.empty.get(id).is_some_and(|old| *old >= mtime)
            && !self
                .failures
                .get(id)
                .is_some_and(|f| f.mtime == mtime && (f.attempts >= 3 || f.retry_after > now))
    }

    pub fn failed(&mut self, id: &str, mtime: i64, now: i64, error: String) {
        let attempts = self
            .failures
            .get(id)
            .filter(|f| f.mtime == mtime)
            .map_or(1, |f| f.attempts + 1);
        self.failures.insert(
            id.into(),
            Failure {
                mtime,
                attempts,
                retry_after: now + HOUR,
            },
        );
        self.error = Some(redact(&error));
    }

    pub fn selected(&self, now: i64) -> Vec<Output> {
        let mut outputs: Vec<_> = self
            .outputs
            .values()
            .filter(|o| now - o.last_usage.unwrap_or(o.generated_at) <= MAX_UNUSED)
            .cloned()
            .collect();
        outputs.sort_by(|a, b| {
            b.usage_count
                .cmp(&a.usage_count)
                .then_with(|| {
                    b.last_usage
                        .unwrap_or(b.source_updated_at)
                        .cmp(&a.last_usage.unwrap_or(a.source_updated_at))
                })
                .then_with(|| a.conversation_id.cmp(&b.conversation_id))
        });
        outputs.truncate(256);
        outputs
    }
}

pub fn clip(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

pub fn redact(value: &str) -> String {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\z)",
            r"\bsk-[A-Za-z0-9_-]{16,}",
            r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}",
            r"\bAKIA[0-9A-Z]{16}\b",
            r"\bxox[abprs]-[A-Za-z0-9-]{10,}",
            r"\bAIza[0-9A-Za-z_-]{30,}",
            r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
            r"(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}",
        ]
        .into_iter()
        .map(|p| Regex::new(p).expect("static secret pattern"))
        .collect()
    });
    let mut out = value.to_string();
    for pattern in patterns {
        out = pattern.replace_all(&out, "[REDACTED_SECRET]").into_owned();
    }
    static ASSIGNMENT: OnceLock<Regex> = OnceLock::new();
    let assignment = ASSIGNMENT.get_or_init(|| Regex::new(r#"(?i)\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passwd|password|credential)[A-Za-z0-9_.-]*)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{6,})"#).unwrap());
    assignment
        .replace_all(&out, "${1}${2}[REDACTED_SECRET]")
        .into_owned()
}

pub fn render(messages: &[Message], budget: usize) -> Option<String> {
    let mut lines = Vec::new();
    let (mut users, mut answers) = (0, 0);
    for message in messages {
        match message {
            Message::User { text } if !text.trim().is_empty() => {
                users += 1;
                lines.push(format!("[user] {}", clip(&redact(text.trim()), 10_000)));
            }
            Message::Assistant(a) => {
                let text = fv_core::strip_memory_citation(&a.text());
                if !text.trim().is_empty() {
                    answers += 1;
                    lines.push(format!(
                        "[assistant] {}",
                        clip(&redact(text.trim()), 10_000)
                    ));
                }
                for block in &a.content {
                    if let ContentBlock::ToolCall {
                        name, arguments, ..
                    } = block
                    {
                        lines.push(format!(
                            "[tool call] {name} {}",
                            clip(&redact(&arguments.to_string()), 10_000)
                        ));
                    }
                }
            }
            Message::ToolResult { name, content, .. } => lines.push(format!(
                "[tool result: {name}] {}",
                clip(&redact(content.trim()), 8_000)
            )),
            _ => {} // Hidden contexts, thoughts, images and compaction notes are not evidence.
        }
    }
    let text = redact(&lines.join("\n"));
    if users == 0 || answers == 0 || text.chars().count() < 200 {
        return None;
    }
    if text.chars().count() <= budget {
        return Some(text);
    }
    let marker = "\n[... response items omitted ...]\n";
    let keep = budget.saturating_sub(marker.len()) / 2;
    let tail: String = text
        .chars()
        .rev()
        .take(keep)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Some(format!("{}{marker}{tail}", clip(&text, keep)))
}

#[derive(Debug, Deserialize)]
pub struct Extraction {
    #[serde(default)]
    pub raw_memory: String,
    #[serde(default)]
    pub rollout_summary: String,
    #[serde(default)]
    pub rollout_slug: String,
}

pub fn parse(text: &str) -> Result<Extraction, String> {
    let start = text.find('{').ok_or("memory extraction returned no JSON")?;
    let end = text
        .rfind('}')
        .ok_or("memory extraction returned incomplete JSON")?;
    if end < start {
        return Err("invalid memory extraction JSON".into());
    }
    let raw: serde_json::Value =
        serde_json::from_str(&text[start..=end]).map_err(|e| e.to_string())?;
    if raw.get("raw_memory").is_none() && raw.get("rollout_summary").is_none() {
        return Err("memory extraction returned no memory fields".into());
    }
    let mut value: Extraction = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    value.raw_memory = redact(value.raw_memory.trim());
    value.rollout_summary = redact(value.rollout_summary.trim());
    value.rollout_slug = clip(&value.rollout_slug, 60)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_end_matches('_')
        .to_string();
    Ok(value)
}

pub fn filename(output: &Output) -> String {
    use sha2::{Digest, Sha256};
    let time = chrono::DateTime::from_timestamp_millis(output.created_at)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H-%M-%S");
    let digest = format!("{:x}", Sha256::digest(output.conversation_id.as_bytes()));
    let slug = if output.slug.is_empty() {
        String::new()
    } else {
        format!("-{}", output.slug)
    };
    format!("{time}-{}{slug}.md", &digest[..12])
}

pub fn inputs(outputs: &[Output]) -> BTreeMap<String, String> {
    let mut tree = BTreeMap::new();
    let mut sorted: Vec<_> = outputs.iter().collect();
    sorted.sort_by_key(|o| &o.conversation_id);
    let mut raw = "# Raw Memories\n\n".to_string();
    for output in sorted {
        let name = filename(output);
        let meta = format!(
            "thread_id: {}\nupdated_at: {}\nrollout_path: {}\ncwd: {}\n",
            output.conversation_id,
            chrono::DateTime::from_timestamp_millis(output.source_updated_at)
                .unwrap_or_default()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
            output.rollout_path,
            output.cwd
        );
        tree.insert(
            format!("rollout_summaries/{name}"),
            format!("{meta}\n{}\n", output.rollout_summary),
        );
        raw.push_str(&format!(
            "## Thread `{}`\n{meta}rollout_summary_file: {name}\n\n{}\n\n",
            output.conversation_id, output.raw_memory
        ));
    }
    tree.insert("raw_memories.md".into(), raw);
    tree
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eligibility_uses_transcript_idle_time_and_retries_only_when_due_or_changed() {
        let mut ledger = Ledger::default();
        let mtime = 100 * DAY;
        assert!(!ledger.eligible("x", mtime, mtime + MIN_IDLE - 1));
        assert!(ledger.eligible("x", mtime, mtime + MIN_IDLE));
        assert!(!ledger.eligible("x", mtime, mtime + MAX_AGE + 1));
        for attempt in 1..=3 {
            let now = mtime + MIN_IDLE + attempt * HOUR;
            assert!(ledger.eligible("x", mtime, now));
            ledger.failed("x", mtime, now, "failed".into());
            assert!(!ledger.eligible("x", mtime, now + 1));
        }
        assert!(!ledger.eligible("x", mtime, mtime + MAX_AGE));
        assert!(ledger.eligible("x", mtime + HOUR, mtime + MAX_AGE));
        ledger.empty.insert("x".into(), mtime + HOUR);
        assert!(!ledger.eligible("x", mtime + HOUR, mtime + MAX_AGE));
    }

    #[test]
    fn consolidation_keeps_the_most_used_256_and_expires_only_unused_notes() {
        let now = 100 * DAY;
        let mut ledger = Ledger::default();
        for index in 0..300 {
            let id = index.to_string();
            ledger.outputs.insert(
                id.clone(),
                Output {
                    conversation_id: id,
                    cwd: "/repo".into(),
                    rollout_path: "/session".into(),
                    created_at: 0,
                    source_updated_at: now,
                    generated_at: now,
                    raw_memory: "note".into(),
                    rollout_summary: "recap".into(),
                    slug: String::new(),
                    usage_count: index,
                    last_usage: None,
                },
            );
        }
        let selected = ledger.selected(now);
        assert_eq!(selected.len(), 256);
        assert_eq!(selected[0].conversation_id, "299");
        let files = inputs(&selected[..1]);
        assert!(files["raw_memories.md"].contains("updated_at: 1970-04-11T00:00:00+00:00"));
        let stale = ledger.outputs.get_mut("299").unwrap();
        stale.generated_at = now - MAX_UNUSED - 1;
        assert_ne!(ledger.selected(now)[0].conversation_id, "299");
        ledger.outputs.get_mut("299").unwrap().last_usage = Some(now);
        assert_eq!(ledger.selected(now)[0].conversation_id, "299");
    }

    #[test]
    fn extraction_keeps_authored_evidence_and_redacts_before_clipping() {
        let token = "sk-abcdefghijklmnopqrstuvwx";
        let user = format!("{} {token}", "a".repeat(9_990));
        let answer = fv_core::AssistantMessage {
            duration_ms: None,
            content: vec![
                ContentBlock::Text {
                    text: "b".repeat(250),
                },
                ContentBlock::Thinking {
                    text: "PRIVATE_THOUGHT".into(),
                    signature: None,
                },
            ],
            stop: fv_core::StopReason::Stop,
            usage: Default::default(),
            model: None,
        };
        let messages = [
            Message::MemoryContext {
                summary: "HIDDEN_MAP".into(),
            },
            Message::User { text: user },
            Message::Assistant(answer),
        ];
        let rendered = render(&messages, 20_000).unwrap();
        assert!(!rendered.contains("sk-"));
        assert!(!rendered.contains("PRIVATE_THOUGHT"));
        assert!(!rendered.contains("HIDDEN_MAP"));
        assert!(
            render(&messages, 200)
                .unwrap()
                .contains("response items omitted")
        );
        for secret in [
            "password = password123",
            "Bearer abcdefghijklmnopqrstuvwxyz",
            "-----BEGIN PRIVATE KEY-----\nkey data",
        ] {
            let redacted = redact(secret);
            assert!(redacted.contains("[REDACTED_SECRET]"), "{redacted}");
            assert!(!redacted.contains("password123"));
        }
        let parsed = parse("```json\n{\"raw_memory\":\"password=secretvalue\",\"rollout_summary\":\"memo\",\"rollout_slug\":\"../../Hello 中文\"}\n```").unwrap();
        assert!(parsed.raw_memory.contains("[REDACTED_SECRET]"));
        assert!(!parsed.rollout_slug.contains('/'));
        assert!(parse("{\"raw_memory\": 2}").is_err());
    }
}
