//! The conversation model the engine reasons in, independent of any provider's wire format
//! and of the client protocol. The transcript on disk and every request to a model are built
//! from these types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod image;
mod memory;
mod web_search;
pub use memory::{memory_citation_ids, strip_memory_citation};
pub use web_search::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContentBlock {
    HostedSearch(WebSearchCall),
    Citations {
        citations: Vec<UrlCitation>,
    },
    Text {
        text: String,
    },
    /// `signature` is the provider's opaque proof of the thought (Anthropic's signature,
    /// OpenAI's encrypted reasoning, Gemini's thought signature). It has to be sent back
    /// unchanged for the model to keep its reasoning across tool calls, and only to the
    /// model that produced it.
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StopReason {
    /// The model finished its answer.
    Stop,
    /// The model asked for tools and is waiting for their results.
    ToolUse,
    /// Cut off at the output limit.
    Length,
    /// Stopped by the user; the content is whatever had arrived.
    Aborted,
    Error {
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    /// Time for this model request, including first-token wait, excluding tool execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub content: Vec<ContentBlock>,
    pub stop: StopReason,
    #[serde(default)]
    pub usage: Usage,
    /// Which model wrote it (`provider/model`). Thinking signatures are only valid for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

pub struct ToolCallRef<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub arguments: &'a Value,
}

impl AssistantMessage {
    pub fn tool_calls(&self) -> impl Iterator<Item = ToolCallRef<'_>> {
        self.content.iter().filter_map(|b| match b {
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
            } => Some(ToolCallRef {
                id,
                name,
                arguments,
            }),
            _ => None,
        })
    }

    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "role",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Message {
    User {
        text: String,
    },
    /// Hidden, persisted memory map. Kept separate from authored user messages so disabling
    /// memory can remove it from requests without rewriting the transcript or a user's words.
    MemoryContext {
        summary: String,
    },
    Assistant(AssistantMessage),
    ToolResult {
        call_id: String,
        name: String,
        content: String,
        is_error: bool,
    },
    /// Pictures a tool returned (`view_image`). Providers cannot carry an image inside a tool
    /// result, so these follow the results of the batch they came from; a message of this kind
    /// is only ever placed after tool results.
    ToolImages {
        call_id: String,
        name: String,
        images: Vec<ImagePart>,
    },
    ToolAudio {
        call_id: String,
        name: String,
        audio: Vec<AudioPart>,
    },
    /// The conversation so far was summarized to make room. Everything before this message is
    /// no longer sent to the model; it stays in the transcript, which only ever grows.
    Compaction {
        /// Usage of the summary request; old transcripts did not record it.
        #[serde(default)]
        usage: Usage,
        /// Which model wrote the summary, so its own price applies to that usage. Absent on
        /// summaries written before this was recorded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// Every message the user wrote before this point (the earlier ones carried over from
        /// previous compactions), so their own words survive however many times this happens.
        user_messages: Vec<String>,
        summary: String,
    },
}

/// How much of the user's own words a compaction carries over, in bytes (about 20k tokens).
const KEPT_USER_MESSAGE_BYTES: usize = 80_000;

impl Message {
    pub fn memory_context_text(summary: &str) -> String {
        format!(
            "========= MEMORY_SUMMARY BEGINS =========\n{summary}\n========= MEMORY_SUMMARY ENDS ========="
        )
    }
    /// The text a model is shown in place of everything a compaction replaced: what the user
    /// asked, then the summary of what was done about it. After codex's `history_bridge.md`.
    pub fn compaction_text(user_messages: &[String], summary: &str) -> String {
        Self::compaction_text_with_budget(user_messages, summary, KEPT_USER_MESSAGE_BYTES)
    }

    /// Request-only projection for a smaller physical window. Original user messages stay
    /// in the persisted checkpoint; its summary also carries their requirements.
    pub fn compaction_text_with_budget(
        user_messages: &[String],
        summary: &str,
        max_user_bytes: usize,
    ) -> String {
        let users = if user_messages.is_empty() {
            "(none)".to_string()
        } else {
            user_messages.join("\n\n")
        };
        let users = truncate_middle(&users, max_user_bytes.min(KEPT_USER_MESSAGE_BYTES));
        let summary = if summary.trim().is_empty() {
            "(no summary available)"
        } else {
            summary
        };
        format!(
            "You were originally given instructions from a user over one or more turns. Here were the user messages:\n\n{users}\n\nAnother language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\n\n{summary}"
        )
    }
}

/// Keep the start and the end of `s`, cut the middle, on character boundaries.
fn truncate_middle(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let marker = format!("\n[… {} bytes omitted …]\n", s.len() - max_bytes);
    let keep = max_bytes.saturating_sub(marker.len()) / 2;
    let mut head = keep;
    while head > 0 && !s.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = s.len() - keep;
    while tail < s.len() && !s.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}{marker}{}", &s[..head], &s[tail..])
}

/// What the model is sent: everything from the last compaction on (the compaction included),
/// or all of it when there has been none.
pub fn effective_history(messages: &[Message]) -> Vec<Message> {
    let start = messages
        .iter()
        .rposition(|m| matches!(m, Message::Compaction { .. }))
        .unwrap_or(0);
    messages[start..].to_vec()
}

/// A rough size in tokens, at four bytes to a token. Pictures count as a fixed amount.
pub fn estimate_tokens(messages: &[Message]) -> u64 {
    const PICTURE_TOKENS: u64 = 1_500;
    let bytes: u64 = messages
        .iter()
        .map(|m| match m {
            Message::User { text } => text.len() as u64,
            Message::MemoryContext { summary } => summary.len() as u64,
            Message::Assistant(a) => a
                .content
                .iter()
                .map(|b| match b {
                    ContentBlock::HostedSearch(_) | ContentBlock::Citations { .. } => 0,
                    ContentBlock::Text { text } | ContentBlock::Thinking { text, .. } => {
                        text.len() as u64
                    }
                    ContentBlock::ToolCall {
                        name, arguments, ..
                    } => (name.len() + arguments.to_string().len()) as u64,
                })
                .sum(),
            Message::ToolResult { content, .. } => content.len() as u64,
            Message::ToolImages { images, .. } => images.len() as u64 * PICTURE_TOKENS * 4,
            Message::ToolAudio { audio, .. } => audio.len() as u64 * PICTURE_TOKENS * 4,
            Message::Compaction {
                user_messages,
                summary,
                ..
            } => Message::compaction_text(user_messages, summary).len() as u64,
        })
        .sum();
    bytes.div_ceil(4)
}

/// One choice offered with a question.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

/// A question the agent asks the user (`request_user_input`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// Stable identifier the answer is filed under.
    pub id: String,
    /// A short heading (12 characters or fewer).
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    /// The client offers a free-form "Other" answer besides the options.
    #[serde(default)]
    pub is_other: bool,
}

/// What the user chose or typed for each question, by question id.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answers {
    pub answers: std::collections::BTreeMap<String, AnswerList>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerList {
    pub answers: Vec<String>,
}

/// A picture, by where its bytes are.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    /// `image/png`, `image/jpeg`, …
    pub mime: String,
    pub source: ImageSource,
}

/// In memory an image is its base64 bytes; on disk it is a file next to the transcript, so a
/// transcript stays small however many screenshots a conversation has seen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ImageSource {
    Base64 { data: String },
    File { path: String },
}

/// Audio generated by a tool or a code-mode cell. It is kept separate from image
/// parts so providers and clients never guess a media type from a filename.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPart {
    pub mime: String,
    pub source: AudioSource,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AudioSource {
    Base64 { data: String },
    File { path: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(t: &str) -> Message {
        Message::User { text: t.into() }
    }

    #[test]
    fn the_model_is_shown_only_what_follows_the_last_compaction() {
        let compaction = Message::Compaction {
            usage: Default::default(),
            model: None,
            user_messages: vec!["a".into()],
            summary: "s".into(),
        };
        let all = vec![user("a"), user("b"), compaction.clone(), user("c")];
        assert_eq!(effective_history(&all), vec![compaction, user("c")]);
        let none = vec![user("a"), user("b")];
        assert_eq!(effective_history(&none), none);
        assert!(effective_history(&[]).is_empty());
        // A later compaction supersedes an earlier one.
        let two = vec![
            Message::Compaction {
                usage: Default::default(),
                model: None,
                user_messages: vec![],
                summary: "old".into(),
            },
            user("x"),
            Message::Compaction {
                usage: Default::default(),
                model: None,
                user_messages: vec!["x".into()],
                summary: "new".into(),
            },
        ];
        assert_eq!(effective_history(&two).len(), 1);
    }

    #[test]
    fn the_bridge_carries_the_users_words_and_the_summary() {
        let text =
            Message::compaction_text(&["first ask".into(), "second ask".into()], "did the thing");
        assert!(text.contains("first ask\n\nsecond ask") && text.contains("did the thing"));
        assert!(Message::compaction_text(&[], "").contains("(none)"));
        assert!(Message::compaction_text(&[], "  ").contains("(no summary available)"));
    }

    #[test]
    fn a_very_long_run_of_user_messages_is_cut_in_the_middle() {
        let long = "é".repeat(100_000);
        let text = Message::compaction_text(&[long], "s");
        assert!(text.len() < 90_000, "{} bytes", text.len());
        assert!(text.contains("bytes omitted"));
        // Cut on a character boundary: this would have panicked otherwise.
        assert!(text.is_char_boundary(text.len()));
    }

    #[test]
    fn size_is_estimated_by_bytes() {
        assert_eq!(estimate_tokens(&[user(&"x".repeat(400))]), 100);
        let call = Message::Assistant(AssistantMessage {
            duration_ms: None,
            content: vec![ContentBlock::ToolCall {
                id: "c".into(),
                name: "read".into(),
                arguments: serde_json::json!({"p": "x"}),
            }],
            stop: StopReason::ToolUse,
            usage: Usage::default(),
            model: None,
        });
        assert!(estimate_tokens(&[call]) > 0);
    }
}
