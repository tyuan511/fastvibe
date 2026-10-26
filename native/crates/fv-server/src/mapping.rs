//! Agent events → log events. Pure, so the translation is tested without a server.

use std::collections::HashMap;

use fv_agent::{AgentEvent, BlockKind};
use fv_core::ContentBlock;
use fv_protocol::types::{Item, PlanStep};
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
    window: u64,
    kinds: HashMap<String, Kind>,
    /// Tool calls whose arguments are known (set when the block is done) but whose item
    /// completes only when the result arrives.
    calls: HashMap<String, (String, Value)>,
}

impl EventMapper {
    pub fn new(turn_id: String, window: u64) -> Self {
        Self {
            turn_id,
            window,
            kinds: HashMap::new(),
            calls: HashMap::new(),
        }
    }

    pub fn map(&mut self, event: AgentEvent) -> Vec<LogEvent> {
        let turn_id = self.turn_id.clone();
        match event {
            AgentEvent::ContextBudgetChanged { used, window } => {
                self.window = window;
                vec![LogEvent::TokenUsage { used, window }]
            }
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
                        item: Item::AgentMessage {
                            id,
                            text: fv_core::strip_memory_citation(&text),
                        },
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
            // The provider's count of that request, plus the reply: what the next request starts from.
            AgentEvent::MessageDone(m) => {
                let u = &m.usage;
                let used =
                    u.input_tokens + u.cache_read_tokens + u.cache_write_tokens + u.output_tokens;
                if used == 0 {
                    return Vec::new();
                }
                vec![LogEvent::TokenUsage {
                    used,
                    window: self.window,
                }]
            }
            AgentEvent::Committed(message) => match message {
                fv_core::Message::User { .. }
                | fv_core::Message::Assistant(_)
                | fv_core::Message::Compaction { .. } => vec![LogEvent::StatsMessage(message)],
                _ => Vec::new(),
            },
            AgentEvent::CompactionStarted { id } => vec![LogEvent::ItemStarted {
                turn_id,
                item: Item::ContextCompaction { id },
            }],
            // A failed one is closed too, so no client is left showing it in progress; the
            // turn reports the failure itself.
            AgentEvent::CompactionDone { id, .. } | AgentEvent::CompactionFailed { id } => {
                vec![LogEvent::ItemCompleted {
                    turn_id,
                    item: Item::ContextCompaction { id },
                }]
            }
            AgentEvent::ToolResult {
                call_id,
                name,
                arguments,
                output,
                is_error,
            } => {
                let (name, arguments) = self.calls.remove(&call_id).unwrap_or((name, arguments));
                // `update_plan` carries its checklist in its arguments; clients get it as an event.
                let plan = (name == "update_plan" && !is_error)
                    .then(|| plan_from(&arguments))
                    .flatten();
                let mut out = vec![LogEvent::ItemCompleted {
                    turn_id: turn_id.clone(),
                    item: Item::ToolCall {
                        id: call_id,
                        name,
                        arguments,
                        output: Some(output),
                        is_error,
                    },
                }];
                if let Some((explanation, plan)) = plan {
                    out.push(LogEvent::PlanUpdated {
                        turn_id,
                        explanation,
                        plan,
                    });
                }
                out
            }
        }
    }
}

fn plan_from(arguments: &Value) -> Option<(Option<String>, Vec<PlanStep>)> {
    #[derive(serde::Deserialize)]
    struct Args {
        explanation: Option<String>,
        plan: Vec<PlanStep>,
    }
    let args: Args = serde_json::from_value(arguments.clone()).ok()?;
    Some((args.explanation, args.plan))
}
