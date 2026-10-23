//! The conversation model the engine reasons in, independent of any provider's wire format
//! and of the client protocol. The transcript on disk and every request to a model are built
//! from these types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
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
#[serde(tag = "role", rename_all = "camelCase")]
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
}
