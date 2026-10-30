//! A ready scripted provider reaches spawn before the server drains committed events. This
//! exercises the persistence receipt, public role APIs, billing identities and restart together.
use futures_util::stream::BoxStream;
use fv_agent::{
    Model, ModelError, ModelEvent, ModelRequest,
    testing::{Reply, ScriptedModel},
};
use fv_client::Client;
use fv_core::Message;
use fv_protocol::{
    PROTOCOL_VERSION, ServerNotification,
    methods::*,
    subagents::*,
    types::*,
    usage::{UsageParams, UsageRange},
};
use fv_server::{ServerState, UnixServer};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
mod common;
#[derive(Default)]
struct ForkModel {
    requests: Mutex<Vec<ModelRequest>>,
}
impl Model for ForkModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        self.requests.lock().unwrap().push(request.clone());
        let last_user = request
            .messages
            .iter()
            .rev()
            .find_map(|m| match m {
                Message::User { text } => Some(text.as_str()),
                _ => None,
            })
            .unwrap();
        let tool = request.messages.iter().rev().find_map(|m| match m {
            Message::ToolResult { name, content, .. } => Some((name.as_str(), content.as_str())),
            _ => None,
        });
        let reply = match last_user {
            "remember data" => Reply::new().text("retained facts").done(),
            // The spawn tool prefixes the child's canonical task name onto its opening
            // message, and a finished child reports back with a FINAL_ANSWER message.
            text if text.ends_with("child task") || text.ends_with("child followup") => {
                assert!(request.system.contains("ROLE_SNAPSHOT_FIRST"));
                assert!(!request.system.contains("ROLE_SNAPSHOT_SECOND"));
                assert!(
                    request
                        .messages
                        .iter()
                        .any(|m| matches!(m,Message::User{text} if text=="remember data"))
                );
                assert!(
                    request
                        .messages
                        .iter()
                        .any(|m| matches!(m,Message::User{text} if text=="delegate now"))
                );
                assert!(
                    request
                        .messages
                        .iter()
                        .any(|m| matches!(m,Message::Assistant(a) if a.text()=="retained facts"))
                );
                assert!(!request.messages.iter().any(|m|matches!(m,Message::Assistant(a) if a.text()=="late parent answer" || a.tool_calls().any(|t|t.name=="spawn_agent"))));
                assert!(request.messages.iter().any(|m|matches!(m,Message::Assistant(a) if a.text().contains("current delegation plan"))));
                assert_eq!(
                    request
                        .tools
                        .iter()
                        .map(|t| t.name.as_str())
                        .collect::<Vec<_>>(),
                    ["view_image"]
                );
                Reply::new().text("fork complete").input_tokens(20).done()
            }
            "delegate now" => match tool {
                None => Reply::new()
                    .text("current delegation plan")
                    .tool(
                        "spawn-ready",
                        "spawn_agent",
                        json!({"message":"child task","fork_turns":"all","agent_type":"worker","task_name":"forked"}),
                    )
                    .done(),
                Some(("spawn_agent", output)) => {
                    let response: Value = serde_json::from_str(output).unwrap();
                    assert_eq!(response["task_name"], "/root/forked", "{output}");
                    Reply::new()
                        .tool(
                            "wait-child",
                            "wait_agent",
                            json!({"timeout_ms":3000}),
                        )
                        .done()
                }
                Some(("wait_agent", output)) => {
                    // v2 wait reports who updated, not the content: the forked child's
                    // answer lives in its transcript.
                    assert!(output.contains("/root/forked"), "{output}");
                    Reply::new()
                        .text("late parent answer")
                        .input_tokens(30)
                        .done()
                }
                _ => panic!("unexpected tool {tool:?}"),
            },
            text if text.starts_with("Message Type: FINAL_ANSWER") => {
                // The child's completion reaches the parent as its own message.
                assert!(text.contains("fork complete"), "{text}");
                Reply::new().text("parent saw the answer").done()
            }
            _ => panic!("unexpected prompt {last_user}"),
        };
        ScriptedModel::new([reply]).stream(request)
    }
}
async fn connect(
    socket: &std::path::Path,
) -> (
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) {
    let (client, notes) = Client::connect_unix(socket).await.unwrap();
    client
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
    (client, notes)
}
async fn say(
    client: &Client,
    notes: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
    id: &str,
    text: &str,
) {
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: id.into(),
            text: text.into(),
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5),async{
        while let Some(note)=notes.recv().await{if matches!(note,ServerNotification::ThreadStatusChanged(e) if e.thread_id==id&&!e.body.running){return;}}
        panic!("connection ended");
    }).await.unwrap();
}
#[tokio::test]
async fn live_context_fork_keeps_its_role_and_usage_identity_through_edits_delete_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let model = Arc::new(ForkModel::default());
    let state = Arc::new(
        ServerState::new(
            dir.path().into(),
            fv_server::agent_with_builtin_tools(model.clone()),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = dir.path().join("fork.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (client, mut notes) = connect(&socket).await;
    let roles = client.call::<SubagentRoleList>(Empty {}).await.unwrap();
    let worker = roles
        .roles
        .iter()
        .find(|r| r.id == "worker")
        .unwrap()
        .clone();
    let mut role = worker.clone();
    role.system_prompt = "ROLE_SNAPSHOT_FIRST".into();
    role.tools = Some(vec!["view_image".into()]);
    client
        .call::<SubagentRoleUpsert>(SubagentRoleUpsertParams {
            role: role.clone(),
            expected: Some(worker),
        })
        .await
        .unwrap();
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
    say(&client, &mut notes, &root, "remember data").await;
    say(&client, &mut notes, &root, "delegate now").await;
    let agents = client
        .call::<SubagentList>(SubagentListParams {
            thread_id: Some(root.clone()),
        })
        .await
        .unwrap()
        .agents;
    assert_eq!(agents.len(), 1);
    let child = &agents[0];
    assert!(child.fork_context);
    assert_eq!(child.status, SubagentStatus::Completed);
    let usage = client
        .call::<StatsUsage>(UsageParams {
            range: UsageRange::All,
            timezone: "Asia/Shanghai".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        usage.totals.metrics.requests, 5,
        "copied parent requests must retain their origins"
    );
    assert_eq!(
        usage
            .conversations
            .iter()
            .find(|c| c.session_id == child.agent_id)
            .unwrap()
            .metrics
            .input,
        20
    );
    let mut changed = role.clone();
    changed.system_prompt = "ROLE_SNAPSHOT_SECOND".into();
    client
        .call::<SubagentRoleUpsert>(SubagentRoleUpsertParams {
            role: changed.clone(),
            expected: Some(role.clone()),
        })
        .await
        .unwrap();
    assert!(
        client
            .call::<SubagentRoleUpsert>(SubagentRoleUpsertParams {
                role: role.clone(),
                expected: None
            })
            .await
            .is_err()
    );
    client
        .call::<SubagentRoleDelete>(SubagentRoleDeleteParams { expected: changed })
        .await
        .unwrap();
    server.abort();
    drop(client);
    let after = Arc::new(ForkModel::default());
    let reloaded = Arc::new(
        ServerState::new(
            dir.path().into(),
            fv_server::agent_with_builtin_tools(after.clone()),
        )
        .unwrap(),
    );
    let restart = dir.path().join("restart.sock");
    let server = tokio::spawn(UnixServer::bind(reloaded, &restart).await.unwrap().run());
    let (client, mut notes) = connect(&restart).await;
    say(&client, &mut notes, &child.agent_id, "child followup").await;
    let snapshot = client
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: child.agent_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        snapshot.turns.len(),
        4,
        "two inherited turns and two child turns"
    );
    let usage = client
        .call::<StatsUsage>(UsageParams {
            range: UsageRange::All,
            timezone: "Asia/Shanghai".into(),
        })
        .await
        .unwrap();
    assert_eq!(usage.totals.metrics.requests, 6);
    assert_eq!(
        usage
            .conversations
            .iter()
            .find(|c| c.session_id == child.agent_id)
            .unwrap()
            .metrics
            .input,
        40
    );
    // Deleting the override brings the built-in worker back; the override itself is gone.
    let after_delete = client
        .call::<SubagentRoleList>(Empty {})
        .await
        .unwrap()
        .roles;
    let worker = after_delete
        .iter()
        .find(|r| r.id == "worker")
        .expect("the built-in worker returns after its override is deleted");
    assert!(worker.builtin);
    assert!(worker.system_prompt != "ROLE_SNAPSHOT_SECOND");
    server.abort();
}
