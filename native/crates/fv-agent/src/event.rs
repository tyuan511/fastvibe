use fv_core::{AssistantMessage, ContentBlock};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum BlockKind {
    Text,
    Thinking,
    ToolCall { name: String },
}

/// What a turn reports while it runs. Ids are the agent's own: one per content block, and a
/// tool call's block id is the call id the model gave it.
#[derive(Clone, Debug, PartialEq)]
pub enum AgentEvent {
    BlockStarted {
        id: String,
        kind: BlockKind,
    },
    BlockDelta {
        id: String,
        delta: String,
    },
    /// The block is complete; for a tool call this is the first time its arguments are parsed.
    BlockDone {
        id: String,
        block: ContentBlock,
    },
    /// One model request finished (carries its usage).
    MessageDone(AssistantMessage),
    ToolResult {
        call_id: String,
        name: String,
        arguments: Value,
        output: String,
        is_error: bool,
    },
}
