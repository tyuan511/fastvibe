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
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let task_name = format!(
        "task_{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    SpawnArgs {
        message: message.into(),
        task_name,
        // The codex default is `all`; unit tests drive the engine directly, so they say
        // `none` explicitly rather than paying a parent-history fork each time.
        fork_turns: Some("none".into()),
        ..Default::default()
    }
}

#[test]
fn fork_turns_follows_the_codex_default_of_all() {
    let parse = |raw: Option<&str>| {
        SpawnArgs {
            fork_turns: raw.map(str::to_string),
            ..Default::default()
        }
        .fork_context()
        .unwrap()
    };
    assert!(parse(None));
    assert!(parse(Some("")));
    assert!(parse(Some("all")));
    assert!(!parse(Some("none")));
    assert!(
        SpawnArgs {
            fork_turns: Some("everything".into()),
            ..Default::default()
        }
        .fork_context()
        .is_err()
    );
}
/// Wait until the child reaches a terminal status, then hand back its row.
async fn done(state: &ServerState, id: &str) -> Subagent {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(Some(agent)) = state.store.db.subagent(id) {
                match agent.status {
                    SubagentStatus::Running | SubagentStatus::Idle => {}
                    _ => return agent,
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
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
    let result = done(&s, &child.agent_id).await;
    assert_eq!(result.result, "child result");
    assert_eq!(
        s.threads(false).unwrap().len(),
        1,
        "children have a separate catalog"
    );
    assert!(s.store.transcripts.read(&root).unwrap().messages.is_empty());
    followup(
        &s,
        &root,
        TargetedMessage {
            target: child.agent_id.clone(),
            message: "followup".into(),
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let result = done(&s, &child.agent_id).await;
    assert_eq!(result.result, "followup result");
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
    assert!(
        matches!(&conversation(&requests[0])[0], fv_core::Message::User{text}
            if text.starts_with("You are the agent \"/root/task_") && text.ends_with("first task"))
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
    assert!(resolve(&s, &other.id, &child.agent_id).is_err());
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
    let result = done(&s, &child.agent_id).await;
    assert_eq!(result.status, SubagentStatus::Completed);
    assert!(s.runtime(&child.agent_id).exec_sessions.has_running());
    close(&s, &child.agent_id).unwrap();
    settle(&s, &child.agent_id).await;
    resume(&s, &child.agent_id).unwrap();
    followup(
        &s,
        &root,
        TargetedMessage {
            target: child.agent_id.clone(),
            message: "new command".into(),
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let result = done(&s, &child.agent_id).await;
    assert_eq!(result.result, "resumed successfully");
    let loaded = s.store.transcripts.read(&child.agent_id).unwrap();
    assert!(loaded.messages.iter().any(|m|matches!(m,fv_core::Message::ToolResult{name,content,is_error:false,..} if name=="exec_command" && content.contains("resumed"))));
}

#[tokio::test]
async fn interrupt_then_followup_starts_a_new_turn_once_the_old_one_settles() {
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
    interrupt(
        &s,
        &root,
        Target {
            target: child.agent_id.clone(),
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    followup(
        &s,
        &root,
        TargetedMessage {
            target: child.agent_id.clone(),
            message: "replacement".into(),
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let result = done(&s, &child.agent_id).await;
    assert_eq!(result.result, "new task done");
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
    done(&s, &child.agent_id).await;
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
    assert!(tools.specs().iter().any(|s| s.name == "followup_task"));
    assert!(tools.specs().iter().any(|s| s.name == "interrupt_agent"));
    assert!(!tools.specs().iter().any(|s| s.name == "send_input"));
    assert!(!tools.specs().iter().any(|s| s.name == "close_agent"));
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
        builtin: false,
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
    done(&s, &child.agent_id).await;
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
    followup(
        &s,
        &root,
        TargetedMessage {
            target: child.agent_id.clone(),
            message: "second task".into(),
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    done(&s, &child.agent_id).await;
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
    followup(
        &reloaded,
        &root,
        TargetedMessage {
            target: child.agent_id.clone(),
            message: "resume after restart".into(),
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    done(&reloaded, &child.agent_id).await;
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
    done(&s, &child.agent_id).await;
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
    done(&s, &child.agent_id).await;
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
    done(&s, &child.agent_id).await;
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

#[test]
fn built_in_roles_are_compiled_in_not_stored_and_survive_deleting_every_saved_role() {
    let (_dir, s, _root) = state(Arc::new(ScriptedModel::default()));
    // Nothing is persisted for built-ins: the settings key stays empty.
    assert!(roles::read(&s).unwrap().is_empty());
    let merged = roles::merged(&s).unwrap();
    let ids: Vec<&str> = merged.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["explorer", "worker"]);
    assert!(merged.iter().all(|r| r.builtin));
    assert!(
        merged
            .iter()
            .find(|r| r.id == "explorer")
            .unwrap()
            .read_only
    );
    // A legacy install seeded the old defaults into the database: an untouched copy is
    // the built-in itself, so it is not listed twice beside it.
    let legacy = serde_json::to_string(&merged).unwrap();
    s.store
        .db
        .set_setting("subagent_roles_v1", Some(&legacy))
        .unwrap();
    let after_seed = roles::merged(&s).unwrap();
    assert_eq!(after_seed.len(), 2);
    assert!(after_seed.iter().all(|r| r.builtin));
    // A delete naming a built-in is a no-op on the saved list: nothing matches, the
    // built-in is still there afterwards.
    for role in merged {
        let _ = roles::delete(&s, SubagentRoleDeleteParams { expected: role });
    }
    assert_eq!(roles::merged(&s).unwrap().len(), 2);
    s.store.db.set_setting("subagent_roles_v1", None).unwrap();
    assert_eq!(roles::merged(&s).unwrap().len(), 2);
}

#[tokio::test]
async fn a_saved_role_with_the_same_id_overrides_the_built_in_and_deleting_it_restores_the_builtin()
{
    let model = Arc::new(ScriptedModel::new([
        Reply::new().text("override done").done(),
        Reply::new().text("builtin done").done(),
    ]));
    let (_dir, s, root) = state(model.clone());
    // Shadow the built-in "worker" with a custom definition, as codex's user-configured
    // agent roles override the compiled-in ones by name.
    let mut override_role = role("worker");
    override_role.system_prompt = "custom worker prompt".into();
    roles::upsert(
        &s,
        SubagentRoleUpsertParams {
            role: override_role.clone(),
            expected: None,
        },
    )
    .unwrap();
    let merged = roles::merged(&s).unwrap();
    assert_eq!(merged.len(), 2); // explorer stays built-in, worker is the override
    assert!(merged.iter().find(|r| r.id == "explorer").unwrap().builtin);
    assert!(!merged.iter().find(|r| r.id == "worker").unwrap().builtin);
    let mut args = task("custom");
    args.agent_type = Some("worker".into());
    let child = spawn(&s, &root, args, &CancellationToken::new())
        .await
        .unwrap();
    done(&s, &child.agent_id).await;
    assert!(model.requests()[0].system.contains("custom worker prompt"));
    // A client cannot smuggle the built-in flag into the persisted list.
    let mut forged = override_role.clone();
    forged.builtin = true;
    roles::upsert(
        &s,
        SubagentRoleUpsertParams {
            role: forged,
            expected: Some(override_role.clone()),
        },
    )
    .unwrap();
    assert!(
        roles::read(&s)
            .unwrap()
            .into_iter()
            .all(|r: SubagentRole| !r.builtin)
    );
    // Removing the override brings the built-in back.
    roles::delete(
        &s,
        SubagentRoleDeleteParams {
            expected: override_role,
        },
    )
    .unwrap();
    let restored = roles::merged(&s).unwrap();
    assert_eq!(restored.len(), 2);
    assert!(restored.iter().find(|r| r.id == "worker").unwrap().builtin);
    // The spawn tool offers every role, built-ins included.
    let mut tools = ToolRegistry::new();
    register(&s, &root, "test-turn", &mut tools);
    let specs = tools.specs();
    let spawn = specs
        .iter()
        .find(|spec| spec.name == "spawn_agent")
        .unwrap();
    assert!(spawn.description.contains("explorer"));
    assert!(spawn.description.contains("worker"));
    assert!(spawn.description.contains("Role explorer:"));
    let schema = serde_json::to_string(&spawn.schema).unwrap();
    assert!(schema.contains("explorer"));
    assert!(schema.contains("worker"));
}

#[tokio::test]
async fn task_names_address_agents_by_path_and_duplicate_names_are_refused() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::new([
        Reply::new().text("done").done(),
        Reply::new().text("done").done(),
    ])));
    configure(
        &s,
        SubagentConfig {
            max_depth: 2,
            ..Default::default()
        },
    )
    .unwrap();
    let mut args = task("nested work");
    args.task_name = "outer".into();
    let child = spawn(&s, &root, args, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(child.task_name.as_deref(), Some("/root/outer"));
    // A nested child of `/root/outer` gets a path under its spawner's.
    let mut nested = task("inner work");
    nested.task_name = "inner".into();
    let grandchild = spawn(&s, &child.agent_id, nested, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(grandchild.task_name.as_deref(), Some("/root/outer/inner"));
    // Relative (from the caller's path), absolute, and id all resolve to the same agent.
    assert_eq!(
        resolve(&s, &root, "outer").unwrap().agent_id,
        child.agent_id
    );
    assert_eq!(
        resolve(&s, &child.agent_id, "inner").unwrap().agent_id,
        grandchild.agent_id
    );
    assert_eq!(
        resolve(&s, &root, "/root/outer/inner").unwrap().agent_id,
        grandchild.agent_id
    );
    assert_eq!(
        resolve(&s, &root, &grandchild.agent_id).unwrap().agent_id,
        grandchild.agent_id
    );
    // References may only go down the tree, and the root is not an agent.
    assert!(resolve(&s, &grandchild.agent_id, "outer").is_err());
    assert!(resolve(&s, &root, "/root").is_err());
    assert!(resolve(&s, &root, "/root/missing").is_err());
    // A duplicate name in the tree is refused, and the name rules follow codex.
    let mut duplicate = task("duplicate");
    duplicate.task_name = "outer".into();
    assert!(
        spawn(&s, &root, duplicate, &CancellationToken::new())
            .await
            .is_err()
    );
    let mut bad = task("bad name");
    bad.task_name = "Bad-Name".into();
    assert!(
        spawn(&s, &root, bad, &CancellationToken::new())
            .await
            .is_err()
    );
    close(&s, &child.agent_id).unwrap();
    settle(&s, &child.agent_id).await;
    settle(&s, &grandchild.agent_id).await;
}

#[tokio::test]
async fn wait_reports_the_agent_that_finished_by_name_without_its_content() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::new([Reply::new()
        .text("the answer text")
        .done()])));
    let mut args = task("finish fast");
    args.task_name = "finisher".into();
    let _child = spawn(&s, &root, args, &CancellationToken::new())
        .await
        .unwrap();
    let result = wait(
        &s,
        &root,
        WaitArgs {
            timeout_ms: Some(3000),
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result["timed_out"], false);
    let agents = result["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["agent_name"], "/root/finisher");
    let raw = agents[0].to_string();
    assert!(
        !raw.contains("the answer text"),
        "wait returns who updated, not the content: {raw}"
    );
}

#[tokio::test]
async fn the_final_answer_is_delivered_to_the_parent_as_its_own_message() {
    let model = Arc::new(ScriptedModel::new([
        // Child turn: completes with the answer.
        Reply::new().text("child says 42").done(),
        // Parent turn that runs when the next input boundary reads the mail.
        Reply::new().text("parent reports").done(),
    ]));
    let (_dir, s, root) = state(model.clone());
    let mut args = task("answer me");
    args.task_name = "oracle".into();
    let child = spawn(&s, &root, args, &CancellationToken::new())
        .await
        .unwrap();
    done(&s, &child.agent_id).await;
    // The parent is idle here: the notification waits in its mailbox and does not wake the
    // thread (codex's WakeOnAgentMessages is off by default) and does not enter the
    // user-visible prompt queue.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(s.store.db.queue(&root).unwrap().is_empty());
    let mail = s.agent_mailbox.lock().unwrap().get(&root).cloned().unwrap();
    assert_eq!(mail.len(), 1);
    assert!(mail[0].contains("Message Type: FINAL_ANSWER"));
    assert!(mail[0].contains("Task name: /root/oracle"));
    assert!(mail[0].contains("child says 42"));
    assert!(state_delivered(&s, &child.agent_id));
    // The next input boundary reads it: the parent's next turn carries the mail beside its
    // own prompt, in the same request.
    let replies = model.requests();
    assert_eq!(replies.len(), 1, "the mailbox alone never starts a turn");
    let rt = s.runtime(&root);
    crate::turn::start_text(s.clone(), rt, &root, "please report".into()).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while model.requests().len() < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let request = &model.requests()[1];
    assert!(
        request
            .messages
            .iter()
            .any(|m| matches!(m, fv_core::Message::User{text}
            if text.contains("Message Type: FINAL_ANSWER") && text.contains("child says 42"))),
        "the mail rides the next turn: {:?}",
        request.messages
    );
    assert!(
        request
            .messages
            .iter()
            .any(|m| matches!(m, fv_core::Message::User{text}
            if text == "please report")),
        "the turn's own prompt is still there: {:?}",
        request.messages
    );
}

fn state_delivered(s: &ServerState, id: &str) -> bool {
    s.subagent_delivered.lock().unwrap().contains_key(id)
}

#[tokio::test]
async fn send_message_queues_on_an_idle_agent_without_starting_a_turn() {
    let model = Arc::new(ScriptedModel::new([
        Reply::new().text("done").done(),
        Reply::new().text("awake").done(),
    ]));
    let (_dir, s, root) = state(model.clone());
    let mut args = task("idle target");
    args.task_name = "idler".into();
    let child = spawn(&s, &root, args, &CancellationToken::new())
        .await
        .unwrap();
    done(&s, &child.agent_id).await;
    message(
        &s,
        &root,
        TargetedMessage {
            target: "/root/idler".into(),
            message: "context only, do not wake".into(),
        },
    )
    .await
    .unwrap();
    assert!(!s.runtime(&child.agent_id).is_running());
    assert!(s.store.db.queue(&child.agent_id).unwrap().is_empty());
    assert_eq!(
        s.agent_mailbox
            .lock()
            .unwrap()
            .get(&child.agent_id)
            .cloned()
            .unwrap(),
        vec!["context only, do not wake".to_string()]
    );
    // A follow-up then starts the turn, and the mail rides the same first request.
    followup(
        &s,
        &root,
        TargetedMessage {
            target: "/root/idler".into(),
            message: "now do it".into(),
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while model.requests().len() < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let request = &model.requests()[1];
    assert!(
        request
            .messages
            .iter()
            .any(|m| matches!(m, fv_core::Message::User{text}
            if text == "context only, do not wake")),
        "queue-only mail is read at the next input boundary: {:?}",
        request.messages
    );
    close(&s, &child.agent_id).unwrap();
}

#[tokio::test]
async fn list_agents_filters_by_path_prefix_and_hides_closed_agents() {
    let (_dir, s, root) = state(Arc::new(ScriptedModel::new([
        Reply::new().text("done").done(),
        Reply::new().text("done").done(),
    ])));
    for name in ["alpha", "beta"] {
        let mut args = task("work");
        args.task_name = name.into();
        spawn(&s, &root, args, &CancellationToken::new())
            .await
            .unwrap();
    }
    let tool = AgentTool {
        state: Arc::downgrade(&s),
        parent: root.clone(),
        turn: "test-turn".into(),
        kind: Kind::List,
    };
    let all = tool
        .call(ToolCtx::new(CancellationToken::new(), None), json!({}))
        .await;
    let all: Value = serde_json::from_str(&all.content).unwrap();
    let names: Vec<&str> = all["agents"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a["agent_name"].as_str())
        .collect();
    assert_eq!(names, ["/root/alpha", "/root/beta"]);
    let filtered = tool
        .call(
            ToolCtx::new(CancellationToken::new(), None),
            json!({"path_prefix": "/root/al"}),
        )
        .await;
    let filtered: Value = serde_json::from_str(&filtered.content).unwrap();
    assert_eq!(
        filtered["agents"].as_array().unwrap().len(),
        1,
        "{filtered}"
    );
    close(&s, &root).err();
}

#[tokio::test]
async fn settled_agents_are_evicted_from_residency_to_free_the_spawn_limit() {
    let model = Arc::new(ScriptedModel::new(
        (0..5).map(|_| Reply::new().text("done").done()),
    ));
    let (_dir, s, root) = state(model.clone());
    configure(
        &s,
        SubagentConfig {
            max_agents: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let mut completed = Vec::new();
    for i in 0..3 {
        let mut args = task("finish");
        args.task_name = format!("agent{i}");
        let child = spawn(&s, &root, args, &CancellationToken::new())
            .await
            .unwrap();
        done(&s, &child.agent_id).await;
        completed.push(child);
    }
    // All three stay durable in the tree, but at most one runtime is resident at a time.
    assert_eq!(s.store.db.subagents(Some(&root)).unwrap().len(), 3);
    let resident = completed
        .iter()
        .filter(|a| s.loaded_runtime(&a.agent_id).is_some())
        .count();
    assert!(resident <= 1, "{resident} residents for a limit of 1");
    // An evicted agent still resolves by name and still takes a follow-up: the runtime is
    // rebuilt from its transcript on demand.
    let first = completed.first().unwrap();
    let mut more = task("more work");
    more.task_name = "later".into();
    assert!(
        spawn(&s, &root, more, &CancellationToken::new())
            .await
            .is_ok(),
        "eviction freed the limit"
    );
    followup(
        &s,
        &root,
        TargetedMessage {
            target: "/root/agent0".into(),
            message: "pick this up again".into(),
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let row = done(&s, &first.agent_id).await;
    assert_eq!(row.result, "done");
    for child in completed {
        close(&s, &child.agent_id).unwrap();
    }
}
