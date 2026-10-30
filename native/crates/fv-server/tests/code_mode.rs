//! Code-mode effects use the public native engine, not an alternate command path.
use futures_util::stream::BoxStream;
use fv_agent::{
    Model, ModelError, ModelEvent, ModelRequest,
    testing::{Reply, ScriptedModel},
};
use fv_client::Client;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification, ServerRequest, methods::*, types::*};
use fv_server::{ServerState, UnixServer};
use serde_json::json;
use std::{sync::Arc, time::Duration};
mod common;
async fn connect(
    path: &std::path::Path,
) -> (
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
) {
    let (c, n) = Client::connect_unix(path).await.unwrap();
    let init = c
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "code-mode-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(init.features.iter().any(|f| f == "codeMode"));
    (c, n)
}
async fn idle(notes: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>, id: &str) {
    tokio::time::timeout(Duration::from_secs(8),async{while let Some(n)=notes.recv().await{if matches!(n,ServerNotification::ThreadStatusChanged(e)if e.thread_id==id&&!e.body.running){return;}}panic!("disconnected");}).await.unwrap();
}
async fn start(c: &Client, work: &std::path::Path) -> String {
    c.call::<ThreadStart>(ThreadStartParams {
        cwd: Some(work.display().to_string()),
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
async fn nested_patch_is_visible_after_restart_but_only_printed_output_reaches_the_model() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let code = "const result=await tools.apply_patch({input:'*** Begin Patch\\n*** Add File: artifact.txt\\n+from JS\\n*** End Patch'.replaceAll('\\\\n','\\n')});store('saved',123);text('compact result');";
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool("script", "code_mode", json!({"code":code}))
            .done(),
        Reply::new().text("finished").done(),
    ]));
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(model.clone()),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (c, mut notes) = connect(&socket).await;
    let thread = start(&c, work.path()).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "write with JS".into(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    assert_eq!(
        std::fs::read_to_string(work.path().join("artifact.txt")).unwrap(),
        "from JS\n"
    );
    let requests = model.requests();
    assert_eq!(requests.len(), 2);
    let results = requests[1]
        .messages
        .iter()
        .filter_map(|m| match m {
            fv_core::Message::ToolResult { name, content, .. } => Some((name, content)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, "code_mode");
    assert!(results[0].1.contains("compact result"));
    assert!(!results[0].1.contains("Success"));
    let output = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    assert!(output.turns[0].items.iter().any(
        |i| matches!(i,Item::ToolCall{name,output:Some(_),is_error:false,..}if name=="apply_patch")
    ));
    state.shutdown_schedules().await;
    server.abort();
    drop(c);
    let restored = ServerState::new(
        data.path().into(),
        fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
    )
    .unwrap();
    let loaded = restored.store.transcripts.read(&thread).unwrap();
    assert_eq!(loaded.skipped, 0);
    assert!(loaded.turns()[0].items.iter().any(
        |i| matches!(i,Item::ToolCall{name,output:Some(_),is_error:false,..}if name=="apply_patch")
    ));
    assert_eq!(
        loaded
            .messages
            .iter()
            .filter(|m| matches!(m, fv_core::Message::ToolResult { .. }))
            .count(),
        1
    );
    let branch = restored.fork_thread(&thread).unwrap();
    assert!(
        restored.store.transcripts.read(&branch.id).unwrap().turns()[0]
            .items
            .iter()
            .any(|i| matches!(i,Item::ToolCall{name,..}if name=="apply_patch"))
    );
}
#[tokio::test]
async fn nested_escalation_waits_for_the_same_approval_and_denial_cannot_write() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("never.txt");
    let command = format!("printf denied > '{}'", target.display());
    let code = format!(
        "try{{await tools.exec_command({})}}catch(e){{text(String(e))}}",
        json!({"cmd":command,"login":false,"sandbox_permissions":"require_escalated","justification":"test outside write"})
    );
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool("script", "code_mode", json!({"code":code}))
            .done(),
        Reply::new().text("denied correctly").done(),
    ]));
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(model),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (c, mut notes) = connect(&socket).await;
    c.call::<SettingsSet>(AppSettingsPatch {
        sandbox_mode: Some(SandboxMode::WorkspaceWrite),
        approval_policy: Some(ApprovalPolicy::OnRequest),
        ..Default::default()
    })
    .await
    .unwrap();
    let mut requests = c.take_requests().unwrap();
    let thread = start(&c, work.path()).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "attempt write".into(),
    })
    .await
    .unwrap();
    let approval = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(!target.exists());
    let ServerRequest::Approval { id, params } = approval else {
        panic!("expected approval")
    };
    assert!(params.call_id.contains("/code/"));
    c.respond(id, json!({"decision":"deny"})).await.unwrap();
    idle(&mut notes, &thread).await;
    assert!(!target.exists());
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
    assert!(
        snapshot.turns[0]
            .items
            .iter()
            .any(|i| matches!(i,Item::ToolCall{name,is_error:true,..}if name=="exec_command"))
    );
    state.shutdown_schedules().await;
    server.abort();
}
struct YieldModel;
impl Model for YieldModel {
    fn stream(&self, r: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        let previous = r.messages.iter().rev().find_map(|m| match m {
            fv_core::Message::ToolResult { name, content, .. } => Some((name.as_str(), content)),
            _ => None,
        });
        let reply=match previous {
            Some(("code_mode",output))=>{let id=output.strip_prefix("Script running with cell ID ").unwrap().split('.').next().unwrap();Reply::new().tool("collect","wait",json!({"cell_id":id,"yield_time_ms":1000})).done()},
            Some(("wait",_))=>Reply::new().text("collected").done(),
            _=>Reply::new().tool("script","code_mode",json!({"code":"text('early');await yield_control();await new Promise(r=>setTimeout(r,60));text('late');"})).done(),
        };
        ScriptedModel::new([reply]).stream(r)
    }
}
#[tokio::test]
async fn setting_removes_code_mode_and_wait_at_the_next_turn() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool("script", "code_mode", json!({"code":"text(123)"}))
            .done(),
        Reply::new().text("done").done(),
        Reply::new().text("disabled").done(),
    ]));
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(model.clone()),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (c, mut notes) = connect(&socket).await;
    let thread = start(&c, work.path()).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "enabled".into(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    c.call::<SettingsSet>(AppSettingsPatch {
        code_mode_enabled: Some(false),
        ..Default::default()
    })
    .await
    .unwrap();
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "disabled".into(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    assert!(
        model.requests()[0]
            .tools
            .iter()
            .any(|s| s.name == "code_mode")
    );
    assert!(
        !model.requests()[2]
            .tools
            .iter()
            .any(|s| matches!(s.name.as_str(), "code_mode" | "wait"))
    );
    state.shutdown_schedules().await;
    server.abort();
}

#[tokio::test]
async fn yielded_cell_is_continued_through_the_public_engine_without_duplicate_output() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(Arc::new(YieldModel)),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (c, mut notes) = connect(&socket).await;
    let thread = start(&c, work.path()).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "yield and collect".into(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
    let outputs = snapshot.turns[0]
        .items
        .iter()
        .filter_map(|i| match i {
            Item::ToolCall {
                name,
                output: Some(output),
                ..
            } => Some((name.as_str(), output)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(outputs.len(), 2);
    assert!(outputs[0].1.contains("early"));
    assert!(!outputs[0].1.contains("late"));
    assert!(outputs[1].1.contains("late"));
    assert!(!outputs[1].1.contains("early"));
    state.shutdown_schedules().await;
    server.abort();
}

struct ForkModel;
impl Model for ForkModel {
    fn stream(&self, r: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        // The spawn tool prefixes the child's canonical task name onto its opening message.
        let child = r
            .messages
            .iter()
            .any(|m| matches!(m,fv_core::Message::User{text}if text.ends_with("child task")));
        let reply = if child {
            Reply::new().text("child inherited context").done()
        } else if r
            .messages
            .iter()
            .any(|m| matches!(m,fv_core::Message::ToolResult{name,..}if name=="code_mode"))
        {
            Reply::new().text("delegation finished").done()
        } else {
            Reply::new().tool("script","code_mode",json!({"code":"const child=await tools.spawn_agent({message:'child task',task_name:'inner',fork_turns:'all'});text(child.task_name);text(await tools.wait_agent({timeout_ms:3000}));"})).done()
        };
        ScriptedModel::new([reply]).stream(r)
    }
}
#[tokio::test]
async fn nested_delegation_forks_the_outer_durable_boundary_and_can_wait_for_the_child() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(Arc::new(ForkModel)),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (c, mut notes) = connect(&socket).await;
    let thread = start(&c, work.path()).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "delegate using parent context".into(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    let children = c
        .call::<SubagentList>(fv_protocol::subagents::SubagentListParams {
            thread_id: Some(thread),
        })
        .await
        .unwrap();
    assert_eq!(children.agents.len(), 1);
    assert_eq!(
        children.agents[0].status,
        fv_protocol::subagents::SubagentStatus::Completed
    );
    let inherited = state
        .store
        .transcripts
        .read(&children.agents[0].agent_id)
        .unwrap();
    assert!(
        inherited.messages.iter().any(
            |m| matches!(m,fv_core::Message::User{text}if text=="delegate using parent context")
        )
    );
    assert!(!inherited.messages.iter().any(
        |m| matches!(m,fv_core::Message::Assistant(a)if a.tool_calls().any(|t|t.name=="code_mode"))
    ));
    state.shutdown_schedules().await;
    server.abort();
}
#[tokio::test]
async fn interrupting_a_yielded_script_cancels_its_pending_real_command() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let model=Arc::new(ScriptedModel::new([Reply::new().tool("script","code_mode",json!({"code":"await tools.exec_command({cmd:'echo $$ > pid; exec sleep 60',login:false,yield_time_ms:1000});await new Promise(()=>{});","yield_time_ms":20})).done(),vec![fv_agent::testing::Step::Hang]]));
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(model),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (c, mut notes) = connect(&socket).await;
    let thread = start(&c, work.path()).await;
    let _turn = c
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.clone(),
            text: "run and wait".into(),
        })
        .await
        .unwrap();
    let pid = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(pid) = std::fs::read_to_string(work.path().join("pid"))
                && let Ok(pid) = pid.trim().parse::<i32>()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
    c.call::<TurnInterrupt>(ThreadIdParams {
        thread_id: thread.clone(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    state.shutdown_schedules().await;
    server.abort();
}

#[tokio::test]
async fn a_returned_command_session_survives_the_cell_and_can_be_polled_in_a_later_cell() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let first = "const result=await tools.exec_command({cmd:'sleep 0.6; printf later-output',login:false,yield_time_ms:250});const id=Number(result.match(/session ID (\\d+)/)[1]);store('process',id);text(id);";
    let second =
        "text(await tools.write_stdin({session_id:load('process'),chars:'',yield_time_ms:1000}));";
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool("launch", "code_mode", json!({"code":first}))
            .done(),
        Reply::new()
            .tool("poll", "code_mode", json!({"code":second}))
            .done(),
        Reply::new().text("done").done(),
    ]));
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(model.clone()),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (c, mut notes) = connect(&socket).await;
    let thread = start(&c, work.path()).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "launch then poll across cells".into(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    let requests = model.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[2].messages.iter().any(|m|matches!(m,fv_core::Message::ToolResult{call_id,content,is_error:false,..}if call_id=="poll"&&content.contains("later-output")&&content.contains("Process exited with code 0"))));
    state.shutdown_schedules().await;
    server.abort();
}

struct ReadOnlyModel;
impl Model for ReadOnlyModel {
    fn stream(&self, r: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        let child = r
            .messages
            .iter()
            .any(|m| matches!(m,fv_core::Message::User{text}if text.ends_with("inspect readonly")));
        let last = r.messages.iter().rev().find_map(|m| match m {
            fv_core::Message::ToolResult { name, content, .. } => Some((name.as_str(), content)),
            _ => None,
        });
        let reply = if child {
            assert!(r.tools.iter().any(|t| t.name == "code_mode"));
            assert!(!r.tools.iter().any(|t| t.name == "apply_patch"));
            if last.is_some_and(|(name, _)| name == "code_mode") {
                Reply::new().text("read-only preserved").done()
            } else {
                Reply::new().tool("readonly-script","code_mode",json!({"code":"text(typeof tools.apply_patch);let blocked=false;try{await tools.exec_command({cmd:'printf denied > readonly-target',login:false})}catch{blocked=true}text(blocked);"})).done()
            }
        } else {
            match last {
                None => Reply::new()
                    .tool(
                        "spawn",
                        "spawn_agent",
                        json!({"message":"inspect readonly","agent_type":"explorer","task_name":"scout"}),
                    )
                    .done(),
                Some(("spawn_agent", out)) => {
                    let child: serde_json::Value = serde_json::from_str(out).unwrap();
                    assert_eq!(child["task_name"], "/root/scout");
                    Reply::new()
                        .tool(
                            "wait-child",
                            "wait_agent",
                            json!({"timeout_ms":3000}),
                        )
                        .done()
                }
                _ => Reply::new().text("inspected").done(),
            }
        };
        ScriptedModel::new([reply]).stream(r)
    }
}
#[tokio::test]
async fn a_read_only_role_can_orchestrate_its_own_tools_without_acquiring_write_access() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let state = Arc::new(
        ServerState::new(
            data.path().into(),
            fv_server::agent_with_builtin_tools(Arc::new(ReadOnlyModel)),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (c, mut notes) = connect(&socket).await;
    let thread = start(&c, work.path()).await;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "readonly JS orchestration".into(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    assert!(!work.path().join("readonly-target").exists());
    let children = c
        .call::<SubagentList>(fv_protocol::subagents::SubagentListParams {
            thread_id: Some(thread),
        })
        .await
        .unwrap();
    assert_eq!(children.agents.len(), 1);
    assert_eq!(
        children.agents[0].status,
        fv_protocol::subagents::SubagentStatus::Completed
    );
    let child = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: children.agents[0].agent_id.clone(),
        })
        .await
        .unwrap();
    // With the codex fork default the transcript starts with the inherited prefix, so the
    // code_mode call can sit in any turn of the child's history.
    assert!(child.turns.iter().flat_map(|t| t.items.iter()).any(|i|matches!(i,Item::ToolCall{name,output:Some(out),is_error:false,..}if name=="code_mode"&&out.contains("undefined\ntrue"))));
    state.shutdown_schedules().await;
    server.abort();
}
