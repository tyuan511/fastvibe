//! Leaving the sandbox, through the protocol: the request, the answers, what the model hears.

//! The plan and the questions: what a client sees, and how it answers.

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::{Initialize, ThreadStart, TurnStart};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification, ServerRequest};
use fv_server::{ServerState, UnixServer};
use serde_json::{Value, json};
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

fn escalated(target: &std::path::Path) -> Value {
    json!({
        "cmd": format!("echo hi > {}", target.display()),
        "login": false,
        "sandbox_permissions": "require_escalated",
        "justification": "write outside the project"
    })
}

fn output_of(events: &[ServerNotification]) -> (String, bool) {
    let (o, e) = tool_output(events, "exec_command").expect("the command finished");
    (o.to_string(), e)
}

fn tool_output<'a>(events: &'a [ServerNotification], name: &str) -> Option<(&'a str, bool)> {
    events.iter().find_map(|n| match n {
        ServerNotification::ItemCompleted(e) => match &e.body.item {
            Item::ToolCall {
                name: n,
                output: Some(o),
                is_error,
                ..
            } if n == name => Some((o.as_str(), *is_error)),
            _ => None,
        },
        _ => None,
    })
}

async fn new_in(c: &Client, dir: &std::path::Path) -> String {
    c.call::<ThreadStart>(ThreadStartParams {
        cwd: Some(dir.display().to_string()),
        ..Default::default()
    })
    .await
    .unwrap()
    .thread
    .id
}

#[tokio::test]
async fn leaving_the_sandbox_asks_the_client_and_runs_only_on_a_yes() {
    if !fv_sandbox::available() {
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let away = tempfile::tempdir().unwrap();
    let target = away.path().join("out.txt");
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("c1", "exec_command", escalated(&target))
            .done(),
        Reply::new().text("done").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_in(&p.client, work.path()).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.clone(),
            text: "write it".into(),
        })
        .await
        .unwrap();

    // The command waits for the user, and says why and what.
    let ServerRequest::Approval { id, params } = recv(&mut p.requests).await else {
        panic!("expected an approval request")
    };
    assert_eq!(params.thread_id, thread);
    assert_eq!(params.call_id, "c1");
    assert_eq!(params.reason.as_deref(), Some("write outside the project"));
    assert!(
        matches!(&params.kind, ApprovalKind::Command { command, .. } if command.contains("out.txt"))
    );
    assert!(!target.exists(), "it ran before the user answered");

    p.client
        .respond(id, json!({"decision": "approved"}))
        .await
        .unwrap();
    let events = until(&mut p.notes, idle).await;
    let (out, failed) = output_of(&events);
    assert!(!failed, "{out}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "hi\n");
    // Everyone is told the request is settled.
    assert!(
        events
            .iter()
            .any(|n| matches!(n, ServerNotification::ServerRequestResolved(_)))
    );
}

#[tokio::test]
async fn a_no_leaves_the_command_unrun_and_tells_the_model() {
    if !fv_sandbox::available() {
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let away = tempfile::tempdir().unwrap();
    let target = away.path().join("out.txt");
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("c1", "exec_command", escalated(&target))
            .done(),
        Reply::new().text("understood").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_in(&p.client, work.path()).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread,
            text: "write it".into(),
        })
        .await
        .unwrap();
    let ServerRequest::Approval { id, .. } = recv(&mut p.requests).await else {
        panic!("expected an approval request")
    };
    p.client
        .respond(id, json!({"decision": "denied"}))
        .await
        .unwrap();
    let events = until(&mut p.notes, idle).await;
    let (out, failed) = output_of(&events);
    assert!(failed && out.contains("did not allow"), "{out}");
    assert!(!target.exists());
}

#[tokio::test]
async fn approved_for_the_session_is_not_asked_again() {
    if !fv_sandbox::available() {
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let away = tempfile::tempdir().unwrap();
    let target = away.path().join("out.txt");
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("c1", "exec_command", escalated(&target))
            .done(),
        Reply::new()
            .tool("c2", "exec_command", escalated(&target))
            .done(),
        Reply::new().text("twice").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_in(&p.client, work.path()).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread,
            text: "write it twice".into(),
        })
        .await
        .unwrap();
    let ServerRequest::Approval { id, .. } = recv(&mut p.requests).await else {
        panic!("expected an approval request")
    };
    p.client
        .respond(id, json!({"decision": "approvedForSession"}))
        .await
        .unwrap();
    let events = until(&mut p.notes, idle).await;
    let ran = events
        .iter()
        .filter(|n| matches!(n, ServerNotification::ItemCompleted(e) if matches!(&e.body.item, Item::ToolCall { is_error: false, .. })))
        .count();
    assert_eq!(ran, 2, "both runs went through");
    assert!(
        p.requests.try_recv().is_err(),
        "the second was asked about again"
    );
}

#[tokio::test]
async fn the_model_is_told_what_its_sandbox_allows() {
    let work = tempfile::tempdir().unwrap();
    let h = start(ScriptedModel::new([Reply::new().text("ok").done()])).await;
    let mut p = h.peer().await;
    let thread = new_in(&p.client, work.path()).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread,
            text: "hi".into(),
        })
        .await
        .unwrap();
    until(&mut p.notes, idle).await;
    let system = h.model.requests()[0].system.clone();
    assert!(
        system.contains("Filesystem sandboxing and approvals"),
        "{system}"
    );
    assert!(system.contains("write only inside"), "{system}");
    assert!(
        system.contains(&work.path().canonicalize().unwrap().display().to_string())
            || system.contains(&work.path().display().to_string()),
        "{system}"
    );
    assert!(system.contains("require_escalated"), "{system}");
    assert!(
        system.contains("Network access from commands is blocked"),
        "{system}"
    );
}
