//! A thread's record of what has happened in it: the turns and their items as a client would
//! draw them, and the sequence number of the last event. This is what `thread/resume` returns,
//! so a client that connects mid-reply sees the reply so far and then only newer events.

use std::collections::HashMap;

use fv_protocol::ServerNotification;
use fv_protocol::types::*;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One thing that happened in a thread, before it is stamped with a sequence number.
#[derive(Clone, Debug)]
pub enum LogEvent {
    TurnStarted {
        turn_id: TurnId,
    },
    ItemStarted {
        turn_id: TurnId,
        item: Item,
    },
    /// Replaces the started item with the same id, or is added if there was none (an error
    /// item, say, never starts).
    ItemCompleted {
        turn_id: TurnId,
        item: Item,
    },
    TextDelta {
        turn_id: TurnId,
        item_id: ItemId,
        delta: String,
    },
    ReasoningDelta {
        turn_id: TurnId,
        item_id: ItemId,
        delta: String,
    },
    ToolArgsDelta {
        turn_id: TurnId,
        item_id: ItemId,
        delta: String,
    },
    TurnCompleted {
        turn_id: TurnId,
        status: TurnStatus,
        error: Option<String>,
    },
    Running(bool),
    StatsMessage(fv_core::Message),
    /// The stats as they now stand, after a recomputation the client should see (the bill).
    StatsSnapshot,
    /// How full the context window is after a request.
    TokenUsage {
        used: u64,
        window: u64,
    },
    /// The prompts waiting behind the reply in flight, whole.
    QueueChanged(QueueState),
    /// The standing guess at the user's next message; `None` withdraws it.
    SuggestionChanged(Option<String>),
    /// A message the agent pushed to the user.
    Notice(String),
    /// The thread's goal as it now stands; `None` means it was cleared.
    GoalChanged(Option<fv_protocol::types::Goal>),
    /// That turn, and everything after it, is gone: it is about to run again. Clients drop the
    /// turns from that id on, which is what makes a retry show one turn rather than two.
    Rewound {
        turn_id: TurnId,
    },
    PlanUpdated {
        turn_id: TurnId,
        explanation: Option<String>,
        plan: Vec<PlanStep>,
    },
    /// A request to the client was answered or withdrawn.
    RequestResolved {
        request_id: fv_protocol::RequestId,
    },
}

pub struct ThreadLog {
    thread_id: ThreadId,
    /// 回复推荐's standing answer, so `thread/resume` can offer it after a reconnect.
    pub suggestion: Option<String>,
    pub turns: Vec<Turn>,
    /// Turn ids are unique for a thread. Keeping their positions makes streamed deltas and
    /// completion updates constant time instead of scanning the whole conversation per event.
    turn_positions: HashMap<TurnId, usize>,
    pub seq: u64,
    pub running: bool,
    pub stats: SessionStats,
    /// Whether the last message folded into `stats` was a summary (see `record_stats`).
    pub stats_after_compaction: bool,
    pub token_usage: Option<TokenUsage>,
    /// Server-clock start times for reasoning blocks that are currently streaming.
    reasoning_starts: HashMap<ItemId, i64>,
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

impl ThreadLog {
    pub fn new(thread_id: ThreadId) -> Self {
        Self {
            thread_id,
            suggestion: None,
            turns: Vec::new(),
            turn_positions: HashMap::new(),
            seq: 0,
            running: false,
            stats: SessionStats::default(),
            stats_after_compaction: false,
            token_usage: None,
            reasoning_starts: HashMap::new(),
        }
    }

    pub fn with_turns(thread_id: ThreadId, turns: Vec<Turn>) -> Self {
        let turn_positions = turns
            .iter()
            .enumerate()
            .map(|(index, turn)| (turn.id.clone(), index))
            .collect();
        Self {
            thread_id,
            suggestion: None,
            turns,
            turn_positions,
            seq: 0,
            running: false,
            stats: SessionStats::default(),
            stats_after_compaction: false,
            token_usage: None,
            reasoning_starts: HashMap::new(),
        }
    }

    fn turn_mut(&mut self, turn_id: &str) -> Option<&mut Turn> {
        let index = self.turn_positions.get(turn_id).copied()?;
        self.turns.get_mut(index)
    }

    pub(crate) fn turn(&self, turn_id: &str) -> Option<Turn> {
        let index = self.turn_positions.get(turn_id).copied()?;
        self.turns.get(index).cloned()
    }

    /// Record the event, give it the next sequence number, and return the notification to send.
    /// Applying and numbering happen together, so a snapshot taken between two events is
    /// always consistent with the number it reports.
    /// Price the thread's usage against the catalog. Called after a message lands and on
    /// restoration, so `stats.cost` is either the real bill or absent — never a guessed zero.
    /// The new stats come back only when the figure actually moved, so a thread on an unlisted
    /// model (or with pricing not yet configured) does not push an identical update every turn.
    pub fn reprice(
        &mut self,
        catalog: &fv_provider::Catalog,
        history: &[fv_core::Message],
    ) -> Option<SessionStats> {
        let cost = fv_provider::history_cost(catalog, history);
        (cost != self.stats.cost).then(|| {
            self.stats.cost = cost;
            self.stats.clone()
        })
    }

    pub fn append(&mut self, event: LogEvent) -> ServerNotification {
        self.seq += 1;
        let (thread_id, seq) = (self.thread_id.clone(), self.seq);
        macro_rules! ev {
            ($body:expr) => {
                ThreadEvent {
                    thread_id,
                    seq,
                    body: $body,
                }
            };
        }
        match event {
            LogEvent::StatsMessage(message) => {
                fv_store::record_stats(&mut self.stats, &message, &mut self.stats_after_compaction);
                ServerNotification::ThreadStatsUpdated(ev!(self.stats.clone()))
            }
            LogEvent::StatsSnapshot => {
                ServerNotification::ThreadStatsUpdated(ev!(self.stats.clone()))
            }
            LogEvent::TurnStarted { turn_id } => {
                let at = Some(now_ms());
                let mut turn = Turn::new(turn_id.clone(), Vec::new());
                turn.started_at = at;
                let index = self.turns.len();
                self.turn_positions.insert(turn_id.clone(), index);
                self.turns.push(turn);
                ServerNotification::TurnStarted(ev!(TurnRef { turn_id, at }))
            }
            LogEvent::ItemStarted { turn_id, item } => {
                let at = now_ms();
                if let Some(t) = self.turn_mut(&turn_id) {
                    t.items.push(item.clone());
                }
                if let Item::Reasoning { id, .. } = &item {
                    self.reasoning_starts.insert(id.clone(), at);
                }
                ServerNotification::ItemStarted(ev!(ItemRef {
                    turn_id,
                    item,
                    at: Some(at),
                    duration_ms: None,
                }))
            }
            LogEvent::ItemCompleted { turn_id, item } => {
                let at = now_ms();
                let duration_ms = match &item {
                    Item::Reasoning { id, .. } => self
                        .reasoning_starts
                        .remove(id)
                        .map(|start| (at - start).max(0) as u64),
                    _ => None,
                };
                if let Some(t) = self.turn_mut(&turn_id) {
                    if matches!(
                        item,
                        Item::ToolCall {
                            output: Some(_),
                            ..
                        }
                    ) {
                        t.process_ended_at = Some(at);
                    }
                    match t.items.iter_mut().find(|i| item_id(i) == item_id(&item)) {
                        Some(slot) => *slot = item.clone(),
                        None => t.items.push(item.clone()),
                    }
                }
                if let Item::Reasoning { id, .. } = &item
                    && let Some(duration_ms) = duration_ms
                    && let Some(t) = self.turn_mut(&turn_id)
                {
                    t.reasoning_durations.insert(id.clone(), duration_ms);
                }
                ServerNotification::ItemCompleted(ev!(ItemRef {
                    turn_id,
                    item,
                    at: Some(at),
                    duration_ms,
                }))
            }
            LogEvent::TextDelta {
                turn_id,
                item_id,
                delta,
            } => {
                self.append_text(&turn_id, &item_id, &delta);
                ServerNotification::AgentMessageDelta(ev!(Delta {
                    turn_id,
                    item_id,
                    delta
                }))
            }
            LogEvent::ReasoningDelta {
                turn_id,
                item_id,
                delta,
            } => {
                self.append_text(&turn_id, &item_id, &delta);
                ServerNotification::ReasoningDelta(ev!(Delta {
                    turn_id,
                    item_id,
                    delta
                }))
            }
            // A tool call's arguments are only meaningful once complete, so the snapshot keeps
            // none of the partial text; the live stream still carries it.
            LogEvent::ToolArgsDelta {
                turn_id,
                item_id,
                delta,
            } => ServerNotification::ToolCallArgumentsDelta(ev!(Delta {
                turn_id,
                item_id,
                delta
            })),
            LogEvent::TurnCompleted {
                turn_id,
                status,
                error,
            } => {
                let at = Some(now_ms());
                self.reasoning_starts.clear();
                if let Some(t) = self.turn_mut(&turn_id) {
                    t.completed_at = at;
                }
                ServerNotification::TurnCompleted(ev!(TurnCompleted {
                    turn_id,
                    status,
                    error,
                    at,
                }))
            }
            LogEvent::TokenUsage { used, window } => {
                self.token_usage = Some(TokenUsage { used, window });
                ServerNotification::ThreadTokenUsageUpdated(ev!(TokenUsage { used, window }))
            }
            LogEvent::QueueChanged(queue) => ServerNotification::ThreadQueueChanged(ev!(queue)),
            LogEvent::Notice(text) => {
                ServerNotification::ThreadNotice(ev!(fv_protocol::types::ThreadNotice { text }))
            }
            LogEvent::GoalChanged(goal) => {
                ServerNotification::ThreadGoalChanged(ev!(fv_protocol::types::GoalChanged { goal }))
            }
            LogEvent::SuggestionChanged(text) => {
                // The runtime's own copy is what a client that connects later reads, so the
                // event and the snapshot can never disagree about what is standing.
                self.suggestion = text.clone();
                ServerNotification::ThreadSuggestionChanged(ev!(fv_protocol::types::Suggestion {
                    text
                }))
            }
            LogEvent::Rewound { turn_id } => {
                self.token_usage = None;
                if let Some(index) = self.turn_positions.get(&turn_id).copied() {
                    self.turns.truncate(index);
                    self.turn_positions.retain(|_, position| *position < index);
                }
                ServerNotification::TurnRewound(ev!(Rewound { turn_id }))
            }
            LogEvent::PlanUpdated {
                turn_id,
                explanation,
                plan,
            } => ServerNotification::TurnPlanUpdated(ev!(PlanUpdated {
                turn_id,
                explanation,
                plan
            })),
            LogEvent::RequestResolved { request_id } => {
                ServerNotification::ServerRequestResolved(ev!(RequestResolved { request_id }))
            }
            LogEvent::Running(running) => {
                self.running = running;
                ServerNotification::ThreadStatusChanged(ev!(ThreadStatus { running }))
            }
        }
    }

    fn append_text(&mut self, turn_id: &str, item_id_: &str, delta: &str) {
        let Some(turn) = self.turn_mut(turn_id) else {
            return;
        };
        for item in &mut turn.items {
            match item {
                Item::AgentMessage { id, text } | Item::Reasoning { id, text }
                    if id == item_id_ =>
                {
                    text.push_str(delta);
                }
                _ => {}
            }
        }
    }
}
