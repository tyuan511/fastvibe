//! Turn boundaries belong to the transcript, independently of what a model can read. A
//! refusal with no assistant message and a failed manual compaction still have a turn.

use fv_protocol::types::{Item, Turn, TurnStatus};
use serde::{Deserialize, Serialize};

use crate::Loaded;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordedError {
    pub id: String,
    pub message: String,
}

#[derive(Clone, Debug)]
pub(crate) struct TurnRecord {
    pub id: String,
    pub tools: Vec<(String, Item)>,
    pub start: usize,
    pub end: usize,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub status: TurnStatus,
    pub error: Option<RecordedError>,
}

impl Loaded {
    /// Original turn ids and terminal errors survive process restarts. Older transcripts
    /// without boundary records keep the position-derived projection they used before.
    pub fn turns(&self) -> Vec<Turn> {
        self.positioned_turns()
            .into_iter()
            .map(|(_, t)| t)
            .collect()
    }

    pub fn turn_start(&self, id: &str) -> Option<usize> {
        self.positioned_turns()
            .into_iter()
            .find_map(|(start, turn)| (turn.id == id).then_some(start))
    }

    fn positioned_turns(&self) -> Vec<(usize, Turn)> {
        let mut out = Vec::new();
        let mut cursor = 0;
        for record in &self.turn_records {
            self.legacy_turns(cursor, record.start, &mut out);
            let mut turn = Turn::new(record.id.clone(), Vec::new());
            turn.started_at = Some(record.started_at);
            turn.completed_at = record.completed_at;
            // The legacy projection knows how to match tool outputs and draw compaction
            // dividers. Merge its parts: a steer or an automatic compaction is still part
            // of this run, rather than a new turn on every reload.
            for part in crate::turns_from_timed_history(
                &self.messages[record.start..record.end],
                &self.timestamps[record.start..record.end],
            ) {
                turn.items.extend(part.items);
                if part.process_ended_at.is_some() {
                    turn.process_ended_at = part.process_ended_at;
                }
            }
            // Group nested activity under the provider call that launched it. These rows
            // are UI history only and never become model-visible tool messages.
            for (parent, item) in record.tools.iter().rev() {
                let Some(at) = turn
                    .items
                    .iter()
                    .position(|i| matches!(i,Item::ToolCall{id,..}if id==parent))
                else {
                    continue;
                };
                let mut item = item.clone();
                if let Item::ToolCall {
                    output, is_error, ..
                } = &mut item
                    && output.is_none()
                {
                    *output = Some("Interrupted before the nested tool finished.".into());
                    *is_error = true;
                }
                turn.items.insert(at + 1, item);
            }
            renumber(&mut turn);
            if record.status == TurnStatus::Failed
                && let Some(error) = &record.error
            {
                turn.items.push(Item::Error {
                    id: error.id.clone(),
                    message: error.message.clone(),
                });
            }
            out.push((record.start, turn));
            cursor = record.end;
        }
        self.legacy_turns(cursor, self.messages.len(), &mut out);
        out
    }

    fn legacy_turns(&self, start: usize, end: usize, out: &mut Vec<(usize, Turn)>) {
        let starts = self.messages[start..end]
            .iter()
            .enumerate()
            .filter_map(|(i, m)| {
                matches!(
                    m,
                    fv_core::Message::User { .. } | fv_core::Message::Compaction { .. }
                )
                .then_some(start + i)
            });
        for (at, mut turn) in starts.zip(crate::turns_from_timed_history(
            &self.messages[start..end],
            &self.timestamps[start..end],
        )) {
            turn.id = format!("t{}", out.len());
            renumber(&mut turn);
            out.push((at, turn));
        }
    }
}

fn renumber(turn: &mut Turn) {
    for (i, item) in turn.items.iter_mut().enumerate() {
        match item {
            Item::UserMessage { id, .. }
            | Item::AgentMessage { id, .. }
            | Item::Reasoning { id, .. }
            | Item::ContextCompaction { id, .. }
            | Item::Error { id, .. } => *id = format!("{}i{i}", turn.id),
            // Tool ids come from the provider; the corresponding result names the same id.
            Item::ToolCall { .. } | Item::Audio { .. } | Item::Image { .. } => {}
        }
    }
}
