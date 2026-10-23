use futures_util::stream::BoxStream;
use fv_core::{AssistantMessage, Message};

use crate::tool::ToolSpec;

#[derive(Clone, Debug, PartialEq)]
pub struct ModelRequest {
    pub system: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
}

/// What a provider streams back. `Done` carries the complete message and is authoritative:
/// the deltas before it exist only so a client can draw the reply as it arrives.
#[derive(Clone, Debug, PartialEq)]
pub enum ModelEvent {
    Text(String),
    Thinking(String),
    ToolCallStart { id: String, name: String },
    ToolCallArgs { id: String, delta: String },
    Done(AssistantMessage),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelError {
    pub message: String,
    /// Whether asking again might work (429, 5xx, a dropped connection). The provider layer
    /// retries these itself before the error ever reaches the loop.
    pub retryable: bool,
}

impl ModelError {
    pub fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ModelError {}

/// A model the loop can sample. Dropping the stream cancels the request.
pub trait Model: Send + Sync {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>>;
}
