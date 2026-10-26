use std::os::unix::fs::PermissionsExt;

use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};
use fv_protocol::types::{Item, Thread};
use fv_store::{Db, Store, StoreError, TranscriptStore, turns_from_history};
use serde_json::json;

fn thread(id: &str, updated_at: i64) -> Thread {
    Thread {
        id: id.into(),
        title: format!("thread {id}"),
        cwd: Some("/tmp/p".into()),
        project: None,
        created_at: 1,
        updated_at,
        archived: false,
        unread: false,
        pinned: false,
        worktree: None,
        model: None,
        thinking: None,
    }
}

fn mode(p: &std::path::Path) -> u32 {
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn the_database_is_private_versioned_and_reopens_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fastvibe.db");
    let db = Db::open(&path).unwrap();
    assert_eq!(db.schema_version().unwrap(), 3);
    db.put_thread(&thread("a", 5)).unwrap();
    assert_eq!(mode(&path), 0o600);
    // The write-ahead log files are written by SQLite; they must not be wider than the database.
    for ext in ["db-wal", "db-shm"] {
        let p = dir.path().join(format!("fastvibe.{ext}"));
        if p.exists() {
            assert_eq!(mode(&p), 0o600, "{ext}");
        }
    }
    drop(db);
    let again = Db::open(&path).unwrap();
    assert_eq!(again.schema_version().unwrap(), 3);
    assert_eq!(again.get_thread("a").unwrap().unwrap().title, "thread a");
}

#[test]
fn a_database_from_a_newer_build_is_refused_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fastvibe.db");
    drop(Db::open(&path).unwrap());
    rusqlite_set_version(&path, 99);
    match Db::open(&path) {
        Err(StoreError::TooNew {
            found: 99,
            known: 3,
        }) => {}
        other => panic!("{:?}", other.err()),
    }
}

fn rusqlite_set_version(path: &std::path::Path, v: i64) {
    // Through the sqlite3 CLI-free route: the store's own dependency.
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.pragma_update(None, "user_version", v).unwrap();
}

#[test]
fn threads_list_newest_first_and_archived_ones_only_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(&dir.path().join("fastvibe.db")).unwrap();
    db.put_thread(&thread("old", 10)).unwrap();
    db.put_thread(&thread("new", 30)).unwrap();
    let mut archived = thread("hidden", 20);
    archived.archived = true;
    db.put_thread(&archived).unwrap();

    let ids = |t: Vec<Thread>| t.into_iter().map(|t| t.id).collect::<Vec<_>>();
    assert_eq!(ids(db.list_threads(false).unwrap()), ["new", "old"]);
    assert_eq!(
        ids(db.list_threads(true).unwrap()),
        ["new", "hidden", "old"]
    );

    // Updating moves it; deleting removes it.
    let mut t = db.get_thread("old").unwrap().unwrap();
    t.updated_at = 99;
    db.put_thread(&t).unwrap();
    assert_eq!(ids(db.list_threads(false).unwrap()), ["old", "new"]);
    assert!(db.delete_thread("old").unwrap());
    assert!(!db.delete_thread("old").unwrap());
    assert!(db.get_thread("old").unwrap().is_none());
}

fn user(t: &str) -> Message {
    Message::User { text: t.into() }
}

fn assistant(content: Vec<ContentBlock>) -> Message {
    Message::Assistant(AssistantMessage {
        duration_ms: None,
        content,
        stop: StopReason::Stop,
        usage: Default::default(),
        model: Some("p/m".into()),
    })
}

#[test]
fn a_transcript_round_trips_in_order_and_is_chained() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().join("sessions")).unwrap();
    let messages = vec![
        user("hi"),
        assistant(vec![
            ContentBlock::Thinking {
                text: "hm".into(),
                signature: Some("sig".into()),
            },
            ContentBlock::ToolCall {
                id: "c1".into(),
                name: "read".into(),
                arguments: json!({"path": "a"}),
            },
        ]),
        Message::ToolResult {
            call_id: "c1".into(),
            name: "read".into(),
            content: "text".into(),
            is_error: false,
        },
    ];
    store.append("t1", &messages[..2]).unwrap();
    store.append("t1", &messages[2..]).unwrap();

    let loaded = store.read("t1").unwrap();
    assert_eq!(loaded.messages, messages);
    assert_eq!(loaded.skipped, 0);

    // Each entry names the one before it; the first has none.
    let raw = std::fs::read_to_string(store.path("t1")).unwrap();
    let lines: Vec<serde_json::Value> = raw
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines[0]["type"], "session");
    assert_eq!(lines[1]["parentId"], serde_json::Value::Null);
    for i in 2..lines.len() {
        assert_eq!(lines[i]["parentId"], lines[i - 1]["id"], "line {i}");
    }

    assert_eq!(mode(&store.path("t1")), 0o600);
    assert_eq!(mode(store.path("t1").parent().unwrap()), 0o700);
}

#[test]
fn a_new_process_continues_the_chain_where_the_last_one_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = dir.path().join("sessions");
    TranscriptStore::new(sessions.clone())
        .unwrap()
        .append("t1", &[user("one")])
        .unwrap();
    // A fresh store has no memory of the file; it reads the tail from disk.
    let second = TranscriptStore::new(sessions).unwrap();
    second.append("t1", &[user("two")]).unwrap();
    let raw = std::fs::read_to_string(second.path("t1")).unwrap();
    let lines: Vec<serde_json::Value> = raw
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines[2]["parentId"], lines[1]["id"]);
    assert_eq!(
        second.read("t1").unwrap().messages,
        vec![user("one"), user("two")]
    );
}

#[test]
fn a_line_cut_short_by_a_crash_costs_only_that_line() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().join("sessions")).unwrap();
    store.append("t1", &[user("kept")]).unwrap();
    // Simulate dying half-way through the next write.
    let mut raw = std::fs::read(store.path("t1")).unwrap();
    raw.extend_from_slice(br#"{"type":"message","id":"x","parentId":"y","timest"#);
    std::fs::write(store.path("t1"), raw).unwrap();

    let loaded = store.read("t1").unwrap();
    assert_eq!(loaded.messages, vec![user("kept")]);
    assert_eq!(loaded.skipped, 1);

    // Appending afterwards must not glue onto the broken line.
    let fresh = TranscriptStore::new(dir.path().join("sessions")).unwrap();
    fresh.append("t1", &[user("after")]).unwrap();
    let loaded = fresh.read("t1").unwrap();
    assert_eq!(loaded.messages, vec![user("kept"), user("after")]);
}

#[test]
fn a_missing_transcript_is_empty_and_ids_cannot_escape_the_directory() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().join("sessions")).unwrap();
    assert!(store.read("nope").unwrap().messages.is_empty());
    let p = store.path("../../etc/passwd");
    assert!(p.starts_with(dir.path().join("sessions")), "{p:?}");
    store.append("t1", &[user("x")]).unwrap();
    store.delete("t1").unwrap();
    store.delete("t1").unwrap();
    assert!(!store.exists("t1"));
}

#[test]
fn history_becomes_turns_with_tool_results_filled_in() {
    let messages = vec![
        user("first"),
        assistant(vec![
            ContentBlock::Thinking {
                text: "plan".into(),
                signature: None,
            },
            ContentBlock::Thinking {
                text: "  ".into(),
                signature: Some("blank".into()),
            },
            ContentBlock::Text {
                text: "reading".into(),
            },
            ContentBlock::ToolCall {
                id: "c1".into(),
                name: "read".into(),
                arguments: json!({"p": 1}),
            },
        ]),
        Message::ToolResult {
            call_id: "c1".into(),
            name: "read".into(),
            content: "data".into(),
            is_error: true,
        },
        assistant(vec![ContentBlock::Text {
            text: "done".into(),
        }]),
        user("second"),
    ];
    let turns = turns_from_history(&messages);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].id, "t0");
    let shape: Vec<&str> = turns[0]
        .items
        .iter()
        .map(|i| match i {
            Item::UserMessage { .. } => "user",
            Item::Reasoning { .. } => "reasoning",
            Item::AgentMessage { .. } => "agent",
            Item::ToolCall { .. } => "tool",
            Item::Error { .. } => "error",
            Item::ContextCompaction { .. } => "compaction",
        })
        .collect();
    // The blank thinking block draws nothing.
    assert_eq!(shape, ["user", "reasoning", "agent", "tool", "agent"]);
    assert!(
        matches!(&turns[0].items[3], Item::ToolCall { id, output: Some(o), is_error: true, .. } if id == "c1" && o == "data")
    );
    // Same input, same ids.
    assert_eq!(turns_from_history(&messages), turns);
    assert_eq!(turns[1].items.len(), 1);
}

#[test]
fn the_store_opens_both_halves_on_one_directory() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("data")).unwrap();
    store.db.put_thread(&thread("a", 1)).unwrap();
    store.transcripts.append("a", &[user("x")]).unwrap();
    drop(store);
    let again = Store::open(&dir.path().join("data")).unwrap();
    assert_eq!(again.db.list_threads(false).unwrap().len(), 1);
    assert_eq!(again.transcripts.read("a").unwrap().messages.len(), 1);
}

fn provider(id: &str, name: &str) -> fv_store::StoredProvider {
    use fv_protocol::types::{ApiProtocol, ModelInfo};
    fv_store::StoredProvider {
        id: id.into(),
        name: name.into(),
        protocol: ApiProtocol::Chat,
        base_url: "https://x/v1".into(),
        enabled: true,
        models: vec![ModelInfo {
            id: "m1".into(),
            name: Some("Model One".into()),
            protocol: None,
            supports_images: true,
            context_window: Some(128_000),
            max_output_tokens: None,
        }],
    }
}

#[test]
fn providers_keep_their_order_and_their_place_when_edited() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(&dir.path().join("fastvibe.db")).unwrap();
    for (id, name) in [("a", "A"), ("b", "B"), ("c", "C")] {
        db.put_provider(&provider(id, name)).unwrap();
    }
    let ids = |db: &Db| {
        db.list_providers()
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&db), ["a", "b", "c"]);

    // Editing keeps the place.
    let mut b = provider("b", "Renamed");
    b.enabled = false;
    db.put_provider(&b).unwrap();
    assert_eq!(ids(&db), ["a", "b", "c"]);
    assert_eq!(db.get_provider("b").unwrap().unwrap().name, "Renamed");

    // Reordering names some; the rest follow in their old order; unknown ids are ignored.
    db.reorder_providers(&["c".into(), "ghost".into()]).unwrap();
    assert_eq!(ids(&db), ["c", "a", "b"]);

    assert!(db.delete_provider("a").unwrap());
    assert!(!db.delete_provider("a").unwrap());
    assert_eq!(ids(&db), ["c", "b"]);
    // A new one goes to the end, whatever was deleted.
    db.put_provider(&provider("d", "D")).unwrap();
    assert_eq!(ids(&db), ["c", "b", "d"]);
}

#[test]
fn settings_are_a_small_key_value_table() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(&dir.path().join("fastvibe.db")).unwrap();
    assert_eq!(db.get_setting("default_model").unwrap(), None);
    db.set_setting("default_model", Some("relay/m1")).unwrap();
    db.set_setting("default_model", Some("relay/m2")).unwrap();
    assert_eq!(
        db.get_setting("default_model").unwrap().as_deref(),
        Some("relay/m2")
    );
    db.set_setting("default_model", None).unwrap();
    assert_eq!(db.get_setting("default_model").unwrap(), None);
}

#[test]
fn a_database_from_before_providers_is_upgraded_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fastvibe.db");
    // What schema 1 looked like, with a conversation in it.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE conversations (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
         CREATE INDEX conversations_updated ON conversations(updated_at DESC);",
    )
    .unwrap();
    let old = serde_json::json!({"id":"old","title":"from v1","cwd":null,"project":null,"createdAt":1,"updatedAt":2,"archived":false,"unread":false});
    conn.execute(
        "INSERT INTO conversations VALUES ('old', 2, 0, ?1)",
        [old.to_string()],
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    drop(conn);

    let db = Db::open(&path).unwrap();
    assert_eq!(db.schema_version().unwrap(), 3);
    let t = db.get_thread("old").unwrap().expect("the old conversation");
    assert_eq!(
        (t.title.as_str(), t.model, t.thinking),
        ("from v1", None, None),
        "new fields default"
    );
    db.put_provider(&provider("a", "A")).unwrap();
}

#[test]
fn credentials_are_private_replaced_whole_and_removed_with_the_provider() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("data")).unwrap();
    let file = dir.path().join("data/credentials.json");

    assert_eq!(store.credentials.get("relay").unwrap(), None);
    assert!(!store.credentials.has("relay").unwrap());
    store.credentials.set("relay", "sk-secret-1").unwrap();
    store.credentials.set("other", "sk-secret-2").unwrap();
    assert_eq!(mode(&file), 0o600);
    assert_eq!(
        store.credentials.get("relay").unwrap().as_deref(),
        Some("sk-secret-1")
    );

    // A key is replaced, not appended.
    store.credentials.set("relay", "sk-secret-3").unwrap();
    assert_eq!(
        store.credentials.get("relay").unwrap().as_deref(),
        Some("sk-secret-3")
    );

    // Nothing is left half-written beside it.
    let names: Vec<_> = std::fs::read_dir(file.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!names.iter().any(|n| n.ends_with(".tmp")), "{names:?}");

    store.credentials.remove("relay").unwrap();
    store.credentials.remove("relay").unwrap();
    assert!(!store.credentials.has("relay").unwrap());
    assert_eq!(
        store.credentials.get("other").unwrap().as_deref(),
        Some("sk-secret-2")
    );

    // The database never learns a key.
    store.db.put_provider(&provider("other", "Other")).unwrap();
    store.db.checkpoint().unwrap();
    let raw = std::fs::read(dir.path().join("data/fastvibe.db")).unwrap();
    assert!(
        !String::from_utf8_lossy(&raw).contains("sk-secret"),
        "a key reached the database"
    );
}

#[test]
fn an_unreadable_credentials_file_is_an_error_not_an_empty_one() {
    // Treating it as empty would let the next write destroy keys nobody could read.
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("data")).unwrap();
    std::fs::write(dir.path().join("data/credentials.json"), "{ not json").unwrap();
    assert!(store.credentials.get("relay").is_err());
    assert!(store.credentials.set("relay", "k").is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("data/credentials.json")).unwrap(),
        "{ not json"
    );
}

#[test]
fn a_compaction_is_a_divider_between_turns_and_hides_nothing() {
    let messages = vec![
        user("first"),
        assistant(vec![ContentBlock::Text { text: "one".into() }]),
        Message::Compaction {
            model: None,
            usage: Default::default(),
            user_messages: vec!["first".into()],
            summary: "s".into(),
        },
        user("second"),
        assistant(vec![ContentBlock::Text { text: "two".into() }]),
    ];
    let turns = turns_from_history(&messages);
    // What was said before the summary is still drawn; the model just stops seeing it.
    assert_eq!(turns.len(), 3);
    assert!(matches!(&turns[0].items[0], Item::UserMessage { text, .. } if text == "first"));
    assert!(matches!(
        &turns[1].items[..],
        [Item::ContextCompaction { .. }]
    ));
    assert!(matches!(&turns[2].items[0], Item::UserMessage { text, .. } if text == "second"));
}

#[test]
fn a_compaction_survives_the_transcript_and_picks_the_models_view() {
    use fv_core::effective_history;
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().join("sessions")).unwrap();
    let compaction = Message::Compaction {
        model: None,
        usage: Default::default(),
        user_messages: vec!["a".into()],
        summary: "s".into(),
    };
    store
        .append(
            "t1",
            &[
                user("a"),
                assistant(vec![ContentBlock::Text { text: "b".into() }]),
            ],
        )
        .unwrap();
    store
        .append("t1", &[compaction.clone(), user("c")])
        .unwrap();

    let all = store.read("t1").unwrap().messages;
    assert_eq!(all.len(), 4, "the transcript keeps everything");
    assert_eq!(effective_history(&all), vec![compaction, user("c")]);
}

#[test]
fn restored_turns_carry_when_they_started_worked_and_ended() {
    use fv_core::Message;
    let messages = vec![
        Message::User { text: "hi".into() },
        Message::ToolResult {
            call_id: "c".into(),
            name: "exec_command".into(),
            content: "ok".into(),
            is_error: false,
        },
        Message::User {
            text: "again".into(),
        },
    ];
    let turns = fv_store::turns_from_timed_history(&messages, &[1_000, 4_000, 9_000]);
    assert_eq!(turns[0].started_at, Some(1_000));
    assert_eq!(turns[0].process_ended_at, Some(4_000));
    assert_eq!(turns[0].completed_at, Some(4_000));
    assert_eq!(turns[1].started_at, Some(9_000));
    assert_eq!(turns[1].completed_at, None);
}
