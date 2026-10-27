use fv_core::{ContentBlock, Message};
use fv_protocol::types::{Item, Turn};

/// A conversation's messages as the turns and items a client draws, for a thread that has
/// been closed and is being opened again.
///
/// Ids are derived from position (`t3`, `t3i7`), so the same transcript always yields the same
/// ids. This is also the fallback for old transcripts without turn boundaries; new stored
/// transcripts use [`crate::Loaded::turns`] so errors with no assistant message survive.
pub fn turns_from_history(messages: &[Message]) -> Vec<Turn> {
    turns_from_timed_history(messages, &[])
}

/// [`turns_from_history`], with each message's write time (parallel to `messages`; may be
/// empty) giving the turns their start, end of work and end.
pub fn turns_from_timed_history(messages: &[Message], times: &[i64]) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    for (i, message) in messages.iter().enumerate() {
        if matches!(message, Message::MemoryContext { .. }) {
            continue;
        }
        let at = times.get(i).copied();
        if !matches!(message, Message::User { .. } | Message::Compaction { .. })
            && let Some(turn) = turns.last_mut()
            && at.is_some()
        {
            turn.completed_at = at;
        }
        match message {
            Message::User { text } => {
                let turn = format!("t{}", turns.len());
                let mut t = Turn::new(
                    turn.clone(),
                    vec![Item::UserMessage {
                        id: format!("{turn}i0"),
                        text: text.clone(),
                    }],
                );
                t.started_at = at;
                turns.push(t);
            }
            Message::Assistant(a) => {
                let Some(turn) = turns.last_mut() else {
                    continue;
                };
                for block in &a.content {
                    let id = format!("{}i{}", turn.id, turn.items.len());
                    match block {
                        ContentBlock::HostedSearch(call) => {
                            turn.items.push(fv_protocol::types::hosted_search_item(
                                call.id.clone(),
                                serde_json::to_value(call).unwrap(),
                                true,
                                matches!(
                                    call.status,
                                    fv_core::SearchStatus::Failed
                                        | fv_core::SearchStatus::Interrupted
                                ),
                            ));
                        }
                        ContentBlock::Citations { .. } => (),
                        ContentBlock::Text { text } if !text.is_empty() => {
                            turn.items.push(Item::AgentMessage {
                                id,
                                text: fv_core::strip_memory_citation(text),
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
            Message::ToolImages {
                call_id,
                name,
                images,
            } => {
                let Some(turn) = turns.last_mut() else {
                    continue;
                };
                use base64::Engine;
                for (index, image) in images.iter().enumerate() {
                    let data = match &image.source {
                        fv_core::ImageSource::Base64 { data } => data.clone(),
                        fv_core::ImageSource::File { path } => match std::fs::read(path) {
                            Ok(bytes) => base64::engine::general_purpose::STANDARD.encode(bytes),
                            Err(_) => continue,
                        },
                    };
                    turn.items.push(Item::Image {
                        id: format!("{call_id}:image:{index}"),
                        name: name.clone(),
                        mime: image.mime.clone(),
                        data,
                    });
                }
            }
            Message::MemoryContext { .. } => {}
            Message::ToolAudio {
                call_id,
                name,
                audio,
            } => {
                let Some(turn) = turns.last_mut() else {
                    continue;
                };
                use base64::Engine;
                for (index, clip) in audio.iter().enumerate() {
                    let data = match &clip.source {
                        fv_core::AudioSource::Base64 { data } => data.clone(),
                        fv_core::AudioSource::File { path } => match std::fs::read(path) {
                            Ok(bytes) => base64::engine::general_purpose::STANDARD.encode(bytes),
                            Err(_) => continue,
                        },
                    };
                    turn.items.push(Item::Audio {
                        id: format!("{call_id}:audio:{index}"),
                        name: name.clone(),
                        mime: clip.mime.clone(),
                        data,
                    });
                }
            }
            // A divider where the conversation was summarized. The messages before it are
            // still in the transcript, and still drawn: only the model stops seeing them.
            Message::Compaction { .. } => {
                let turn = format!("t{}", turns.len());
                let mut t = Turn::new(
                    turn.clone(),
                    vec![Item::ContextCompaction {
                        id: format!("{turn}i0"),
                    }],
                );
                t.started_at = at;
                t.completed_at = at;
                turns.push(t);
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
                if at.is_some() {
                    turn.process_ended_at = at;
                }
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
