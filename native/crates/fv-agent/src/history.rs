use std::collections::HashSet;

use fv_core::{ContentBlock, Message};

const MISSING_RESULT: &str = "The tool call did not finish (no result was recorded).";

/// The history as a provider should see it: every tool call is answered, by the result that
/// directly follows it, and nothing answers a call that was never made.
///
/// A turn can end between a call and its result (the app quit, the run was stopped, a
/// transcript was cut), and providers reject a call with no result. Rather than refuse the
/// conversation, the gap is filled with an error result; stray results are dropped.
pub fn normalize(history: &[Message]) -> Vec<Message> {
    let mut out = Vec::with_capacity(history.len());
    // Calls from the last assistant message still waiting for their result: (id, name).
    let mut pending: Vec<(String, String)> = Vec::new();

    fn close(out: &mut Vec<Message>, pending: &mut Vec<(String, String)>) {
        for (call_id, name) in pending.drain(..) {
            out.push(Message::ToolResult {
                call_id,
                name,
                content: MISSING_RESULT.into(),
                is_error: true,
            });
        }
    }

    for message in history {
        match message {
            Message::ToolResult { call_id, .. } => {
                if let Some(at) = pending.iter().position(|(id, _)| id == call_id) {
                    pending.remove(at);
                    out.push(message.clone());
                }
                // else: orphan, dropped
            }
            other => {
                close(&mut out, &mut pending);
                if let Message::Assistant(a) = other {
                    let mut seen = HashSet::new();
                    pending = a
                        .content
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolCall { id, name, .. } if seen.insert(id.clone()) => {
                                Some((id.clone(), name.clone()))
                            }
                            _ => None,
                        })
                        .collect();
                }
                match other {
                    Message::MemoryContext { summary } => out.push(Message::User {
                        text: Message::memory_context_text(summary),
                    }),
                    // What a compaction replaced is shown to the model as one user message.
                    Message::Compaction {
                        user_messages,
                        summary,
                        ..
                    } => out.push(Message::User {
                        text: Message::compaction_text(user_messages, summary),
                    }),
                    _ => out.push(other.clone()),
                }
            }
        }
    }
    close(&mut out, &mut pending);
    out
}
