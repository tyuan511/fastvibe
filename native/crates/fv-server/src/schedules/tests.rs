use super::*;
use fv_agent::testing::{Reply, ScriptedModel, Step};
fn state(model: Arc<dyn fv_agent::Model>) -> (tempfile::TempDir, Arc<ServerState>) {
    let dir = tempfile::tempdir().unwrap();
    let s = Arc::new(
        ServerState::new(dir.path().into(), crate::agent_with_builtin_tools(model)).unwrap(),
    );
    (dir, s)
}
fn definition(name: &str) -> ScheduleDefinition {
    ScheduleDefinition {
        name: name.into(),
        prompt: name.into(),
        project: None,
        model: None,
        thinking: None,
        rule: ScheduleRule::Daily {
            time: "09:00".into(),
            time_zone: "Asia/Shanghai".into(),
        },
        max_run_seconds: 3600,
        missed_policy: MissedPolicy::RunLatest,
    }
}
async fn create(s: &Arc<ServerState>, d: ScheduleDefinition) -> ScheduledTask {
    s.schedules
        .upsert(
            s,
            ScheduleUpsertParams {
                task_id: None,
                expected_version: None,
                definition: d,
                enabled: true,
            },
        )
        .await
        .unwrap()
}
async fn terminal(s: &ServerState, id: &str) -> ScheduledRun {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let run = s
                .schedules
                .store
                .read(|d| d.runs.iter().find(|r| r.run.id == id).unwrap().run.clone());
            if run.status.terminal()
                && !s
                    .schedules
                    .active
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|a| a.run.id == id)
            {
                return run;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn run_writes_in_fresh_scratch_records_real_output_and_consumes_one_off_once() {
    let model=Arc::new(ScriptedModel::new([Reply::new().tool("write","apply_patch",serde_json::json!({"input":"*** Begin Patch\n*** Add File: artifact.txt\n+scheduled output\n*** End Patch"})).done(),Reply::new().text("done").done()]));
    let (_dir, s) = state(model.clone());
    let mut d = definition("one off");
    d.rule = ScheduleRule::Once {
        at: chrono::DateTime::from_timestamp_millis(now_ms() + 60_000)
            .unwrap()
            .to_rfc3339(),
    };
    let task = create(&s, d).await;
    let run = s.schedules.run_now(&s, &task.id).await.unwrap();
    assert!(!s.schedules.snapshot().tasks[0].enabled);
    assert!(s.schedules.snapshot().tasks[0].next_run_at.is_none());
    assert_eq!(s.schedules.run_now(&s, &task.id).await.unwrap().id, run.id);
    s.schedules.pump(&s, now_ms()).await.unwrap();
    let finished = terminal(&s, &run.id).await;
    assert_eq!(finished.status, ScheduleRunStatus::Completed);
    assert_eq!(finished.result, "done");
    let thread = s
        .thread(finished.thread_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    let cwd = std::path::Path::new(thread.cwd.as_deref().unwrap());
    assert!(cwd.starts_with(s.data_dir.join("scratch")));
    assert_eq!(
        std::fs::read_to_string(cwd.join("artifact.txt")).unwrap(),
        "scheduled output\n"
    );
    assert_eq!(
        model.requests().len(),
        2,
        "scheduled runs do not spend a suggestion request"
    );
    assert_eq!(s.store.db.usage_records().unwrap().len(), 2);
    s.schedules.pump(&s, now_ms() + 120_000).await.unwrap();
    assert_eq!(s.schedules.store.read(|d| d.runs.len()), 1);
    s.shutdown_schedules().await;
}
#[tokio::test]
async fn queued_snapshots_survive_edits_and_single_slot_is_released_only_after_stop() {
    let model = Arc::new(ScriptedModel::new([
        vec![Step::Hang],
        Reply::new().text("queued version").done(),
    ]));
    let (_dir, s) = state(model.clone());
    let a = create(&s, definition("a")).await;
    let b = create(&s, definition("original b")).await;
    let ar = s.schedules.run_now(&s, &a.id).await.unwrap();
    s.schedules.pump(&s, now_ms()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while model.requests().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let br = s.schedules.run_now(&s, &b.id).await.unwrap();
    assert_eq!(s.schedules.run_now(&s, &b.id).await.unwrap().id, br.id);
    let mut changed = b.definition.clone();
    changed.prompt = "edited b".into();
    s.schedules
        .upsert(
            &s,
            ScheduleUpsertParams {
                task_id: Some(b.id.clone()),
                expected_version: Some(b.version),
                definition: changed,
                enabled: true,
            },
        )
        .await
        .unwrap();
    s.schedules.pump(&s, now_ms()).await.unwrap();
    assert_eq!(model.requests().len(), 1);
    s.schedules.stop(&s, &a.id).await.unwrap();
    assert_eq!(
        terminal(&s, &ar.id).await.status,
        ScheduleRunStatus::Stopped
    );
    s.schedules.pump(&s, now_ms()).await.unwrap();
    assert_eq!(
        terminal(&s, &br.id).await.status,
        ScheduleRunStatus::Completed
    );
    assert!(
        matches!(model.requests()[1].messages.last(),Some(fv_core::Message::User{text})if text=="original b")
    );
    s.shutdown_schedules().await;
}
#[tokio::test]
async fn timeout_and_shutdown_stop_real_runs_and_queue_is_retained_without_replay() {
    let model = Arc::new(ScriptedModel::new([vec![Step::Hang], vec![Step::Hang]]));
    let (dir, s) = state(model);
    let mut d = definition("timed");
    d.max_run_seconds = 1;
    let task = create(&s, d).await;
    let run = s.schedules.run_now(&s, &task.id).await.unwrap();
    s.schedules.pump(&s, now_ms()).await.unwrap();
    let failed = terminal(&s, &run.id).await;
    assert_eq!(failed.status, ScheduleRunStatus::Failed);
    assert!(failed.error.unwrap().contains("时限"));
    let next = s.schedules.run_now(&s, &task.id).await.unwrap();
    s.schedules.pump(&s, now_ms()).await.unwrap();
    let queued_task = create(&s, definition("queued")).await;
    let queued = s.schedules.run_now(&s, &queued_task.id).await.unwrap();
    s.shutdown_schedules().await;
    assert_eq!(
        s.schedules.store.read(|d| d
            .runs
            .iter()
            .find(|r| r.run.id == next.id)
            .unwrap()
            .run
            .status),
        ScheduleRunStatus::Interrupted
    );
    let after = Arc::new(
        ServerState::new(
            dir.path().into(),
            crate::agent_with_builtin_tools(Arc::new(ScriptedModel::new([Reply::new()
                .text("restored queued")
                .done()]))),
        )
        .unwrap(),
    );
    after.schedules.recover(&after).unwrap();
    assert_eq!(after.schedules.snapshot().queued[0].id, queued.id);
    after.schedules.pump(&after, now_ms()).await.unwrap();
    assert_eq!(terminal(&after, &queued.id).await.result, "restored queued");
    assert_eq!(after.schedules.store.read(|d| d.runs.len()), 3);
    after.shutdown_schedules().await;
}
#[tokio::test]
async fn edits_use_cas_pause_cancels_queue_and_second_engine_cannot_claim_catalog() {
    let (dir, s) = state(Arc::new(ScriptedModel::default()));
    let task = create(&s, definition("task")).await;
    let other = Arc::new(
        ServerState::new(
            dir.path().into(),
            crate::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
        )
        .unwrap(),
    );
    assert!(other.schedules.recover(&other).is_err());
    let run = s.schedules.run_now(&s, &task.id).await.unwrap();
    let paused = s
        .schedules
        .upsert(
            &s,
            ScheduleUpsertParams {
                task_id: Some(task.id.clone()),
                expected_version: Some(task.version),
                definition: task.definition.clone(),
                enabled: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        s.schedules.store.read(|d| d
            .runs
            .iter()
            .find(|r| r.run.id == run.id)
            .unwrap()
            .run
            .status),
        ScheduleRunStatus::Stopped
    );
    assert!(
        s.schedules
            .upsert(
                &s,
                ScheduleUpsertParams {
                    task_id: Some(task.id.clone()),
                    expected_version: Some(task.version),
                    definition: task.definition,
                    enabled: true
                }
            )
            .await
            .is_err()
    );
    assert!(
        s.schedules
            .delete(
                &s,
                ScheduleDeleteParams {
                    task_id: task.id.clone(),
                    expected_version: task.version
                }
            )
            .await
            .is_err()
    );
    s.schedules
        .delete(
            &s,
            ScheduleDeleteParams {
                task_id: task.id,
                expected_version: paused.version,
            },
        )
        .await
        .unwrap();
    s.shutdown_schedules().await;
}

#[tokio::test]
async fn due_occurrences_coalesce_without_replay_and_expire_while_queued() {
    let model = Arc::new(ScriptedModel::new([vec![Step::Hang]]));
    let (_dir, s) = state(model.clone());
    let blocker = create(&s, definition("blocker")).await;
    let blocked = s.schedules.run_now(&s, &blocker.id).await.unwrap();
    s.schedules.pump(&s, now_ms()).await.unwrap();
    let latest = create(&s, definition("catch up")).await;
    let mut skip = definition("skip late");
    skip.missed_policy = MissedPolicy::Skip;
    let skip = create(&s, skip).await;
    let at = calendar::latest(&latest.definition.rule, now_ms())
        .unwrap()
        .unwrap();
    // Set the next trigger several days behind, as after a sleeping/stopped server.
    s.schedules
        .store
        .mutate(|d| {
            for id in [&latest.id, &skip.id] {
                d.tasks.get_mut(id).unwrap().next_run_at = Some(at - 3 * 86_400_000);
            }
            Ok(())
        })
        .unwrap();
    s.schedules.pump(&s, at + 90_000).await.unwrap();
    let rows = s.schedules.store.read(|d| d.runs.clone());
    let catch = rows.iter().find(|r| r.run.task_id == latest.id).unwrap();
    assert_eq!(catch.run.status, ScheduleRunStatus::Queued);
    assert_eq!(catch.run.scheduled_at, at);
    assert_eq!(
        rows.iter()
            .find(|r| r.run.task_id == skip.id)
            .unwrap()
            .run
            .status,
        ScheduleRunStatus::Missed
    );
    let count = rows.len();
    s.schedules.pump(&s, at + 90_000).await.unwrap();
    assert_eq!(s.schedules.store.read(|d| d.runs.len()), count);
    // A new occurrence cannot create a second pending entry for the same task.
    s.schedules.pump(&s, at + 86_400_000).await.unwrap();
    assert_eq!(
        s.schedules
            .snapshot()
            .queued
            .iter()
            .filter(|r| r.task_id == latest.id)
            .count(),
        1
    );
    assert!(
        s.schedules
            .store
            .read(|d| d.runs.iter().any(|r| r.run.task_id == latest.id
                && r.run.status == ScheduleRunStatus::Missed
                && r.run.error.as_ref().is_some_and(|e| e.contains("待执行"))))
    );
    s.schedules.pump(&s, at + 86_400_001).await.unwrap();
    assert_eq!(
        s.schedules.store.read(|d| d
            .runs
            .iter()
            .find(|r| r.run.id == catch.run.id)
            .unwrap()
            .run
            .status),
        ScheduleRunStatus::Missed
    );
    s.schedules.stop(&s, &blocker.id).await.unwrap();
    assert_eq!(
        terminal(&s, &blocked.id).await.status,
        ScheduleRunStatus::Stopped
    );
    s.shutdown_schedules().await;
}

#[tokio::test]
async fn manual_repeat_preserves_next_time_and_pause_keeps_current_run_alive() {
    let model = Arc::new(ScriptedModel::new([vec![Step::Hang]]));
    let (_dir, s) = state(model.clone());
    let task = create(&s, definition("repeat")).await;
    let run = s.schedules.run_now(&s, &task.id).await.unwrap();
    assert_eq!(
        s.schedules.snapshot().tasks[0].next_run_at,
        task.next_run_at
    );
    s.schedules.pump(&s, now_ms()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while model.requests().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut request = ScheduleUpsertParams {
        task_id: Some(task.id.clone()),
        expected_version: Some(task.version),
        definition: task.definition.clone(),
        enabled: false,
    };
    s.schedules.upsert(&s, request.clone()).await.unwrap();
    assert_eq!(s.schedules.snapshot().active.unwrap().id, run.id);
    assert!(
        s.runtime(
            s.schedules
                .snapshot()
                .active
                .unwrap()
                .thread_id
                .as_deref()
                .unwrap()
        )
        .is_running()
    );
    request.expected_version = Some(task.version + 1);
    request.enabled = true;
    s.schedules.upsert(&s, request).await.unwrap();
    s.schedules.stop(&s, &task.id).await.unwrap();
    assert_eq!(
        terminal(&s, &run.id).await.status,
        ScheduleRunStatus::Stopped
    );
    s.shutdown_schedules().await;
}

struct ChildModel {
    fail: bool,
}
impl fv_agent::Model for ChildModel {
    fn stream(
        &self,
        request: fv_agent::ModelRequest,
    ) -> futures_util::stream::BoxStream<'static, Result<fv_agent::ModelEvent, fv_agent::ModelError>>
    {
        use fv_core::Message;
        let child = request
            .messages
            .iter()
            .any(|m| matches!(m,Message::User{text}if text.ends_with("hanging child")));
        if child && self.fail {
            return fv_agent::testing::FailingModel("child failed".into()).stream(request);
        }
        let reply = if child {
            vec![Step::Hang]
        } else if request
            .messages
            .iter()
            .any(|m| matches!(m,Message::ToolResult{name,..}if name=="spawn_agent"))
        {
            Reply::new().text("parent done").done()
        } else {
            Reply::new()
                .tool(
                    "spawn",
                    "spawn_agent",
                    serde_json::json!({"message":"hanging child","task_name":"hang"}),
                )
                .done()
        };
        ScriptedModel::new([reply]).stream(request)
    }
}
#[tokio::test]
async fn finished_parent_keeps_slot_until_children_end_and_stop_owns_deleted_children() {
    let (dir, s) = state(Arc::new(ChildModel { fail: false }));
    // Open the second cache before the first engine creates its schedule.
    let second = Arc::new(
        ServerState::new(
            dir.path().into(),
            crate::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
        )
        .unwrap(),
    );
    let task = create(&s, definition("parent")).await;
    let run = s.schedules.run_now(&s, &task.id).await.unwrap();
    s.schedules.pump(&s, now_ms()).await.unwrap();
    let root = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let active = s.schedules.active.lock().unwrap().clone().unwrap();
            if !s.runtime(&active.root).is_running() && active.owned.lock().unwrap().len() == 2 {
                return active.root.clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        s.schedules.snapshot().active.unwrap().status,
        ScheduleRunStatus::Running
    );
    // An unrelated new turn cannot race into the root after the parent has completed.
    assert!(s.runtime(&root).begin(&s, "intruder").await.is_none());
    let child = s
        .schedules
        .active
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .owned
        .lock()
        .unwrap()
        .keys()
        .find(|id| *id != &root)
        .unwrap()
        .clone();
    let child_rt = s.runtime(&child);
    assert!(child_rt.is_running());
    assert!(
        crate::UnixServer::bind(second, &dir.path().join("other.sock"))
            .await
            .is_err()
    );
    assert_eq!(
        s.store.db.subagent(&child).unwrap().unwrap().status,
        fv_protocol::subagents::SubagentStatus::Running
    );
    s.delete_thread(&child).unwrap();
    s.schedules.stop(&s, &task.id).await.unwrap();
    assert_eq!(
        terminal(&s, &run.id).await.status,
        ScheduleRunStatus::Stopped
    );
    assert!(!child_rt.is_running());
    s.shutdown_schedules().await;
}
#[tokio::test]
async fn stop_waits_for_a_real_background_process_to_exit() {
    let model=Arc::new(ScriptedModel::new([Reply::new().tool("command","exec_command",serde_json::json!({"cmd":"echo $$ > pid; exec sleep 60","login":false,"yield_time_ms":1000})).done(),vec![Step::Hang]]));
    let (_dir, s) = state(model.clone());
    let task = create(&s, definition("process")).await;
    let run = s.schedules.run_now(&s, &task.id).await.unwrap();
    s.schedules.pump(&s, now_ms()).await.unwrap();
    let (pid, rt) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let current = s.schedules.snapshot().active.unwrap();
            let thread = s
                .thread(current.thread_id.as_deref().unwrap())
                .unwrap()
                .unwrap();
            let path = std::path::Path::new(thread.cwd.as_deref().unwrap()).join("pid");
            if let Ok(pid) = std::fs::read_to_string(path)
                && model.requests().len() >= 2
            {
                return (pid.trim().parse::<i32>().unwrap(), s.runtime(&thread.id));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
    assert!(rt.exec_sessions.has_running());
    s.schedules.stop(&s, &task.id).await.unwrap();
    assert_eq!(
        terminal(&s, &run.id).await.status,
        ScheduleRunStatus::Stopped
    );
    assert!(!rt.exec_sessions.has_running());
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    s.shutdown_schedules().await;
}

#[tokio::test]
async fn crash_recovery_interrupts_a_claimed_occurrence_without_replaying_it() {
    let (dir, s) = state(Arc::new(ScriptedModel::default()));
    let task = create(&s, definition("claimed before crash")).await;
    let run = s.schedules.run_now(&s, &task.id).await.unwrap();
    // Simulate the committed claim left by a killed process, before any worker can run.
    s.schedules
        .store
        .mutate(|d| {
            let row = d.runs.iter_mut().find(|r| r.run.id == run.id).unwrap();
            row.run.status = ScheduleRunStatus::Running;
            row.run.started_at = Some(now_ms());
            d.refresh_task(&task.id);
            Ok(())
        })
        .unwrap();
    drop(s);
    let model = Arc::new(ScriptedModel::new([Reply::new()
        .text("must not replay")
        .done()]));
    let restored = Arc::new(
        ServerState::new(
            dir.path().into(),
            crate::agent_with_builtin_tools(model.clone()),
        )
        .unwrap(),
    );
    restored.schedules.recover(&restored).unwrap();
    restored.schedules.pump(&restored, now_ms()).await.unwrap();
    let history = restored
        .schedules
        .history(
            &restored,
            ScheduleHistoryParams {
                task_id: task.id.clone(),
                offset: 0,
                limit: None,
            },
        )
        .unwrap();
    assert_eq!(history.runs[0].status, ScheduleRunStatus::Interrupted);
    assert_eq!(history.runs[0].id, run.id);
    assert!(model.requests().is_empty());
    assert!(restored.schedules.snapshot().active.is_none());
    assert_eq!(
        restored.schedules.snapshot().tasks[0].next_run_at,
        task.next_run_at
    );
    restored.shutdown_schedules().await;
}

#[tokio::test]
async fn an_unhandled_failed_child_prevents_a_successful_schedule_status() {
    let (_dir, s) = state(Arc::new(ChildModel { fail: true }));
    let task = create(&s, definition("parent")).await;
    let run = s.schedules.run_now(&s, &task.id).await.unwrap();
    s.schedules.pump(&s, now_ms()).await.unwrap();
    let result = terminal(&s, &run.id).await;
    assert_eq!(result.status, ScheduleRunStatus::Failed);
    assert!(result.error.unwrap().contains("子任务"));
    assert_eq!(result.result, "parent done");
    s.shutdown_schedules().await;
}
