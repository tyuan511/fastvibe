//! One engine owns the schedule catalog. Mutations commit a row diff and revision together,
//! then replace the read snapshot; a failed write never changes the cache.
use crate::{Db, StoreError};
use fv_protocol::schedules::*;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedScheduleRun {
    pub position: u64,
    pub run: ScheduledRun,
    pub definition: ScheduleDefinition,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScheduleData {
    pub tasks: BTreeMap<String, ScheduledTask>,
    pub runs: Vec<SavedScheduleRun>,
    pub revision: u64,
    pub sequence: u64,
}
impl ScheduleData {
    pub fn snapshot(&self) -> ScheduleSnapshot {
        let mut tasks = self.tasks.values().cloned().collect::<Vec<_>>();
        tasks.sort_by_key(|t| (std::cmp::Reverse(t.created_at), t.id.clone()));
        ScheduleSnapshot {
            revision: self.revision,
            tasks,
            active: self
                .runs
                .iter()
                .find(|r| r.run.status == ScheduleRunStatus::Running)
                .map(|r| r.run.clone()),
            queued: self
                .runs
                .iter()
                .filter(|r| r.run.status == ScheduleRunStatus::Queued)
                .map(|r| r.run.clone())
                .collect(),
        }
    }
    pub fn refresh_task(&mut self, id: &str) {
        let Some(task) = self.tasks.get_mut(id) else {
            return;
        };
        let matching = self
            .runs
            .iter()
            .rev()
            .filter(|r| r.run.task_id == id)
            .collect::<Vec<_>>();
        task.last_status = matching
            .iter()
            .find(|r| r.run.status == ScheduleRunStatus::Running)
            .or_else(|| {
                matching
                    .iter()
                    .find(|r| r.run.status == ScheduleRunStatus::Queued)
            })
            .or_else(|| matching.first())
            .map(|r| r.run.status);
        task.last_run_at = matching
            .iter()
            .find_map(|r| r.run.started_at.or(r.run.ended_at));
    }
    /// Keep the latest 500 finished records globally; active/queued records are never pruned.
    pub fn retain_history(&mut self) {
        let mut kept = 0;
        self.runs.reverse();
        self.runs.retain(|r| {
            if !r.run.status.terminal() {
                true
            } else {
                kept += 1;
                kept <= 500
            }
        });
        self.runs.reverse();
    }
}
#[derive(Debug)]
pub enum ScheduleStoreError {
    Storage(StoreError),
    Invalid(String),
}
impl From<StoreError> for ScheduleStoreError {
    fn from(e: StoreError) -> Self {
        Self::Storage(e)
    }
}
impl std::fmt::Display for ScheduleStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(e) => write!(f, "{e}"),
            Self::Invalid(s) => write!(f, "{s}"),
        }
    }
}
impl std::error::Error for ScheduleStoreError {}
pub struct ScheduleStore {
    db: Arc<Db>,
    data: Mutex<ScheduleData>,
}
impl ScheduleStore {
    pub fn open(db: Arc<Db>) -> Result<Self, StoreError> {
        let data = {
            let conn = db.conn.lock().unwrap();
            let mut tasks = BTreeMap::new();
            let mut stmt = conn.prepare("SELECT data FROM scheduled_tasks ORDER BY id")?;
            for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
                let task: ScheduledTask = serde_json::from_str(&row?)?;
                tasks.insert(task.id.clone(), task);
            }
            let mut runs = Vec::new();
            let mut stmt = conn.prepare("SELECT data FROM scheduled_runs ORDER BY position")?;
            for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
                runs.push(serde_json::from_str(&row?)?);
            }
            let meta: Option<String> = conn
                .query_row(
                    "SELECT value FROM schedule_meta WHERE key='state'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            let (revision, sequence) = meta
                .map(|s| serde_json::from_str::<(u64, u64)>(&s))
                .transpose()?
                .unwrap_or_default();
            ScheduleData {
                tasks,
                runs,
                revision,
                sequence,
            }
        };
        Ok(Self {
            db,
            data: Mutex::new(data),
        })
    }
    pub fn reload(&self) -> Result<(), StoreError> {
        let reopened = Self::open(self.db.clone())?;
        *self.data.lock().unwrap() = reopened.data.into_inner().unwrap();
        Ok(())
    }
    pub fn read<T>(&self, read: impl FnOnce(&ScheduleData) -> T) -> T {
        read(&self.data.lock().unwrap())
    }
    pub fn mutate<T>(
        &self,
        change: impl FnOnce(&mut ScheduleData) -> Result<T, String>,
    ) -> Result<T, ScheduleStoreError> {
        self.mutate_inner(None, change)
    }
    pub fn mutate_with_thread<T>(
        &self,
        thread: &fv_protocol::types::Thread,
        change: impl FnOnce(&mut ScheduleData) -> Result<T, String>,
    ) -> Result<T, ScheduleStoreError> {
        self.mutate_inner(Some(thread), change)
    }
    fn mutate_inner<T>(
        &self,
        thread: Option<&fv_protocol::types::Thread>,
        change: impl FnOnce(&mut ScheduleData) -> Result<T, String>,
    ) -> Result<T, ScheduleStoreError> {
        let mut old = self.data.lock().unwrap();
        let mut next = old.clone();
        let result = change(&mut next).map_err(ScheduleStoreError::Invalid)?;
        next.retain_history();
        if next == *old {
            return Ok(result);
        }
        next.revision = old
            .revision
            .checked_add(1)
            .ok_or_else(|| ScheduleStoreError::Invalid("Schedule revision exhausted.".into()))?;
        self.persist(&old, &next, thread)?;
        *old = next;
        Ok(result)
    }
    fn persist(
        &self,
        old: &ScheduleData,
        next: &ScheduleData,
        thread: Option<&fv_protocol::types::Thread>,
    ) -> Result<(), StoreError> {
        let mut conn = self.db.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if let Some(thread) = thread {
            tx.execute(
                "INSERT INTO conversations(id,updated_at,archived,data) VALUES(?1,?2,?3,?4)",
                params![
                    thread.id,
                    thread.updated_at,
                    thread.archived,
                    serde_json::to_string(thread)?
                ],
            )?;
        }
        for run in &old.runs {
            if !next.runs.iter().any(|r| r.run.id == run.run.id) {
                tx.execute("DELETE FROM scheduled_runs WHERE id=?1", [&run.run.id])?;
            }
        }
        for id in old.tasks.keys() {
            if !next.tasks.contains_key(id) {
                tx.execute("DELETE FROM scheduled_tasks WHERE id=?1", [id])?;
            }
        }
        for (id, task) in &next.tasks {
            if old.tasks.get(id) != Some(task) {
                tx.execute("INSERT INTO scheduled_tasks(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![id,serde_json::to_string(task)?])?;
            }
        }
        for run in &next.runs {
            if !old.runs.iter().any(|r| r == run) {
                tx.execute("INSERT INTO scheduled_runs(id,task_id,position,status,data) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",params![run.run.id,run.run.task_id,i64::try_from(run.position).map_err(|_|StoreError::Io(std::io::Error::other("Schedule sequence exceeds SQLite range")))?,run.run.status.as_str(),serde_json::to_string(run)?])?;
            }
        }
        tx.execute("INSERT INTO schedule_meta(key,value) VALUES('state',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&(next.revision,next.sequence))?])?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task(id: &str) -> ScheduledTask {
        ScheduledTask {
            id: id.into(),
            version: 1,
            definition: ScheduleDefinition {
                name: id.into(),
                prompt: "work".into(),
                project: None,
                model: None,
                thinking: None,
                rule: ScheduleRule::Daily {
                    time: "09:00".into(),
                    time_zone: "UTC".into(),
                },
                max_run_seconds: 3600,
                missed_policy: MissedPolicy::RunLatest,
            },
            enabled: true,
            created_at: 1,
            updated_at: 1,
            next_run_at: Some(2),
            last_run_at: None,
            last_status: None,
        }
    }
    fn run(task: &ScheduledTask, position: u64, status: ScheduleRunStatus) -> SavedScheduleRun {
        SavedScheduleRun {
            position,
            definition: task.definition.clone(),
            run: ScheduledRun {
                id: format!("{}-{position}", task.id),
                task_id: task.id.clone(),
                task_name: task.definition.name.clone(),
                task_version: 1,
                scheduled_at: 2,
                started_at: None,
                ended_at: None,
                manual: false,
                status,
                stopping: false,
                waiting_for_input: false,
                thread_id: None,
                error: None,
                result: String::new(),
            },
        }
    }
    #[test]
    fn sqlite_constraints_rollback_entire_mutation_and_cache() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&dir.path().join("db")).unwrap());
        let store = ScheduleStore::open(db.clone()).unwrap();
        let a = task("a");
        let b = task("b");
        store
            .mutate(|d| {
                d.tasks.insert(a.id.clone(), a.clone());
                d.tasks.insert(b.id.clone(), b.clone());
                d.runs.push(run(&a, 1, ScheduleRunStatus::Queued));
                d.sequence = 1;
                Ok(())
            })
            .unwrap();
        let before = store.read(Clone::clone);
        assert!(
            store
                .mutate(|d| {
                    d.tasks.get_mut("a").unwrap().definition.prompt = "must rollback".into();
                    d.runs.push(run(&a, 2, ScheduleRunStatus::Queued));
                    d.sequence = 2;
                    Ok(())
                })
                .is_err()
        );
        assert_eq!(store.read(Clone::clone), before);
        assert_eq!(
            ScheduleStore::open(db.clone()).unwrap().read(Clone::clone),
            before
        );
        assert!(
            store
                .mutate(|d| {
                    d.runs[0].run.status = ScheduleRunStatus::Running;
                    d.runs.push(run(&b, 2, ScheduleRunStatus::Running));
                    Ok(())
                })
                .is_err()
        );
        assert_eq!(store.read(Clone::clone), before);
        store
            .mutate(|d| {
                d.runs[0].run.status = ScheduleRunStatus::Running;
                d.runs.push(run(&b, 2, ScheduleRunStatus::Queued));
                d.sequence = 2;
                Ok(())
            })
            .unwrap();
        let after = ScheduleStore::open(db).unwrap().read(Clone::clone);
        assert_eq!(after.revision, 2);
        assert_eq!(after.sequence, 2);
        assert_eq!(after.runs.len(), 2);
    }
    #[test]
    fn run_claim_and_conversation_are_atomic_even_when_a_constraint_fails() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&dir.path().join("db")).unwrap());
        let store = ScheduleStore::open(db.clone()).unwrap();
        let a = task("a");
        store
            .mutate(|d| {
                d.tasks.insert(a.id.clone(), a.clone());
                d.runs.push(run(&a, 1, ScheduleRunStatus::Queued));
                Ok(())
            })
            .unwrap();
        let thread:fv_protocol::types::Thread=serde_json::from_value(serde_json::json!({"id":"conversation","title":"scheduled","createdAt":1,"updatedAt":1,"archived":false,"unread":false})).unwrap();
        assert!(
            store
                .mutate_with_thread(&thread, |d| {
                    d.runs[0].run.status = ScheduleRunStatus::Running;
                    d.runs.push(run(&a, 2, ScheduleRunStatus::Running));
                    Ok(())
                })
                .is_err()
        );
        assert!(db.get_thread("conversation").unwrap().is_none());
        assert_eq!(
            store.read(|d| d.runs[0].run.status),
            ScheduleRunStatus::Queued
        );
        store
            .mutate_with_thread(&thread, |d| {
                d.runs[0].run.status = ScheduleRunStatus::Running;
                d.runs[0].run.thread_id = Some(thread.id.clone());
                Ok(())
            })
            .unwrap();
        assert_eq!(db.get_thread("conversation").unwrap().unwrap(), thread);
        assert_eq!(
            store.read(|d| d.runs[0].run.status),
            ScheduleRunStatus::Running
        );
    }
    #[test]
    fn retention_prunes_only_old_finished_records_and_never_reuses_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&dir.path().join("db")).unwrap());
        let store = ScheduleStore::open(db.clone()).unwrap();
        let a = task("a");
        let b = task("b");
        store
            .mutate(|d| {
                d.tasks.insert(a.id.clone(), a.clone());
                d.tasks.insert(b.id.clone(), b.clone());
                d.runs.push(run(&a, 1, ScheduleRunStatus::Running));
                d.runs.push(run(&b, 2, ScheduleRunStatus::Queued));
                for p in 3..=610 {
                    d.runs.push(run(&a, p, ScheduleRunStatus::Completed));
                }
                d.sequence = 610;
                Ok(())
            })
            .unwrap();
        let reopened = ScheduleStore::open(db).unwrap();
        assert_eq!(reopened.read(|d| d.runs.len()), 502);
        assert_eq!(reopened.read(|d| d.runs[2].position), 111);
        assert_eq!(reopened.read(|d| d.sequence), 610);
        assert_eq!(reopened.read(|d| d.snapshot().queued.len()), 1);
        assert!(reopened.read(|d| d.snapshot().active.is_some()));
    }
}
