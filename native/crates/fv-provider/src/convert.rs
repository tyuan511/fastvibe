//! FastVibe messages ⇄ genai's.

use std::collections::HashSet;

use fv_agent::{ModelRequest, ToolSpec};
use fv_core::{AssistantMessage, ContentBlock, ImagePart, ImageSource, Message, StopReason, Usage};
use genai::chat::{
    Binary, ChatMessage, ChatRequest, ContentPart, MessageContent, StopReason as GenaiStop,
    StreamEnd, Tool, ToolCall, ToolResponse, Usage as GenaiUsage,
};

pub fn to_chat_request(request: &ModelRequest, model_label: &str, images_ok: bool) -> ChatRequest {
    let mut chat = ChatRequest::default();
    if !request.system.is_empty() {
        chat = chat.with_system(request.system.clone());
    }
    if !request.tools.is_empty() {
        chat = chat.with_tools(
            request
                .tools
                .iter()
                .filter(|s| s.name != "web_search")
                .map(to_tool)
                .collect::<Vec<_>>(),
        );
    }
    // Pictures tool calls returned wait here until the run of tool results they follow ends:
    // a provider wants every tool message right after the call, so the pictures go in one
    // user turn after all of them.
    let mut pictures: Vec<ContentPart> = Vec::new();
    for message in &request.messages {
        if !matches!(message, Message::ToolImages { .. }) && !pictures.is_empty() {
            chat = chat.append_message(ChatMessage::user(MessageContent::from_parts(
                std::mem::take(&mut pictures),
            )));
        }
        match message {
            Message::ToolAudio { .. } => {}
            Message::ToolImages { name, images, .. } => {
                pictures.extend(picture_parts(name, images, images_ok));
            }
            Message::User { text } => chat = chat.append_message(ChatMessage::user(text.clone())),
            Message::MemoryContext { summary } => {
                chat = chat.append_message(ChatMessage::user(Message::memory_context_text(summary)))
            }
            // `normalize` has turned these into user messages already; this is only for a caller
            // that did not use it.
            Message::Compaction {
                user_messages,
                summary,
                ..
            } => {
                chat = chat.append_message(ChatMessage::user(Message::compaction_text(
                    user_messages,
                    summary,
                )));
            }
            Message::Assistant(a) => {
                if let Some(m) = assistant_message(a, model_label) {
                    chat = chat.append_message(m);
                }
            }
            Message::ToolResult {
                call_id,
                name,
                content,
                ..
            } => {
                let response =
                    ToolResponse::new(call_id.clone(), content.clone()).with_fn_name(name.clone());
                chat = chat.append_message(ChatMessage::from(response));
            }
        }
    }
    if !pictures.is_empty() {
        chat = chat.append_message(ChatMessage::user(MessageContent::from_parts(pictures)));
    }
    chat
}

/// What a tool's pictures become in the request. A file that has gone away, or a model that
/// cannot see, leaves a sentence saying so rather than nothing: the model should know
/// something was there.
fn picture_parts(tool: &str, images: &[ImagePart], images_ok: bool) -> Vec<ContentPart> {
    use base64::Engine;
    if !images_ok {
        return vec![ContentPart::Text(format!(
            "[The `{tool}` tool returned an image, but this model cannot see images.]"
        ))];
    }
    let mut parts = vec![ContentPart::Text(format!(
        "Image returned by the `{tool}` tool:"
    ))];
    for image in images {
        let data = match &image.source {
            ImageSource::Base64 { data } => Some(data.clone()),
            ImageSource::File { path } => std::fs::read(path)
                .ok()
                .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
        };
        parts.push(match data {
            Some(data) => ContentPart::Binary(Binary::from_base64(image.mime.clone(), data, None)),
            None => ContentPart::Text("[The image is no longer available.]".into()),
        });
    }
    parts
}

fn to_tool(spec: &ToolSpec) -> Tool {
    Tool::new(spec.name.clone())
        .with_description(spec.description.clone())
        .with_schema(spec.schema.clone())
}

/// A reply as the model should see it again. Thinking comes first, as providers expect, and a
/// signature is only sent back to the model that wrote it: another provider rejects it.
fn assistant_message(a: &AssistantMessage, model_label: &str) -> Option<ChatMessage> {
    let own = a.model.as_deref() == Some(model_label);
    let mut parts: Vec<ContentPart> = Vec::new();
    for block in &a.content {
        if let ContentBlock::Thinking { text, signature } = block {
            match signature {
                Some(sig) if own => {
                    parts.push(ContentPart::ThoughtSignature(sig.clone()));
                    if !text.trim().is_empty() {
                        parts.push(ContentPart::ReasoningContent(text.clone()));
                    }
                }
                // Reasoning text without a usable signature is dropped: replaying it as plain
                // content would pass the model's thoughts off as its answer.
                _ => {}
            }
        }
    }
    for block in &a.content {
        match block {
            ContentBlock::Text { text } if !text.is_empty() => {
                parts.push(ContentPart::Text(text.clone()))
            }
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
            } => parts.push(ContentPart::ToolCall(ToolCall {
                call_id: id.clone(),
                fn_name: name.clone(),
                fn_arguments: arguments.clone(),
                thought_signatures: None,
            })),
            _ => {}
        }
    }
    (!parts.is_empty()).then(|| ChatMessage::assistant(MessageContent::from_parts(parts)))
}

/// What the stream delivered before its end, for when the end carries less than it should.
#[derive(Default)]
pub struct Streamed {
    pub text: String,
    pub reasoning: String,
}

pub fn assistant_from_end(
    end: StreamEnd,
    streamed: Streamed,
    model_label: &str,
) -> AssistantMessage {
    let mut blocks: Vec<ContentBlock> = Vec::new();
    let mut pending_signature: Option<String> = None;
    let mut saw_reasoning = false;
    let mut saw_text = false;

    let flush = |blocks: &mut Vec<ContentBlock>, pending: &mut Option<String>| {
        if let Some(signature) = pending.take() {
            blocks.push(ContentBlock::Thinking {
                text: String::new(),
                signature: Some(signature),
            });
        }
    };

    let parts = end
        .captured_content
        .map(MessageContent::into_parts)
        .unwrap_or_default();
    // Signatures mirrored onto the first tool call duplicate the leading ones; ours are kept once.
    let mut seen_calls = HashSet::new();
    for part in parts {
        match part {
            ContentPart::ThoughtSignature(s) => {
                if let Some(previous) = pending_signature.replace(s) {
                    blocks.push(ContentBlock::Thinking {
                        text: String::new(),
                        signature: Some(previous),
                    });
                }
            }
            ContentPart::ReasoningContent(text) => {
                saw_reasoning = true;
                blocks.push(ContentBlock::Thinking {
                    text,
                    signature: pending_signature.take(),
                });
            }
            ContentPart::Text(text) => {
                flush(&mut blocks, &mut pending_signature);
                saw_text = true;
                blocks.push(ContentBlock::Text { text });
            }
            ContentPart::ToolCall(call) => {
                flush(&mut blocks, &mut pending_signature);
                if seen_calls.insert(call.call_id.clone()) {
                    blocks.push(ContentBlock::ToolCall {
                        id: call.call_id,
                        name: call.fn_name,
                        arguments: call.fn_arguments,
                    });
                }
            }
            _ => {}
        }
    }
    flush(&mut blocks, &mut pending_signature);

    // The end event is allowed to carry less than was streamed (it depends on what was captured);
    // what arrived is not thrown away.
    if !saw_reasoning {
        let text = end.captured_reasoning_content.unwrap_or(streamed.reasoning);
        if !text.is_empty() {
            // Keep a signature-only block's signature on the reasoning it belongs to.
            let at = blocks
                .iter()
                .position(|b| matches!(b, ContentBlock::Thinking { text, .. } if text.is_empty()));
            match at {
                Some(i) => {
                    if let ContentBlock::Thinking { text: slot, .. } = &mut blocks[i] {
                        *slot = text;
                    }
                }
                None => blocks.insert(
                    0,
                    ContentBlock::Thinking {
                        text,
                        signature: None,
                    },
                ),
            }
        }
    }
    if !saw_text && !streamed.text.is_empty() {
        let at = blocks
            .iter()
            .position(|b| matches!(b, ContentBlock::ToolCall { .. }))
            .unwrap_or(blocks.len());
        blocks.insert(
            at,
            ContentBlock::Text {
                text: streamed.text,
            },
        );
    }

    let has_calls = blocks
        .iter()
        .any(|b| matches!(b, ContentBlock::ToolCall { .. }));
    let stop = match end.captured_stop_reason {
        Some(GenaiStop::MaxTokens(_)) => StopReason::Length,
        Some(GenaiStop::ContentFilter(_)) => StopReason::Error {
            message: "The reply was blocked by the provider's content filter.".into(),
        },
        _ if has_calls => StopReason::ToolUse,
        _ => StopReason::Stop,
    };
    AssistantMessage {
        duration_ms: None,
        content: blocks,
        stop,
        usage: end.captured_usage.as_ref().map(usage).unwrap_or_default(),
        model: Some(model_label.to_string()),
    }
}

/// genai reports `prompt_tokens` as the whole input, cache included. FastVibe counts input
/// without the cached part, so the hit rate `cacheRead / (input + cacheRead)` means something.
pub fn usage(u: &GenaiUsage) -> Usage {
    let n = |v: Option<i32>| v.unwrap_or(0).max(0) as u64;
    let details = u.prompt_tokens_details.as_ref();
    let cache_read = n(details.and_then(|d| d.cached_tokens));
    let cache_write = n(details.and_then(|d| d.cache_creation_tokens));
    Usage {
        input_tokens: n(u.prompt_tokens).saturating_sub(cache_read + cache_write),
        output_tokens: n(u.completion_tokens),
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
    }
}
