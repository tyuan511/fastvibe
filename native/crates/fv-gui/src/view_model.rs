//! A conversation as a client holds it: the turns and items the server described, kept up to
//! date from its notifications.
//!
//! The server numbers every event of a thread. A snapshot (`thread/resume`) carries the number
//! it was taken at, so events at or below it are already in it and are skipped, and a number
//! that jumps ahead means events were missed (a slow client is cut loose by the server) and
//! the thread has to be read again.

use fv_protocol::ServerNotification;
use fv_protocol::types::*;

#[derive(Clone, Debug, PartialEq)]
pub struct ThreadView {
    pub thread: Thread,
    pub turns: Vec<Turn>,
    /// The last event applied.
    pub seq: u64,
    pub running: bool,
    pub token_usage: Option<TokenUsage>,
    /// The model's checklist, as of its last `update_plan`.
    pub plan: Option<PlanUpdated>,
    /// Questions waiting for the user, by request id.
    pub questions: Vec<(fv_protocol::RequestId, UserInputRequest)>,
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
        Self {
            thread: snapshot.thread,
            turns: snapshot.turns,
            seq: snapshot.seq,
            running: snapshot.running,
            token_usage: snapshot.token_usage,
            plan: None,
            questions: Vec::new(),
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
            N::ServerRequestResolved(e) => (&e.thread_id, e.seq),
            // Catalog-level notices belong to the list of threads, not to one of them.
            N::ThreadStarted(_) | N::CatalogChanged(_) | N::ProvidersChanged(_) => {
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
                self.turns.push(turn);
            }
            N::TurnCompleted(e) => {
                if let Some(t) = self.turn_mut(&e.body.turn_id) {
                    t.completed_at = e.body.at;
                }
            }
            N::ThreadStatusChanged(e) => self.running = e.body.running,
            N::ItemStarted(e) => {
                if let Some(t) = self.turn_mut(&e.body.turn_id) {
                    t.items.push(e.body.item.clone());
                }
            }
            N::ItemCompleted(e) => {
                if let Some(t) = self.turn_mut(&e.body.turn_id) {
                    if matches!(e.body.item, Item::ToolCall { .. }) && e.body.at.is_some() {
                        t.process_ended_at = e.body.at;
                    }
                    match t
                        .items
                        .iter_mut()
                        .find(|i| item_id(i) == item_id(&e.body.item))
                    {
                        Some(slot) => *slot = e.body.item.clone(),
                        None => t.items.push(e.body.item.clone()),
                    }
                }
            }
            N::AgentMessageDelta(e) | N::ReasoningDelta(e) => self.append_text(&e.body),
            // A tool call's arguments are drawn once complete.
            N::ToolCallArgumentsDelta(_) => {}
            N::TurnPlanUpdated(e) => self.plan = Some(e.body.clone()),
            N::ThreadTokenUsageUpdated(e) => self.token_usage = Some(e.body),
            N::ServerRequestResolved(e) => {
                self.questions.retain(|(id, _)| *id != e.body.request_id)
            }
            N::ThreadStarted(_) | N::CatalogChanged(_) | N::ProvidersChanged(_) => {}
        }
        Applied::Changed
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

    /// Whether the last turn is still producing something the user is waiting on.
    pub fn is_waiting_on_user(&self) -> bool {
        !self.questions.is_empty()
    }
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

/// The items of every turn, flat, in order, each with the turn it belongs to.
pub fn flat_items(turns: &[Turn]) -> impl Iterator<Item = (&str, &Item)> {
    turns
        .iter()
        .flat_map(|t| t.items.iter().map(move |i| (t.id.as_str(), i)))
}
