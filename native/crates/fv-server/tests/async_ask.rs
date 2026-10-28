//! Asking and telling without waiting: the turn carries on, and the answer comes back as a message.

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

mod common;

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
    common::disable_reply_suggestions(&state);
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

#[tokio::test]
async fn a_question_asked_without_waiting_comes_back_as_a_message() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool(
                "c1",
                "request_user_input_async",
                json!({"questions": [{
                    "id": "branch", "header": "Branch", "question": "Which branch?",
                    "options": [{"label": "main", "description": "default"}, {"label": "dev", "description": "work"}]
                }]}),
            )
            .done(),
        Reply::new().text("carrying on").done(),
        Reply::new().text("thanks").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_thread(&p.client).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.clone(),
            text: "go".into(),
        })
        .await
        .unwrap();
    let ServerRequest::UserInput { id, .. } = recv(&mut p.requests).await else {
        panic!("expected a question")
    };
    // The turn is not held up by the question.
    until(&mut p.notes, idle).await;
    assert_eq!(h.model.requests().len(), 2);
    p.client
        .respond(id, json!({"answers": {"branch": {"answers": ["dev"]}}}))
        .await
        .unwrap();
    // The answer starts a turn of its own.
    until(&mut p.notes, idle).await;
    let requests = h.model.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[2].messages.iter().any(|m| matches!(
        m,
        fv_core::Message::User { text } if text.contains("answered") && text.contains("dev")
    )));
}

#[tokio::test]
async fn telling_the_user_pushes_a_notice_and_goes_on() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool(
                "c1",
                "send_message_to_user_async",
                json!({"message": "build finished"}),
            )
            .done(),
        Reply::new().text("done").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_thread(&p.client).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread,
            text: "go".into(),
        })
        .await
        .unwrap();
    let seen = until(&mut p.notes, idle).await;
    assert!(seen.iter().any(|n| matches!(
        n,
        ServerNotification::ThreadNotice(e) if e.body.text == "build finished"
    )));
}
