//! Agent events → log events. Pure, so the translation is tested without a server.

use std::collections::HashMap;

use fv_agent::{AgentEvent, BlockKind};
use fv_core::ContentBlock;
use fv_protocol::types::Item;
use serde_json::Value;

use crate::log::LogEvent;

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Thinking,
    ToolCall,
}

/// Remembers which block is which, since a delta names only its block's id.
pub struct EventMapper {
    turn_id: String,
    kinds: HashMap<String, Kind>,
    /// Tool calls whose arguments are known (set when the block is done) but whose item
    /// completes only when the result arrives.
    calls: HashMap<String, (String, Value)>,
}

impl EventMapper {
    pub fn new(turn_id: String) -> Self {
        Self {
            turn_id,
            kinds: HashMap::new(),
            calls: HashMap::new(),
        }
    }

    pub fn map(&mut self, event: AgentEvent) -> Vec<LogEvent> {
        let turn_id = self.turn_id.clone();
        match event {
            AgentEvent::BlockStarted { id, kind } => {
                let (k, item) = match kind {
                    BlockKind::Text => (
                        Kind::Text,
                        Item::AgentMessage {
                            id: id.clone(),
                            text: String::new(),
                        },
                    ),
                    BlockKind::Thinking => (
                        Kind::Thinking,
                        Item::Reasoning {
                            id: id.clone(),
                            text: String::new(),
                        },
                    ),
                    BlockKind::ToolCall { name } => (
                        Kind::ToolCall,
                        Item::ToolCall {
                            id: id.clone(),
                            name,
                            arguments: Value::Null,
                            output: None,
                            is_error: false,
                        },
                    ),
                };
                self.kinds.insert(id, k);
                vec![LogEvent::ItemStarted { turn_id, item }]
            }
            AgentEvent::BlockDelta { id, delta } => match self.kinds.get(&id) {
                Some(Kind::Text) => vec![LogEvent::TextDelta {
                    turn_id,
                    item_id: id,
                    delta,
                }],
                Some(Kind::Thinking) => vec![LogEvent::ReasoningDelta {
                    turn_id,
                    item_id: id,
                    delta,
                }],
                Some(Kind::ToolCall) => vec![LogEvent::ToolArgsDelta {
                    turn_id,
                    item_id: id,
                    delta,
                }],
                None => Vec::new(),
            },
            AgentEvent::BlockDone { id, block } => match block {
                ContentBlock::Text { text } => {
                    vec![LogEvent::ItemCompleted {
                        turn_id,
                        item: Item::AgentMessage { id, text },
                    }]
                }
                ContentBlock::Thinking { text, .. } => {
                    vec![LogEvent::ItemCompleted {
                        turn_id,
                        item: Item::Reasoning { id, text },
                    }]
                }
                ContentBlock::ToolCall {
                    name, arguments, ..
                } => {
                    self.calls.insert(id, (name, arguments));
                    Vec::new()
                }
            },
            AgentEvent::MessageDone(_) | AgentEvent::Committed(_) => Vec::new(),
            AgentEvent::ToolResult {
                call_id,
                name,
                arguments,
                output,
                is_error,
            } => {
                let (name, arguments) = self.calls.remove(&call_id).unwrap_or((name, arguments));
                vec![LogEvent::ItemCompleted {
                    turn_id,
                    item: Item::ToolCall {
                        id: call_id,
                        name,
                        arguments,
                        output: Some(output),
                        is_error,
                    },
                }]
            }
        }
    }
}
