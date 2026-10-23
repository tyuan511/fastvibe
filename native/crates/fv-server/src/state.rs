use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use std::sync::Arc;

use fv_agent::AgentContext;
use fv_protocol::types::{Thread, ThreadId};
use fv_protocol::{Message, ServerNotification};
use tokio::sync::mpsc;

use crate::runtime::ThreadRuntime;

pub type ConnId = u64;

/// Frames queued for one connection before a slow reader starts to cost the server memory.
pub const OUTBOUND_CAPACITY: usize = 256;

/// Everything the server holds, shared by every connection.
///
/// There is deliberately no "current conversation" here: each connection says which thread it
/// means in every call, and subscribes to the ones it wants. The catalog is in memory for now;
/// `fv-store` replaces it.
pub struct ServerState {
    pub data_dir: PathBuf,
    pub agent: AgentContext,
    threads: Mutex<Vec<Thread>>,
    connections: Mutex<HashMap<ConnId, mpsc::Sender<Message>>>,
    runtimes: Mutex<HashMap<ThreadId, Arc<ThreadRuntime>>>,
    next_conn: AtomicU64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ServerState {
    pub fn new(data_dir: PathBuf, agent: AgentContext) -> Self {
        Self {
            data_dir,
            agent,
            threads: Mutex::default(),
            connections: Mutex::default(),
            runtimes: Mutex::default(),
            next_conn: AtomicU64::new(1),
        }
    }

    pub(crate) fn register(&self, tx: mpsc::Sender<Message>) -> ConnId {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        self.connections.lock().unwrap().insert(id, tx);
        id
    }

    pub(crate) fn unregister(&self, id: ConnId) {
        self.connections.lock().unwrap().remove(&id);
        let runtimes: Vec<_> = self.runtimes.lock().unwrap().values().cloned().collect();
        for rt in runtimes {
            rt.unsubscribe(id);
        }
    }

    pub(crate) fn sender(&self, id: ConnId) -> Option<mpsc::Sender<Message>> {
        self.connections.lock().unwrap().get(&id).cloned()
    }

    /// The thread's runtime state, created on first use.
    pub fn runtime(&self, thread_id: &str) -> Arc<ThreadRuntime> {
        self.runtimes
            .lock()
            .unwrap()
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(ThreadRuntime::new(thread_id.to_string())))
            .clone()
    }

    pub fn touch_thread(&self, id: &str) {
        if let Some(t) = self.threads.lock().unwrap().iter_mut().find(|t| t.id == id) {
            t.updated_at = now_ms();
        }
        self.broadcast(ServerNotification::CatalogChanged(
            fv_protocol::types::CatalogChanged {},
        ));
    }

    pub fn threads(&self, include_archived: bool) -> Vec<Thread> {
        let mut all: Vec<Thread> = self
            .threads
            .lock()
            .unwrap()
            .iter()
            .filter(|t| include_archived || !t.archived)
            .cloned()
            .collect();
        all.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
        all
    }

    pub fn thread(&self, id: &str) -> Option<Thread> {
        self.threads
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.id == id)
            .cloned()
    }

    pub fn create_thread(&self, cwd: Option<String>, project: Option<String>) -> Thread {
        let now = now_ms();
        let thread = Thread {
            id: uuid::Uuid::new_v4().to_string(),
            title: String::new(),
            cwd,
            project,
            created_at: now,
            updated_at: now,
            archived: false,
            unread: false,
        };
        self.threads.lock().unwrap().push(thread.clone());
        self.broadcast(ServerNotification::ThreadStarted(thread.clone()));
        self.broadcast(ServerNotification::CatalogChanged(
            fv_protocol::types::CatalogChanged {},
        ));
        thread
    }

    pub fn subscriber_count(&self, thread: &str) -> usize {
        self.runtime(thread).subscriber_count()
    }

    /// Catalog-level notices go to every connection.
    ///
    /// Each frame is queued without waiting on the receiver: a stuck client must not stall the
    /// caller. When a connection's queue is full the frame is handed to a task that waits for room,
    /// so it is delayed rather than lost. That can reorder two notices to one client, which is
    /// fine for catalog notices (they mean "re-read"); per-thread events will need strict order.
    pub fn broadcast(&self, note: ServerNotification) {
        let frame = notification_frame(&note);
        let targets: Vec<_> = self.connections.lock().unwrap().values().cloned().collect();
        for tx in targets {
            if let Err(mpsc::error::TrySendError::Full(frame)) = tx.try_send(frame.clone()) {
                tokio::spawn(async move {
                    let _ = tx.send(frame).await;
                });
            }
        }
    }
}

pub(crate) fn notification_frame(note: &ServerNotification) -> Message {
    let v = serde_json::to_value(note).expect("notifications serialize");
    Message::Notification {
        method: v["method"].as_str().expect("tagged").to_string(),
        params: v.get("params").cloned().unwrap_or(serde_json::Value::Null),
    }
}
