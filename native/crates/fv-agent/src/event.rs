use fv_core::{AssistantMessage, ContentBlock, Message};
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
    HostedSearch(fv_core::WebSearchCall),
    ContextBudgetChanged {
        used: u64,
        window: u64,
    },
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
    /// A message was added to the history, in the order the history has it. This is what
    /// gets written to the transcript: persisting from here, rather than from the finished
    /// history, means a crash loses at most the message being written.
    Committed(Message),
    /// The conversation is being summarized to make room.
    CompactionStarted {
        id: String,
    },
    CompactionDone {
        id: String,
        summary: String,
        /// Why and by how much, when the summary was measured.
        stats: Option<fv_core::CompactionStats>,
    },
    CompactionFailed {
        id: String,
    },
    NestedToolStarted {
        parent_id: String,
        call_id: String,
        name: String,
        arguments: Value,
    },
    NestedToolFinished {
        parent_id: String,
        call_id: String,
        name: String,
        arguments: Value,
        output: String,
        is_error: bool,
    },
    ToolResult {
        call_id: String,
        name: String,
        arguments: Value,
        output: String,
        is_error: bool,
    },
}
