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
    assert_eq!(db.schema_version().unwrap(), 1);
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
    assert_eq!(again.schema_version().unwrap(), 1);
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
            known: 1,
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
