use fv_core::{ContentBlock, Message};
use fv_protocol::types::{Item, Turn};

/// A conversation's messages as the turns and items a client draws, for a thread that has
/// been closed and is being opened again.
///
/// Ids are derived from position (`t3`, `t3i7`), so the same transcript always yields the same
/// ids. A turn that failed or was stopped leaves no trace beyond its messages: an error item
/// has no message of its own.
pub fn turns_from_history(messages: &[Message]) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    for message in messages {
        match message {
            Message::User { text } => {
                let turn = format!("t{}", turns.len());
                turns.push(Turn {
                    id: turn.clone(),
                    items: vec![Item::UserMessage {
                        id: format!("{turn}i0"),
                        text: text.clone(),
                    }],
                });
            }
            Message::Assistant(a) => {
                let Some(turn) = turns.last_mut() else {
                    continue;
                };
                for block in &a.content {
                    let id = format!("{}i{}", turn.id, turn.items.len());
                    match block {
                        ContentBlock::Text { text } if !text.is_empty() => {
                            turn.items.push(Item::AgentMessage {
                                id,
                                text: text.clone(),
                            })
                        }
                        ContentBlock::Thinking { text, .. } if !text.trim().is_empty() => {
                            turn.items.push(Item::Reasoning {
                                id,
                                text: text.clone(),
                            });
                        }
                        // A tool call is identified by the model's call id, which the live
                        // stream also uses, so a client can match the two.
                        ContentBlock::ToolCall {
                            id,
                            name,
                            arguments,
                        } => turn.items.push(Item::ToolCall {
                            id: id.clone(),
                            name: name.clone(),
                            arguments: arguments.clone(),
                            output: None,
                            is_error: false,
                        }),
                        _ => {}
                    }
                }
            }
            // Pictures a tool returned; the tool's item already shows what it did.
            Message::ToolImages { .. } => {}
            // A divider where the conversation was summarized. The messages before it are
            // still in the transcript, and still drawn: only the model stops seeing them.
            Message::Compaction { .. } => {
                let turn = format!("t{}", turns.len());
                turns.push(Turn {
                    id: turn.clone(),
                    items: vec![Item::ContextCompaction {
                        id: format!("{turn}i0"),
                    }],
                });
            }
            Message::ToolResult {
                call_id,
                content,
                is_error: failed,
                ..
            } => {
                let Some(turn) = turns.last_mut() else {
                    continue;
                };
                for item in &mut turn.items {
                    if let Item::ToolCall {
                        id,
                        output,
                        is_error,
                        ..
                    } = item
                        && id == call_id
                    {
                        *output = Some(content.clone());
                        *is_error = *failed;
                    }
                }
            }
        }
    }
    turns
}
