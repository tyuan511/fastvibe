//! Making room: when a conversation nears the model's context window, the model is asked to
//! write a note for whoever continues, and the history is replaced by that note and the user's
//! own words. Modelled on codex's inline compaction (`codex/compact.rs`): the same prompt, the
//! same bridge. Oversized input is processed incrementally against the learned capacity,
//! so older evidence is summarized rather than dropped.

use fv_core::{Message, estimate_tokens};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::event::AgentEvent;
use crate::model::Model;
use crate::turn::AgentContext;

/// Codex's summarization prompt, from `core/templates/compact/prompt.md` (Apache-2.0).
pub const SUMMARIZATION_PROMPT: &str = "You have exceeded the maximum number of tokens, please stop coding and instead write a short memento message for the next agent. Your note should:\n- Summarize what you finished and what still needs work. If there was a recent update_plan call, repeat its steps verbatim.\n- List outstanding TODOs with file paths / line numbers so they're easy to find.\n- Flag code that needs more tests (edge cases, performance, integration, etc.).\n- Record any open bugs, quirks, or setup steps that will make it easier for the next agent to pick up where you left off.";

/// Used when a model does not say what its window is. A model with a smaller one fails once,
/// and the overflow is answered by a compaction.
pub const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;

/// Compact when this much of the window is in use.
const TRIGGER_PERCENT: u64 = 90;

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

pub fn effective_context_window(ctx: &AgentContext) -> u64 {
    ctx.budget.window(ctx.model.as_ref())
}

pub(crate) fn input_limit(ctx: &AgentContext) -> u64 {
    let window = effective_context_window(ctx);
    let threshold = window.saturating_mul(TRIGGER_PERCENT) / 100;
    if ctx.budget.learned(ctx.model.as_ref()) {
        threshold.min(
            window
                .saturating_sub(crate::budget::reply_reserve(ctx.model.as_ref(), window))
                .saturating_sub(crate::budget::margin(window)),
        )
    } else {
        threshold
    }
}

pub fn needs_compaction(ctx: &AgentContext, history: &[Message]) -> bool {
    crate::budget::request_tokens(&crate::turn::model_request(ctx, history)) >= input_limit(ctx)
}

#[derive(Debug, PartialEq, Eq)]
pub enum CompactError {
    Interrupted,
    Failed(String),
    /// Distinct from transport/auth failures: only capacity failures can stop automatic
    /// continuations until the user edits history, changes the route or probes manually.
    Capacity(String),
}

/// Explicit compaction probes the declared capacity again. Cancellation and any failure
/// restore the previous protection; a valid published checkpoint commits the new budget.
pub async fn compact(
    ctx: &AgentContext,
    history: &mut Vec<Message>,
    events: &mpsc::UnboundedSender<AgentEvent>,
    cancel: &CancellationToken,
) -> Result<(), CompactError> {
    let mut probe = ctx.budget.probe(ctx.model.as_ref());
    let result = compact_inner(ctx, history, events, cancel, false).await;
    if result.is_ok() {
        probe.commit();
    }
    drop(probe);
    if result.is_err() {
        let _ = events.send(AgentEvent::ContextBudgetChanged {
            used: crate::budget::request_tokens(&crate::turn::model_request(ctx, history)),
            window: effective_context_window(ctx),
        });
    }
    result
}

/// How much of the last answer survives a compaction word for word.
const RETAINED_ANSWER_CHARS: usize = 4_000;

/// The conversation's last answer, when it is plain text: the summary says what happened, but the
/// reply the user just read is what their next message is about, and a summary rewords it.
fn retained_answer(history: &[Message]) -> Option<Message> {
    let Some(Message::Assistant(last)) = history.last() else {
        return None;
    };
    if last.stop != fv_core::StopReason::Stop
        || last
            .content
            .iter()
            .any(|b| matches!(b, fv_core::ContentBlock::ToolCall { .. }))
    {
        return None;
    }
    let text: String = last
        .content
        .iter()
        .filter_map(|b| match b {
            fv_core::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let text = if text.chars().count() > RETAINED_ANSWER_CHARS {
        let cut: String = text.chars().take(RETAINED_ANSWER_CHARS).collect();
        format!("{cut}\n[… the rest of this answer was left out]")
    } else {
        text.to_string()
    };
    Some(Message::Assistant(fv_core::AssistantMessage {
        duration_ms: None,
        content: vec![fv_core::ContentBlock::Text { text }],
        stop: fv_core::StopReason::Stop,
        usage: Default::default(),
        model: None,
    }))
}

pub(crate) async fn compact_auto(
    ctx: &AgentContext,
    history: &mut Vec<Message>,
    events: &mpsc::UnboundedSender<AgentEvent>,
    cancel: &CancellationToken,
) -> Result<(), CompactError> {
    compact_inner(ctx, history, events, cancel, true).await
}

async fn compact_inner(
    ctx: &AgentContext,
    history: &mut Vec<Message>,
    events: &mpsc::UnboundedSender<AgentEvent>,
    cancel: &CancellationToken,
    require_smaller: bool,
) -> Result<(), CompactError> {
    let id = uuid::Uuid::new_v4().to_string();
    let _ = events.send(AgentEvent::CompactionStarted { id: id.clone() });
    let result = async {
        let before = crate::budget::request_tokens(&crate::turn::model_request(ctx, history));
        let (summary, usage) = crate::compact_input::summarize(ctx, history, events, cancel).await?;
        if cancel.is_cancelled() { return Err(CompactError::Interrupted); }
        let mut user_messages = Vec::new();
        for m in history.iter() {
            match m {
                Message::Compaction { user_messages: earlier, .. } => user_messages.extend(earlier.iter().cloned()),
                Message::User { text } => user_messages.push(text.clone()),
                _ => {}
            }
        }
        let message = Message::Compaction {
            usage, model: ctx.model.label().map(str::to_owned), user_messages, summary: summary.clone(),
        };
        let retained = retained_answer(history);
        // Check the ordinary request's projection, including the memory map that will be
        // re-injected, system instructions and tools. Do not publish an unusable checkpoint.
        let mut proposed = vec![message.clone()];
        proposed.extend(retained.clone());
        if let Some(summary) = ctx.memory.as_ref().and_then(|m| m.snapshot()) {
            proposed.push(Message::MemoryContext { summary });
        }
        let after = crate::budget::request_tokens(&crate::turn::model_request(ctx, &proposed));
        if after >= input_limit(ctx) || (require_smaller && after >= before) {
            return Err(CompactError::Capacity("The summary and required instructions still do not leave enough context space to continue.".into()));
        }
        if cancel.is_cancelled() { return Err(CompactError::Interrupted); }
        let _ = events.send(AgentEvent::Committed(message.clone()));
        history.clear();
        history.push(message);
        if let Some(answer) = retained {
            let _ = events.send(AgentEvent::Committed(answer.clone()));
            history.push(answer);
        }
        let _ = events.send(AgentEvent::CompactionDone { id: id.clone(), summary });
        let _ = events.send(AgentEvent::ContextBudgetChanged { used: after, window: effective_context_window(ctx) });
        Ok(())
    }.await;
    if result.is_err() {
        let _ = events.send(AgentEvent::CompactionFailed { id });
    }
    result
}
