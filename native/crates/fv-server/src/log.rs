//! A thread's record of what has happened in it: the turns and their items as a client would
//! draw them, and the sequence number of the last event. This is what `thread/resume` returns,
//! so a client that connects mid-reply sees the reply so far and then only newer events.

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
    /// How full the context window is after a request.
    TokenUsage {
        used: u64,
        window: u64,
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
    pub turns: Vec<Turn>,
    pub seq: u64,
    pub running: bool,
}

pub fn item_id(item: &Item) -> &str {
    match item {
        Item::UserMessage { id, .. }
        | Item::AgentMessage { id, .. }
        | Item::Reasoning { id, .. }
        | Item::ToolCall { id, .. }
        | Item::Error { id, .. }
        | Item::ContextCompaction { id } => id,
    }
}

impl ThreadLog {
    pub fn new(thread_id: ThreadId) -> Self {
        Self {
            thread_id,
            turns: Vec::new(),
            seq: 0,
            running: false,
        }
    }

    pub fn with_turns(thread_id: ThreadId, turns: Vec<Turn>) -> Self {
        Self {
            thread_id,
            turns,
            seq: 0,
            running: false,
        }
    }

    fn turn_mut(&mut self, turn_id: &str) -> Option<&mut Turn> {
        self.turns.iter_mut().find(|t| t.id == turn_id)
    }

    /// Record the event, give it the next sequence number, and return the notification to send.
    /// Applying and numbering happen together, so a snapshot taken between two events is
    /// always consistent with the number it reports.
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
            LogEvent::TurnStarted { turn_id } => {
                let at = Some(now_ms());
                let mut turn = Turn::new(turn_id.clone(), Vec::new());
                turn.started_at = at;
                self.turns.push(turn);
                ServerNotification::TurnStarted(ev!(TurnRef { turn_id, at }))
            }
            LogEvent::ItemStarted { turn_id, item } => {
                if let Some(t) = self.turn_mut(&turn_id) {
                    t.items.push(item.clone());
                }
                ServerNotification::ItemStarted(ev!(ItemRef {
                    turn_id,
                    item,
                    at: Some(now_ms()),
                }))
            }
            LogEvent::ItemCompleted { turn_id, item } => {
                let at = Some(now_ms());
                if let Some(t) = self.turn_mut(&turn_id) {
                    if matches!(item, Item::ToolCall { .. }) {
                        t.process_ended_at = at;
                    }
                    match t.items.iter_mut().find(|i| item_id(i) == item_id(&item)) {
                        Some(slot) => *slot = item.clone(),
                        None => t.items.push(item.clone()),
                    }
                }
                ServerNotification::ItemCompleted(ev!(ItemRef { turn_id, item, at }))
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
                ServerNotification::ThreadTokenUsageUpdated(ev!(TokenUsage { used, window }))
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
