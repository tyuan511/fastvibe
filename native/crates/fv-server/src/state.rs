use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use std::sync::Arc;

use fv_agent::AgentContext;
use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::{Thread, ThreadId};
use fv_protocol::{Message, ServerNotification};
use fv_store::{Store, StoreError, turns_from_history};
use tokio::sync::mpsc;

use crate::runtime::ThreadRuntime;

pub type ConnId = u64;

/// A question put to the user whose answer the agent is waiting for.
pub(crate) struct PendingPrompt {
    pub thread_id: ThreadId,
    /// Kept so a client that connects later can be shown it.
    pub request: fv_protocol::ServerRequest,
    pub answer: tokio::sync::oneshot::Sender<Option<fv_core::Answers>>,
}

/// Frames queued for one connection before a slow reader starts to cost the server memory.
pub const OUTBOUND_CAPACITY: usize = 256;

/// Everything the server holds, shared by every connection.
///
/// There is deliberately no "current conversation" here: each connection says which thread it
/// means in every call, and subscribes to the ones it wants. What must outlive the process (the
/// catalog, the transcripts) is in `store`; the rest is rebuilt from it when a thread is opened.
pub struct ServerState {
    pub data_dir: PathBuf,
    pub agent: AgentContext,
    pub store: Store,
    connections: Mutex<HashMap<ConnId, mpsc::Sender<Message>>>,
    runtimes: Mutex<HashMap<ThreadId, Arc<ThreadRuntime>>>,
    prompts: Mutex<HashMap<fv_protocol::RequestId, PendingPrompt>>,
    next_conn: AtomicU64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ServerState {
    pub fn new(data_dir: PathBuf, agent: AgentContext) -> Result<Self, StoreError> {
        let store = Store::open(&data_dir)?;
        Ok(Self {
            data_dir,
            agent,
            store,
            connections: Mutex::default(),
            runtimes: Mutex::default(),
            prompts: Mutex::default(),
            next_conn: AtomicU64::new(1),
        })
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

    /// The thread's runtime state, created on first use: its history is read back from the
    /// transcript and its turns rebuilt from that, so a thread opened after a restart looks the
    /// way it did before.
    pub fn runtime(&self, thread_id: &str) -> Arc<ThreadRuntime> {
        let mut runtimes = self.runtimes.lock().unwrap();
        if let Some(rt) = runtimes.get(thread_id) {
            return rt.clone();
        }
        let history = match self.store.transcripts.read(thread_id) {
            Ok(loaded) => {
                if loaded.skipped > 0 {
                    eprintln!(
                        "transcript of {thread_id}: skipped {} unreadable line(s)",
                        loaded.skipped
                    );
                }
                loaded.messages
            }
            Err(e) => {
                eprintln!("cannot read the transcript of {thread_id}: {e}");
                Vec::new()
            }
        };
        let turns = turns_from_history(&history);
        let rt = Arc::new(ThreadRuntime::restored(
            thread_id.to_string(),
            history,
            turns,
        ));
        runtimes.insert(thread_id.to_string(), rt.clone());
        rt
    }

    /// Write a message to the thread's transcript. A failure is reported, not fatal: the turn
    /// carries on, and the message is still in memory for the next request.
    pub fn persist(&self, thread_id: &str, message: &fv_core::Message) {
        if let Err(e) = self
            .store
            .transcripts
            .append(thread_id, std::slice::from_ref(message))
        {
            eprintln!("cannot write the transcript of {thread_id}: {e}");
        }
    }

    /// A turn finished in this thread: it moves to the top of the list, and a thread that has
    /// no title yet is named after its first prompt.
    pub fn touch_thread(&self, id: &str, first_prompt: Option<&str>) {
        if let Ok(Some(mut t)) = self.store.db.get_thread(id) {
            t.updated_at = now_ms();
            if t.title.is_empty()
                && let Some(prompt) = first_prompt
            {
                t.title = title_from(prompt);
            }
            if let Err(e) = self.store.db.put_thread(&t) {
                eprintln!("cannot update thread {id}: {e}");
            }
        }
        self.broadcast(ServerNotification::CatalogChanged(
            fv_protocol::types::CatalogChanged {},
        ));
    }

    pub fn threads(&self, include_archived: bool) -> Result<Vec<Thread>, ErrorObject> {
        self.store
            .db
            .list_threads(include_archived)
            .map_err(internal)
    }

    pub fn thread(&self, id: &str) -> Result<Option<Thread>, ErrorObject> {
        self.store.db.get_thread(id).map_err(internal)
    }

    pub fn create_thread(
        &self,
        cwd: Option<String>,
        project: Option<String>,
    ) -> Result<Thread, ErrorObject> {
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
        self.store.db.put_thread(&thread).map_err(internal)?;
        self.broadcast(ServerNotification::ThreadStarted(thread.clone()));
        self.broadcast(ServerNotification::CatalogChanged(
            fv_protocol::types::CatalogChanged {},
        ));
        Ok(thread)
    }

    pub(crate) fn park_prompt(
        &self,
        id: fv_protocol::RequestId,
        thread_id: &str,
        request: fv_protocol::ServerRequest,
    ) -> tokio::sync::oneshot::Receiver<Option<fv_core::Answers>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.prompts.lock().unwrap().insert(
            id,
            PendingPrompt {
                thread_id: thread_id.to_string(),
                request,
                answer: tx,
            },
        );
        rx
    }

    /// Remove a prompt. Whoever gets it owns delivering its answer (or withdrawing it), so an
    /// answer and a cancellation arriving together cannot both act.
    pub(crate) fn take_prompt(&self, id: &fv_protocol::RequestId) -> Option<PendingPrompt> {
        self.prompts.lock().unwrap().remove(id)
    }

    /// The prompts still waiting in a thread.
    pub fn pending_prompts(&self, thread_id: &str) -> Vec<fv_protocol::ServerRequest> {
        self.prompts
            .lock()
            .unwrap()
            .values()
            .filter(|p| p.thread_id == thread_id)
            .map(|p| p.request.clone())
            .collect()
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

fn internal(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}

/// A sidebar title from the first prompt: its first line, shortened.
fn title_from(prompt: &str) -> String {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let mut title: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        title.push('…');
    }
    title
}
