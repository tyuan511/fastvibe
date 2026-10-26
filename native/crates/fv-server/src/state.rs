use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use std::sync::Arc;

use fv_agent::AgentContext;
use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::{Thread, ThreadId};
use fv_protocol::{Message, ServerNotification};
use fv_store::{Store, StoreError};
use tokio::sync::mpsc;

use crate::runtime::ThreadRuntime;

pub type ConnId = u64;

/// A question put to the user whose answer the agent is waiting for.
pub(crate) struct PendingPrompt {
    pub thread_id: ThreadId,
    /// Kept so a client that connects later can be shown it.
    pub request: fv_protocol::ServerRequest,
    pub answer: tokio::sync::oneshot::Sender<Reply>,
}

/// What a client sent back for a request of ours: `None` when it declined or never answered.
pub(crate) enum Reply {
    Answers(Option<fv_core::Answers>),
    Decision(Option<fv_protocol::types::ApprovalDecision>),
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
    pub context: crate::context::ContextLoader,
    pub mcp: Arc<fv_mcp::Manager>,
    pub memory: Arc<crate::memory::Memory>,
    pub(crate) services_started: AtomicBool,
    pub(crate) auto_compaction: Arc<AtomicBool>,
    pub store: Store,
    /// The side pane's shells. One per terminal, with its own pty and parsed screen.
    pub(crate) terminals: crate::terminal::Terminals,
    /// models.dev, as this install knows it: a model's window, output ceiling, modalities and
    /// prices. Read once at startup — refreshing it needs a restart, as in the Electron app.
    pub catalog: fv_provider::Catalog,
    connections: Mutex<HashMap<ConnId, mpsc::Sender<Message>>>,
    runtimes: Mutex<HashMap<ThreadId, Arc<ThreadRuntime>>>,
    prompts: Mutex<HashMap<fv_protocol::RequestId, PendingPrompt>>,
    pub(crate) settings_lock: Mutex<()>,
    pub(crate) workspace_entries_lock: Mutex<()>,
    /// Each conversation's workspace as it was before its current turn ran (see `turn::rewind`).
    pub(crate) checkpoints: Mutex<HashMap<ThreadId, fv_store::Checkpoint>>,
    /// A model set aside for 回复推荐, for tests that pin the conversation's own script. Production
    /// never sets it: the guess runs on the conversation's model, deliberately.
    suggestion_model: Mutex<Option<std::sync::Arc<dyn fv_agent::Model>>>,
    next_conn: AtomicU64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ServerState {
    /// Start process-wide services once. The watcher owns only a weak state reference.
    pub fn start_services(self: &Arc<Self>) {
        if self.services_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut changes = self.mcp.subscribe();
        self.mcp.start();
        self.memory.start_timer(self);
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                let Some(state) = weak.upgrade() else {
                    break;
                };
                state.broadcast(ServerNotification::McpChanged(fv_protocol::types::Empty {}));
            }
        });
    }

    pub fn new(data_dir: PathBuf, agent: AgentContext) -> Result<Self, StoreError> {
        let store = Store::open(&data_dir)?;
        let catalog = fv_provider::load_catalog(&data_dir);
        let auto_compaction = Arc::new(AtomicBool::new(
            crate::settings::read_db(&store.db)?.auto_compaction_enabled,
        ));
        Ok(Self {
            auto_compaction,
            memory: crate::memory::Memory::open(&data_dir, &store.db)?,
            mcp: fv_mcp::Manager::open(&data_dir)?,
            services_started: AtomicBool::new(false),
            context: crate::context::ContextLoader::new(&data_dir),
            data_dir,
            agent,
            store,
            catalog,
            terminals: crate::terminal::Terminals::default(),
            connections: Mutex::default(),
            runtimes: Mutex::default(),
            prompts: Mutex::default(),
            settings_lock: Mutex::new(()),
            workspace_entries_lock: Mutex::new(()),
            checkpoints: Mutex::default(),
            suggestion_model: Mutex::default(),
            next_conn: AtomicU64::new(1),
        })
    }

    /// Give 回复推荐 a model of its own. Only a test does this.
    pub fn set_suggestion_model(&self, model: std::sync::Arc<dyn fv_agent::Model>) {
        *self.suggestion_model.lock().unwrap() = Some(model);
    }

    /// The model a suggestion request uses: the one set aside for it, else the thread's own.
    pub fn suggestion_model(&self, thread: &Thread) -> std::sync::Arc<dyn fv_agent::Model> {
        if let Some(model) = self.suggestion_model.lock().unwrap().clone() {
            return model;
        }
        crate::providers::model_for(self, thread)
    }

    pub(crate) fn register(&self, tx: mpsc::Sender<Message>) -> ConnId {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        self.connections.lock().unwrap().insert(id, tx);
        id
    }

    pub(crate) fn unregister(&self, id: ConnId) {
        self.mcp.auth_disconnected(id);
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
        let (history, turns) = match self.store.transcripts.read(thread_id) {
            Ok(loaded) => {
                if loaded.skipped > 0 {
                    eprintln!(
                        "transcript of {thread_id}: skipped {} unreadable line(s)",
                        loaded.skipped
                    );
                }
                let turns = loaded.turns();
                (loaded.messages, turns)
            }
            Err(e) => {
                eprintln!("cannot read the transcript of {thread_id}: {e}");
                (Vec::new(), Vec::new())
            }
        };
        // The thread is drawn in full; the model is sent only what follows the last summary.
        // Give restoration the full transcript, so usage before compaction still counts.
        let rt = Arc::new(ThreadRuntime::restored(
            thread_id.to_string(),
            history.clone(),
            turns,
        ));
        // The bill is re-derived from that transcript at today's prices, so an edited provider
        // or a corrected catalog applies to history a client has not looked at yet.
        rt.reprice(&self.catalog, &history);
        // Prompts queued when the last process stopped come back with the thread.
        crate::queue::restore(self, &rt, thread_id);
        runtimes.insert(thread_id.to_string(), rt.clone());
        rt
    }

    /// Write a message to the thread's transcript. A failure is reported, not fatal: the turn
    /// carries on, and the message is still in memory for the next request.
    pub fn persist(&self, thread_id: &str, message: &fv_core::Message) {
        // Pictures go to files; the transcript line keeps their paths.
        let message = match self.store.images.externalize(thread_id, message) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("cannot store a picture of {thread_id}: {e}");
                return;
            }
        };
        if let Err(e) = self
            .store
            .transcripts
            .append(thread_id, std::slice::from_ref(&message))
        {
            eprintln!("cannot write the transcript of {thread_id}: {e}");
        }
        if matches!(message, fv_core::Message::Assistant(_)) {
            self.broadcast(ServerNotification::UsageChanged(
                fv_protocol::types::Empty {},
            ));
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

    /// Rename, archive or pin a thread. None of these is activity, so `updated_at` stays.
    pub fn update_thread(
        &self,
        patch: fv_protocol::types::ThreadUpdateParams,
    ) -> Result<Thread, ErrorObject> {
        let mut thread = self
            .thread(&patch.thread_id)?
            .ok_or_else(|| ErrorObject::new(code::INVALID_PARAMS, "no such thread"))?;
        if let Some(title) = patch.title {
            thread.title = title.trim().to_string();
        }
        if let Some(archived) = patch.archived {
            thread.archived = archived;
        }
        if let Some(pinned) = patch.pinned {
            thread.pinned = pinned;
        }
        self.store.db.put_thread(&thread).map_err(internal)?;
        self.broadcast(ServerNotification::CatalogChanged(
            fv_protocol::types::CatalogChanged {},
        ));
        Ok(thread)
    }

    /// Fork completed history, including independent picture files, before publishing it.
    pub fn fork_thread(&self, id: &str) -> Result<Thread, ErrorObject> {
        let original = self
            .thread(id)?
            .ok_or_else(|| ErrorObject::new(code::INVALID_PARAMS, "no such thread"))?;
        if self.loaded_runtime(id).is_some_and(|rt| rt.is_running()) {
            return Err(ErrorObject::new(
                code::INVALID_PARAMS,
                "Wait for the running turn to finish before forking",
            ));
        }
        let loaded = self.store.transcripts.read(id).map_err(internal)?;
        if loaded.skipped > 0 {
            return Err(ErrorObject::new(
                code::INTERNAL_ERROR,
                "Cannot fork a damaged transcript",
            ));
        }
        let now = now_ms();
        let thread = Thread {
            id: uuid::Uuid::new_v4().to_string(),
            title: format!("{}（分支）", original.title),
            created_at: now,
            updated_at: now,
            archived: false,
            pinned: false,
            unread: false,
            worktree: None,
            ..original
        };
        let result = (|| {
            let messages = loaded
                .messages
                .iter()
                .map(|m| self.store.images.copy_message(&thread.id, m))
                .collect::<Result<Vec<_>, _>>()?;
            self.store
                .transcripts
                .copy_loaded(&thread.id, &loaded, &messages)?;
            self.store.db.put_thread(&thread)
        })();
        if let Err(e) = result {
            let _ = self.store.transcripts.delete(&thread.id);
            let _ = self.store.images.delete(&thread.id);
            return Err(internal(e));
        }
        self.broadcast(ServerNotification::ThreadStarted(thread.clone()));
        self.broadcast(ServerNotification::CatalogChanged(
            fv_protocol::types::CatalogChanged {},
        ));
        Ok(thread)
    }

    /// Remove a thread for good: a run in progress is stopped, then its record, transcript and
    /// pictures go. A thread that is already gone is not an error.
    pub fn delete_thread(&self, id: &str) -> Result<(), ErrorObject> {
        if let Some(rt) = self.runtimes.lock().unwrap().remove(id) {
            rt.exec_sessions.close();
            rt.interrupt();
        }
        self.store.transcripts.delete(id).map_err(internal)?;
        self.store.images.delete(id).map_err(internal)?;
        self.store.db.delete_thread(id).map_err(internal)?;
        self.broadcast(ServerNotification::CatalogChanged(
            fv_protocol::types::CatalogChanged {},
        ));
        Ok(())
    }

    /// A restart may replace the server only when no conversation has work in flight,
    /// including commands that yielded and outlived their launching turn, and pane PTYs.
    pub fn has_running_turns(&self) -> bool {
        self.terminals.has_running()
            || self
                .runtimes
                .lock()
                .unwrap()
                .values()
                .any(|runtime| runtime.is_running() || runtime.exec_sessions.has_running())
    }

    pub fn close_command_sessions(&self) {
        for runtime in self.runtimes.lock().unwrap().values() {
            runtime.exec_sessions.close();
        }
    }

    /// Look up an already open runtime without reading a transcript or retaining a new one.
    pub(crate) fn loaded_runtime(&self, id: &str) -> Option<Arc<ThreadRuntime>> {
        self.runtimes.lock().unwrap().get(id).cloned()
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
        model: Option<String>,
        thinking: Option<fv_protocol::types::ThinkingLevel>,
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
            model,
            thinking,
            pinned: false,
            worktree: None,
        };
        self.store.db.put_thread(&thread).map_err(internal)?;
        if let Some(project) = &thread.project {
            crate::projects::note_used(self, project);
        }
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
    ) -> tokio::sync::oneshot::Receiver<Reply> {
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
