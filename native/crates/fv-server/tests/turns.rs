//! Turns over the wire: what a client sees while the agent works, and what it can do to it.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use fv_agent::testing::{NoModel, Reply, ScriptedModel};
use fv_agent::{AgentContext, Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
use fv_client::{Client, ClientError};
use fv_protocol::jsonrpc::code;
use fv_protocol::methods::{Initialize, ThreadResume, ThreadStart, TurnInterrupt, TurnStart};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

type Notes = UnboundedReceiver<ServerNotification>;

struct Echo;
impl Tool for Echo {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "echo".into(),
            description: String::new(),
            schema: json!({}),
        }
    }
    fn mutates(&self) -> bool {
        false
    }
    fn call(&self, _: ToolCtx, args: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            ToolOutput::ok(format!("echoed {}", args["text"].as_str().unwrap_or("")))
        })
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    sock: std::path::PathBuf,
    model: Option<Arc<ScriptedModel>>,
}

async fn start(model: Option<ScriptedModel>) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let model = model.map(Arc::new);
    let mut tools = ToolRegistry::new();
    tools.register(Echo);
    let agent = AgentContext {
        model: match &model {
            Some(m) => m.clone(),
            None => Arc::new(NoModel),
        },
        tools: Arc::new(tools),
        system: "sys".into(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
    };
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), agent).unwrap());
    let sock = dir.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    Harness {
        _dir: dir,
        sock,
        model,
    }
}

impl Harness {
    async fn client(&self) -> (Client, Notes) {
        let (c, n) = Client::connect_unix(&self.sock).await.unwrap();
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
}

async fn new_thread(c: &Client) -> String {
    c.call::<ThreadStart>(ThreadStartParams {
        cwd: None,
        project: None,
        model: None,
        thinking: None,
    })
    .await
    .unwrap()
    .thread
    .id
}

async fn say(c: &Client, thread: &str, text: &str) -> Result<String, ClientError> {
    Ok(c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.into(),
        text: text.into(),
    })
    .await?
    .turn_id)
}

fn to_json(n: &ServerNotification) -> Value {
    serde_json::to_value(n).unwrap()
}

/// Read notifications until `done` says to stop; thread-catalog notices are skipped.
async fn until(
    notes: &mut Notes,
    mut done: impl FnMut(&ServerNotification) -> bool,
) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), notes.recv())
            .await
            .expect("timed out waiting for a notification")
            .expect("connection closed");
        if matches!(n.method(), "catalog/changed" | "thread/started") {
            continue;
        }
        let stop = done(&n);
        seen.push(n);
        if stop {
            return seen;
        }
    }
}

fn idle(n: &ServerNotification) -> bool {
    matches!(n, ServerNotification::ThreadStatusChanged(e) if !e.body.running)
}

fn seqs(events: &[ServerNotification]) -> Vec<u64> {
    events
        .iter()
        .map(|n| to_json(n)["params"]["seq"].as_u64().unwrap())
        .collect()
}

fn methods(events: &[ServerNotification]) -> Vec<&'static str> {
    events.iter().map(ServerNotification::method).collect()
}

#[tokio::test]
async fn a_turn_streams_its_items_in_order_with_contiguous_sequence_numbers() {
    let h = start(Some(ScriptedModel::new([Reply::new()
        .thinking("let me think")
        .text("it works fine")
        .done()])))
    .await;
    let (c, mut notes) = h.client().await;
    let thread = new_thread(&c).await;
    let turn = say(&c, &thread, "hello").await.unwrap();

    let events = until(&mut notes, idle).await;
    assert_eq!(
        methods(&events),
        [
            "thread/status/changed", // running
            "turn/started",
            "item/completed", // the user's message
            "item/started",   // reasoning
            "item/reasoning/delta",
            "item/completed",
            "item/started", // answer
            "item/agentMessage/delta",
            "item/agentMessage/delta",
            "item/agentMessage/delta",
            "item/completed",
            "thread/tokenUsage/updated", // how full the window is after that request
            "turn/completed",
            "thread/status/changed", // idle, strictly after the completion
        ]
    );
    let s = seqs(&events);
    assert_eq!(
        s,
        (s[0]..s[0] + s.len() as u64).collect::<Vec<_>>(),
        "sequence numbers have gaps: {s:?}"
    );

    let completed = events.iter().find_map(|n| match n {
        ServerNotification::TurnCompleted(e) => Some(e.body.clone()),
        _ => None,
    });
    assert_eq!(
        completed,
        Some(TurnCompleted {
            turn_id: turn,
            status: TurnStatus::Completed,
            error: None
        })
    );

    // The finished answer is the text as the model wrote it, not the pieces.
    let answer = events.iter().rev().find_map(|n| match n {
        ServerNotification::ItemCompleted(e) => match &e.body.item {
            Item::AgentMessage { text, .. } => Some(text.clone()),
            _ => None,
        },
        _ => None,
    });
    assert_eq!(answer.as_deref(), Some("it works fine"));
}

#[tokio::test]
async fn tool_calls_appear_as_items_that_finish_with_their_output() {
    let h = start(Some(ScriptedModel::new([
        Reply::new()
            .tool("c1", "echo", json!({"text": "ping"}))
            .done(),
        Reply::new().text("got it").done(),
    ])))
    .await;
    let (c, mut notes) = h.client().await;
    let thread = new_thread(&c).await;
    say(&c, &thread, "use the tool").await.unwrap();
    let events = until(&mut notes, idle).await;

    let started = events.iter().any(|n| matches!(n, ServerNotification::ItemStarted(e) if matches!(&e.body.item, Item::ToolCall { name, output: None, .. } if name == "echo")));
    assert!(
        started,
        "tool call item never started: {:?}",
        methods(&events)
    );
    assert!(
        events
            .iter()
            .any(|n| n.method() == "item/toolCall/argumentsDelta")
    );

    let finished = events.iter().find_map(|n| match n {
        ServerNotification::ItemCompleted(e) => match &e.body.item {
            Item::ToolCall {
                id,
                arguments,
                output,
                is_error,
                ..
            } => Some((id.clone(), arguments.clone(), output.clone(), *is_error)),
            _ => None,
        },
        _ => None,
    });
    assert_eq!(
        finished,
        Some((
            "c1".into(),
            json!({"text": "ping"}),
            Some("echoed ping".into()),
            false
        ))
    );
}

#[tokio::test]
async fn interrupt_stops_the_turn_and_frees_the_thread() {
    let h = start(Some(ScriptedModel::new([
        Reply::new().text("working on it ").then_hang(),
        Reply::new().text("fresh start").done(),
    ])))
    .await;
    let (c, mut notes) = h.client().await;
    let thread = new_thread(&c).await;
    say(&c, &thread, "start").await.unwrap();

    until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;
    c.call::<TurnInterrupt>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    let rest = until(&mut notes, idle).await;

    let status = rest.iter().find_map(|n| match n {
        ServerNotification::TurnCompleted(e) => Some(e.body.status),
        _ => None,
    });
    assert_eq!(
        status,
        Some(TurnStatus::Interrupted),
        "{:?}",
        methods(&rest)
    );
    // The half-written answer is closed, not left spinning.
    assert!(rest.iter().any(|n| matches!(n, ServerNotification::ItemCompleted(e) if matches!(&e.body.item, Item::AgentMessage { text, .. } if text.starts_with("working")))));
    // An interruption is not an error item.
    assert!(!rest.iter().any(|n| matches!(n, ServerNotification::ItemCompleted(e) if matches!(e.body.item, Item::Error { .. }))));

    // The thread takes the next turn, and the model sees the stopped one in its history.
    say(&c, &thread, "again").await.unwrap();
    until(&mut notes, idle).await;
    let second = &h.model.as_ref().unwrap().requests()[1];
    assert!(
        matches!(&second.messages[1], fv_core::Message::Assistant(a) if a.text().starts_with("working"))
    );
}

#[tokio::test]
async fn interrupting_an_idle_thread_is_not_an_error() {
    let h = start(None).await;
    let (c, _n) = h.client().await;
    let thread = new_thread(&c).await;
    c.call::<TurnInterrupt>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
}

#[tokio::test]
async fn a_second_turn_while_one_runs_is_refused() {
    let h = start(Some(ScriptedModel::new([Reply::new()
        .text("busy ")
        .then_hang()])))
    .await;
    let (c, mut notes) = h.client().await;
    let thread = new_thread(&c).await;
    say(&c, &thread, "one").await.unwrap();
    until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;
    match say(&c, &thread, "two").await {
        Err(ClientError::Rpc(e)) => assert_eq!(e.code, code::THREAD_BUSY),
        other => panic!("{other:?}"),
    }
    c.call::<TurnInterrupt>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
    until(&mut notes, idle).await;
}

#[tokio::test]
async fn a_failed_turn_says_why_and_leaves_the_thread_usable() {
    let h = start(None).await;
    let (c, mut notes) = h.client().await;
    let thread = new_thread(&c).await;
    say(&c, &thread, "hi").await.unwrap();
    let events = until(&mut notes, idle).await;
    let failed = events.iter().find_map(|n| match n {
        ServerNotification::TurnCompleted(e) => Some(e.body.clone()),
        _ => None,
    });
    let failed = failed.expect("turn/completed");
    assert_eq!(failed.status, TurnStatus::Failed);
    assert!(failed.error.unwrap().contains("No model is configured"));
    assert!(events.iter().any(|n| matches!(n, ServerNotification::ItemCompleted(e) if matches!(e.body.item, Item::Error { .. }))));
    say(&c, &thread, "again")
        .await
        .expect("the thread is free again");
}

#[tokio::test]
async fn a_client_that_joins_mid_reply_gets_the_reply_so_far_and_then_only_newer_events() {
    let slow_words = Reply::new()
        .text("one ")
        .wait(Duration::from_millis(80))
        .text("two ")
        .wait(Duration::from_millis(80))
        .text("three ")
        .wait(Duration::from_millis(80))
        .text("four")
        .done();
    let h = start(Some(ScriptedModel::new([slow_words]))).await;
    let (a, mut notes_a) = h.client().await;
    let (b, mut notes_b) = h.client().await;
    let thread = new_thread(&a).await;
    say(&a, &thread, "count").await.unwrap();

    // Join once the answer is under way.
    until(&mut notes_a, |n| n.method() == "item/agentMessage/delta").await;
    let snapshot = b
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    assert!(snapshot.running);
    let partial = match snapshot.turns[0].items.last() {
        Some(Item::AgentMessage { text, .. }) => text.clone(),
        other => panic!("the reply in progress is not in the snapshot: {other:?}"),
    };
    assert!(
        !partial.is_empty() && partial.len() < "one two three four".len(),
        "partial = {partial:?}"
    );

    let rest = until(&mut notes_b, idle).await;
    let s = seqs(&rest);
    assert_eq!(
        s[0],
        snapshot.seq + 1,
        "events must continue exactly where the snapshot stopped"
    );
    assert_eq!(s, (s[0]..s[0] + s.len() as u64).collect::<Vec<_>>());

    // Snapshot text plus the deltas that followed is the whole answer: nothing doubled or lost.
    let mut text = partial;
    for n in &rest {
        if let ServerNotification::AgentMessageDelta(e) = n {
            text.push_str(&e.body.delta);
        }
    }
    assert_eq!(text, "one two three four");
}

#[tokio::test]
async fn a_client_that_never_joined_hears_nothing_of_the_thread() {
    let h = start(Some(ScriptedModel::new([Reply::new()
        .text("private")
        .done()])))
    .await;
    let (a, mut notes_a) = h.client().await;
    let (_bystander, mut notes_c) = h.client().await;
    let thread = new_thread(&a).await;
    say(&a, &thread, "hi").await.unwrap();
    until(&mut notes_a, idle).await;
    while let Ok(n) = notes_c.try_recv() {
        assert!(
            matches!(n.method(), "catalog/changed" | "thread/started"),
            "leaked {}",
            n.method()
        );
    }
}

#[tokio::test]
async fn history_carries_over_between_turns() {
    let h = start(Some(ScriptedModel::new([
        Reply::new().text("first answer").done(),
        Reply::new().text("second answer").done(),
    ])))
    .await;
    let (c, mut notes) = h.client().await;
    let thread = new_thread(&c).await;
    say(&c, &thread, "q1").await.unwrap();
    until(&mut notes, idle).await;
    say(&c, &thread, "q2").await.unwrap();
    until(&mut notes, idle).await;

    let requests = h.model.as_ref().unwrap().requests();
    assert_eq!(requests[1].messages.len(), 3);
    assert!(matches!(&requests[1].messages[0], fv_core::Message::User { text } if text == "q1"));
    assert!(matches!(&requests[1].messages[2], fv_core::Message::User { text } if text == "q2"));
    assert!(
        requests[1].system.starts_with("You are FastVibe") && requests[1].system.ends_with("sys"),
        "{}",
        requests[1].system
    );

    // And a later resume shows both turns.
    let snap = c
        .call::<ThreadResume>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
    assert_eq!(snap.turns.len(), 2);
    assert!(!snap.running);
}
