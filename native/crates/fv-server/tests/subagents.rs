//! Whole-engine collaboration over the public native protocol; no external model or UI.
use futures_util::stream::BoxStream;
use fv_agent::{
    Model, ModelError, ModelEvent, ModelRequest,
    testing::{Reply, ScriptedModel},
};
use fv_client::Client;
use fv_core::Message;
use fv_protocol::{
    PROTOCOL_VERSION, ServerNotification, ServerRequest, methods::*, subagents::*, types::*,
};
use fv_server::{ServerState, UnixServer};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
mod common;

struct DelegatingModel {
    question: bool,
}
impl Model for DelegatingModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        let child = request
            .messages
            .iter()
            .any(|m| matches!(m,Message::User{text} if text == "Write child artifact"));
        let last_tool = request.messages.iter().rev().find_map(|m| match m {
            Message::ToolResult { name, content, .. } => Some((name.as_str(), content.as_str())),
            _ => None,
        });
        let reply = if child {
            match last_tool {
                None if self.question => Reply::new().tool("question", "request_user_input", json!({"questions":[{"id":"scope","header":"Scope","question":"Proceed?","options":[{"label":"Proceed","description":"Write the artifact."},{"label":"Stop","description":"Do not write."}]}]})).done(),
                Some(("apply_patch",_)) => Reply::new().text("Child wrote artifact.txt").input_tokens(100).done(),
                _ => Reply::new().tool("patch", "apply_patch", json!({"input":"*** Begin Patch\n*** Add File: artifact.txt\n+from child\n*** End Patch"})).done(),
            }
        } else {
            match last_tool {
                None => Reply::new()
                    .tool(
                        "spawn",
                        "spawn_agent",
                        json!({"message":"Write child artifact"}),
                    )
                    .done(),
                Some(("spawn_agent", output)) => {
                    let parsed: Value = serde_json::from_str(output).unwrap();
                    Reply::new()
                        .tool(
                            "wait",
                            "wait_agent",
                            json!({"targets":[parsed["agent_id"]],"timeout_ms":3000}),
                        )
                        .done()
                }
                Some(("wait_agent", output)) => {
                    assert!(
                        output.contains("completed") || output.contains("waiting_for_input\":true"),
                        "{output}"
                    );
                    Reply::new().text("Parent received child status").done()
                }
                _ => panic!("unexpected model input: {request:?}"),
            }
        };
        ScriptedModel::new([reply]).stream(request)
    }
}
async fn init(client: &Client) {
    let response = client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(response.features.iter().any(|f| f == "subagents"));
}
async fn idle(notes: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>, id: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(note)=notes.recv().await {
            if matches!(note,ServerNotification::ThreadStatusChanged(e) if e.thread_id==id && !e.body.running){return;}
        }
        panic!("connection closed");
    }).await.unwrap();
}

#[tokio::test]
async fn delegate_write_wait_inspect_close_resume_and_delete_over_public_protocol() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(Arc::new(DelegatingModel { question: false })),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("s.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (client, mut notes) = Client::connect_unix(&socket).await.unwrap();
    init(&client).await;
    let root = client
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(work.path().display().to_string()),
            project: None,
            model: None,
            thinking: None,
        })
        .await
        .unwrap()
        .thread
        .id;
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: root.clone(),
            text: "Delegate writing".into(),
        })
        .await
        .unwrap();
    idle(&mut notes, &root).await;
    assert_eq!(
        std::fs::read_to_string(work.path().join("artifact.txt")).unwrap(),
        "from child\n"
    );
    let list = client
        .call::<SubagentList>(SubagentListParams {
            thread_id: Some(root.clone()),
        })
        .await
        .unwrap();
    assert_eq!(list.agents.len(), 1);
    let child = &list.agents[0];
    assert_eq!(child.status, SubagentStatus::Completed);
    assert!(child.result.contains("artifact.txt"));
    assert_eq!(
        client
            .call::<ThreadList>(ThreadListParams {
                include_archived: true
            })
            .await
            .unwrap()
            .threads
            .len(),
        1
    );
    let snapshot = client
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: child.agent_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(snapshot.turns.len(), 1);
    assert!(
        snapshot.turns[0]
            .items
            .iter()
            .any(|i| matches!(i,Item::ToolCall{name,is_error:false,..} if name=="apply_patch"))
    );
    let usage = client
        .call::<StatsUsage>(fv_protocol::usage::UsageParams {
            range: fv_protocol::usage::UsageRange::All,
            timezone: "Asia/Shanghai".into(),
        })
        .await
        .unwrap();
    let child_usage = usage
        .conversations
        .iter()
        .find(|row| row.session_id == child.agent_id)
        .unwrap();
    assert_eq!(
        child_usage.thread_id.as_deref(),
        Some(child.agent_id.as_str())
    );
    assert_eq!(child_usage.title.as_deref(), Some("Write child artifact"));
    assert_eq!(child_usage.metrics.input, 110); // 10 for the patch request, 100 for its final reply.
    assert_eq!(child_usage.metrics.requests, 2);
    assert!(!state.has_running_turns());
    let id = SubagentIdParams {
        agent_id: child.agent_id.clone(),
    };
    assert_eq!(
        client
            .call::<SubagentClose>(id.clone())
            .await
            .unwrap()
            .status,
        SubagentStatus::Closed
    );
    assert!(
        client
            .call::<TurnStart>(TurnStartParams {
                thread_id: child.agent_id.clone(),
                text: "bypass closed".into()
            })
            .await
            .is_err()
    );
    assert_eq!(
        client.call::<SubagentResume>(id).await.unwrap().status,
        SubagentStatus::Idle
    );
    client
        .call::<ThreadDelete>(ThreadIdParams { thread_id: root })
        .await
        .unwrap();
    assert!(
        client
            .call::<SubagentList>(SubagentListParams { thread_id: None })
            .await
            .unwrap()
            .agents
            .is_empty()
    );
    server.abort();
}

#[tokio::test]
async fn child_question_reaches_root_watchers_and_replays_when_root_reconnects() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(Arc::new(DelegatingModel { question: true })),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("s.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (client, mut notes) = Client::connect_unix(&socket).await.unwrap();
    init(&client).await;
    let mut requests = client.take_requests().unwrap();
    let root = client
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(work.path().display().to_string()),
            project: None,
            model: None,
            thinking: None,
        })
        .await
        .unwrap()
        .thread
        .id;
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: root.clone(),
            text: "Delegate with a question".into(),
        })
        .await
        .unwrap();
    let request = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    let ServerRequest::UserInput { id, params } = request else {
        panic!("expected question")
    };
    assert_ne!(params.thread_id, root);
    idle(&mut notes, &root).await;
    let list = client
        .call::<SubagentList>(SubagentListParams {
            thread_id: Some(root.clone()),
        })
        .await
        .unwrap();
    assert!(list.agents[0].waiting_for_input);
    let (other, mut other_notes) = Client::connect_unix(&socket).await.unwrap();
    init(&other).await;
    let mut replay = other.take_requests().unwrap();
    other
        .call::<ThreadResume>(ThreadIdParams { thread_id: root })
        .await
        .unwrap();
    let repeated = tokio::time::timeout(Duration::from_secs(2), replay.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(repeated.id(), &id);
    other
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: params.thread_id.clone(),
        })
        .await
        .unwrap();
    other
        .respond(id, json!({"answers":{"scope":{"answers":["Proceed"]}}}))
        .await
        .unwrap();
    idle(&mut other_notes, &params.thread_id).await;
    assert_eq!(
        std::fs::read_to_string(work.path().join("artifact.txt")).unwrap(),
        "from child\n"
    );
    assert!(
        !client
            .call::<SubagentList>(SubagentListParams { thread_id: None })
            .await
            .unwrap()
            .agents[0]
            .waiting_for_input
    );
    server.abort();
}
