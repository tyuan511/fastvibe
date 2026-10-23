//! The plan and the questions: what a client sees, and how it answers.

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::{Initialize, ThreadResume, ThreadStart, TurnInterrupt, TurnStart};
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, RequestId, ServerNotification, ServerRequest};
use fv_server::{ServerState, UnixServer};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

type Notes = UnboundedReceiver<ServerNotification>;
type Requests = UnboundedReceiver<ServerRequest>;

struct Harness {
    _dir: tempfile::TempDir,
    sock: std::path::PathBuf,
    model: Arc<ScriptedModel>,
    state: Arc<ServerState>,
}

async fn start(model: ScriptedModel) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(model);
    let agent = fv_server::agent_with_builtin_tools(model.clone());
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), agent).unwrap());
    let sock = dir.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    Harness {
        _dir: dir,
        sock,
        model,
        state,
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
    })
    .await
    .unwrap()
    .thread
    .id
}

fn ask_args() -> Value {
    json!({"questions": [{
        "id": "scope",
        "header": "Scope",
        "question": "How much should I change?",
        "options": [
            {"label": "Just this file", "description": "Smallest change"},
            {"label": "Everything", "description": "Larger refactor"}
        ]
    }]})
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

#[tokio::test]
async fn a_plan_update_reaches_clients_as_an_event() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool(
                "p1",
                "update_plan",
                json!({"explanation": "here we go", "plan": [
                    {"step": "look around", "status": "in_progress"},
                    {"step": "change it", "status": "pending"}
                ]}),
            )
            .done(),
        Reply::new().text("planned").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_thread(&p.client).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread,
            text: "plan it".into(),
        })
        .await
        .unwrap();
    let events = until(&mut p.notes, idle).await;

    let update = events.iter().find_map(|n| match n {
        ServerNotification::TurnPlanUpdated(e) => Some(e.body.clone()),
        _ => None,
    });
    let update = update.expect("turn/plan/updated");
    assert_eq!(update.explanation.as_deref(), Some("here we go"));
    assert_eq!(
        update.plan,
        vec![
            PlanStep {
                step: "look around".into(),
                status: PlanStatus::InProgress
            },
            PlanStep {
                step: "change it".into(),
                status: PlanStatus::Pending
            },
        ]
    );
    // It is also an ordinary tool item, so a thread read later still shows the plan.
    assert_eq!(
        tool_output(&events, "update_plan"),
        Some(("Plan updated", false))
    );
}

#[tokio::test]
async fn a_malformed_plan_is_an_error_and_not_an_event() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool(
                "p1",
                "update_plan",
                json!({"plan": [{"step": "x", "status": "doing"}]}),
            )
            .done(),
        Reply::new().text("ok").done(),
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
    let events = until(&mut p.notes, idle).await;
    assert!(!events.iter().any(|n| n.method() == "turn/plan/updated"));
    assert!(
        tool_output(&events, "update_plan").unwrap().1,
        "the model was not told its plan was invalid"
    );
}

#[tokio::test]
async fn a_question_stops_the_turn_until_the_client_answers() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("q1", "request_user_input", ask_args())
            .done(),
        Reply::new().text("Going with that.").done(),
    ]))
    .await;
    let mut p = h.peer().await;
    let thread = new_thread(&p.client).await;
    p.client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.clone(),
            text: "refactor".into(),
        })
        .await
        .unwrap();

    // The question arrives as a request, and the turn is still running while it waits.
    let ServerRequest::UserInput { id, params } = recv(&mut p.requests).await;
    assert_eq!(params.thread_id, thread);
    assert_eq!(params.call_id, "q1");
    assert_eq!(params.questions[0].id, "scope");
    assert!(params.questions[0].is_other);
    assert_eq!(
        h.model.requests().len(),
        1,
        "the model was asked again before the user answered"
    );

    p.client
        .respond(
            id.clone(),
            json!({"answers": {"scope": {"answers": ["Just this file"]}}}),
        )
        .await
        .unwrap();
    let events = until(&mut p.notes, idle).await;

    // Everyone is told it was answered, before the turn goes on.
    let resolved_at = events
        .iter()
        .position(|n| matches!(n, ServerNotification::ServerRequestResolved(e) if e.body.request_id == id))
        .expect("serverRequest/resolved");
    let completed_at = events
        .iter()
        .position(|n| n.method() == "turn/completed")
        .unwrap();
    assert!(resolved_at < completed_at);

    // The model got the answer as the tool's result.
    let (output, is_error) = tool_output(&events, "request_user_input").unwrap();
    assert!(!is_error);
    assert_eq!(
        serde_json::from_str::<Value>(output).unwrap(),
        json!({"answers": {"scope": {"answers": ["Just this file"]}}})
    );
    assert_eq!(h.model.requests().len(), 2);
}

#[tokio::test]
async fn declining_a_question_tells_the_model_and_the_turn_goes_on() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("q1", "request_user_input", ask_args())
            .done(),
        Reply::new().text("Fine, I will decide.").done(),
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
    let request = recv(&mut p.requests).await;
    p.client
        .decline(request.id().clone(), "not now")
        .await
        .unwrap();
    let events = until(&mut p.notes, idle).await;
    let (output, is_error) = tool_output(&events, "request_user_input").unwrap();
    assert!(is_error && output.contains("cancelled"), "{output}");
    assert!(events.iter().any(|n| matches!(n, ServerNotification::TurnCompleted(e) if e.body.status == TurnStatus::Completed)));
}

#[tokio::test]
async fn stopping_the_turn_withdraws_the_question() {
    let h = start(ScriptedModel::new([Reply::new()
        .tool("q1", "request_user_input", ask_args())
        .done()]))
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
    let request = recv(&mut p.requests).await;
    assert_eq!(h.state.pending_prompts(&thread).len(), 1);

    p.client
        .call::<TurnInterrupt>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    let events = until(&mut p.notes, idle).await;
    assert!(
        events.iter().any(|n| matches!(n, ServerNotification::ServerRequestResolved(e) if &e.body.request_id == request.id())),
        "clients were left showing a question nobody is waiting for"
    );
    assert!(events.iter().any(|n| matches!(n, ServerNotification::TurnCompleted(e) if e.body.status == TurnStatus::Interrupted)));
    assert!(h.state.pending_prompts(&thread).is_empty());
}

#[tokio::test]
async fn a_client_that_opens_the_thread_later_is_shown_the_waiting_question() {
    let h = start(ScriptedModel::new([
        Reply::new()
            .tool("q1", "request_user_input", ask_args())
            .done(),
        Reply::new().text("Done.").done(),
    ]))
    .await;
    let mut first = h.peer().await;
    let thread = new_thread(&first.client).await;
    first
        .client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.clone(),
            text: "go".into(),
        })
        .await
        .unwrap();
    let original = recv(&mut first.requests).await;

    // A second client (the phone, say) opens the thread while the question is unanswered.
    let mut second = h.peer().await;
    let snapshot = second
        .client
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    assert!(snapshot.running);
    let replayed = recv(&mut second.requests).await;
    assert_eq!(
        replayed.id(),
        original.id(),
        "the same request, so either client can answer it"
    );

    // It answers; the first client is told, and its prompt comes down.
    second
        .client
        .respond(
            replayed.id().clone(),
            json!({"answers": {"scope": {"answers": ["Everything"]}}}),
        )
        .await
        .unwrap();
    let seen = until(&mut first.notes, idle).await;
    assert!(seen.iter().any(|n| matches!(n, ServerNotification::ServerRequestResolved(e) if &e.body.request_id == original.id())));
    assert_eq!(
        tool_output(&seen, "request_user_input").map(|o| o.1),
        Some(false)
    );

    // A late, duplicate answer from the first client is ignored.
    first
        .client
        .respond(original.id().clone(), json!({"answers": {}}))
        .await
        .unwrap();
    assert_eq!(h.model.requests().len(), 2);
}

#[tokio::test]
async fn answers_to_unknown_requests_are_ignored() {
    let h = start(ScriptedModel::new([])).await;
    let p = h.peer().await;
    p.client
        .respond(
            RequestId::String("never-asked".into()),
            json!({"answers": {}}),
        )
        .await
        .unwrap();
    // Still usable afterwards.
    new_thread(&p.client).await;
}
