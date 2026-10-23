//! The conversation model the engine reasons in, independent of any provider's wire format
//! and of the client protocol. The transcript on disk and every request to a model are built
//! from these types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContentBlock {
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
