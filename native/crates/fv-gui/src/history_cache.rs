//! Bound copies of idle transcripts. Navigation already reads an authoritative
//! snapshot; keep lightweight live state so notices/plans/prompts do not disappear.
use std::collections::{HashMap, VecDeque};

use crate::view_model::ThreadView;
use fv_protocol::types::{Item, ThreadId, Turn};

const IDLE_VIEWS: usize = 3;
const IDLE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct HistoryCache {
    recent: VecDeque<ThreadId>,
}

impl HistoryCache {
    pub fn touch(&mut self, id: &ThreadId) {
        self.recent.retain(|old| old != id);
        self.recent.push_back(id.clone());
    }

    pub fn trim(&mut self, views: &mut HashMap<ThreadId, ThreadView>, selected: Option<&ThreadId>) {
        self.recent
            .retain(|id| views.contains_key(id) || selected == Some(id));
        // Background questions can load a view without navigating to it.
        let mut idle: Vec<_> = views
            .iter()
            .filter(|(id, view)| {
                selected != Some(*id)
                    && !view.running
                    && !view.is_waiting_on_user()
                    && view.queue.items.is_empty()
                    && !view.turns.is_empty()
            })
            .map(|(id, view)| {
                (
                    id.clone(),
                    history_bytes(view),
                    self.recent.iter().position(|x| x == id),
                )
            })
            .collect();
        idle.sort_by_key(|(_, _, recency)| *recency);
        let mut count = idle.len();
        let mut bytes = idle.iter().map(|(_, size, _)| size).sum::<usize>();
        for (id, size, _) in idle {
            if count <= IDLE_VIEWS && bytes <= IDLE_BYTES {
                break;
            }
            let view = views.get_mut(&id).unwrap();
            view.turns = Vec::new();
            view.reasoning_durations = HashMap::new();
            view.reasoning_starts = HashMap::new();
            count -= 1;
            bytes = bytes.saturating_sub(size);
        }
    }
}

// Count retained capacities, including media and tool JSON, without serializing
// a potentially multi-MiB transcript on the UI thread.
fn history_bytes(view: &ThreadView) -> usize {
    let turns = &view.turns;
    turns.capacity() * std::mem::size_of::<Turn>()
        + turns
            .iter()
            .map(|turn| {
                turn.id.capacity()
                    + turn.items.capacity() * std::mem::size_of::<Item>()
                    + turn
                        .reasoning_durations
                        .keys()
                        .map(|key| key.capacity() + 64)
                        .sum::<usize>()
                    + turn
                        .items
                        .iter()
                        .map(|item| match item {
                            Item::UserMessage { id, text }
                            | Item::AgentMessage { id, text }
                            | Item::Reasoning { id, text } => id.capacity() + text.capacity(),
                            Item::Error { id, message } => id.capacity() + message.capacity(),
                            Item::ToolCall {
                                id,
                                name,
                                arguments,
                                output,
                                ..
                            } => {
                                id.capacity()
                                    + name.capacity()
                                    + json_bytes(arguments)
                                    + output.as_ref().map_or(0, String::capacity)
                            }
                            Item::Audio {
                                id,
                                name,
                                mime,
                                data,
                            }
                            | Item::Image {
                                id,
                                name,
                                mime,
                                data,
                            } => {
                                id.capacity() + name.capacity() + mime.capacity() + data.capacity()
                            }
                            Item::ContextCompaction { id, reason, .. } => {
                                id.capacity() + reason.as_ref().map_or(0, String::capacity)
                            }
                        })
                        .sum::<usize>()
            })
            .sum::<usize>()
}

fn json_bytes(value: &serde_json::Value) -> usize {
    use serde_json::Value;
    match value {
        Value::String(text) => text.capacity(),
        Value::Array(values) => {
            values.capacity() * std::mem::size_of::<Value>()
                + values.iter().map(json_bytes).sum::<usize>()
        }
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| {
                key.capacity() + std::mem::size_of::<Value>() + 64 + json_bytes(value)
            })
            .sum(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fv_protocol::types::*;

    fn view(id: &str, bytes: usize) -> ThreadView {
        ThreadView::from_snapshot(ThreadResumeResponse {
            thread: Thread {
                id: id.into(),
                title: id.into(),
                cwd: None,
                project: None,
                source: None,
                created_at: 0,
                updated_at: 0,
                archived: false,
                unread: false,
                pinned: false,
                worktree: None,
                model: None,
                thinking: None,
            },
            turns: vec![Turn::new(
                "turn".into(),
                vec![Item::AgentMessage {
                    id: "item".into(),
                    text: "x".repeat(bytes),
                }],
            )],
            seq: 7,
            running: false,
            token_usage: None,
            stats: Default::default(),
            queue: Default::default(),
            goal: None,
            mode: Default::default(),
            suggestion: None,
        })
    }

    #[test]
    fn oldest_idle_bodies_are_released_but_live_metadata_stays() {
        let mut cache = HistoryCache::default();
        let mut views = HashMap::new();
        for id in ["a", "b", "c", "d", "selected"] {
            let mut v = view(id, 100);
            v.notice = Some("notice".into());
            views.insert(id.into(), v);
            cache.touch(&id.into());
        }
        // Revisiting a makes b the least recently used idle conversation.
        cache.touch(&"a".into());
        cache.trim(&mut views, Some(&"selected".into()));
        assert!(views["b"].turns.is_empty());
        for id in ["a", "c", "d", "selected"] {
            assert_eq!(views[id].turns.len(), 1);
        }
        assert_eq!(views["b"].seq, 7);
        assert_eq!(views["b"].notice.as_deref(), Some("notice"));
    }

    #[test]
    fn oversized_media_is_released_while_selected_running_and_queued_views_are_pinned() {
        let mut cache = HistoryCache::default();
        let mut views: HashMap<_, _> = ["idle", "selected", "running", "queued", "question"]
            .into_iter()
            .map(|id| (id.into(), view(id, 10)))
            .collect();
        views.get_mut("idle").unwrap().turns[0].items = vec![Item::Image {
            id: "image".into(),
            name: "image".into(),
            mime: "image/png".into(),
            data: "x".repeat(IDLE_BYTES + 1),
        }];
        views.get_mut("selected").unwrap().turns[0]
            .items
            .push(Item::ToolCall {
                id: "tool".into(),
                name: "write".into(),
                arguments: serde_json::json!({"content": "x".repeat(IDLE_BYTES + 1)}),
                output: None,
                is_error: false,
            });
        views.get_mut("running").unwrap().running = true;
        views
            .get_mut("queued")
            .unwrap()
            .queue
            .items
            .push(QueueItem {
                id: "queued".into(),
                text: "next".into(),
                at: 0,
            });
        views.get_mut("question").unwrap().approvals.push((
            fv_protocol::RequestId::Number(1),
            ApprovalRequestParams {
                thread_id: "question".into(),
                turn_id: "turn".into(),
                call_id: "tool".into(),
                kind: ApprovalKind::Command {
                    command: "pwd".into(),
                    cwd: None,
                },
                reason: None,
            },
        ));
        cache.trim(&mut views, Some(&"selected".into()));
        assert!(views["idle"].turns.is_empty());
        for id in ["selected", "running", "queued", "question"] {
            assert_eq!(views[id].turns.len(), 1);
        }
    }
}
