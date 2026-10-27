use super::*;
use fv_agent::testing::{Reply, ScriptedModel, Step};

fn state(model: Arc<dyn fv_agent::Model>) -> (tempfile::TempDir, Arc<ServerState>, String) {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(
        ServerState::new(dir.path().into(), crate::agent_with_builtin_tools(model)).unwrap(),
    );
    let root = state.create_thread(None, None, None, None).unwrap();
    (dir, state, root.id)
}
fn task(message: &str) -> SpawnArgs {
    SpawnArgs {
        message: message.into(),
        model: None,
        reasoning_effort: None,
        ..Default::default()
    }
}
async fn done(state: &ServerState, parent: &str, id: &str) -> Value {
    tokio::time::timeout(
        Duration::from_secs(3),
        wait(
            state,
            parent,
            WaitArgs {
                targets: vec![id.into()],
                timeout_ms: Some(2000),
            },
            &CancellationToken::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap()
}
async fn settle(state: &ServerState, id: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while state
            .loaded_runtime(id)
            .is_some_and(|rt| rt.is_running() || rt.exec_sessions.has_running())
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn independent_history_persists_and_send_resumes_finished_child() {
    let model = Arc::new(ScriptedModel::new([
        Reply::new().text("child result").done(),
        Reply::new().text("followup result").done(),
    ]));
    let (dir, s, root) = state(model.clone());
    let child = spawn(&s, &root, task("first task"), &CancellationToken::new())
        .await
        .unwrap();
    let result = done(&s, &root, &child.agent_id).await;
    assert_eq!(result["status"][&child.agent_id]["result"], "child result");
    assert_eq!(
        s.threads(false).unwrap().len(),
        1,
        "children have a separate catalog"
    );
    assert!(s.store.transcripts.read(&root).unwrap().messages.is_empty());
    send(
        &s,
        &root,
        SendArgs {
            target: child.agent_id.clone(),
            message: "followup".into(),
            interrupt: false,
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let result = done(&s, &root, &child.agent_id).await;
    assert_eq!(
        result["status"][&child.agent_id]["result"],
        "followup result"
    );
    let requests = model.requests();
    let conversation = |request: &fv_agent::ModelRequest| -> Vec<fv_core::Message> {
        request
            .messages
            .iter()
            .filter(|m| {
                !matches!(m, fv_core::Message::User { text } if text.starts_with("<project_context>"))
            })
            .cloned()
            .collect()
    };
    assert_eq!(
        conversation(&requests[0])[0],
        fv_core::Message::User {
            text: "first task".into()
        }
    );
    assert!(
        requests[1]
            .messages
            .iter()
            .any(|m| matches!(m, fv_core::Message::Assistant(a) if a.text() == "child result"))
    );
    let reloaded = ServerState::new(
        dir.path().into(),
        crate::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
    )
    .unwrap();
    assert_eq!(
        get(&reloaded, &child.agent_id).unwrap().status,
        SubagentStatus::Completed
    );
    assert_eq!(reloaded.runtime(&child.agent_id).turns().len(), 2);
}

#[tokio::test]
async fn limits_are_atomic_and_cross_parent_control_is_refused() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::new([
        vec![Step::Hang],
        vec![Step::Hang],
    ])));
    configure(
        &s,
        SubagentConfig {
            max_agents: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let token = CancellationToken::new();
    let (a, b) = tokio::join!(
        spawn(&s, &root, task("a"), &token),
        spawn(&s, &root, task("b"), &token)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let child = a.or(b).unwrap();
    let other = s.create_thread(None, None, None, None).unwrap();
    assert!(owned(&s, &other.id, &child.agent_id).is_err());
    assert!(
        spawn(&s, &child.agent_id, task("too deep"), &token)
            .await
            .is_err()
    );
    token.cancel();
    settle(&s, &child.agent_id).await;
    close(&s, &child.agent_id).unwrap();
    assert!(
        s.runtime(&child.agent_id)
            .begin(&s, "bypass")
            .await
            .is_none()
    );
    let next = spawn(&s, &root, task("next"), &CancellationToken::new())
        .await
        .unwrap();
    assert!(resume(&s, &child.agent_id).is_err());
    close(&s, &next.agent_id).unwrap();
    settle(&s, &next.agent_id).await;
}

#[tokio::test]
async fn close_cascades_and_resume_never_starts_work() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::new([
        vec![Step::Hang],
        vec![Step::Hang],
    ])));
    configure(
        &s,
        SubagentConfig {
            max_depth: 3,
            ..Default::default()
        },
    )
    .unwrap();
    let a = spawn(&s, &root, task("parent child"), &CancellationToken::new())
        .await
        .unwrap();
    let b = spawn(
        &s,
        &a.agent_id,
        task("nested child"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    close(&s, &a.agent_id).unwrap();
    settle(&s, &a.agent_id).await;
    settle(&s, &b.agent_id).await;
    assert_eq!(get(&s, &b.agent_id).unwrap().status, SubagentStatus::Closed);
    assert!(resume(&s, &b.agent_id).is_err());
    assert_eq!(
        resume(&s, &a.agent_id).unwrap().status,
        SubagentStatus::Idle
    );
    assert!(!s.runtime(&a.agent_id).is_running());
    assert_eq!(
        resume(&s, &b.agent_id).unwrap().status,
        SubagentStatus::Idle
    );
}

#[tokio::test]
async fn cancelled_spawn_does_not_allocate_and_parent_stop_reaches_children() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::new([vec![Step::Hang]])));
    let token = CancellationToken::new();
    token.cancel();
    assert!(spawn(&s, &root, task("cancelled"), &token).await.is_err());
    assert!(list(&s, Some(&root)).unwrap().agents.is_empty());
    let token = CancellationToken::new();
    let child = spawn(&s, &root, task("running"), &token).await.unwrap();
    token.cancel();
    settle(&s, &child.agent_id).await;
    assert_eq!(
        get(&s, &child.agent_id).unwrap().status,
        SubagentStatus::Interrupted
    );
}

#[tokio::test]
async fn wait_times_out_and_is_cancellable_without_stopping_child() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::new([vec![Step::Hang]])));
    let child = spawn(&s, &root, task("running"), &CancellationToken::new())
        .await
        .unwrap();
    let args = || WaitArgs {
        targets: vec![child.agent_id.clone()],
        timeout_ms: Some(0),
    };
    assert_eq!(
        wait(&s, &root, args(), &CancellationToken::new())
            .await
            .unwrap()["timed_out"],
        true
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(wait(&s, &root, args(), &cancel).await.is_err());
    assert!(s.runtime(&child.agent_id).is_running());
    close(&s, &child.agent_id).unwrap();
    settle(&s, &child.agent_id).await;
}

#[tokio::test]
async fn deletion_removes_subtree_transcripts_without_late_resurrection() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::new([vec![Step::Hang]])));
    let child = spawn(&s, &root, task("running"), &CancellationToken::new())
        .await
        .unwrap();
    let rt = s.runtime(&child.agent_id);
    s.delete_thread(&root).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while rt.is_running() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(s.store.db.subagents(None).unwrap().is_empty());
    assert!(s.thread(&child.agent_id).unwrap().is_none());
    assert!(!s.store.transcripts.exists(&child.agent_id));
    assert!(s.store.db.queue_pause(&child.agent_id).unwrap().is_none());
    assert!(s.store.db.queue(&child.agent_id).unwrap().is_empty());
    assert!(rt.begin(&s, "deleted").await.is_none());
}

#[tokio::test]
async fn restart_marks_inflight_children_interrupted_without_restarting() {
    let (dir, s, root) = state(Arc::new(ScriptedModel::new([vec![Step::Hang]])));
    let child = spawn(&s, &root, task("running"), &CancellationToken::new())
        .await
        .unwrap();
    let reloaded = ServerState::new(
        dir.path().into(),
        crate::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
    )
    .unwrap();
    reloaded.store.db.recover_subagents().unwrap();
    assert_eq!(
        get(&reloaded, &child.agent_id).unwrap().status,
        SubagentStatus::Interrupted
    );
    assert!(!reloaded.has_running_turns());
    close(&s, &child.agent_id).unwrap();
    settle(&s, &child.agent_id).await;
}

#[tokio::test]
async fn unknown_fields_and_bad_model_do_not_create_children() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::default()));
    let tool = AgentTool {
        state: Arc::downgrade(&s),
        parent: root.clone(),
        turn: "test-turn".into(),
        kind: Kind::Spawn,
    };
    let output = tool
        .call(
            ToolCtx::new(CancellationToken::new(), None),
            json!({"message":"work","unsupported_option":true}),
        )
        .await;
    assert!(output.is_error);
    let mut args = task("work");
    args.model = Some("missing/model".into());
    assert!(
        spawn(&s, &root, args, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(list(&s, Some(&root)).unwrap().agents.is_empty());
    assert!(
        configure(
            &s,
            SubagentConfig {
                max_depth: 4,
                ..Default::default()
            }
        )
        .is_err()
    );
}

#[tokio::test]
async fn a_finished_child_with_a_yielded_command_can_close_and_use_commands_after_resume() {
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool(
                "long",
                "exec_command",
                json!({"cmd":"printf ready; sleep 60","yield_time_ms":10,"login":false}),
            )
            .done(),
        Reply::new().text("command is in the background").done(),
        Reply::new()
            .tool(
                "new",
                "exec_command",
                json!({"cmd":"printf resumed","yield_time_ms":1000,"login":false}),
            )
            .done(),
        Reply::new().text("resumed successfully").done(),
    ]));
    let (_dir, s, root) = state(model.clone());
    let child = spawn(
        &s,
        &root,
        task("background task"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let result = done(&s, &root, &child.agent_id).await;
    assert_eq!(result["status"][&child.agent_id]["status"], "completed");
    assert!(s.runtime(&child.agent_id).exec_sessions.has_running());
    close(&s, &child.agent_id).unwrap();
    settle(&s, &child.agent_id).await;
    resume(&s, &child.agent_id).unwrap();
    send(
        &s,
        &root,
        SendArgs {
            target: child.agent_id.clone(),
            message: "new command".into(),
            interrupt: false,
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let result = done(&s, &root, &child.agent_id).await;
    assert_eq!(
        result["status"][&child.agent_id]["result"],
        "resumed successfully"
    );
    let loaded = s.store.transcripts.read(&child.agent_id).unwrap();
    assert!(loaded.messages.iter().any(|m|matches!(m,fv_core::Message::ToolResult{name,content,is_error:false,..} if name=="exec_command" && content.contains("resumed"))));
}

#[tokio::test]
async fn interrupt_input_waits_for_old_turn_before_starting_a_new_one() {
    let model = Arc::new(ScriptedModel::new([
        vec![Step::Hang],
        Reply::new().text("new task done").done(),
    ]));
    let (_dir, s, root) = state(model.clone());
    let child = spawn(&s, &root, task("old task"), &CancellationToken::new())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while model.requests().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    send(
        &s,
        &root,
        SendArgs {
            target: child.agent_id.clone(),
            message: "replacement".into(),
            interrupt: true,
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let result = done(&s, &root, &child.agent_id).await;
    assert_eq!(result["status"][&child.agent_id]["result"], "new task done");
    assert_eq!(s.runtime(&child.agent_id).turns().len(), 2);
    assert!(
        matches!(model.requests()[1].messages.last(),Some(fv_core::Message::User{text}) if text=="replacement")
    );
}

#[tokio::test]
async fn disabled_or_depth_limited_spawning_is_not_offered_but_controls_stay_available() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::new([Reply::new()
        .text("done")
        .done()])));
    let child = spawn(&s, &root, task("child"), &CancellationToken::new())
        .await
        .unwrap();
    done(&s, &root, &child.agent_id).await;
    let mut tools = ToolRegistry::new();
    register(&s, &child.agent_id, "test-turn", &mut tools);
    assert!(!tools.specs().iter().any(|s| s.name == "spawn_agent"));
    configure(
        &s,
        SubagentConfig {
            enabled: false,
            ..Default::default()
        },
    )
    .unwrap();
    let mut tools = ToolRegistry::new();
    register(&s, &root, "test-turn", &mut tools);
    assert!(!tools.specs().iter().any(|s| s.name == "spawn_agent"));
    assert!(tools.specs().iter().any(|s| s.name == "close_agent"));
    assert!(
        spawn(&s, &root, task("disabled"), &CancellationToken::new())
            .await
            .is_err()
    );
    close(&s, &child.agent_id).unwrap();
}

#[tokio::test]
async fn second_server_construction_and_failed_bind_do_not_interrupt_live_children() {
    let (dir, s, root) = state(Arc::new(ScriptedModel::new([vec![Step::Hang]])));
    let socket = dir.path().join("live.sock");
    let server = tokio::spawn(
        crate::UnixServer::bind(s.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let child = spawn(&s, &root, task("live child"), &CancellationToken::new())
        .await
        .unwrap();
    let contender = Arc::new(
        ServerState::new(
            dir.path().into(),
            crate::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
        )
        .unwrap(),
    );
    assert_eq!(
        get(&s, &child.agent_id).unwrap().status,
        SubagentStatus::Running
    );
    assert!(matches!(
        crate::UnixServer::bind(contender, &socket).await,
        Err(crate::ListenError::AlreadyRunning(_))
    ));
    assert_eq!(
        get(&s, &child.agent_id).unwrap().status,
        SubagentStatus::Running
    );
    close(&s, &child.agent_id).unwrap();
    settle(&s, &child.agent_id).await;
    server.abort();
}

fn role(id: &str) -> SubagentRole {
    SubagentRole {
        id: id.into(),
        name: id.into(),
        description: "focused task".into(),
        system_prompt: "snapshot v1".into(),
        model: None,
        thinking: None,
        read_only: false,
        tools: Some(vec!["view_image".into()]),
    }
}
#[tokio::test]
async fn role_edits_are_cas_guarded_and_existing_children_keep_their_snapshot_after_restart() {
    let model = Arc::new(ScriptedModel::new([
        Reply::new().text("first").done(),
        Reply::new().text("second").done(),
    ]));
    let (dir, s, root) = state(model.clone());
    let first = role("reviewer");
    roles::upsert(
        &s,
        SubagentRoleUpsertParams {
            role: first.clone(),
            expected: None,
        },
    )
    .unwrap();
    assert!(
        roles::upsert(
            &s,
            SubagentRoleUpsertParams {
                role: first.clone(),
                expected: None
            }
        )
        .is_err()
    );
    let mut args = task("first task");
    args.agent_type = Some("reviewer".into());
    let child = spawn(&s, &root, args, &CancellationToken::new())
        .await
        .unwrap();
    done(&s, &root, &child.agent_id).await;
    let mut next = first.clone();
    next.system_prompt = "snapshot v2".into();
    next.tools = Some(vec!["exec_command".into()]);
    roles::upsert(
        &s,
        SubagentRoleUpsertParams {
            role: next.clone(),
            expected: Some(first.clone()),
        },
    )
    .unwrap();
    assert!(
        roles::upsert(
            &s,
            SubagentRoleUpsertParams {
                role: first.clone(),
                expected: Some(first.clone())
            }
        )
        .is_err()
    );
    assert!(
        roles::delete(
            &s,
            SubagentRoleDeleteParams {
                expected: first.clone()
            }
        )
        .is_err()
    );
    send(
        &s,
        &root,
        SendArgs {
            target: child.agent_id.clone(),
            message: "second task".into(),
            interrupt: false,
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    done(&s, &root, &child.agent_id).await;
    assert!(model.requests()[1].system.contains("snapshot v1"));
    assert!(!model.requests()[1].system.contains("snapshot v2"));
    assert_eq!(
        model.requests()[1]
            .tools
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        ["view_image"]
    );
    roles::delete(&s, SubagentRoleDeleteParams { expected: next }).unwrap();
    let after = Arc::new(ScriptedModel::new([Reply::new()
        .text("after restart")
        .done()]));
    let reloaded = Arc::new(
        ServerState::new(
            dir.path().into(),
            crate::agent_with_builtin_tools(after.clone()),
        )
        .unwrap(),
    );
    send(
        &reloaded,
        &root,
        SendArgs {
            target: child.agent_id.clone(),
            message: "resume after restart".into(),
            interrupt: false,
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    done(&reloaded, &root, &child.agent_id).await;
    assert_eq!(get(&reloaded, &child.agent_id).unwrap().role, Some(first));
    assert!(after.requests()[0].system.contains("snapshot v1"));
    assert_eq!(
        after.requests()[0]
            .tools
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        ["view_image"]
    );
}
#[tokio::test]
async fn read_only_role_has_no_write_tools_and_cannot_escape_its_sandbox_or_delegate() {
    let work = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("source.txt"), "source content").unwrap();
    let model=Arc::new(ScriptedModel::new([
        Reply::new().tool("read","exec_command",json!({"cmd":"cat source.txt; printf forbidden > blocked.txt","login":false,"yield_time_ms":1000})).done(),
        Reply::new().tool("escape","exec_command",json!({"cmd":"touch escaped.txt","login":false,"sandbox_permissions":"require_escalated","justification":"try to escape"})).done(),
        Reply::new().text("read complete").done(),
    ]));
    let (_dir, s, root) = state(model.clone());
    let mut parent = s.thread(&root).unwrap().unwrap();
    parent.cwd = Some(work.path().display().to_string());
    s.store.db.put_thread(&parent).unwrap();
    let mut args = task("investigate");
    args.agent_type = Some("explorer".into());
    let child = spawn(&s, &root, args, &CancellationToken::new())
        .await
        .unwrap();
    done(&s, &root, &child.agent_id).await;
    assert!(!work.path().join("blocked.txt").exists());
    assert!(!work.path().join("escaped.txt").exists());
    assert!(model.requests()[0].system.contains("read-only sandbox"));
    assert!(
        !model.requests()[0]
            .tools
            .iter()
            .any(|t| ["apply_patch", "spawn_agent", "tool_search"].contains(&t.name.as_str()))
    );
    assert!(s.pending_prompts(&child.agent_id).is_empty());
    assert!(
        spawn(
            &s,
            &child.agent_id,
            task("cannot delegate"),
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    let loaded = s.store.transcripts.read(&child.agent_id).unwrap();
    assert!(loaded.messages.iter().any(
        |m| matches!(m,fv_core::Message::ToolResult{call_id,is_error:true,..} if call_id=="escape")
    ));
}
#[tokio::test]
async fn delegation_never_widens_an_ancestors_tool_grant() {
    let model = Arc::new(ScriptedModel::new([
        vec![Step::Hang],
        Reply::new().text("child done").done(),
    ]));
    let (_dir, s, root) = state(model.clone());
    configure(
        &s,
        SubagentConfig {
            max_depth: 2,
            ..Default::default()
        },
    )
    .unwrap();
    let mut parent_role = role("coordinator");
    parent_role.tools = Some(vec!["spawn_agent".into(), "exec_command".into()]);
    roles::upsert(
        &s,
        SubagentRoleUpsertParams {
            role: parent_role,
            expected: None,
        },
    )
    .unwrap();
    let mut args = task("coordinate");
    args.agent_type = Some("coordinator".into());
    let parent = spawn(&s, &root, args, &CancellationToken::new())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while model.requests().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut args = task("implement");
    args.agent_type = Some("worker".into());
    let child = spawn(&s, &parent.agent_id, args, &CancellationToken::new())
        .await
        .unwrap();
    done(&s, &parent.agent_id, &child.agent_id).await;
    assert_eq!(
        model.requests()[1]
            .tools
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        ["exec_command"]
    );
    assert_eq!(
        child.tool_ceiling,
        Some(vec!["spawn_agent".into(), "exec_command".into()])
    );
    close(&s, &parent.agent_id).unwrap();
    settle(&s, &parent.agent_id).await;
}
#[tokio::test]
async fn invalid_roles_do_not_mutate_configuration_or_allocate_children() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::default()));
    let original = roles::read(&s).unwrap();
    for invalid_role in [
        SubagentRole {
            id: "bad role".into(),
            ..role("valid")
        },
        SubagentRole {
            model: Some("missing/model".into()),
            ..role("valid")
        },
        SubagentRole {
            tools: Some(vec!["missing_tool".into()]),
            ..role("valid")
        },
        SubagentRole {
            read_only: true,
            tools: Some(vec!["apply_patch".into()]),
            ..role("valid")
        },
    ] {
        assert!(
            roles::upsert(
                &s,
                SubagentRoleUpsertParams {
                    role: invalid_role,
                    expected: None
                }
            )
            .is_err()
        );
    }
    assert_eq!(roles::read(&s).unwrap(), original);
    let mut args = task("missing role");
    args.agent_type = Some("missing".into());
    assert!(
        spawn(&s, &root, args, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(list(&s, Some(&root)).unwrap().agents.is_empty());
}

struct DeferredRoleTool(&'static str);
impl Tool for DeferredRoleTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.0.into(),
            description: "role tool".into(),
            schema: json!({"type":"object","properties":{}}),
        }
    }
    fn deferred(&self) -> bool {
        true
    }
    fn call(&self, _: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async { ToolOutput::ok("granted tool ran") })
    }
}
#[tokio::test]
async fn explicit_deferred_grants_work_without_search_and_do_not_expose_ungranted_tools() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool("read", "mcp__test__read", json!({}))
            .done(),
        Reply::new().text("done").done(),
    ]));
    let mut agent = crate::agent_with_builtin_tools(model.clone());
    let mut tools = (*agent.tools).clone();
    tools
        .register(DeferredRoleTool("mcp__test__read"))
        .register(DeferredRoleTool("mcp__test__write"));
    agent.tools = Arc::new(tools);
    let s = Arc::new(ServerState::new(dir.path().into(), agent).unwrap());
    let root = s.create_thread(None, None, None, None).unwrap().id;
    let mut profile = role("reader");
    profile.tools = Some(vec!["mcp__test__read".into()]);
    roles::upsert(
        &s,
        SubagentRoleUpsertParams {
            role: profile,
            expected: None,
        },
    )
    .unwrap();
    let mut args = task("read");
    args.agent_type = Some("reader".into());
    let child = spawn(&s, &root, args, &CancellationToken::new())
        .await
        .unwrap();
    done(&s, &root, &child.agent_id).await;
    assert_eq!(
        model.requests()[0]
            .tools
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        ["mcp__test__read"]
    );
    assert!(
        !s.agent
            .tools
            .specs()
            .iter()
            .any(|t| t.name == "mcp__test__read"),
        "the parent registry is unchanged"
    );
    let messages = s.store.transcripts.read(&child.agent_id).unwrap().messages;
    assert!(messages.iter().any(|m|matches!(m,fv_core::Message::ToolResult{content,is_error:false,..} if content=="granted tool ran")));
}

#[tokio::test]
async fn explicit_model_and_effort_override_role_then_role_overrides_parent() {
    use fv_protocol::types::{ApiProtocol, ModelInfo, ThinkingLevel};
    let (_dir, s, root) = state(Arc::new(ScriptedModel::default()));
    s.store
        .db
        .put_provider(&fv_store::StoredProvider {
            id: "local".into(),
            name: "custom endpoint".into(),
            protocol: ApiProtocol::Chat,
            base_url: "http://127.0.0.1:9/v1".into(),
            enabled: true,
            models: ["parent", "role", "explicit"]
                .into_iter()
                .map(|id| ModelInfo {
                    id: id.into(),
                    reasoning: Some(true),
                    ..Default::default()
                })
                .collect(),
        })
        .unwrap();
    s.store.credentials.set("local", "test-only-key").unwrap();
    let mut thread = s.thread(&root).unwrap().unwrap();
    thread.model = Some("local/parent".into());
    thread.thinking = Some(ThinkingLevel::Low);
    s.store.db.put_thread(&thread).unwrap();
    let mut profile = role("model-role");
    profile.model = Some("local/role".into());
    profile.thinking = Some(ThinkingLevel::High);
    roles::upsert(
        &s,
        SubagentRoleUpsertParams {
            role: profile,
            expected: None,
        },
    )
    .unwrap();
    for (explicit, expected_model, expected_effort) in [
        (false, "local/role", ThinkingLevel::High),
        (true, "local/explicit", ThinkingLevel::Medium),
    ] {
        let cancel = CancellationToken::new();
        let mut args = task("metadata only");
        args.agent_type = Some("model-role".into());
        if explicit {
            args.model = Some("local/explicit".into());
            args.reasoning_effort = Some(ThinkingLevel::Medium);
        }
        let child = spawn(&s, &root, args, &cancel).await.unwrap();
        let thread = s.thread(&child.agent_id).unwrap().unwrap();
        assert_eq!(thread.model.as_deref(), Some(expected_model));
        assert_eq!(thread.thinking, Some(expected_effort));
        assert_eq!(
            crate::providers::model_for(&s, &thread).label(),
            Some(expected_model)
        );
        // No provider request is sent: stop before the background worker gets its first poll.
        cancel.cancel();
        settle(&s, &child.agent_id).await;
    }
}
