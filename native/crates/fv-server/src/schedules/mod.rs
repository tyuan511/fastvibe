//! Engine-owned scheduling. A process lease, atomic claims and owned runtimes ensure that
//! closing a window, cancelling a tool, or restarting never silently replays an occurrence.
pub(crate) mod calendar;
use crate::{
    runtime::ThreadRuntime,
    state::{ServerState, now_ms},
};
use fv_protocol::{
    ErrorObject, ServerNotification,
    jsonrpc::code,
    schedules::*,
    types::{Empty, Thread, TurnStatus},
};
use fv_store::{SavedScheduleRun, ScheduleData, ScheduleStore, ScheduleStoreError};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn invalid(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, e.to_string())
}
fn internal(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}
fn store_error(e: ScheduleStoreError) -> ErrorObject {
    match e {
        ScheduleStoreError::Invalid(e) => invalid(e),
        ScheduleStoreError::Storage(e) => internal(e),
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum StopReason {
    User,
    Timeout,
    Shutdown,
}
struct Owned {
    rt: Arc<ThreadRuntime>,
    turn: String,
}
struct Active {
    run: ScheduledRun,
    root: String,
    cancel: CancellationToken,
    reason: Mutex<Option<StopReason>>,
    owned: Mutex<HashMap<String, Owned>>,
    done: tokio::sync::watch::Sender<bool>,
}
impl Active {
    fn runtimes(&self) -> Vec<Arc<ThreadRuntime>> {
        self.owned
            .lock()
            .unwrap()
            .values()
            .map(|o| o.rt.clone())
            .collect()
    }
    fn stop(&self, reason: StopReason) {
        let mut current = self.reason.lock().unwrap();
        if current.is_none() {
            *current = Some(reason);
        }
        drop(current);
        self.cancel.cancel();
        for rt in self.runtimes() {
            rt.interrupt();
            rt.exec_sessions.terminate_all();
        }
    }
    fn settled(&self) -> bool {
        self.runtimes()
            .iter()
            .all(|rt| !rt.is_running() && !rt.exec_sessions.has_running())
    }
}

pub struct Schedules {
    store: ScheduleStore,
    gate: tokio::sync::Mutex<()>,
    active: Mutex<Option<Arc<Active>>>,
    lease: Mutex<Option<File>>,
    started: AtomicBool,
    stopped: AtomicBool,
    pending: AtomicBool,
    wake: Arc<tokio::sync::Notify>,
}
impl Schedules {
    pub fn open(db: Arc<fv_store::Db>) -> Result<Self, fv_store::StoreError> {
        let store = ScheduleStore::open(db)?;
        let pending = store.read(|d| d.runs.iter().any(|r| !r.run.status.terminal()));
        Ok(Self {
            store,
            gate: Default::default(),
            active: Default::default(),
            lease: Default::default(),
            started: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            pending: AtomicBool::new(pending),
            wake: Default::default(),
        })
    }
    fn ensure_lease(&self, state: &ServerState) -> Result<(), ErrorObject> {
        let mut lease = self.lease.lock().unwrap();
        if lease.is_some() {
            return Ok(());
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(state.data_dir.join("schedules.lock"))
            .map_err(internal)?;
        file.try_lock()
            .map_err(|_| invalid("Another server owns schedules in this data directory."))?;
        self.store.reload().map_err(internal)?;
        *lease = Some(file);
        Ok(())
    }
    /// Only after claiming the listener; merely constructing a second server cannot recover
    /// the first server's live runs. Even an apparently empty cache must acquire the lease:
    /// another process may have created tasks since this state was opened.
    pub fn recover(&self, state: &ServerState) -> Result<(), ErrorObject> {
        self.ensure_lease(state)?;
        let now = now_ms();
        self.store
            .mutate(|d| {
                let mut ids = Vec::new();
                for row in &mut d.runs {
                    if row.run.status == ScheduleRunStatus::Running {
                        row.run.status = ScheduleRunStatus::Interrupted;
                        row.run.stopping = false;
                        row.run.ended_at = Some(now);
                        row.run.error = Some("服务在运行期间停止，未自动重放此任务。".into());
                        ids.push(row.run.task_id.clone());
                    }
                }
                for id in ids {
                    d.refresh_task(&id);
                }
                Ok(())
            })
            .map_err(store_error)?;
        self.signal(state);
        Ok(())
    }
    /// Keep the lease across child recovery too. Empty, idle engines need not retain it,
    /// but no scheduled run can be claimed between the two recovery operations.
    pub fn recovery_complete(&self) {
        if self.store.read(|d| d.tasks.is_empty() && d.runs.is_empty()) {
            self.lease.lock().unwrap().take();
        }
    }
    pub fn start(state: &Arc<ServerState>) {
        if state.schedules.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(state);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(1));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                let Some(state) = weak.upgrade() else {
                    break;
                };
                if state.schedules.stopped.load(Ordering::Acquire) {
                    break;
                }
                if let Err(e) = state.schedules.pump(&state, now_ms()).await {
                    eprintln!("schedule pump: {}", e.message);
                }
                let wake = state.schedules.wake.clone();
                drop(state);
                tokio::select! {_ = timer.tick()=>(),_ = wake.notified()=>()}
            }
        });
    }
    fn signal(&self, state: &ServerState) {
        self.pending.store(
            self.store
                .read(|d| d.runs.iter().any(|r| !r.run.status.terminal())),
            Ordering::Release,
        );
        self.wake.notify_one();
        state.broadcast(ServerNotification::SchedulesChanged(Empty {}));
    }
    pub fn busy(&self) -> bool {
        self.pending.load(Ordering::Acquire) || self.active.lock().unwrap().is_some()
    }
    pub fn snapshot(&self) -> ScheduleSnapshot {
        self.store.read(|d| d.snapshot())
    }
    pub fn snapshot_live(&self, state: &ServerState) -> ScheduleSnapshot {
        let mut snapshot = self.snapshot();
        if let Some(run) = &mut snapshot.active {
            run.waiting_for_input = self.waiting(state);
        }
        snapshot
    }
    fn waiting(&self, state: &ServerState) -> bool {
        let ids = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.owned.lock().unwrap().keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        ids.iter().any(|id| !state.pending_prompts(id).is_empty())
    }
    pub fn prompt_changed(&self, state: &ServerState) {
        if self.active.lock().unwrap().is_some() {
            state.broadcast(ServerNotification::SchedulesChanged(Empty {}));
        }
    }
    pub fn history(
        &self,
        state: &ServerState,
        p: ScheduleHistoryParams,
    ) -> Result<ScheduleHistory, ErrorObject> {
        let waiting = self.waiting(state);
        self.store.read(|d| {
            if !d.tasks.contains_key(&p.task_id) {
                return Err(invalid("定时任务不存在。"));
            }
            let all = d
                .runs
                .iter()
                .rev()
                .filter(|r| r.run.task_id == p.task_id)
                .map(|r| r.run.clone())
                .collect::<Vec<_>>();
            let total = all.len() as u32;
            let mut runs = all
                .into_iter()
                .skip(p.offset as usize)
                .take(p.limit.unwrap_or(30).clamp(1, 100) as usize)
                .collect::<Vec<_>>();
            for run in &mut runs {
                if run.status == ScheduleRunStatus::Running {
                    run.waiting_for_input = waiting;
                }
            }
            Ok(ScheduleHistory {
                runs,
                total,
                offset: p.offset,
            })
        })
    }
    pub async fn upsert(
        &self,
        state: &Arc<ServerState>,
        p: ScheduleUpsertParams,
    ) -> Result<ScheduledTask, ErrorObject> {
        let _gate = self.gate.lock().await;
        self.ensure_lease(state)?;
        validate(state, &p.definition)?;
        let now = now_ms();
        if p.enabled
            && matches!(&p.definition.rule, ScheduleRule::Once { .. })
            && calendar::next(&p.definition.rule, now)
                .map_err(invalid)?
                .is_none()
        {
            return Err(invalid("启用的一次性任务需要选择未来时间。"));
        }
        let id = p
            .task_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let result = self
            .store
            .mutate(|d| {
                let old = d.tasks.get(&id).cloned();
                if old.as_ref().map(|t| t.version) != p.expected_version
                    || old.is_some() != p.task_id.is_some()
                {
                    return Err("任务已在别处修改，请重新载入后保存。".into());
                }
                if old.is_none() && d.tasks.len() >= 200 {
                    return Err("最多保留 200 个定时任务。".into());
                }
                let changed_rule = old.as_ref().is_none_or(|t| {
                    t.definition.rule != p.definition.rule || t.enabled != p.enabled
                });
                let next = if !p.enabled {
                    None
                } else if changed_rule {
                    calendar::next(&p.definition.rule, now)?
                } else {
                    old.as_ref().and_then(|t| t.next_run_at)
                };
                let task = ScheduledTask {
                    id: id.clone(),
                    version: old
                        .as_ref()
                        .map(|t| {
                            t.version
                                .checked_add(1)
                                .ok_or("任务版本已耗尽。".to_string())
                        })
                        .transpose()?
                        .unwrap_or(1),
                    definition: p.definition,
                    enabled: p.enabled,
                    created_at: old.as_ref().map(|t| t.created_at).unwrap_or(now),
                    updated_at: now,
                    next_run_at: next,
                    last_run_at: old.as_ref().and_then(|t| t.last_run_at),
                    last_status: old.as_ref().and_then(|t| t.last_status),
                };
                if !task.enabled && old.as_ref().is_none_or(|t| t.enabled) {
                    for row in &mut d.runs {
                        if row.run.task_id == id && row.run.status == ScheduleRunStatus::Queued {
                            row.run.status = ScheduleRunStatus::Stopped;
                            row.run.ended_at = Some(now);
                            row.run.error = Some("任务已暂停，待执行项已取消。".into());
                        }
                    }
                }
                d.tasks.insert(id.clone(), task);
                d.refresh_task(&id);
                Ok(d.tasks[&id].clone())
            })
            .map_err(store_error)?;
        self.signal(state);
        Ok(result)
    }
    pub async fn delete(
        &self,
        state: &ServerState,
        p: ScheduleDeleteParams,
    ) -> Result<(), ErrorObject> {
        let _gate = self.gate.lock().await;
        self.ensure_lease(state)?;
        if self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.run.task_id == p.task_id)
        {
            return Err(invalid("任务仍在执行或收尾，请先停止并等待结束。"));
        }
        self.store
            .mutate(|d| {
                let task = d.tasks.get(&p.task_id).ok_or("定时任务不存在。")?;
                if task.version != p.expected_version {
                    return Err("任务已在别处修改，请重新载入。".into());
                }
                d.tasks.remove(&p.task_id);
                d.runs.retain(|r| r.run.task_id != p.task_id);
                Ok(())
            })
            .map_err(store_error)?;
        self.signal(state);
        Ok(())
    }
    pub async fn run_now(
        &self,
        state: &ServerState,
        id: &str,
    ) -> Result<ScheduledRun, ErrorObject> {
        let _gate = self.gate.lock().await;
        self.ensure_lease(state)?;
        if self.stopped.load(Ordering::Acquire) {
            return Err(invalid("任务引擎已停止。"));
        }
        let run = self
            .store
            .mutate(|d| {
                let task = d.tasks.get(id).cloned().ok_or("定时任务不存在。")?;
                if d.runs
                    .iter()
                    .any(|r| r.run.task_id == id && r.run.status == ScheduleRunStatus::Running)
                {
                    return Err("该任务正在执行。".into());
                }
                if let Some(row) = d
                    .runs
                    .iter()
                    .find(|r| r.run.task_id == id && r.run.status == ScheduleRunStatus::Queued)
                {
                    return Ok(row.run.clone());
                }
                let run = add_run(d, &task, now_ms(), true, ScheduleRunStatus::Queued, None)?;
                if matches!(task.definition.rule, ScheduleRule::Once { .. }) {
                    let task = d.tasks.get_mut(id).unwrap();
                    task.enabled = false;
                    task.next_run_at = None;
                    task.version = task.version.checked_add(1).ok_or("任务版本已耗尽。")?;
                    task.updated_at = now_ms();
                }
                d.refresh_task(id);
                Ok(run)
            })
            .map_err(store_error)?;
        self.signal(state);
        Ok(run)
    }
    pub async fn stop(&self, state: &ServerState, id: &str) -> Result<(), ErrorObject> {
        let _gate = self.gate.lock().await;
        self.ensure_lease(state)?;
        let now = now_ms();
        self.store
            .mutate(|d| {
                if !d.tasks.contains_key(id) {
                    return Err("定时任务不存在。".into());
                }
                for r in &mut d.runs {
                    if r.run.task_id == id {
                        match r.run.status {
                            ScheduleRunStatus::Queued => {
                                r.run.status = ScheduleRunStatus::Stopped;
                                r.run.ended_at = Some(now);
                            }
                            ScheduleRunStatus::Running => r.run.stopping = true,
                            _ => {}
                        }
                    }
                }
                d.refresh_task(id);
                Ok(())
            })
            .map_err(store_error)?;
        if let Some(active) = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|a| a.run.task_id == id)
            .cloned()
        {
            active.stop(StopReason::User);
        }
        self.signal(state);
        Ok(())
    }
    pub fn can_begin(&self, thread: &str, turn: &str) -> bool {
        self.active.lock().unwrap().as_ref().is_none_or(|a| {
            a.owned
                .lock()
                .unwrap()
                .get(thread)
                .is_none_or(|o| o.turn == turn && !a.cancel.is_cancelled())
        })
    }
    pub fn chain(&self, thread: &str, previous: &str, next: &str) -> bool {
        let Some(active) = self.active.lock().unwrap().clone() else {
            return true;
        };
        let mut owned = active.owned.lock().unwrap();
        let Some(o) = owned.get_mut(thread) else {
            return true;
        };
        if o.turn != previous || active.cancel.is_cancelled() {
            return false;
        }
        o.turn = next.into();
        true
    }
    pub fn adopt(&self, root: &str, thread: &str, turn: &str, rt: Arc<ThreadRuntime>) -> bool {
        let Some(active) = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|a| a.root == root)
            .cloned()
        else {
            return true;
        };
        if active.cancel.is_cancelled() {
            return false;
        }
        active.owned.lock().unwrap().insert(
            thread.into(),
            Owned {
                rt,
                turn: turn.into(),
            },
        );
        true
    }
    pub fn interrupt(&self, thread: &str) {
        if let Some(active) = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|a| a.root == thread)
            .cloned()
        {
            active.stop(StopReason::User);
        }
    }
    pub fn owns(&self, thread: &str) -> bool {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.owned.lock().unwrap().contains_key(thread))
    }
    pub fn instructions(&self, thread: &str) -> &'static str {
        if self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.owned.lock().unwrap().contains_key(thread))
        {
            "\n\nThis is an automated scheduled run. Complete the assigned task with the current sandbox and approval policy. Wait for delegated agents and commands to finish and report concrete results. Do not treat this schedule as authorization for unrelated external actions."
        } else {
            ""
        }
    }
    async fn pump(&self, state: &Arc<ServerState>, now: i64) -> Result<(), ErrorObject> {
        let _gate = self.gate.lock().await;
        if self.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        let due = self.store.read(|d| {
            d.tasks
                .values()
                .filter(|t| t.enabled && t.next_run_at.is_some_and(|at| at <= now))
                .cloned()
                .collect::<Vec<_>>()
        });
        let queued = self.store.read(|d| {
            d.runs
                .iter()
                .any(|r| r.run.status == ScheduleRunStatus::Queued)
        });
        if due.is_empty() && !queued {
            return Ok(());
        }
        self.ensure_lease(state)?;
        let before = self.store.read(|d| d.revision);
        self.store
            .mutate(|d| {
                let mut affected = Vec::new();
                for r in &mut d.runs {
                    if r.run.status == ScheduleRunStatus::Queued
                        && !r.run.manual
                        && late(&r.definition, r.run.scheduled_at, now)
                    {
                        r.run.status = ScheduleRunStatus::Missed;
                        r.run.ended_at = Some(now);
                        r.run.error = Some("排队时间超过补跑期限。".into());
                        affected.push(r.run.task_id.clone());
                    }
                }
                for task in due {
                    if !d.tasks.get(&task.id).is_some_and(|t| {
                        t.enabled && t.version == task.version && t.next_run_at == task.next_run_at
                    }) {
                        continue;
                    }
                    let earliest = task.next_run_at.unwrap();
                    let at = calendar::latest(&task.definition.rule, now)?
                        .unwrap_or(earliest)
                        .max(earliest);
                    let conflict = d.runs.iter().any(|r| {
                        r.run.task_id == task.id && r.run.status == ScheduleRunStatus::Queued
                    });
                    let missed = conflict || late(&task.definition, at, now);
                    add_run(
                        d,
                        &task,
                        at,
                        false,
                        if missed {
                            ScheduleRunStatus::Missed
                        } else {
                            ScheduleRunStatus::Queued
                        },
                        if conflict {
                            Some("已有待执行项，本次触发已跳过。".into())
                        } else if missed {
                            Some("已超过补跑期限。".into())
                        } else {
                            None
                        },
                    )?;
                    let current = d.tasks.get_mut(&task.id).unwrap();
                    current.next_run_at = calendar::next(&task.definition.rule, now)?;
                    if current.next_run_at.is_none() {
                        current.enabled = false;
                        current.version =
                            current.version.checked_add(1).ok_or("任务版本已耗尽。")?;
                        current.updated_at = now;
                    }
                    affected.push(task.id);
                }
                for id in affected {
                    d.refresh_task(&id);
                }
                Ok(())
            })
            .map_err(store_error)?;
        if self.store.read(|d| d.revision) != before {
            self.signal(state);
        }
        if self.active.lock().unwrap().is_some() {
            return Ok(());
        }
        while let Some(row) = self.store.read(|d| {
            d.runs
                .iter()
                .find(|r| r.run.status == ScheduleRunStatus::Queued)
                .cloned()
        }) {
            let thread = match prepare_thread(state, &row, now) {
                Ok(t) => t,
                Err(e) => {
                    self.finish(
                        state,
                        &row.run.id,
                        ScheduleRunStatus::Failed,
                        Some(e),
                        String::new(),
                    )?;
                    continue;
                }
            };
            let rt;
            let active;
            {
                let _claim = state.subagents_lock.lock().unwrap();
                self.store
                    .mutate_with_thread(&thread, |d| {
                        let r = d
                            .runs
                            .iter_mut()
                            .find(|r| {
                                r.run.id == row.run.id && r.run.status == ScheduleRunStatus::Queued
                            })
                            .ok_or("待执行项已经变更。")?;
                        r.run.status = ScheduleRunStatus::Running;
                        r.run.started_at = Some(now);
                        r.run.thread_id = Some(thread.id.clone());
                        d.refresh_task(&row.run.task_id);
                        Ok(())
                    })
                    .map_err(store_error)?;
                rt = state.runtime(&thread.id);
                let run = self.store.read(|d| {
                    d.runs
                        .iter()
                        .find(|r| r.run.id == row.run.id)
                        .unwrap()
                        .run
                        .clone()
                });
                active = Arc::new(Active {
                    run,
                    root: thread.id.clone(),
                    cancel: CancellationToken::new(),
                    reason: Mutex::new(None),
                    owned: Mutex::new(HashMap::new()),
                    done: tokio::sync::watch::channel(false).0,
                });
                active.owned.lock().unwrap().insert(
                    thread.id.clone(),
                    Owned {
                        rt: rt.clone(),
                        turn: uuid::Uuid::new_v4().to_string(),
                    },
                );
                *self.active.lock().unwrap() = Some(active.clone());
            }
            state.broadcast(ServerNotification::ThreadStarted(thread));
            self.signal(state);
            let state = state.clone();
            tokio::spawn(async move {
                run_owned(state, active, row.definition, rt).await;
            });
            break;
        }
        Ok(())
    }
    fn finish(
        &self,
        state: &ServerState,
        id: &str,
        status: ScheduleRunStatus,
        error: Option<String>,
        result: String,
    ) -> Result<(), ErrorObject> {
        self.store
            .mutate(|d| {
                let Some(row) = d
                    .runs
                    .iter_mut()
                    .find(|r| r.run.id == id && !r.run.status.terminal())
                else {
                    return Ok(());
                };
                row.run.status = status;
                row.run.ended_at = Some(now_ms());
                row.run.stopping = false;
                row.run.error = error.map(|e| e.chars().take(8000).collect());
                row.run.result = result.chars().take(8000).collect();
                let task = row.run.task_id.clone();
                d.refresh_task(&task);
                Ok(())
            })
            .map_err(store_error)?;
        self.signal(state);
        Ok(())
    }
    pub async fn shutdown(&self, state: &ServerState) {
        let active = {
            let _gate = self.gate.lock().await;
            self.stopped.store(true, Ordering::Release);
            self.wake.notify_one();
            let active = self.active.lock().unwrap().clone();
            if let Some(active) = &active {
                let _ = self.finish(
                    state,
                    &active.run.id,
                    ScheduleRunStatus::Interrupted,
                    Some("服务已停止。".into()),
                    String::new(),
                );
                active.stop(StopReason::Shutdown);
            }
            active
        };
        if let Some(active) = active {
            let mut done = active.done.subscribe();
            let settled = async {
                while !*done.borrow() {
                    if done.changed().await.is_err() {
                        break;
                    }
                }
            };
            if tokio::time::timeout(Duration::from_secs(10), settled)
                .await
                .is_err()
            {
                return;
            }
        }
        self.lease.lock().unwrap().take();
    }
}
fn validate(state: &ServerState, d: &ScheduleDefinition) -> Result<(), ErrorObject> {
    if d.name.trim().is_empty()
        || d.name.chars().count() > 100
        || d.prompt.trim().is_empty()
        || d.prompt.chars().count() > 32_000
        || !(1..=86400).contains(&d.max_run_seconds)
    {
        return Err(invalid(
            "任务名需为 1–100 字符，指令为 1–32000 字符，时限为 1–86400 秒。",
        ));
    }
    calendar::validate(&d.rule).map_err(invalid)?;
    if let Some(project) = &d.project {
        let p = crate::projects::of_thread(state, project)
            .ok_or_else(|| invalid("所选项目不存在。"))?;
        if !std::path::Path::new(&p.path).is_dir() {
            return Err(invalid("项目目录不可用。"));
        }
    }
    if let Some(model) = &d.model {
        crate::providers::resolve(state, model, d.thinking).map_err(invalid)?;
    }
    Ok(())
}
fn late(d: &ScheduleDefinition, at: i64, now: i64) -> bool {
    now.saturating_sub(at)
        > if d.missed_policy == MissedPolicy::Skip {
            60_000
        } else {
            86_400_000
        }
}
fn add_run(
    d: &mut ScheduleData,
    task: &ScheduledTask,
    at: i64,
    manual: bool,
    status: ScheduleRunStatus,
    error: Option<String>,
) -> Result<ScheduledRun, String> {
    let run = ScheduledRun {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: task.id.clone(),
        task_name: task.definition.name.clone(),
        task_version: task.version,
        scheduled_at: at,
        started_at: None,
        ended_at: status.terminal().then_some(now_ms()),
        manual,
        status,
        stopping: false,
        waiting_for_input: false,
        thread_id: None,
        error,
        result: String::new(),
    };
    d.sequence = d.sequence.checked_add(1).ok_or("任务序号已耗尽。")?;
    d.runs.push(SavedScheduleRun {
        position: d.sequence,
        run: run.clone(),
        definition: task.definition.clone(),
    });
    Ok(run)
}
fn prepare_thread(state: &ServerState, row: &SavedScheduleRun, now: i64) -> Result<Thread, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let cwd = if let Some(project) = &row.definition.project {
        let p = crate::projects::of_thread(state, project).ok_or("运行前项目已被移除。")?;
        if !std::path::Path::new(&p.path).is_dir() {
            return Err("运行前项目目录已不可用。".into());
        }
        p.path
    } else {
        let path = state.data_dir.join("scratch").join(&id);
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&path)
            .map_err(|e| e.to_string())?;
        path.display().to_string()
    };
    Ok(Thread {
        id,
        title: row.definition.name.clone(),
        cwd: Some(cwd),
        project: row.definition.project.clone(),
        source: None,
        model: row.definition.model.clone(),
        thinking: row.definition.thinking,
        created_at: now,
        updated_at: now,
        archived: false,
        unread: false,
        pinned: false,
        worktree: None,
    })
}
async fn run_owned(
    state: Arc<ServerState>,
    active: Arc<Active>,
    definition: ScheduleDefinition,
    rt: Arc<ThreadRuntime>,
) {
    let turn = active.owned.lock().unwrap()[&active.root].turn.clone();
    let elapsed = now_ms()
        .saturating_sub(active.run.started_at.unwrap_or_else(now_ms))
        .max(0) as u64;
    let remaining = (u64::from(definition.max_run_seconds) * 1000).saturating_sub(elapsed);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(remaining);
    let started = rt
        .begin_linked(&state, &turn, active.cancel.child_token())
        .await;
    if tokio::time::Instant::now() >= deadline {
        active.stop(StopReason::Timeout);
    }
    if let Some(cancel) = started {
        crate::turn::spawn_turn(
            state.clone(),
            rt.clone(),
            active.root.clone(),
            turn,
            definition.prompt,
            cancel,
        );
    }
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    loop {
        tick.tick().await;
        if tokio::time::Instant::now() >= deadline && !active.cancel.is_cancelled() {
            active.stop(StopReason::Timeout);
        }
        if !rt.is_running() {
            let owned = active.runtimes();
            if owned.iter().all(|rt| !rt.is_running()) {
                for rt in owned {
                    rt.exec_sessions.terminate_all();
                }
            }
        }
        if active.settled() {
            break;
        }
    }
    let reason = *active.reason.lock().unwrap();
    let (mut status, mut error) = match reason {
        Some(StopReason::Timeout) => (
            ScheduleRunStatus::Failed,
            Some("运行超过设定时限，已停止。".into()),
        ),
        Some(StopReason::User) => (ScheduleRunStatus::Stopped, None),
        Some(StopReason::Shutdown) => (ScheduleRunStatus::Interrupted, None),
        None => match rt.completion() {
            Some((TurnStatus::Completed, e)) => (ScheduleRunStatus::Completed, e),
            Some((TurnStatus::Interrupted, e)) => (ScheduleRunStatus::Stopped, e),
            Some((TurnStatus::Failed, e)) => (ScheduleRunStatus::Failed, e),
            None => (
                ScheduleRunStatus::Stopped,
                Some("运行对话已删除或无法启动。".into()),
            ),
        },
    };
    if status == ScheduleRunStatus::Completed {
        let ids = active
            .owned
            .lock()
            .unwrap()
            .keys()
            .filter(|id| *id != &active.root)
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            if state
                .store
                .db
                .subagent(&id)
                .ok()
                .flatten()
                .is_some_and(|a| a.status == fv_protocol::subagents::SubagentStatus::Failed)
            {
                status = ScheduleRunStatus::Failed;
                error = Some(format!("子任务 {id} 未成功完成。"));
                break;
            }
        }
    }
    let result = rt
        .turns()
        .last()
        .map(|t| {
            t.items
                .iter()
                .filter_map(|i| match i {
                    fv_protocol::types::Item::AgentMessage { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default();
    loop {
        let committed = {
            let _gate = state.schedules.gate.lock().await;
            match state.schedules.finish(
                &state,
                &active.run.id,
                status,
                error.clone(),
                result.clone(),
            ) {
                Ok(()) => {
                    *state.schedules.active.lock().unwrap() = None;
                    active.done.send_replace(true);
                    state.schedules.signal(&state);
                    true
                }
                Err(e) => {
                    eprintln!("cannot finish scheduled run: {}", e.message);
                    false
                }
            }
        };
        if committed {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if status == ScheduleRunStatus::Completed
        && !rt.queue().is_empty()
        && !crate::queue::is_paused(&state, &active.root)
    {
        crate::turn::start_next(state.clone(), rt, &active.root).await;
    }
}

#[cfg(test)]
mod tests;
