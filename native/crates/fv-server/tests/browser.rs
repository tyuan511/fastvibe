//! The browser tool: the request a client gets, and what the model hears back.

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::{Initialize, ThreadStart, TurnStart};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification, ServerRequest};
use fv_server::{ServerState, UnixServer};
use serde_json::json;
use tokio::sync::mpsc::UnboundedReceiver;

type Notes = UnboundedReceiver<ServerNotification>;
type Requests = UnboundedReceiver<ServerRequest>;

struct Harness {
    _dir: tempfile::TempDir,
    sock: std::path::PathBuf,
    model: Arc<ScriptedModel>,
}

async fn start(model: ScriptedModel) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(model);
    let agent = fv_server::agent_with_builtin_tools(model.clone());
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), agent).unwrap());
    let sock = dir.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    Harness {
        _dir: dir,
        sock,
        model,
    }
}

struct Peer {
    client: Client,
    notes: Notes,
    requests: Requests,
}

impl Harness {
    async fn peer(&self) -> Peer {
        let (client, notes) = Client::connect_unix(&self.sock).await.unwrap();
        client
            .call::<Initialize>(InitializeParams {
                client_info: ClientInfo {
                    name: "t".into(),
                    version: "0".into(),
                },
                protocol_version: PROTOCOL_VERSION,
                capabilities: Default::default(),
            })
            .await
            .unwrap();
        let requests = client.take_requests().unwrap();
        Peer {
            client,
            notes,
            requests,
        }
    }
}

async fn recv<T>(rx: &mut UnboundedReceiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("timed out")
        .expect("closed")
}

async fn until(
    notes: &mut Notes,
    mut done: impl FnMut(&ServerNotification) -> bool,
) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    loop {
        let n = recv(notes).await;
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

fn tool_result(h: &Harness) -> (String, bool) {
    h.model.requests()[1]
        .messages
        .iter()
        .find_map(|m| match m {
            fv_core::Message::ToolResult {
                content, is_error, ..
            } => Some((content.clone(), *is_error)),
            _ => None,
        })
        .expect("the model saw a result")
}

#[tokio::test]
async fn the_client_runs_the_action_and_the_model_hears_its_answer() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("c1", "browser", json!({"action": "snapshot"}))
            .done(),
        Reply::new().text("done").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_thread(&p.client).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.clone(),
            text: "look".into(),
        })
        .await
        .unwrap();
    let ServerRequest::Browser { id, params } = recv(&mut p.requests).await else {
        panic!("expected a browser request")
    };
    assert_eq!(params.thread_id, thread);
    assert_eq!(params.action, "snapshot");
    p.client
        .respond(id, json!({"output": "e0 button \"Go\"", "isError": false}))
        .await
        .unwrap();
    until(&mut p.notes, idle).await;
    assert_eq!(tool_result(&h), ("e0 button \"Go\"".to_string(), false));
}

#[tokio::test]
async fn a_failed_action_is_an_error_the_model_can_act_on() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("c1", "browser", json!({"action": "click", "ref": "e9"}))
            .done(),
        Reply::new().text("done").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_thread(&p.client).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread,
            text: "click".into(),
        })
        .await
        .unwrap();
    let ServerRequest::Browser { id, .. } = recv(&mut p.requests).await else {
        panic!("expected a browser request")
    };
    p.client
        .respond(id, json!({"output": "no element e9", "isError": true}))
        .await
        .unwrap();
    until(&mut p.notes, idle).await;
    assert_eq!(tool_result(&h), ("no element e9".to_string(), true));
}

#[tokio::test]
async fn an_unknown_action_never_reaches_a_client() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("c1", "browser", json!({"action": "format_disk"}))
            .done(),
        Reply::new().text("done").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_thread(&p.client).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread,
            text: "x".into(),
        })
        .await
        .unwrap();
    until(&mut p.notes, idle).await;
    assert!(p.requests.try_recv().is_err());
    let (text, failed) = tool_result(&h);
    assert!(failed && text.contains("unknown action"), "{text}");
}
