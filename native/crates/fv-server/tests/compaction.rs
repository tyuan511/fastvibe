//! Making room in a conversation, as a client sees it and as it survives a restart.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::{Client, ClientError};
use fv_core::Message;
use fv_protocol::jsonrpc::code;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use serde_json::json;
use tokio::sync::mpsc::UnboundedReceiver;

type Notes = UnboundedReceiver<ServerNotification>;

async fn run(
    dir: &Path,
    name: &str,
    model: ScriptedModel,
) -> (Arc<ScriptedModel>, std::path::PathBuf) {
    let model = Arc::new(model);
    let agent = fv_server::agent_with_builtin_tools(model.clone());
    let state = Arc::new(ServerState::new(dir.to_path_buf(), agent).unwrap());
    let sock = dir.join(format!("{name}.sock"));
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    (model, sock)
}

async fn connect(sock: &Path) -> (Client, Notes) {
    let (c, n) = Client::connect_unix(sock).await.unwrap();
    c.call::<Initialize>(InitializeParams {
        client_info: ClientInfo {
            name: "t".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    })
    .await
    .unwrap();
    (c, n)
}

async fn until_idle(notes: &mut Notes) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), notes.recv())
            .await
            .expect("timed out")
            .expect("closed");
        let idle = matches!(&n, ServerNotification::ThreadStatusChanged(e) if !e.body.running);
        seen.push(n);
        if idle {
            return seen;
        }
    }
}

async fn say(c: &Client, notes: &mut Notes, thread: &str, text: &str) -> Vec<ServerNotification> {
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.into(),
        text: text.into(),
    })
    .await
    .unwrap();
    until_idle(notes).await
}

fn compaction_items(events: &[ServerNotification]) -> (usize, usize) {
    let started = events.iter().filter(|n| matches!(n, ServerNotification::ItemStarted(e) if matches!(e.body.item, Item::ContextCompaction { .. }))).count();
    let completed = events.iter().filter(|n| matches!(n, ServerNotification::ItemCompleted(e) if matches!(e.body.item, Item::ContextCompaction { .. }))).count();
    (started, completed)
}

fn plan_call() -> serde_json::Value {
    json!({"plan": [{"step": "work", "status": "in_progress"}]})
}

fn status_of(events: &[ServerNotification]) -> Option<TurnStatus> {
    events.iter().find_map(|n| match n {
        ServerNotification::TurnCompleted(e) => Some(e.body.status),
        _ => None,
    })
}

#[tokio::test]
async fn a_conversation_that_fills_its_window_is_summarized_and_remembered_so_after_a_restart() {
    let data = tempfile::tempdir().unwrap();
    let thread = {
        let (_, sock) = run(
            data.path(),
            "a",
            ScriptedModel::new([
                Reply::new()
                    .tool("p1", "update_plan", plan_call())
                    .input_tokens(950)
                    .done(),
                Reply::new().text("SUMMARY: the plan is in progress").done(),
                Reply::new().text("carried on").done(),
            ])
            .with_window(1000),
        )
        .await;
        let (c, mut notes) = connect(&sock).await;
        let thread = c
            .call::<ThreadStart>(ThreadStartParams::default())
            .await
            .unwrap()
            .thread
            .id;
        let events = say(&c, &mut notes, &thread, "do the big job").await;

        assert_eq!(
            compaction_items(&events),
            (1, 1),
            "the summary is shown as an item"
        );
        assert_eq!(status_of(&events), Some(TurnStatus::Completed));
        // The context ring is told how full the window was.
        let usage = events.iter().find_map(|n| match n {
            ServerNotification::ThreadTokenUsageUpdated(e) => Some(e.body),
            _ => None,
        });
        let usage = usage.expect("thread/tokenUsage/updated");
        assert_eq!((usage.used, usage.window), (955, 1000));
        thread
    };

    // The transcript keeps everything; the summary is one more line in it.
    let transcript =
        std::fs::read_to_string(data.path().join("sessions").join(format!("{thread}.jsonl")))
            .unwrap();
    assert!(
        transcript.contains("\"role\":\"compaction\"") && transcript.contains("do the big job")
    );
    assert!(
        transcript.contains("update_plan"),
        "what was summarized is still on disk"
    );

    // A new process: the thread is drawn in full, and the model sees only the summary and what came after.
    let (model, sock) = run(
        data.path(),
        "b",
        ScriptedModel::new([Reply::new().text("next").done()]).with_window(1000),
    )
    .await;
    let (c, mut notes) = connect(&sock).await;
    let snap = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    let kinds: Vec<&str> = snap
        .turns
        .iter()
        .flat_map(|t| t.items.iter())
        .map(|i| match i {
            Item::UserMessage { .. } => "user",
            Item::ToolCall { .. } => "tool",
            Item::AgentMessage { .. } => "agent",
            Item::ContextCompaction { .. } => "compaction",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, ["user", "tool", "compaction", "agent"], "{kinds:?}");
    assert!(snap.token_usage.is_some_and(|u| u.window == 1000));

    say(&c, &mut notes, &thread, "and then?").await;
    let request = &model.requests()[0];
    assert_eq!(request.messages.len(), 3, "{:?}", request.messages);
    assert!(
        matches!(&request.messages[0], Message::User { text } if text.contains("do the big job") && text.contains("SUMMARY: the plan is in progress"))
    );
    assert!(matches!(&request.messages[1], Message::Assistant(a) if a.text() == "carried on"));
    assert!(matches!(&request.messages[2], Message::User { text } if text == "and then?"));
}

#[tokio::test]
async fn a_conversation_can_be_summarized_on_request() {
    let data = tempfile::tempdir().unwrap();
    let (model, sock) = run(
        data.path(),
        "a",
        ScriptedModel::new([
            Reply::new().text("first answer").done(),
            Reply::new().text("SUMMARY: answered once").done(),
            Reply::new().text("second answer").done(),
        ]),
    )
    .await;
    let (c, mut notes) = connect(&sock).await;
    let thread = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    say(&c, &mut notes, &thread, "first question").await;

    c.call::<ThreadCompactStart>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let events = until_idle(&mut notes).await;
    assert_eq!(status_of(&events), Some(TurnStatus::Completed));
    assert_eq!(compaction_items(&events), (1, 1));
    assert!(
        events
            .iter()
            .position(|n| n.method() == "turn/started")
            .unwrap()
            < events
                .iter()
                .position(|n| matches!(n, ServerNotification::ItemStarted(_)))
                .unwrap()
    );

    say(&c, &mut notes, &thread, "second question").await;
    let after = &model.requests()[2];
    assert_eq!(after.messages.len(), 2, "{:?}", after.messages);
    assert!(
        matches!(&after.messages[0], Message::User { text } if text.contains("first question") && text.contains("SUMMARY: answered once"))
    );
}

#[tokio::test]
async fn summarizing_nothing_is_refused_and_so_is_summarizing_a_busy_thread() {
    let data = tempfile::tempdir().unwrap();
    let (_, sock) = run(
        data.path(),
        "a",
        ScriptedModel::new([Reply::new().text("working ").then_hang()]),
    )
    .await;
    let (c, mut notes) = connect(&sock).await;
    let thread = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    match c
        .call::<ThreadCompactStart>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
    {
        Err(ClientError::Rpc(e)) => assert_eq!(e.code, code::INVALID_PARAMS),
        other => panic!("{other:?}"),
    }

    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "go".into(),
    })
    .await
    .unwrap();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), notes.recv())
            .await
            .unwrap()
            .unwrap();
        if n.method() == "item/agentMessage/delta" {
            break;
        }
    }
    match c
        .call::<ThreadCompactStart>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
    {
        Err(ClientError::Rpc(e)) => assert_eq!(e.code, code::THREAD_BUSY),
        other => panic!("{other:?}"),
    }
    c.call::<TurnInterrupt>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
    until_idle(&mut notes).await;
}

#[tokio::test]
async fn stopping_a_summary_leaves_the_conversation_as_it_was() {
    let data = tempfile::tempdir().unwrap();
    let (model, sock) = run(
        data.path(),
        "a",
        ScriptedModel::new([
            Reply::new().text("an answer").done(),
            Reply::new().then_hang(),
            Reply::new().text("another").done(),
        ]),
    )
    .await;
    let (c, mut notes) = connect(&sock).await;
    let thread = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    say(&c, &mut notes, &thread, "question").await;

    c.call::<ThreadCompactStart>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), notes.recv())
            .await
            .unwrap()
            .unwrap();
        if matches!(&n, ServerNotification::ItemStarted(e) if matches!(e.body.item, Item::ContextCompaction { .. }))
        {
            break;
        }
    }
    c.call::<TurnInterrupt>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let events = until_idle(&mut notes).await;
    assert_eq!(status_of(&events), Some(TurnStatus::Interrupted));
    assert_eq!(
        compaction_items(&events).1,
        1,
        "the item was closed, not left spinning"
    );

    // Nothing was replaced: the next turn still has the whole conversation.
    say(&c, &mut notes, &thread, "again").await;
    assert_eq!(model.requests().last().unwrap().messages.len(), 3);
}

#[tokio::test]
async fn a_summary_that_fails_is_reported_and_changes_nothing() {
    let data = tempfile::tempdir().unwrap();
    let (_, sock) = run(
        data.path(),
        "a",
        ScriptedModel::new([
            Reply::new().text("an answer").done(),
            Reply::new().then_fail("quota exceeded"),
        ]),
    )
    .await;
    let (c, mut notes) = connect(&sock).await;
    let thread = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    say(&c, &mut notes, &thread, "question").await;
    c.call::<ThreadCompactStart>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let events = until_idle(&mut notes).await;
    let failed = events.iter().find_map(|n| match n {
        ServerNotification::TurnCompleted(e) if e.body.status == TurnStatus::Failed => {
            e.body.error.clone()
        }
        _ => None,
    });
    assert!(failed.is_some_and(|m| m.contains("quota exceeded")));
    let transcript =
        std::fs::read_to_string(data.path().join("sessions").join(format!("{thread}.jsonl")))
            .unwrap();
    assert!(!transcript.contains("compaction"));
}
