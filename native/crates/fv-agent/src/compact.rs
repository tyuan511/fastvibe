//! Making room: when a conversation nears the model's context window, the model is asked to
//! write a note for whoever continues, and the history is replaced by that note and the user's
//! own words. Modelled on codex's inline compaction (`codex/compact.rs`): the same prompt, the
//! same bridge, and the same answer to a prompt that is itself too big (drop the oldest
//! messages and ask again).

use futures_util::StreamExt;
use fv_core::{Message, estimate_tokens};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::event::AgentEvent;
use crate::history::normalize;
use crate::model::{Model, ModelEvent, ModelRequest};
use crate::turn::AgentContext;

/// Codex's summarization prompt, from `core/templates/compact/prompt.md` (Apache-2.0).
pub const SUMMARIZATION_PROMPT: &str = "You have exceeded the maximum number of tokens, please stop coding and instead write a short memento message for the next agent. Your note should:\n- Summarize what you finished and what still needs work. If there was a recent update_plan call, repeat its steps verbatim.\n- List outstanding TODOs with file paths / line numbers so they're easy to find.\n- Flag code that needs more tests (edge cases, performance, integration, etc.).\n- Record any open bugs, quirks, or setup steps that will make it easier for the next agent to pick up where you left off.";

/// Used when a model does not say what its window is. A model with a smaller one fails once,
/// and the overflow is answered by a compaction.
pub const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;

/// Compact when this much of the window is in use.
const TRIGGER_PERCENT: u64 = 90;
/// The text sent to be summarized is trimmed until it fits this much of the window, leaving
/// room for the note itself.
const FIT_PERCENT: u64 = 85;

pub fn context_window(model: &dyn Model) -> u64 {
    model
        .context_window()
        .map(u64::from)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

/// How much of the window the history takes. A provider's own count of the last request is
/// worth more than any estimate, so it is used for everything up to that reply, and the
/// estimate only for what has been added since.
pub fn context_used(history: &[Message]) -> u64 {
    let last = history.iter().rposition(|m| matches!(m, Message::Assistant(a) if a.usage.input_tokens + a.usage.cache_read_tokens + a.usage.cache_write_tokens > 0));
    match last {
        Some(i) => {
            let Message::Assistant(a) = &history[i] else {
                unreachable!()
            };
            let u = &a.usage;
            u.input_tokens
                + u.cache_read_tokens
                + u.cache_write_tokens
                + u.output_tokens
                + estimate_tokens(&history[i + 1..])
        }
        None => estimate_tokens(history),
    }
}

pub fn needs_compaction(ctx: &AgentContext, history: &[Message]) -> bool {
    context_used(history) * 100 >= context_window(ctx.model.as_ref()) * TRIGGER_PERCENT
}

#[derive(Debug, PartialEq, Eq)]
pub enum CompactError {
    /// The user stopped it; nothing changed.
    Interrupted,
    Failed(String),
}

/// Summarize the history and replace it. On any failure the history is left as it was.
pub async fn compact(
    ctx: &AgentContext,
    history: &mut Vec<Message>,
    events: &mpsc::UnboundedSender<AgentEvent>,
    cancel: &CancellationToken,
) -> Result<(), CompactError> {
    let id = uuid::Uuid::new_v4().to_string();
    let _ = events.send(AgentEvent::CompactionStarted { id: id.clone() });
    match summarize(ctx, history, cancel).await {
        Ok(summary) => {
            let mut user_messages = Vec::new();
            for m in history.iter() {
                match m {
                    Message::Compaction {
                        user_messages: earlier,
                        ..
                    } => user_messages.extend(earlier.iter().cloned()),
                    Message::User { text } => user_messages.push(text.clone()),
                    _ => {}
                }
            }
            let message = Message::Compaction {
                user_messages,
                summary: summary.clone(),
            };
            let _ = events.send(AgentEvent::Committed(message.clone()));
            history.clear();
            history.push(message);
            let _ = events.send(AgentEvent::CompactionDone { id, summary });
            Ok(())
        }
        Err(e) => {
            let _ = events.send(AgentEvent::CompactionFailed { id });
            Err(e)
        }
    }
}

async fn summarize(
    ctx: &AgentContext,
    history: &[Message],
    cancel: &CancellationToken,
) -> Result<String, CompactError> {
    let window = context_window(ctx.model.as_ref());
    let prompt = Message::User {
        text: SUMMARIZATION_PROMPT.to_string(),
    };
    let mut working = normalize(history);
    loop {
        // Too big to be sent: the oldest goes first. What is left is cleaned again, since
        // dropping a call leaves its result with nothing to answer.
        while working.len() > 1
            && estimate_tokens(&working) + estimate_tokens(std::slice::from_ref(&prompt))
                > window * FIT_PERCENT / 100
        {
            working.remove(0);
            working = normalize(&working);
        }
        let mut messages = working.clone();
        messages.push(prompt.clone());
        let request = ModelRequest {
            system: ctx.system.clone(),
            messages,
            tools: Vec::new(),
        };
        match collect_text(ctx.model.as_ref(), request, cancel).await {
            Ok(text) => return Ok(text),
            Err(Collect::Interrupted) => return Err(CompactError::Interrupted),
            Err(Collect::Failed { message, overflow }) => {
                if overflow && working.len() > 1 {
                    working.remove(0);
                    working = normalize(&working);
                    continue;
                }
                return Err(CompactError::Failed(if overflow {
                    "The conversation is too large to summarize.".to_string()
                } else {
                    message
                }));
            }
        }
    }
}

enum Collect {
    Interrupted,
    Failed { message: String, overflow: bool },
}

async fn collect_text(
    model: &dyn Model,
    request: ModelRequest,
    cancel: &CancellationToken,
) -> Result<String, Collect> {
    let mut stream = model.stream(request);
    let mut text = String::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Collect::Interrupted),
            next = stream.next() => next,
        };
        match next {
            None => {
                return Err(Collect::Failed {
                    message: "The model's response ended before it was complete.".into(),
                    overflow: false,
                });
            }
            Some(Err(e)) => {
                return Err(Collect::Failed {
                    message: e.message,
                    overflow: e.overflow,
                });
            }
            Some(Ok(ModelEvent::Text(d))) => text.push_str(&d),
            Some(Ok(ModelEvent::Done(message))) => {
                // The complete message is the truth; the deltas were only the way it arrived.
                let full = message.text();
                return Ok(if full.is_empty() { text } else { full });
            }
            Some(Ok(_)) => {}
        }
    }
}
