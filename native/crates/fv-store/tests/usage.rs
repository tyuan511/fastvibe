use fv_core::{AssistantMessage, ContentBlock, Message, StopReason, Usage};
use fv_store::{Store, TranscriptStore};

fn reply(text: &str, tokens: u64) -> Message {
    Message::Assistant(AssistantMessage {
        duration_ms: None,
        content: vec![
            ContentBlock::Text { text: text.into() },
            ContentBlock::ToolCall {
                id: "call".into(),
                name: "test".into(),
                arguments: serde_json::json!({"secret":"not accounting data"}),
            },
        ],
        stop: StopReason::ToolUse,
        usage: Usage {
            input_tokens: tokens,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
        },
        model: Some("provider/model".into()),
    })
}

#[test]
fn paid_requests_survive_rewind_fork_delete_and_a_late_reply_without_resurrecting_files() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store
        .transcripts
        .append_timed(
            "original",
            &[
                Message::User {
                    text: "request".into(),
                },
                reply("private reply", 10),
            ],
            &[1000, 2000],
        )
        .unwrap();
    store.transcripts.rewind("original", 1).unwrap();
    store
        .transcripts
        .append_timed("original", &[reply("retry", 20)], &[3000])
        .unwrap();
    let loaded = store.transcripts.read("original").unwrap();
    store
        .transcripts
        .copy_loaded("fork", &loaded, &loaded.messages)
        .unwrap();
    store
        .transcripts
        .append_timed("fork", &[reply("new work", 30)], &[4000])
        .unwrap();
    store.transcripts.capture_usage().unwrap();
    let records = store.db.usage_records().unwrap();
    assert_eq!(records.len(), 3);
    assert_eq!(
        records.iter().map(|r| r.usage.input_tokens).sum::<u64>(),
        60
    );
    assert_eq!(records.iter().map(|r| r.tool_calls).sum::<u64>(), 3);
    assert!(
        !serde_json::to_string(&records)
            .unwrap()
            .contains("private reply")
    );
    assert!(!serde_json::to_string(&records).unwrap().contains("secret"));
    store.transcripts.delete("original").unwrap();
    store.transcripts.delete("fork").unwrap();
    assert!(
        store
            .transcripts
            .append("original", &[reply("late finalization", 40)])
            .is_err()
    );
    assert!(!store.transcripts.path("original").exists());
    drop(store);
    let store = Store::open(dir.path()).unwrap();
    store.transcripts.capture_usage().unwrap();
    assert_eq!(store.db.usage_records().unwrap().len(), 4);
}

#[test]
fn legacy_turn_origins_deduplicate_copied_history_and_torn_lines_do_not_hide_valid_records() {
    let dir = tempfile::tempdir().unwrap();
    let transcripts = TranscriptStore::new(dir.path().join("sessions")).unwrap();
    transcripts.start_turn("original", "shared-turn").unwrap();
    transcripts
        .append_timed(
            "original",
            &[
                Message::User { text: "hi".into() },
                reply("one", 1),
                Message::ToolResult {
                    call_id: "call".into(),
                    name: "test".into(),
                    content: "payload".repeat(5000),
                    is_error: false,
                },
                reply("two", 2),
            ],
            &[1000, 2000, 3000, 4000],
        )
        .unwrap();
    let original = std::fs::read_to_string(transcripts.path("original")).unwrap();
    for (thread, copied) in [("original", false), ("copy", true)] {
        let mut lines = Vec::new();
        for (index, line) in original.lines().enumerate() {
            let mut entry: serde_json::Value = serde_json::from_str(line).unwrap();
            entry.as_object_mut().unwrap().remove("usageOrigin");
            if entry["type"] == "session" {
                entry["id"] = thread.into();
            } else if copied && entry["type"] == "message" {
                entry["id"] = format!("copy-{index}").into();
            }
            lines.push(serde_json::to_string(&entry).unwrap());
        }
        std::fs::write(transcripts.path(thread), lines.join("\n") + "\n{torn\n").unwrap();
    }
    let store = Store::open(dir.path()).unwrap();
    // Delete before anyone opens statistics: the old paid records must still be captured.
    store.transcripts.delete("original").unwrap();
    for _ in 0..2 {
        store.transcripts.capture_usage().unwrap();
    }
    assert_eq!(store.db.usage_records().unwrap().len(), 2);
    store
        .transcripts
        .append("copy", &[reply("fresh work", 3)])
        .unwrap();
    store.transcripts.capture_usage().unwrap();
    assert_eq!(store.db.usage_records().unwrap().len(), 3);
    let loaded = store.transcripts.read("copy").unwrap();
    store
        .transcripts
        .copy_loaded("second-copy", &loaded, &loaded.messages)
        .unwrap();
    store.transcripts.capture_usage().unwrap();
    assert_eq!(store.db.usage_records().unwrap().len(), 3);
}

#[test]
fn unavailable_accounting_storage_cannot_delete_the_only_remaining_usage_source() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let old = TranscriptStore::new(dir.path().join("sessions")).unwrap();
    old.append("old", &[reply("legacy request", 10)]).unwrap();
    store.transcripts.capture_usage().unwrap();
    let connection = rusqlite::Connection::open(dir.path().join("fastvibe.db")).unwrap();
    connection.execute_batch("DROP TABLE usage_ledger").unwrap();
    assert!(
        store.transcripts.delete("old").is_err(),
        "cached accounting must be validated before deleting its source"
    );
    assert!(store.transcripts.path("old").is_file());
    assert!(
        store
            .transcripts
            .append("old", &[reply("reply during outage", 11)])
            .is_err()
    );
    assert_eq!(
        store.transcripts.read("old").unwrap().messages.len(),
        2,
        "statistics failure cannot suppress the authored reply"
    );
    assert!(store.transcripts.delete("old").is_err());
    assert!(store.transcripts.path("old").is_file());
    assert!(store.transcripts.capture_usage().is_err());
    connection.execute_batch("CREATE TABLE usage_ledger (request_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, entry_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)").unwrap();
    store.transcripts.capture_usage().unwrap();
    assert_eq!(
        store.db.usage_records().unwrap().len(),
        2,
        "the scan cache must not hide replies written during the outage"
    );
}

#[test]
fn completed_usage_is_kept_even_if_the_transcript_file_cannot_be_written() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    std::fs::create_dir(store.transcripts.path("blocked")).unwrap();
    assert!(
        store
            .transcripts
            .append("blocked", &[reply("paid", 10)])
            .is_err()
    );
    assert_eq!(store.db.usage_records().unwrap().len(), 1);
}

#[test]
fn imported_usage_is_deduplicated_by_source_entry_across_target_threads() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let messages = vec![
        Message::User {
            text: "imported request".into(),
        },
        reply("imported reply", 12),
    ];
    store
        .transcripts
        .append_imported(
            "thread-a",
            &messages,
            &[1000, 2000],
            "/source/session.jsonl",
        )
        .unwrap();
    store
        .transcripts
        .append_imported(
            "thread-b",
            &messages,
            &[1000, 2000],
            "/source/session.jsonl",
        )
        .unwrap();
    assert_eq!(store.db.usage_records().unwrap().len(), 1);
    assert_eq!(store.db.usage_records().unwrap()[0].usage.input_tokens, 12);
}

#[test]
fn fork_boundary_keeps_complete_turns_and_original_usage() {
    use fv_protocol::types::TurnStatus;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    for turn in ["one", "two", "three"] {
        store.transcripts.start_turn("parent", turn).unwrap();
        store
            .transcripts
            .append(
                "parent",
                &[Message::User { text: turn.into() }, reply(turn, 10)],
            )
            .unwrap();
        store
            .transcripts
            .finish_turn("parent", turn, TurnStatus::Completed, None)
            .unwrap();
    }
    let before = store.db.usage_records().unwrap();
    let selected = store
        .transcripts
        .read("parent")
        .unwrap()
        .through_turn("two")
        .unwrap();
    assert_eq!(selected.messages.len(), 4);
    assert_eq!(
        selected
            .turns()
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        vec!["one", "two"]
    );
    store
        .transcripts
        .copy_loaded("child", &selected, &selected.messages)
        .unwrap();
    store.transcripts.capture_usage().unwrap();
    assert_eq!(before, store.db.usage_records().unwrap());
    // A partially installed unpublished file is replaced atomically on crash recovery.
    store
        .transcripts
        .append(
            "staged",
            &[Message::User {
                text: "partial".into(),
            }],
        )
        .unwrap();
    store
        .transcripts
        .install_loaded("staged", &selected, &selected.messages)
        .unwrap();
    let installed = store.transcripts.read("staged").unwrap();
    assert_eq!(installed.messages, selected.messages);
    assert_eq!(installed.turns(), selected.turns());
    store
        .transcripts
        .install_loaded("staged", &selected, &selected.messages)
        .unwrap();
    assert_eq!(
        store.transcripts.read("staged").unwrap().messages,
        selected.messages
    );
    assert!(
        store
            .transcripts
            .read("parent")
            .unwrap()
            .through_turn("missing")
            .is_none()
    );
}
