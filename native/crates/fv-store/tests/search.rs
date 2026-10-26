use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};
use fv_store::{Store, search_snippet};

#[test]
fn excerpts_keep_literal_matches_and_unicode_boundaries() {
    let text = format!("{}İ中文 🦀 foo.bar{}", "前".repeat(80), "后".repeat(80));
    let excerpt = search_snippet(&text, "foo.bar").unwrap();
    assert!(excerpt.contains("foo.bar") && excerpt.starts_with('…') && excerpt.ends_with('…'));
    assert!(excerpt.chars().count() <= 24 + 7 + 40 + 2);
    assert!(search_snippet(&text, "fooXbar").is_none());
    assert!(
        search_snippet("İstanbul 中文", "i\u{307}stanbul")
            .unwrap()
            .contains("İstanbul")
    );
    assert_eq!(search_snippet("A\nB", "b"), Some("A B".into()));
    assert!(search_snippet("anything", "").is_none());
}

#[test]
fn search_reads_visible_messages_but_never_thoughts_arguments_or_summaries() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let history = vec![
        Message::User {
            text: "UserNeedle".into(),
        },
        Message::Assistant(AssistantMessage {
            duration_ms: None,
            content: vec![
                ContentBlock::Thinking {
                    text: "HiddenThought".into(),
                    signature: None,
                },
                ContentBlock::ToolCall {
                    id: "c".into(),
                    name: "exec_command".into(),
                    arguments: serde_json::json!({"command":"HiddenArgs"}),
                },
                ContentBlock::Text {
                    text: "ReplyNeedle".into(),
                },
            ],
            stop: StopReason::Stop,
            usage: Default::default(),
            model: None,
        }),
        Message::ToolResult {
            call_id: "c".into(),
            name: "exec_command".into(),
            content: "OutputNeedle".into(),
            is_error: false,
        },
        Message::Compaction {
            model: None,
            usage: Default::default(),
            user_messages: vec!["HiddenCopy".into()],
            summary: "HiddenSummary".into(),
        },
    ];
    store.transcripts.append("test", &history).unwrap();
    for query in ["userneedle", "replyneedle", "outputneedle"] {
        assert!(
            store.transcripts.search("test", query).unwrap().is_some(),
            "{query}"
        );
    }
    for query in ["hiddenthought", "hiddenargs", "hiddencopy", "hiddensummary"] {
        assert!(
            store.transcripts.search("test", query).unwrap().is_none(),
            "{query}"
        );
    }
    assert!(store.transcripts.search("missing", "x").unwrap().is_none());
    // A damaged final line cannot hide earlier or later valid text.
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(store.transcripts.path("test"))
        .unwrap();
    writeln!(file, "{{broken").unwrap();
    store
        .transcripts
        .append(
            "test",
            &[Message::User {
                text: "after damage".into(),
            }],
        )
        .unwrap();
    assert!(
        store
            .transcripts
            .search("test", "after damage")
            .unwrap()
            .is_some()
    );
}
