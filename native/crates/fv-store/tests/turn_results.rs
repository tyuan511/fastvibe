use fv_core::{AssistantMessage, ContentBlock, Message, StopReason, Usage};
use fv_protocol::types::{Item, TurnStatus};
use fv_store::{RecordedError, TranscriptStore};

fn user(text: &str) -> Message {
    Message::User { text: text.into() }
}
fn reply(text: &str) -> Message {
    Message::Assistant(AssistantMessage {
        duration_ms: None,
        content: vec![ContentBlock::Text { text: text.into() }],
        stop: StopReason::Stop,
        usage: Usage::default(),
        model: None,
    })
}
fn error(message: &str) -> Option<RecordedError> {
    Some(RecordedError {
        id: "error-id".into(),
        message: message.into(),
    })
}

#[test]
fn boundaries_keep_steers_and_compaction_in_their_run_and_errors_out_of_model_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into()).unwrap();
    store.append("t", &[user("legacy"), reply("old")]).unwrap();
    store.start_turn("t", "original-id").unwrap();
    let messages = [
        user("work"),
        reply("working"),
        user("steer"),
        Message::Compaction {
            usage: Usage::default(),
            model: None,
            user_messages: vec!["work".into(), "steer".into()],
            summary: "summary".into(),
            stats: None,
        },
        reply("partial"),
    ];
    store.append("t", &messages).unwrap();
    store
        .finish_turn(
            "t",
            "original-id",
            TurnStatus::Failed,
            error("429: {\"type\":\"quota\"}"),
        )
        .unwrap();
    drop(store);
    let store = TranscriptStore::new(dir.path().into()).unwrap();
    let loaded = store.read("t").unwrap();
    assert_eq!(loaded.skipped, 0);
    assert_eq!(
        loaded.messages.len(),
        7,
        "UI errors must never become model messages"
    );
    assert_eq!(loaded.turn_start("original-id"), Some(2));
    let turns = loaded.turns();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].id, "t0");
    let turn = &turns[1];
    assert_eq!(turn.id, "original-id");
    assert_eq!(
        turn.items
            .iter()
            .filter(|i| matches!(i, Item::UserMessage { .. }))
            .count(),
        2
    );
    assert_eq!(
        turn.items
            .iter()
            .filter(|i| matches!(i, Item::ContextCompaction { .. }))
            .count(),
        1
    );
    assert!(
        matches!(turn.items.last(), Some(Item::Error { id, message }) if id == "error-id" && message == "429: {\"type\":\"quota\"}")
    );
    assert!(turn.started_at.is_some() && turn.completed_at.is_some());
}

#[test]
fn empty_failed_manual_turns_copy_with_their_error_and_time_and_rewind_without_resurrection() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into()).unwrap();
    store.start_turn("t", "first").unwrap();
    store.append("t", &[user("q"), reply("a")]).unwrap();
    store
        .finish_turn("t", "first", TurnStatus::Completed, None)
        .unwrap();
    store.start_turn("t", "manual").unwrap();
    store
        .finish_turn("t", "manual", TurnStatus::Failed, error("summary refused"))
        .unwrap();
    store.start_turn("t", "retry-me").unwrap();
    store.append("t", &[user("new")]).unwrap();
    store
        .finish_turn("t", "retry-me", TurnStatus::Failed, error("second error"))
        .unwrap();
    let loaded = store.read("t").unwrap();
    store
        .copy_loaded("fork", &loaded, &loaded.messages)
        .unwrap();
    assert_eq!(store.read("fork").unwrap().turns(), loaded.turns());
    store.rewind_before("t", 2, Some("retry-me")).unwrap();
    store.start_turn("t", "retried").unwrap();
    store
        .append("t", &[user("replacement"), reply("done")])
        .unwrap();
    store
        .finish_turn("t", "retried", TurnStatus::Completed, None)
        .unwrap();
    let turns = store.read("t").unwrap().turns();
    assert_eq!(
        turns.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["first", "manual", "retried"]
    );
    assert!(
        matches!(turns[1].items.last(), Some(Item::Error { message, .. }) if message == "summary refused")
    );
    assert!(
        !turns[2]
            .items
            .iter()
            .any(|i| matches!(i, Item::Error { .. }))
    );
    let raw = std::fs::read_to_string(store.path("t")).unwrap();
    assert!(raw.contains("second error"), "rewinds remain append-only");
    assert_eq!(store.read("fork").unwrap().turns().len(), 3);
}

#[test]
fn torn_completion_is_repaired_before_a_later_record_and_interruption_is_never_a_failure() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into()).unwrap();
    store.start_turn("t", "stopped").unwrap();
    store
        .append("t", &[user("stop"), reply("partial")])
        .unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(store.path("t"))
        .unwrap()
        .write_all(b"{\"type\":\"turnCompleted\",\"turnId\":")
        .unwrap();
    store.start_turn("t", "next").unwrap();
    store.append("t", &[user("continue")]).unwrap();
    store
        .finish_turn("t", "next", TurnStatus::Interrupted, error("must not show"))
        .unwrap();
    let loaded = store.read("t").unwrap();
    assert_eq!(loaded.skipped, 1);
    assert_eq!(loaded.turns().len(), 2);
    assert!(
        loaded
            .turns()
            .iter()
            .all(|t| !t.items.iter().any(|i| matches!(i, Item::Error { .. })))
    );
    assert_eq!(loaded.turns()[0].completed_at, None);
    assert!(loaded.turns()[1].completed_at.is_some());
}

#[test]
fn unmarked_old_transcripts_keep_their_existing_projection_and_rewind_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into()).unwrap();
    let messages = [user("one"), reply("a"), user("two"), reply("b")];
    store.append_timed("t", &messages, &[1, 2, 3, 4]).unwrap();
    assert_eq!(
        store.read("t").unwrap().turns(),
        fv_store::turns_from_timed_history(&messages, &[1, 2, 3, 4])
    );
    store.rewind("t", 2).unwrap();
    assert_eq!(store.read("t").unwrap().messages, messages[..2]);
}

#[test]
fn deleted_conversations_cannot_be_recreated_by_a_late_commit_or_completion() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into()).unwrap();
    store.start_turn("t", "running").unwrap();
    store.append("t", &[user("remove me")]).unwrap();
    store.delete("t").unwrap();
    assert!(
        store
            .finish_turn("t", "running", TurnStatus::Interrupted, None)
            .is_err()
    );
    assert!(store.append("t", &[reply("late")]).is_err());
    assert!(store.start_turn("t", "late").is_err());
    assert!(!store.path("t").exists());
}
