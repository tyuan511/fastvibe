use fv_core::{AssistantMessage, ContentBlock, ImagePart, ImageSource, Message, StopReason, Usage};
use fv_protocol::types::TurnStatus;
use fv_store::Store;
use serde_json::json;
fn assistant(block: ContentBlock) -> Message {
    Message::Assistant(AssistantMessage {
        duration_ms: None,
        content: vec![block],
        stop: StopReason::ToolUse,
        usage: Usage {
            input_tokens: 10,
            ..Default::default()
        },
        model: Some("custom/model".into()),
    })
}
fn pending() -> Message {
    assistant(ContentBlock::ToolCall {
        id: "reused".into(),
        name: "spawn_agent".into(),
        arguments: json!({"message":"child","fork_context":true}),
    })
}
#[test]
fn fork_snapshot_is_exact_complete_independent_and_does_not_double_bill() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.transcripts.start_turn("parent", "previous").unwrap();
    store
        .transcripts
        .append(
            "parent",
            &[
                Message::User {
                    text: "earlier context".into(),
                },
                assistant(ContentBlock::Text {
                    text: "previous answer".into(),
                }),
            ],
        )
        .unwrap();
    store
        .transcripts
        .finish_turn("parent", "previous", TurnStatus::Completed, None)
        .unwrap();
    store.transcripts.start_turn("parent", "current").unwrap();
    let picture = store
        .images
        .externalize(
            "parent",
            &Message::ToolImages {
                call_id: "picture".into(),
                name: "view_image".into(),
                images: vec![ImagePart {
                    mime: "image/png".into(),
                    source: ImageSource::Base64 {
                        data: "eA==".into(),
                    },
                }],
            },
        )
        .unwrap();
    store
        .transcripts
        .append(
            "parent",
            &[
                Message::User {
                    text: "latest parent input".into(),
                },
                assistant(ContentBlock::ToolCall {
                    id: "picture".into(),
                    name: "view_image".into(),
                    arguments: json!({"path":"image.png"}),
                }),
                Message::ToolResult {
                    call_id: "picture".into(),
                    name: "view_image".into(),
                    content: "picture".into(),
                    is_error: false,
                },
                picture,
                pending(),
            ],
        )
        .unwrap();
    assert!(
        store
            .transcripts
            .read("parent")
            .unwrap()
            .before_tool_call("previous", "reused", 7)
            .is_none()
    );
    assert!(
        store
            .transcripts
            .read("parent")
            .unwrap()
            .before_tool_call("current", "reused", 6)
            .is_none()
    );
    let snapshot = store
        .transcripts
        .read("parent")
        .unwrap()
        .before_tool_call("current", "reused", 7)
        .unwrap();
    assert_eq!(snapshot.messages.len(), 6);
    assert!(snapshot.turns().iter().all(|t| t.completed_at.is_some()));
    let messages = snapshot
        .messages
        .iter()
        .map(|m| store.images.copy_message("child", m))
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    store
        .transcripts
        .copy_loaded("child", &snapshot, &messages)
        .unwrap();
    assert_eq!(
        store.db.usage_records().unwrap().len(),
        3,
        "copied requests keep parent billing identity"
    );
    store.transcripts.delete("parent").unwrap();
    store.images.delete("parent").unwrap();
    let loaded = store.transcripts.read("child").unwrap();
    assert!(
        loaded
            .messages
            .iter()
            .any(|m| matches!(m,Message::User{text} if text=="latest parent input"))
    );
    for m in &loaded.messages {
        if let Message::ToolImages { images, .. } = m {
            for i in images {
                let ImageSource::File { path } = &i.source else {
                    panic!("picture must be owned")
                };
                assert_eq!(std::fs::read(path).unwrap(), b"x");
            }
        }
    }
    drop(store);
    let store = Store::open(dir.path()).unwrap();
    store.transcripts.capture_usage().unwrap();
    assert_eq!(store.db.usage_records().unwrap().len(), 3);
    assert_eq!(store.transcripts.read("child").unwrap().messages.len(), 6);
}
#[test]
fn reused_call_id_cannot_match_an_older_batch_and_compaction_boundary_is_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.transcripts.start_turn("parent", "current").unwrap();
    store
        .transcripts
        .append("parent", &[Message::User { text: "one".into() }, pending()])
        .unwrap();
    assert!(
        store
            .transcripts
            .read("parent")
            .unwrap()
            .before_tool_call("current", "reused", 4)
            .is_none()
    );
    store
        .transcripts
        .append(
            "parent",
            &[
                Message::ToolResult {
                    call_id: "reused".into(),
                    name: "spawn_agent".into(),
                    content: "earlier child".into(),
                    is_error: false,
                },
                pending(),
            ],
        )
        .unwrap();
    let snap = store
        .transcripts
        .read("parent")
        .unwrap()
        .before_tool_call("current", "reused", 4)
        .unwrap();
    assert_eq!(snap.messages.len(), 3);
    store
        .transcripts
        .append(
            "parent",
            &[
                Message::Compaction {
                    user_messages: vec!["one".into()],
                    summary: "summary".into(),
                    usage: Usage::default(),
                    model: None,
                    stats: None,
                },
                Message::User {
                    text: "after summary".into(),
                },
                pending(),
            ],
        )
        .unwrap();
    let snap = store
        .transcripts
        .read("parent")
        .unwrap()
        .before_tool_call("current", "reused", 3)
        .unwrap();
    assert!(
        matches!(fv_core::effective_history(&snap.messages).as_slice(),[Message::Compaction{..},Message::User{text}] if text=="after summary")
    );
}

#[test]
fn text_before_delegation_is_kept_without_copying_pending_calls_or_later_text() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.transcripts.start_turn("parent", "current").unwrap();
    let mut message = match pending() {
        Message::Assistant(a) => a,
        _ => unreachable!(),
    };
    message.content.insert(
        0,
        ContentBlock::Text {
            text: "current plan".into(),
        },
    );
    message.content.insert(
        1,
        ContentBlock::ToolCall {
            id: "earlier-in-batch".into(),
            name: "exec_command".into(),
            arguments: json!({}),
        },
    );
    message.content.insert(
        2,
        ContentBlock::Text {
            text: "additional context".into(),
        },
    );
    message.content.push(ContentBlock::Text {
        text: "after delegation".into(),
    });
    store
        .transcripts
        .append(
            "parent",
            &[
                Message::User {
                    text: "task".into(),
                },
                Message::Assistant(message),
            ],
        )
        .unwrap();
    let snapshot = store
        .transcripts
        .read("parent")
        .unwrap()
        .before_tool_call("current", "reused", 2)
        .unwrap();
    let Message::Assistant(message) = snapshot.messages.last().unwrap() else {
        panic!("missing assistant context")
    };
    assert!(
        message.text().contains("current plan") && message.text().contains("additional context")
    );
    assert!(!message.text().contains("after delegation"));
    assert_eq!(message.tool_calls().count(), 0);
    store
        .transcripts
        .copy_loaded("child", &snapshot, &snapshot.messages)
        .unwrap();
    assert_eq!(store.db.usage_records().unwrap().len(), 1);
    assert_eq!(
        store.db.usage_records().unwrap()[0].tool_calls,
        2,
        "the original request's accounting is unchanged"
    );
}
