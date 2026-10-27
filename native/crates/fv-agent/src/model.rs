use futures_util::stream::BoxStream;
use fv_core::{AssistantMessage, Message};

use crate::tool::ToolSpec;

#[derive(Clone, Debug, PartialEq)]
pub struct ModelRequest {
    pub system: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    /// Per-request capacity guard. Providers also respect their configured output limit.
    pub max_output_tokens: Option<u32>,
}

/// What a provider streams back. `Done` carries the complete message and is authoritative:
/// the deltas before it exist only so a client can draw the reply as it arrives.
#[derive(Clone, Debug, PartialEq)]
pub enum ModelEvent {
    HostedSearch(fv_core::WebSearchCall),
    Citations(Vec<fv_core::UrlCitation>),
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
    /// The request was larger than the model's context window. Asking again as it is cannot
    /// work; summarizing the conversation can.
    pub overflow: bool,
}

impl ModelError {
    pub fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            overflow: false,
        }
    }

    pub fn context_overflow(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            overflow: true,
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
    /// Stable physical route identity, excluding credentials. Unconfigured/test models use
    /// instance identity so unrelated models never share a learned limit accidentally.
    fn context_key(&self) -> String {
        format!("{}:{:p}", std::any::type_name::<Self>(), self)
    }

    fn max_output_tokens(&self) -> Option<u32> {
        None
    }
    /// Whether the model can look at images. A tool that returns one (`view_image`) refuses
    /// when it cannot.
    fn supports_web_search(&self) -> bool {
        false
    }

    fn supports_images(&self) -> bool {
        true
    }

    /// The context window in tokens, when it is known.
    fn context_window(&self) -> Option<u32> {
        None
    }

    /// `provider/model`, as it is recorded on every reply and priced by the catalog. Absent for
    /// a model that has no configuration behind it (a scripted test model).
    fn label(&self) -> Option<&str> {
        None
    }

    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>>;
}
