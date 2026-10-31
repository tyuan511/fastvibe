//! A conversation as a client holds it: the turns and items the server described, kept up to
//! date from its notifications.
//!
//! The server numbers every event of a thread. A snapshot (`thread/resume`) carries the number
//! it was taken at, so events at or below it are already in it and are skipped, and a number
//! that jumps ahead means events were missed (a slow client is cut loose by the server) and
//! the thread has to be read again.

use std::collections::HashMap;

use fv_protocol::ServerNotification;
use fv_protocol::types::*;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq)]
pub struct ThreadView {
    pub thread: Thread,
    pub turns: Vec<Turn>,
    /// The last event applied.
    pub seq: u64,
    pub running: bool,
    pub token_usage: Option<TokenUsage>,
    pub stats: SessionStats,
    /// The model's checklist, as of its last `update_plan`.
    pub plan: Option<PlanUpdated>,
    /// Prompts queued behind the reply in flight, in the order they will be sent.
    pub queue: QueueState,
    pub goal: Option<fv_protocol::types::Goal>,
    /// The latest message the agent pushed without waiting for an answer.
    pub notice: Option<String>,
    pub mode: fv_protocol::types::ThreadMode,
    /// The run in flight, as the client last heard of it: what a steer has to name.
    pub active_turn: Option<TurnId>,
    /// 回复推荐: the guess at the user's next message, offered as the composer's placeholder.
    pub suggestion: Option<String>,
    /// Questions waiting for the user, by request id.
    pub questions: Vec<(fv_protocol::RequestId, UserInputRequest)>,
    /// Commands and patches waiting for the user's say-so, by request id.
    pub approvals: Vec<(fv_protocol::RequestId, ApprovalRequestParams)>,
    /// Thinking item id -> measured duration in seconds.
    pub reasoning_durations: HashMap<String, u64>,
    /// Thinking item id -> start timestamp (ms) while running.
    pub reasoning_starts: HashMap<String, i64>,
    /// A prompt drawn before the server's first turn event arrives.
    pub optimistic_turn: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// The view changed; it should be redrawn.
    Changed,
    /// Nothing to do (not this thread's, or already in the snapshot).
    Ignored,
    /// Events were missed; read the thread again.
    Gap,
}

impl ThreadView {
    pub fn from_snapshot(snapshot: ThreadResumeResponse) -> Self {
        let turns = snapshot.turns;
        let reasoning_durations = turns
            .iter()
            .flat_map(|turn| turn.reasoning_durations.iter())
            .map(|(id, duration_ms)| (id.clone(), duration_ms.div_ceil(1000).max(1)))
            .collect();
        Self {
            thread: snapshot.thread,
            turns,
            seq: snapshot.seq,
            running: snapshot.running,
            token_usage: snapshot.token_usage,
            stats: snapshot.stats,
            plan: None,
            queue: snapshot.queue,
            goal: snapshot.goal,
            notice: None,
            mode: snapshot.mode,
            active_turn: None,
            suggestion: snapshot.suggestion,
            questions: Vec::new(),
            approvals: Vec::new(),
            reasoning_durations,
            reasoning_starts: HashMap::new(),
            optimistic_turn: None,
        }
    }

    pub fn id(&self) -> &str {
        &self.thread.id
    }

    /// Apply a notification, if it is one of this thread's events.
    pub fn apply(&mut self, note: &ServerNotification) -> Applied {
        use ServerNotification as N;
        let (thread_id, seq) = match note {
            N::TurnStarted(e) => (&e.thread_id, e.seq),
            N::TurnCompleted(e) => (&e.thread_id, e.seq),
            N::ThreadStatusChanged(e) => (&e.thread_id, e.seq),
            N::ItemStarted(e) | N::ItemCompleted(e) => (&e.thread_id, e.seq),
            N::AgentMessageDelta(e) | N::ReasoningDelta(e) | N::ToolCallArgumentsDelta(e) => {
                (&e.thread_id, e.seq)
            }
            N::TurnPlanUpdated(e) => (&e.thread_id, e.seq),
            N::ThreadTokenUsageUpdated(e) => (&e.thread_id, e.seq),
            N::ThreadStatsUpdated(e) => (&e.thread_id, e.seq),
            N::ThreadQueueChanged(e) => (&e.thread_id, e.seq),
            N::ThreadGoalChanged(e) => (&e.thread_id, e.seq),
            N::ThreadNotice(e) => (&e.thread_id, e.seq),
            N::TurnRewound(e) => (&e.thread_id, e.seq),
            N::ThreadSuggestionChanged(e) => (&e.thread_id, e.seq),
            N::ServerRequestResolved(e) => (&e.thread_id, e.seq),
            // Catalog-level notices belong to the list of threads, not to one of them.
            N::ThreadStarted(_)
            | N::CatalogChanged(_)
            | N::ProvidersChanged(_)
            | N::SkillsChanged(_)
            | N::McpChanged(_)
            | N::ComputerChanged(_)
            | N::ComputerInstallProgress(_)
            | N::SubagentsChanged(_)
            | N::SchedulesChanged(_)
            | N::SubagentRolesChanged(_)
            | N::MemoryChanged(_)
            | N::WorkspaceEntryChanged(_)
            | N::ModelCatalogChanged(_)
            | N::UsageChanged(_)
            | N::SettingsChanged(_) => {
                return Applied::Ignored;
            }
        };
        if thread_id != &self.thread.id || seq <= self.seq {
            return Applied::Ignored;
        }
        if seq != self.seq + 1 {
            return Applied::Gap;
        }
        self.seq = seq;
        match note {
            N::TurnStarted(e) => {
                let mut turn = Turn::new(e.body.turn_id.clone(), Vec::new());
                turn.started_at = e.body.at;
                if let Some(optimistic_id) = self.optimistic_turn.take()
                    && let Some(existing) = self.turn_mut(&optimistic_id)
                {
                    existing.id = e.body.turn_id.clone();
                    existing.started_at = e.body.at;
                    self.active_turn = Some(e.body.turn_id.clone());
                    return Applied::Changed;
                }
                self.turns.push(turn);
                self.active_turn = Some(e.body.turn_id.clone());
            }
            N::TurnCompleted(e) => {
                if let Some(t) = self.turn_mut(&e.body.turn_id) {
                    t.completed_at = e.body.at;
                }
                // A run that ends is no longer something to steer; a client that tries anyway
                // gets the server's own answer, and its words become the next prompt.
                if self.active_turn.as_deref() == Some(e.body.turn_id.as_str()) {
                    self.active_turn = None;
                }
            }
            N::ThreadStatusChanged(e) => self.running = e.body.running,
            N::ItemStarted(e) => {
                if let Some(t) = self.turn_mut(&e.body.turn_id) {
                    t.items.push(e.body.item.clone());
                }
                if let Item::Reasoning { id, .. } = &e.body.item {
                    let start = e.body.at.unwrap_or_else(now_ms);
                    self.reasoning_starts.insert(id.clone(), start);
                }
            }
            N::ItemCompleted(e) => {
                if let Some(t) = self.turn_mut(&e.body.turn_id) {
                    if matches!(
                        e.body.item,
                        Item::ToolCall {
                            output: Some(_),
                            ..
                        }
                    ) && e.body.at.is_some()
                    {
                        t.process_ended_at = e.body.at;
                    }
                    match t
                        .items
                        .iter_mut()
                        .find(|i| item_id(i) == item_id(&e.body.item))
                    {
                        Some(slot) => *slot = e.body.item.clone(),
                        None if matches!(e.body.item, Item::UserMessage { .. }) => {
                            // The composer may have drawn this user row before the server sent
                            // its authoritative item id. Replace that projection in place.
                            if let Some(slot) = t
                                .items
                                .iter_mut()
                                .find(|i| matches!(i, Item::UserMessage { .. }))
                            {
                                *slot = e.body.item.clone();
                            } else {
                                t.items.push(e.body.item.clone());
                            }
                        }
                        None => t.items.push(e.body.item.clone()),
                    }
                }
                if let Item::Reasoning { id, .. } = &e.body.item {
                    let end = e.body.at.unwrap_or_else(now_ms);
                    let start = self.reasoning_starts.remove(id);
                    let duration_ms = e
                        .body
                        .duration_ms
                        .or_else(|| start.map(|start| (end - start).max(0) as u64));
                    if let Some(duration_ms) = duration_ms {
                        let secs = duration_ms.div_ceil(1000).max(1);
                        self.reasoning_durations.insert(id.clone(), secs);
                        if let Some(t) = self.turn_mut(&e.body.turn_id) {
                            t.reasoning_durations.insert(id.clone(), duration_ms);
                        }
                    }
                }
            }
            N::AgentMessageDelta(e) | N::ReasoningDelta(e) => {
                self.append_text(&e.body);
                if matches!(note, N::ReasoningDelta(_)) {
                    self.reasoning_starts
                        .entry(e.body.item_id.clone())
                        .or_insert_with(now_ms);
                }
            }
            // A tool call's arguments are drawn once complete.
            N::ToolCallArgumentsDelta(_) => {}
            N::TurnPlanUpdated(e) => self.plan = Some(e.body.clone()),
            N::ThreadTokenUsageUpdated(e) => self.token_usage = Some(e.body),
            N::ThreadStatsUpdated(e) => self.stats = e.body.clone(),
            N::ThreadQueueChanged(e) => self.queue = e.body.clone(),
            N::ThreadGoalChanged(e) => self.goal = e.body.goal.clone(),
            N::ThreadNotice(e) => self.notice = Some(e.body.text.clone()),
            // Withdrawal is `None`, and it is the event that says so: a state reply that raced it
            // must not put a stale guess back.
            N::ThreadSuggestionChanged(e) => self.suggestion = e.body.text.clone(),
            N::TurnRewound(e) => {
                if let Some(index) = self.turns.iter().position(|t| t.id == e.body.turn_id) {
                    self.turns.truncate(index);
                }
            }
            N::ServerRequestResolved(e) => {
                self.questions.retain(|(id, _)| *id != e.body.request_id);
                self.approvals.retain(|(id, _)| *id != e.body.request_id);
            }
            N::ThreadStarted(_)
            | N::CatalogChanged(_)
            | N::ProvidersChanged(_)
            | N::SkillsChanged(_)
            | N::McpChanged(_)
            | N::ComputerChanged(_)
            | N::ComputerInstallProgress(_)
            | N::SubagentsChanged(_)
            | N::SchedulesChanged(_)
            | N::SubagentRolesChanged(_)
            | N::MemoryChanged(_)
            | N::WorkspaceEntryChanged(_)
            | N::SettingsChanged(_) => {}
            N::UsageChanged(_) | N::ModelCatalogChanged(_) => {}
        }
        Applied::Changed
    }

    /// The run a steer should name. A run that has not started yet (a thread that is running
    /// because a queued prompt is about to begin) has no id, so a steer is simply queueable.
    pub fn running_turn(&self) -> Option<TurnId> {
        self.running
            .then(|| self.active_turn.clone())
            .flatten()
            .filter(|id| self.optimistic_turn.as_deref() != Some(id.as_str()))
    }

    /// Draw a prompt before the server's first turn event arrives.
    pub fn add_optimistic_prompt(&mut self, text: String) -> bool {
        if self.optimistic_turn.is_some() || text.trim().is_empty() {
            return false;
        }
        let id = format!("optimistic:{}", Uuid::new_v4());
        self.turns.push(Turn::new(
            id.clone(),
            vec![Item::UserMessage {
                id: format!("optimistic-message:{}", Uuid::new_v4()),
                text,
            }],
        ));
        self.optimistic_turn = Some(id.clone());
        self.active_turn = Some(id);
        self.running = true;
        true
    }

    /// Remove a prompt whose start request was rejected before the server accepted it.
    pub fn rollback_optimistic_prompt(&mut self) -> bool {
        let Some(id) = self.optimistic_turn.take() else {
            return false;
        };
        self.turns.retain(|turn| turn.id != id);
        if self.active_turn.as_deref() == Some(id.as_str()) {
            self.active_turn = None;
        }
        self.running = false;
        true
    }

    /// Whether this view is waiting for the server to acknowledge its optimistic turn.
    pub fn has_optimistic_prompt(&self) -> bool {
        self.optimistic_turn.is_some()
    }

    pub fn turn(&self, turn_id: &str) -> Option<&Turn> {
        self.turns.iter().find(|t| t.id == turn_id)
    }

    fn turn_mut(&mut self, turn_id: &str) -> Option<&mut Turn> {
        self.turns.iter_mut().find(|t| t.id == turn_id)
    }

    fn append_text(&mut self, delta: &Delta) {
        let Some(turn) = self.turn_mut(&delta.turn_id) else {
            return;
        };
        for item in &mut turn.items {
            match item {
                Item::AgentMessage { id, text } | Item::Reasoning { id, text }
                    if *id == delta.item_id =>
                {
                    text.push_str(&delta.delta);
                }
                _ => {}
            }
        }
    }

    /// A question from the server for this thread (not an event: it has no sequence number).
    pub fn ask(&mut self, id: fv_protocol::RequestId, request: UserInputRequest) {
        if request.thread_id == self.thread.id && !self.questions.iter().any(|(i, _)| *i == id) {
            self.questions.push((id, request));
        }
    }

    /// An approval request from the server for this thread (like a question, not an event).
    pub fn ask_approval(&mut self, id: fv_protocol::RequestId, request: ApprovalRequestParams) {
        if request.thread_id == self.thread.id && !self.approvals.iter().any(|(i, _)| *i == id) {
            self.approvals.push((id, request));
        }
    }

    /// Whether the last turn is still producing something the user is waiting on.
    pub fn is_waiting_on_user(&self) -> bool {
        !self.questions.is_empty() || !self.approvals.is_empty()
    }
}

pub fn item_id(item: &Item) -> &str {
    match item {
        Item::UserMessage { id, .. }
        | Item::AgentMessage { id, .. }
        | Item::Reasoning { id, .. }
        | Item::ToolCall { id, .. }
        | Item::Audio { id, .. }
        | Item::Image { id, .. }
        | Item::Error { id, .. }
        | Item::ContextCompaction { id, .. } => id,
    }
}

/// The items of every turn, flat, in order, each with the turn it belongs to.
pub fn flat_items(turns: &[Turn]) -> impl Iterator<Item = (&str, &Item)> {
    turns
        .iter()
        .flat_map(|t| t.items.iter().map(move |i| (t.id.as_str(), i)))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
