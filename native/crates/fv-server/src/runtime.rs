use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fv_core::Message;
use fv_protocol::types::{SessionStats, ThreadId, Turn, TurnId};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::log::{LogEvent, ThreadLog};
use crate::state::{ConnId, ServerState, notification_frame};

/// Why a steer did not join the run the client named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SteerRefused {
    /// Nothing is running; the words are a plain prompt now.
    NotRunning,
    /// A different run is live. The id it names is what the client should steer instead.
    OtherTurn(TurnId),
}

/// How long one subscriber may hold up delivery of a thread's events before it is dropped
/// from the thread. It sees a gap in `seq` and re-reads the thread with `thread/resume`.
const SLOW_SUBSCRIBER: Duration = Duration::from_secs(5);

struct Inner {
    log: ThreadLog,
    history: Vec<Message>,
    usage_model: Option<(String, u64)>,
    subscribers: HashSet<ConnId>,
    running: Option<(TurnId, CancellationToken)>,
    /// Deferred tools found with `tool_search`; they stay offered for the rest of the thread.
    loaded: fv_agent::LoadedTools,
    /// Commands and patches the user approved "for the rest of this conversation".
    approved: HashSet<String>,
    /// Prompts waiting behind the reply in flight, oldest first.
    queue: Vec<fv_store::QueuedPrompt>,
    /// Whether the queue is stopped until the user says so (a failed turn, a bad restart).
    queue_paused: bool,
    /// A prompt the user asked to send next (「立即」): it goes before the head of the queue.
    preferred: Option<String>,
    /// Words said during the run that is in flight, waiting for its next model request.
    steers: Arc<fv_agent::Steers>,
}

/// Everything about one thread that exists only while the server runs: its subscribers, the
/// turn in flight, the history the next request is built from, and the event log.
///
/// The log, the sequence number and the subscriber set live under one lock, which is what
/// makes `thread/resume` atomic: the snapshot and the subscription cannot straddle an event.
pub struct ThreadRuntime {
    pub(crate) budget: Arc<fv_agent::ContextBudget>,
    pub(crate) exec_sessions: Arc<fv_tools::ExecSessions>,
    inner: Mutex<Inner>,
}

impl ThreadRuntime {
    pub fn new(thread_id: ThreadId) -> Self {
        Self {
            budget: Default::default(),
            exec_sessions: Arc::new(fv_tools::ExecSessions::default()),
            inner: Mutex::new(Inner {
                log: ThreadLog::new(thread_id),
                history: Vec::new(),
                usage_model: None,
                subscribers: HashSet::new(),
                running: None,
                loaded: Default::default(),
                approved: HashSet::new(),
                queue: Vec::new(),
                queue_paused: false,
                preferred: None,
                steers: Arc::new(fv_agent::Steers::new()),
            }),
        }
    }

    /// Whether the user already said yes to this for the rest of the conversation.
    pub fn is_approved(&self, key: &str) -> bool {
        self.inner.lock().unwrap().approved.contains(key)
    }

    pub fn approve_for_session(&self, key: String) {
        self.inner.lock().unwrap().approved.insert(key);
    }

    /// A runtime for a thread that already has a transcript.
    pub fn restored(thread_id: ThreadId, history: Vec<Message>, turns: Vec<Turn>) -> Self {
        let mut log = ThreadLog::with_turns(thread_id, turns);
        log.stats = fv_store::stats_from_history(&history);
        Self {
            budget: Default::default(),
            exec_sessions: Arc::new(fv_tools::ExecSessions::default()),
            inner: Mutex::new(Inner {
                log,
                history: fv_core::effective_history(&history),
                usage_model: None,
                subscribers: HashSet::new(),
                running: None,
                loaded: Default::default(),
                approved: HashSet::new(),
                queue: Vec::new(),
                queue_paused: false,
                preferred: None,
                steers: Arc::new(fv_agent::Steers::new()),
            }),
        }
    }

    pub fn subscribe(&self, conn: ConnId) {
        self.inner.lock().unwrap().subscribers.insert(conn);
    }

    pub fn unsubscribe(&self, conn: ConnId) {
        self.inner.lock().unwrap().subscribers.remove(&conn);
    }

    pub fn subscriber_count(&self) -> usize {
        self.inner.lock().unwrap().subscribers.len()
    }

    /// The thread as it stands, and a subscription to what follows.
    pub fn resume(
        &self,
        conn: ConnId,
        model: &dyn fv_agent::Model,
    ) -> (
        Vec<Turn>,
        u64,
        bool,
        fv_protocol::types::SessionStats,
        Option<fv_protocol::types::TokenUsage>,
    ) {
        let mut g = self.inner.lock().unwrap();
        g.subscribers.insert(conn);
        let key = (model.context_key(), fv_agent::context_window(model));
        let token_usage = if g.usage_model.as_ref() == Some(&key) {
            g.log.token_usage
        } else {
            None
        }
        .or_else(|| {
            let used = fv_agent::context_used(&g.history);
            (used > 0).then(|| fv_protocol::types::TokenUsage {
                used,
                window: self.budget.window(model),
            })
        });
        (
            g.log.turns.clone(),
            g.log.seq,
            g.log.running,
            g.log.stats.clone(),
            token_usage,
        )
    }

    pub(crate) fn sampling_model(&self, model: &dyn fv_agent::Model) {
        let mut g = self.inner.lock().unwrap();
        let key = (model.context_key(), fv_agent::context_window(model));
        if g.usage_model.as_ref() != Some(&key) {
            g.log.token_usage = None;
        }
        g.usage_model = Some(key);
    }

    /// Search what the client can currently draw, including an unfinished reply.
    pub fn search(&self, query: &str) -> Option<String> {
        let g = self.inner.lock().unwrap();
        g.log
            .turns
            .iter()
            .flat_map(|t| &t.items)
            .find_map(|item| match item {
                fv_protocol::types::Item::UserMessage { text, .. } => {
                    fv_store::search_snippet(text, query)
                }
                fv_protocol::types::Item::AgentMessage { text, .. } => {
                    fv_store::search_snippet(&fv_core::strip_memory_citation(text), query)
                }
                fv_protocol::types::Item::ToolCall {
                    output: Some(text), ..
                } => fv_store::search_snippet(text, query),
                _ => None,
            })
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().unwrap().running.is_some()
    }

    pub fn loaded_tools(&self) -> fv_agent::LoadedTools {
        self.inner.lock().unwrap().loaded.clone()
    }

    /// The turns as they are drawn, for a caller that has to map a turn id to its place.
    pub fn turns(&self) -> Vec<Turn> {
        self.inner.lock().unwrap().log.turns.clone()
    }

    pub fn history(&self) -> Vec<Message> {
        self.inner.lock().unwrap().history.clone()
    }

    /// Price the thread against the catalog after a message landed, and hand back the stats a
    /// client should now show. The bill is computed from the transcript's own tokens and the
    /// model recorded on each reply, so it survives a restart without storing a price.
    pub fn reprice(
        &self,
        catalog: &fv_provider::Catalog,
        history: &[Message],
    ) -> Option<SessionStats> {
        self.inner.lock().unwrap().log.reprice(catalog, history)
    }

    pub fn set_history(&self, history: Vec<Message>) {
        self.inner.lock().unwrap().history = history;
    }

    /// The standing suggestion, for a client that opens the thread later.
    pub fn suggestion(&self) -> Option<String> {
        self.inner.lock().unwrap().log.suggestion.clone()
    }

    /// Take the standing suggestion back. Returns whether there was one, so a caller does not
    /// announce a withdrawal nothing was showing.
    pub fn forget_suggestion(&self) -> bool {
        let mut g = self.inner.lock().unwrap();
        g.log.suggestion.take().is_some()
    }

    /// The run in flight, if there is one: what a steer has to name.
    pub fn running_turn(&self) -> Option<TurnId> {
        self.inner
            .lock()
            .unwrap()
            .running
            .as_ref()
            .map(|(id, _)| id.clone())
    }

    /// Hand words to the live run. `None` when nothing is running, so the caller can turn them
    /// into a queued prompt instead of losing them.
    pub fn steer(&self, expected: &str, text: String) -> Result<(), SteerRefused> {
        let g = self.inner.lock().unwrap();
        let Some((id, _)) = &g.running else {
            return Err(SteerRefused::NotRunning);
        };
        if id != expected {
            return Err(SteerRefused::OtherTurn(id.clone()));
        }
        g.steers.push(text);
        Ok(())
    }

    /// The steers of the current run, for the turn it is about to drive.
    pub fn steers(&self) -> Arc<fv_agent::Steers> {
        self.inner.lock().unwrap().steers.clone()
    }

    // ---- the queue behind the reply in flight

    pub fn queue(&self) -> Vec<fv_store::QueuedPrompt> {
        self.inner.lock().unwrap().queue.clone()
    }

    pub fn set_queue(&self, rows: Vec<fv_store::QueuedPrompt>) {
        self.inner.lock().unwrap().queue = rows;
    }

    pub fn push_queue(&self, row: fv_store::QueuedPrompt) {
        self.inner.lock().unwrap().queue.push(row);
    }

    pub fn push_front_queue(&self, row: fv_store::QueuedPrompt) {
        self.inner.lock().unwrap().queue.insert(0, row);
    }

    pub fn take_queue(&self, id: &str) -> Option<fv_store::QueuedPrompt> {
        let mut g = self.inner.lock().unwrap();
        let index = g.queue.iter().position(|item| item.id == id)?;
        Some(g.queue.remove(index))
    }

    pub fn mark_queue_paused(&self) {
        self.inner.lock().unwrap().queue_paused = true;
    }

    /// A prompt the user picked with 「立即」; `None` once it has been sent.
    pub fn set_preferred(&self, id: &str) {
        self.inner.lock().unwrap().preferred = Some(id.to_string());
    }

    pub fn preferred(&self) -> Option<String> {
        self.inner.lock().unwrap().preferred.clone()
    }

    /// Take the preferred prompt if it is still queued, else `None`.
    pub fn take_preferred(&self) -> Option<fv_store::QueuedPrompt> {
        let mut g = self.inner.lock().unwrap();
        let id = g.preferred.take()?;
        let index = g.queue.iter().position(|item| item.id == id)?;
        Some(g.queue.remove(index))
    }

    /// Stop the running turn, if there is one. Returns whether there was.
    pub fn interrupt(&self) -> bool {
        match &self.inner.lock().unwrap().running {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Claim the thread for a turn. `None` when one is already running.
    pub async fn begin(&self, state: &ServerState, turn_id: &str) -> Option<CancellationToken> {
        let token = CancellationToken::new();
        let staged = {
            let mut g = self.inner.lock().unwrap();
            if g.running.is_some() {
                return None;
            }
            g.running = Some((turn_id.to_string(), token.clone()));
            self.stage(&mut g, state, LogEvent::Running(true))
        };
        deliver(self, staged).await;
        Some(token)
    }

    /// Hand the thread straight from one turn to the next: the next prompt runs in the same
    /// running span, so no client sees the thread go idle between two prompts that were queued
    /// back to back. `None` when the turn being replaced is no longer the one running.
    pub fn chain(&self, turn_id: &str) -> Option<CancellationToken> {
        let token = CancellationToken::new();
        let mut g = self.inner.lock().unwrap();
        match &g.running {
            Some((current, _)) if current == turn_id => {
                g.running = Some((turn_id.to_string(), token.clone()));
                Some(token)
            }
            _ => None,
        }
    }

    /// The turn has fully settled; the thread is free again.
    pub async fn end(&self, state: &ServerState) {
        let staged = {
            let mut g = self.inner.lock().unwrap();
            g.running = None;
            self.stage(&mut g, state, LogEvent::Running(false))
        };
        deliver(self, staged).await;
    }

    pub async fn publish(&self, state: &ServerState, event: LogEvent) {
        let staged = {
            let mut g = self.inner.lock().unwrap();
            self.stage(&mut g, state, event)
        };
        deliver(self, staged).await;
    }

    /// Send a message that is not a thread event (no sequence number) to everyone watching.
    pub async fn send_frame(&self, state: &ServerState, frame: fv_protocol::Message) {
        let targets = {
            let g = self.inner.lock().unwrap();
            g.subscribers
                .iter()
                .filter_map(|c| state.sender(*c).map(|tx| (*c, tx)))
                .collect()
        };
        deliver(self, Staged { frame, targets }).await;
    }

    /// Number the event and work out who gets it, all under the lock; sending happens after.
    fn stage(&self, g: &mut Inner, state: &ServerState, event: LogEvent) -> Staged {
        let note = g.log.append(event);
        let targets = g
            .subscribers
            .iter()
            .filter_map(|c| state.sender(*c).map(|tx| (*c, tx)))
            .collect();
        Staged {
            frame: notification_frame(&note),
            targets,
        }
    }

    fn drop_subscriber(&self, conn: ConnId) {
        self.inner.lock().unwrap().subscribers.remove(&conn);
    }
}

struct Staged {
    frame: fv_protocol::Message,
    targets: Vec<(ConnId, mpsc::Sender<fv_protocol::Message>)>,
}

/// Events of one thread reach each subscriber in order: they are sent one after another from
/// the single task driving the turn, never reordered. A subscriber that stays full is cut loose
/// instead of stalling everyone else.
async fn deliver(rt: &ThreadRuntime, staged: Staged) {
    for (conn, tx) in staged.targets {
        let sent = tokio::time::timeout(SLOW_SUBSCRIBER, tx.send(staged.frame.clone())).await;
        if !matches!(sent, Ok(Ok(()))) {
            rt.drop_subscriber(conn);
        }
    }
}
