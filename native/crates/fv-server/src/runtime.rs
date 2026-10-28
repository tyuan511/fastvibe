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
    price_history: Vec<Message>,
    usage_model: Option<(String, u64)>,
    subscribers: HashSet<ConnId>,
    running: Option<(TurnId, CancellationToken)>,
    completion: Option<(fv_protocol::types::TurnStatus, Option<String>)>,
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
    /// A receipt for transcript writes. Fork tools wait for their invoking message.
    pub(crate) commits: tokio::sync::watch::Sender<u64>,
    thread_id: String,
    retired: std::sync::atomic::AtomicBool,
    pub(crate) budget: Arc<fv_agent::ContextBudget>,
    pub(crate) exec_sessions: Arc<fv_tools::ExecSessions>,
    pub(crate) code_mode: Arc<fv_tools::CodeMode>,
    /// The next turn is a review: read-only, once.
    review_pending: std::sync::atomic::AtomicBool,
    inner: Mutex<Inner>,
    delivery: tokio::sync::Mutex<()>,
}

impl ThreadRuntime {
    pub fn new(thread_id: ThreadId) -> Self {
        Self {
            thread_id: thread_id.clone(),
            commits: tokio::sync::watch::channel(0).0,
            retired: std::sync::atomic::AtomicBool::new(false),
            delivery: tokio::sync::Mutex::new(()),
            budget: Default::default(),
            exec_sessions: Arc::new(fv_tools::ExecSessions::default()),
            code_mode: Arc::new(fv_tools::CodeMode::default()),
            review_pending: std::sync::atomic::AtomicBool::new(false),
            inner: Mutex::new(Inner {
                log: ThreadLog::new(thread_id),
                history: Vec::new(),
                price_history: Vec::new(),
                usage_model: None,
                subscribers: HashSet::new(),
                running: None,
                completion: None,
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
        let mut log = ThreadLog::with_turns(thread_id.clone(), turns);
        log.stats = fv_store::stats_from_history(&history);
        log.stats_after_compaction = matches!(history.last(), Some(Message::Compaction { .. }));
        Self {
            thread_id,
            commits: tokio::sync::watch::channel(0).0,
            retired: std::sync::atomic::AtomicBool::new(false),
            delivery: tokio::sync::Mutex::new(()),
            budget: Default::default(),
            exec_sessions: Arc::new(fv_tools::ExecSessions::default()),
            code_mode: Arc::new(fv_tools::CodeMode::default()),
            review_pending: std::sync::atomic::AtomicBool::new(false),
            inner: Mutex::new(Inner {
                log,
                history: fv_core::effective_history(&history),
                price_history: price_history(&history),
                usage_model: None,
                subscribers: HashSet::new(),
                running: None,
                completion: None,
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

    pub fn completion(&self) -> Option<(fv_protocol::types::TurnStatus, Option<String>)> {
        self.inner.lock().unwrap().completion.clone()
    }

    pub fn set_review_pending(&self) {
        self.review_pending
            .store(true, std::sync::atomic::Ordering::Release);
    }

    /// Whether the turn being built is a review; asking uses it up.
    pub fn take_review(&self) -> bool {
        self.review_pending
            .swap(false, std::sync::atomic::Ordering::AcqRel)
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
        let mut g = self.inner.lock().unwrap();
        g.price_history = price_history(history);
        g.log.reprice(catalog, history)
    }

    /// Publish the changed bill without racing a turn's numbered events. A partial assistant
    /// is not billed until its normal finalized-message path commits it.
    pub async fn refresh_prices(&self, state: &ServerState) {
        let _delivery = self.delivery.lock().await;
        let staged = {
            let mut g = self.inner.lock().unwrap();
            let history = g.price_history.clone();
            if g.log.reprice(&state.catalog.snapshot(), &history).is_none() {
                return;
            }
            self.stage(&mut g, state, LogEvent::StatsSnapshot)
        };
        deliver(self, staged).await;
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

    pub fn retire(&self) {
        self.retired
            .store(true, std::sync::atomic::Ordering::Release);
        self.interrupt();
        self.exec_sessions.close();
        self.code_mode.cancel_all();
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
        self.begin_linked(state, turn_id, CancellationToken::new())
            .await
    }

    pub async fn begin_linked(
        &self,
        state: &ServerState,
        turn_id: &str,
        token: CancellationToken,
    ) -> Option<CancellationToken> {
        if self.is_running() || !crate::subagents::can_begin(state, &self.thread_id) {
            return None;
        }
        let _delivery = self.delivery.lock().await;
        let staged = {
            let _agents = state.subagents_lock.lock().unwrap();
            if self.retired.load(std::sync::atomic::Ordering::Acquire)
                || !crate::subagents::can_begin(state, &self.thread_id)
                || !state.schedules.can_begin(&self.thread_id, turn_id)
            {
                return None;
            }
            let staged = {
                let mut g = self.inner.lock().unwrap();
                if g.running.is_some() {
                    return None;
                }
                g.completion = None;
                g.running = Some((turn_id.to_string(), token.clone()));
                self.stage(&mut g, state, LogEvent::Running(true))
            };
            crate::subagents::started(state, &self.thread_id);
            staged
        };
        deliver(self, staged).await;
        Some(token)
    }

    /// Hand the thread straight from one turn to the next: the next prompt runs in the same
    /// running span, so no client sees the thread go idle between two prompts that were queued
    /// back to back. `None` when the turn being replaced is no longer the one running.
    pub fn chain(
        &self,
        state: &ServerState,
        previous_turn: &str,
        next_turn: &str,
    ) -> Option<CancellationToken> {
        let _agents = state.subagents_lock.lock().unwrap();
        if self.retired.load(std::sync::atomic::Ordering::Acquire)
            || !crate::subagents::can_begin(state, &self.thread_id)
        {
            return None;
        }
        let token = CancellationToken::new();
        let mut g = self.inner.lock().unwrap();
        match &g.running {
            Some((current, _)) if current == previous_turn => {
                if !state
                    .schedules
                    .chain(&self.thread_id, previous_turn, next_turn)
                {
                    return None;
                }
                g.completion = None;
                g.running = Some((next_turn.to_string(), token.clone()));
                Some(token)
            }
            _ => None,
        }
    }

    /// The turn has fully settled; the thread is free again.
    pub async fn end(&self, state: &ServerState) {
        let _delivery = self.delivery.lock().await;
        let staged = {
            let mut g = self.inner.lock().unwrap();
            g.running = None;
            self.stage(&mut g, state, LogEvent::Running(false))
        };
        deliver(self, staged).await;
    }

    pub async fn publish(&self, state: &ServerState, event: LogEvent) {
        let _delivery = self.delivery.lock().await;
        let staged = {
            let mut g = self.inner.lock().unwrap();
            self.stage(&mut g, state, event)
        };
        deliver(self, staged).await;
    }

    /// Send a message that is not a thread event (no sequence number) to everyone watching.
    pub async fn send_frame(&self, state: &ServerState, frame: fv_protocol::Message) {
        let _delivery = self.delivery.lock().await;
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
        if let LogEvent::TurnCompleted { status, error, .. } = &event {
            g.completion = Some((*status, error.clone()));
        }
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

/// Repricing needs only the original model and token buckets. Do not retain another copy of
/// every message, attachment or tool argument for an hourly metadata change.
fn price_history(history: &[Message]) -> Vec<Message> {
    history
        .iter()
        .filter_map(|m| match m {
            Message::Assistant(a) => Some(Message::Assistant(fv_core::AssistantMessage {
                duration_ms: None,
                content: Vec::new(),
                stop: a.stop.clone(),
                usage: a.usage.clone(),
                model: a.model.clone(),
            })),
            Message::Compaction { usage, model, .. } => Some(Message::Compaction {
                usage: usage.clone(),
                model: model.clone(),
                summary: String::new(),
                user_messages: Vec::new(),
                stats: None,
            }),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    #[tokio::test]
    async fn metadata_price_updates_and_turn_events_keep_one_delivery_order() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = |price| {
            serde_json::json!({"v":5,"m":[["m","M",128000,8000,1,null,[price,10,0,0]]],"x":{"m":0}})
                .to_string()
        };
        std::fs::write(dir.path().join("models-dev.json"), snapshot(2)).unwrap();
        let old = fv_provider::load_catalog(dir.path());
        std::fs::write(dir.path().join("models-dev.json"), snapshot(4)).unwrap();
        let state = Arc::new(
            ServerState::new(
                dir.path().into(),
                crate::agent_with_builtin_tools(Arc::new(
                    fv_agent::testing::ScriptedModel::new([]),
                )),
            )
            .unwrap(),
        );
        let thread = state.create_thread(None, None, None, None).unwrap();
        let rt = state.runtime(&thread.id);
        let history = vec![Message::Assistant(fv_core::AssistantMessage {
            duration_ms: None,
            content: Vec::new(),
            stop: fv_core::StopReason::Stop,
            model: Some("m".into()),
            usage: fv_core::Usage {
                input_tokens: 1_000_000,
                ..Default::default()
            },
        })];
        rt.reprice(&old, &history);
        let (tx, mut rx) = mpsc::channel(1);
        let conn = state.register(tx.clone());
        rt.subscribe(conn);
        tx.send(fv_protocol::Message::Notification {
            method: "full".into(),
            params: serde_json::json!({}),
        })
        .await
        .unwrap();
        let delta = || LogEvent::TextDelta {
            turn_id: "t".into(),
            item_id: "a".into(),
            delta: "x".into(),
        };
        let first = {
            let state = state.clone();
            let rt = rt.clone();
            tokio::spawn(async move { rt.publish(&state, delta()).await })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while rt.inner.lock().unwrap().log.seq < 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let refresh = {
            let state = state.clone();
            let rt = rt.clone();
            tokio::spawn(async move { rt.refresh_prices(&state).await })
        };
        let other = {
            let state = state.clone();
            let rt = rt.clone();
            tokio::spawn(async move { rt.publish(&state, delta()).await })
        };
        rx.recv().await.unwrap(); // release the deliberately full subscriber
        let mut seqs = Vec::new();
        let mut price = None;
        for _ in 0..3 {
            let frame = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap();
            if let fv_protocol::Message::Notification { method, params } = frame {
                seqs.push(params["seq"].as_u64().unwrap());
                if method == "thread/stats/updated" {
                    price = params["cost"].as_f64();
                }
            } else {
                panic!("expected a notification");
            }
        }
        first.await.unwrap();
        refresh.await.unwrap();
        other.await.unwrap();
        assert_eq!(
            seqs,
            vec![1, 2, 3],
            "concurrent publishers deliver in stamp order"
        );
        assert_eq!(price, Some(4.0));
        assert_eq!(rt.inner.lock().unwrap().log.stats.cost, Some(4.0));
    }
}
