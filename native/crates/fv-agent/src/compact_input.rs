//! Pack complete conversation evidence into bounded summary requests. Oversized evidence
//! is serialized and processed incrementally; an overflow never silently drops its oldest
//! messages, and a later failure leaves the real history unchanged.

use futures_util::StreamExt;
use fv_core::{ContentBlock, ImageSource, Message, StopReason, Usage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    AgentContext, AgentEvent, CompactError, ModelEvent, ModelRequest, SUMMARIZATION_PROMPT,
};

fn request(ctx: &AgentContext, mut messages: Vec<Message>) -> ModelRequest {
    // Earlier usage measured an ordinary request with its tool declarations, not this
    // summary request. Providers do not send usage metadata back as content; clearing it
    // here sizes the actual projection without changing the persisted messages or billing.
    for message in &mut messages {
        if let Message::Assistant(reply) = message {
            reply.usage = Usage::default();
        }
    }
    ModelRequest {
        system: ctx.system.clone(),
        messages,
        tools: Vec::new(),
        max_output_tokens: Some(output_budget(ctx).max(1) as u32),
    }
}

fn input_budget(ctx: &AgentContext) -> u64 {
    let window = ctx.budget.window(ctx.model.as_ref());
    window
        .saturating_sub(output_budget(ctx))
        .saturating_sub(crate::budget::margin(window))
}

fn output_budget(ctx: &AgentContext) -> u64 {
    let window = ctx.budget.window(ctx.model.as_ref());
    let ordinary = crate::turn::model_request(ctx, &[]);
    let memory = ctx
        .memory
        .as_ref()
        .and_then(|m| m.snapshot())
        .map(|s| s.len() as u64 / 3 + 64)
        .unwrap_or(0);
    let room = crate::compact::input_limit(ctx)
        .saturating_sub(crate::budget::prefix_tokens(
            &format!("{}{}", ordinary.system, ctx.context),
            &ordinary.tools,
        ))
        .saturating_sub(memory)
        .saturating_sub(256);
    crate::budget::reply_reserve(ctx.model.as_ref(), window).min(room / 2)
}

fn check_output_room(ctx: &AgentContext) -> Result<(), CompactError> {
    if output_budget(ctx) < u64::from(ctx.model.max_output_tokens().unwrap_or(128).min(128)).max(1)
    {
        Err(capacity())
    } else {
        Ok(())
    }
}

fn prompt() -> Message {
    Message::User {
        text: SUMMARIZATION_PROMPT.into(),
    }
}
fn capacity() -> CompactError {
    CompactError::Capacity(
        "The conversation cannot be summarized within the model's actual context capacity.".into(),
    )
}

pub(crate) async fn summarize(
    ctx: &AgentContext,
    history: &[Message],
    events: &mpsc::UnboundedSender<AgentEvent>,
    cancel: &CancellationToken,
) -> Result<(String, Usage), CompactError> {
    if cancel.is_cancelled() {
        return Err(CompactError::Interrupted);
    }
    check_output_room(ctx)?;
    let authored: Vec<_> = history
        .iter()
        .filter(|m| !matches!(m, Message::MemoryContext { .. }))
        .cloned()
        .collect();
    let mut messages = crate::normalize(&authored);
    messages.push(prompt());
    let initial = request(ctx, messages);
    if crate::budget::request_tokens(&initial) <= input_budget(ctx) {
        match collect(ctx, initial.clone(), cancel).await {
            Ok(result) => return Ok(result),
            Err(CompactError::Capacity(_)) => {
                if !crate::turn::learn_capacity(ctx, &initial, events) {
                    return Err(capacity());
                }
            }
            Err(error) => return Err(error),
        }
    }
    let serialization = tokio::task::spawn_blocking(move || serialize(&authored));
    let mut source = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CompactError::Interrupted),
        result = serialization => result.map_err(|e| CompactError::Failed(format!("Cannot prepare the summary input: {e}")))?,
    };
    let mut cursor = 0;
    let mut summary = String::new();
    let mut total = Usage::default();
    let mut parts = 0;
    let mut repacks = 0;
    while cursor < source.len() {
        if cancel.is_cancelled() {
            return Err(CompactError::Interrupted);
        }
        if parts >= 4096 {
            return Err(capacity());
        }
        check_output_room(ctx)?;
        let previous = (!summary.is_empty()).then(|| Message::User {
            text: format!("Previous partial checkpoint (update it with the next part):\n{summary}"),
        });
        let skeleton = |part: &str| {
            let mut messages: Vec<_> = previous.clone().into_iter().collect();
            messages.push(Message::User {
                text: format!("Conversation evidence, next part:\n{part}"),
            });
            messages.push(prompt());
            request(ctx, messages)
        };
        let available =
            input_budget(ctx).saturating_sub(crate::budget::request_tokens(&skeleton("")));
        if available < 32 {
            // A summary from a larger window is itself evidence to repack. Never pin it as
            // an unbounded prefix after learning that the endpoint is smaller.
            if summary.is_empty() || repacks >= crate::budget::MAX_CAPACITY_RECOVERIES {
                return Err(capacity());
            }
            repacks += 1;
            source = format!("Previous checkpoint:\n{summary}\n\n{}", &source[cursor..]);
            cursor = 0;
            summary.clear();
            continue;
        }
        let length = take_bytes(
            &source[cursor..],
            available.saturating_mul(3).min(usize::MAX as u64) as usize,
        );
        if length == 0 {
            return Err(capacity());
        }
        let packed = skeleton(&source[cursor..cursor + length]);
        parts += 1;
        match collect(ctx, packed.clone(), cancel).await {
            Ok((next, usage)) => {
                summary = next;
                add_usage(&mut total, usage);
                cursor += length;
            }
            Err(CompactError::Capacity(_)) => {
                if !crate::turn::learn_capacity(ctx, &packed, events) {
                    return Err(capacity());
                }
                // Already accepted evidence is represented by the checkpoint. Pack that
                // checkpoint with everything not yet accepted against the smaller budget.
                source = format!("Previous checkpoint:\n{summary}\n\n{}", &source[cursor..]);
                cursor = 0;
                summary.clear();
            }
            Err(error) => return Err(error),
        }
    }
    if summary.trim().is_empty() {
        return Err(CompactError::Failed(
            "The model returned an empty summary.".into(),
        ));
    }
    Ok((summary, total))
}

fn take_bytes(text: &str, max: usize) -> usize {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == text.len() {
        return end;
    }
    text[..end]
        .rfind('\n')
        .filter(|line| *line > end / 2)
        .map_or(end, |line| line + 1)
}

fn add_usage(total: &mut Usage, next: Usage) {
    total.input_tokens = total.input_tokens.saturating_add(next.input_tokens);
    total.output_tokens = total.output_tokens.saturating_add(next.output_tokens);
    total.cache_read_tokens = total
        .cache_read_tokens
        .saturating_add(next.cache_read_tokens);
    total.cache_write_tokens = total
        .cache_write_tokens
        .saturating_add(next.cache_write_tokens);
}

fn serialize(messages: &[Message]) -> String {
    let mut out = String::new();
    for message in messages {
        match message {
            Message::User { text } => out.push_str(&format!("\nUSER:\n{text}\n")),
            Message::Assistant(a) => {
                for block in &a.content {
                    match block {
                        ContentBlock::HostedSearch(_) | ContentBlock::Citations { .. } => (),
                        ContentBlock::Text { text } => {
                            out.push_str(&format!("\nASSISTANT:\n{text}\n"))
                        }
                        ContentBlock::Thinking { text, .. } => {
                            out.push_str(&format!("\nASSISTANT REASONING:\n{text}\n"))
                        }
                        ContentBlock::ToolCall {
                            id,
                            name,
                            arguments,
                        } => out.push_str(&format!("\nTOOL CALL {id} {name}:\n{arguments}\n")),
                    }
                }
            }
            Message::ToolResult {
                call_id,
                name,
                content,
                is_error,
            } => out.push_str(&format!(
                "\nTOOL RESULT {call_id} {name} (error={is_error}):\n{content}\n"
            )),
            Message::Compaction {
                user_messages,
                summary,
                ..
            } => out.push_str(&format!(
                "\nEARLIER USER REQUIREMENTS:\n{}\nPREVIOUS CHECKPOINT:\n{summary}\n",
                user_messages.join("\n\n")
            )),
            Message::ToolImages {
                call_id, images, ..
            } => {
                out.push_str(&format!(
                    "\nIMAGES FROM {call_id}: {} image(s).\n",
                    images.len()
                ));
                for image in images {
                    if let ImageSource::File { path } = &image.source {
                        out.push_str(&format!("Image file: {path}\n"));
                    }
                }
            }
            Message::ToolAudio { call_id, audio, .. } => {
                out.push_str(&format!(
                    "\nAUDIO FROM {call_id}: {} clip(s).\n",
                    audio.len()
                ));
            }
            Message::MemoryContext { .. } => (),
        }
    }
    out
}

async fn collect(
    ctx: &AgentContext,
    request: ModelRequest,
    cancel: &CancellationToken,
) -> Result<(String, Usage), CompactError> {
    if cancel.is_cancelled() {
        return Err(CompactError::Interrupted);
    }
    let mut stream = ctx.model.stream(request);
    let mut text = String::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(CompactError::Interrupted),
            next = stream.next() => next,
        };
        match next {
            None => {
                return Err(CompactError::Failed(
                    "The model's response ended before it was complete.".into(),
                ));
            }
            Some(Err(error)) => {
                return Err(if error.overflow {
                    capacity()
                } else {
                    CompactError::Failed(error.message)
                });
            }
            Some(Ok(ModelEvent::Text(delta))) => text.push_str(&delta),
            Some(Ok(ModelEvent::Done(message))) => {
                match &message.stop {
                    StopReason::Aborted => return Err(CompactError::Interrupted),
                    StopReason::Length => return Err(capacity()),
                    StopReason::Stop => (),
                    StopReason::Error { message } => {
                        return Err(CompactError::Failed(message.clone()));
                    }
                    StopReason::ToolUse => {
                        return Err(CompactError::Failed(
                            "The summary unexpectedly requested tools.".into(),
                        ));
                    }
                }
                let full = message.text();
                let summary = if full.trim().is_empty() { text } else { full };
                if summary.trim().is_empty() {
                    return Err(CompactError::Failed(
                        "The model returned an empty summary.".into(),
                    ));
                }
                return Ok((summary, message.usage));
            }
            Some(Ok(_)) => (),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunk_boundaries_preserve_unicode_and_prefer_complete_lines() {
        assert_eq!(take_bytes("中文🙂tail", 5), 3);
        assert_eq!(take_bytes("aaaaa\nbbbbb", 8), 6);
        assert_eq!(take_bytes("🙂", 2), 0);
    }
}
