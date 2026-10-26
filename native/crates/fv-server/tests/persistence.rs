//! What survives a restart, and when it reaches the disk.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{AgentContext, Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
use fv_client::Client;
use fv_protocol::methods::{
    Initialize, ThreadList, ThreadResume, ThreadStart, TurnInterrupt, TurnStart,
};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

type Notes = UnboundedReceiver<ServerNotification>;

struct Read;
impl Tool for Read {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "read".into(),
            description: String::new(),
            schema: json!({}),
        }
    }
    fn mutates(&self) -> bool {
        false
    }
    fn call(&self, _: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async { ToolOutput::ok("file contents") })
    }
}

/// One run of the server on `dir`. Dropping it stops the listener, as a quit would.
struct Run {
    sock: PathBuf,
    model: Arc<ScriptedModel>,
    listener: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Drop for Run {
    fn drop(&mut self) {
        self.listener.abort();
    }
}

async fn run(dir: &Path, name: &str, model: ScriptedModel) -> Run {
    let model = Arc::new(model);
    let mut tools = ToolRegistry::new();
    tools.register(Read);
    let agent = AgentContext {
        model: model.clone(),
        tools: Arc::new(tools),
        system: String::new(),
        cwd: None,
        ui: None,
        loaded: Default::default(),
        permissions: None,
        steer: None,
        memory: None,
        budget: Default::default(),
    };
    let state = Arc::new(ServerState::new(dir.to_path_buf(), agent).unwrap());
    let sock = dir.join(format!("{name}.sock"));
    let listener = tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    Run {
        sock,
        model,
        listener,
    }
}

impl Run {
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

async fn until(notes: &mut Notes, mut done: impl FnMut(&ServerNotification) -> bool) {
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), notes.recv())
            .await
            .expect("timed out")
            .expect("closed");
        if done(&n) {
            return;
        }
    }
}

fn idle(n: &ServerNotification) -> bool {
    matches!(n, ServerNotification::ThreadStatusChanged(e) if !e.body.running)
}

async fn say(c: &Client, notes: &mut Notes, thread: &str, text: &str) {
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.into(),
        text: text.into(),
    })
    .await
    .unwrap();
    until(notes, idle).await;
}

async fn new_thread(c: &Client) -> String {
    c.call::<ThreadStart>(ThreadStartParams {
        cwd: Some("/work".into()),
        project: None,
        model: None,
        thinking: None,
    })
    .await
    .unwrap()
    .thread
    .id
}

#[tokio::test]
async fn threads_and_their_history_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let thread = {
        let first = run(
            dir.path(),
            "a",
            ScriptedModel::new([
                Reply::new()
                    .thinking("plan")
                    .text("Reading.")
                    .tool("c1", "read", json!({}))
                    .done(),
                Reply::new().text("It says: file contents").done(),
            ]),
        )
        .await;
        let (c, mut notes) = first.client().await;
        let thread = new_thread(&c).await;
        say(&c, &mut notes, &thread, "What is in the file?\nsecond line").await;
        thread
    };

    // A new process on the same directory.
    let second = run(
        dir.path(),
        "b",
        ScriptedModel::new([Reply::new().text("More.").done()]),
    )
    .await;
    let (c, mut notes) = second.client().await;

    let listed = c
        .call::<ThreadList>(ThreadListParams {
            include_archived: false,
        })
        .await
        .unwrap()
        .threads;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, thread);
    assert_eq!(listed[0].cwd.as_deref(), Some("/work"));
    assert_eq!(
        listed[0].title, "What is in the file?",
        "named after the first line of the first prompt"
    );

    let snap = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    assert!(!snap.running);
    assert_eq!(snap.seq, 0, "a restored thread starts its sequence afresh");
    assert_eq!(snap.turns.len(), 1);
    let items = &snap.turns[0].items;
    assert!(
        matches!(&items[0], Item::UserMessage { text, .. } if text.starts_with("What is in the file?"))
    );
    assert!(matches!(&items[1], Item::Reasoning { text, .. } if text == "plan"));
    assert!(matches!(&items[2], Item::AgentMessage { text, .. } if text == "Reading."));
    assert!(
        matches!(&items[3], Item::ToolCall { id, output: Some(o), is_error: false, .. } if id == "c1" && o == "file contents")
    );
    assert!(matches!(&items[4], Item::AgentMessage { text, .. } if text.starts_with("It says")));

    // The conversation goes on from where it was: the model is shown everything said before.
    say(&c, &mut notes, &thread, "and then?").await;
    let request = &second.model.requests()[0];
    assert_eq!(
        request.messages.len(),
        5,
        "user, assistant+call, result, assistant, user"
    );
    assert!(
        matches!(&request.messages[0], fv_core::Message::User { text } if text.starts_with("What is in"))
    );
    assert!(
        matches!(&request.messages[2], fv_core::Message::ToolResult { call_id, .. } if call_id == "c1")
    );
    assert!(matches!(&request.messages[4], fv_core::Message::User { text } if text == "and then?"));

    // A later prompt does not rename the thread.
    let listed = c
        .call::<ThreadList>(ThreadListParams {
            include_archived: false,
        })
        .await
        .unwrap()
        .threads;
    assert_eq!(listed[0].title, "What is in the file?");
}

#[tokio::test]
async fn messages_reach_the_disk_as_they_are_written_not_when_the_turn_ends() {
    let dir = tempfile::tempdir().unwrap();
    let r = run(
        dir.path(),
        "a",
        ScriptedModel::new([Reply::new().text("half an answer ").then_hang()]),
    )
    .await;
    let (c, mut notes) = r.client().await;
    let thread = new_thread(&c).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "start".into(),
    })
    .await
    .unwrap();
    until(&mut notes, |n| n.method() == "item/agentMessage/delta").await;

    // Mid-turn, as if the process were killed right now: the prompt is safe, the half-written
    // reply is not (it is not a message yet).
    let file = dir.path().join("sessions").join(format!("{thread}.jsonl"));
    let during = std::fs::read_to_string(&file).unwrap();
    let records: Vec<serde_json::Value> = during
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(records.iter().filter(|r| r["type"] == "message").count(), 1);
    assert!(records.iter().any(|r| r["type"] == "turnStarted"));
    assert!(!records.iter().any(|r| r["type"] == "turnCompleted"));
    assert!(during.contains("\"start\"") && !during.contains("half an answer"));

    // Stopped, the reply as far as it got is kept.
    c.call::<TurnInterrupt>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    until(&mut notes, idle).await;
    let after = std::fs::read_to_string(&file).unwrap();
    let records: Vec<serde_json::Value> = after
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(records.iter().filter(|r| r["type"] == "message").count(), 2);
    assert!(records.iter().any(|r| r["type"] == "turnCompleted"
        && r["status"] == "interrupted"
        && r["error"].is_null()));
    assert!(after.contains("half an answer"));
}

#[tokio::test]
async fn a_long_first_prompt_gives_a_short_title() {
    let dir = tempfile::tempdir().unwrap();
    let r = run(
        dir.path(),
        "a",
        ScriptedModel::new([Reply::new().text("ok").done()]),
    )
    .await;
    let (c, mut notes) = r.client().await;
    let thread = new_thread(&c).await;
    say(&c, &mut notes, &thread, &"word ".repeat(40)).await;
    let listed = c
        .call::<ThreadList>(ThreadListParams {
            include_archived: false,
        })
        .await
        .unwrap()
        .threads;
    assert!(listed[0].title.ends_with('…'));
    assert_eq!(listed[0].title.chars().count(), 61);
}

#[tokio::test]
async fn a_thread_with_no_transcript_opens_empty() {
    let dir = tempfile::tempdir().unwrap();
    let r = run(dir.path(), "a", ScriptedModel::new([])).await;
    let (c, _n) = r.client().await;
    let thread = new_thread(&c).await;
    let snap = c
        .call::<ThreadResume>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
    assert!(snap.turns.is_empty());
}
