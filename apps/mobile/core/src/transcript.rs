use crate::support::now_ms;
use crate::*;
use std::collections::VecDeque;

pub struct TranscriptStore {
    messages: VecDeque<ChatMessage>,
    max_messages: usize,
    pub seq: u64,
    pub running: bool,
    pub pending_ui: Vec<serde_json::Value>,
    pub turn_events: Vec<serde_json::Value>,
    pub queue: QueueState,
    pub history_before: Option<String>,
    pub overflowed: bool,
}

impl Default for TranscriptStore {
    fn default() -> Self {
        Self::new(MAX_VISIBLE_MESSAGES)
    }
}

impl TranscriptStore {
    pub fn new(max_messages: usize) -> Self {
        Self {
            messages: VecDeque::new(),
            max_messages: max_messages.max(1),
            seq: 0,
            running: false,
            pending_ui: Vec::new(),
            turn_events: Vec::new(),
            queue: QueueState::default(),
            history_before: None,
            overflowed: false,
        }
    }

    pub fn replace_snapshot(&mut self, snapshot: ConversationSnapshot) {
        self.messages = snapshot.messages.into_iter().collect();
        self.trim_visible();
        self.seq = snapshot.seq;
        self.running = snapshot.running;
        self.pending_ui = snapshot.pending_ui;
        self.turn_events = snapshot.turn_events;
        self.queue = snapshot.queue;
        self.history_before = snapshot
            .history
            .and_then(|history| history.before_entry_id)
            .or(snapshot.history_before_entry_id);
        self.overflowed = snapshot.overflowed;
    }

    pub fn prepend_history(&mut self, page: &ConversationHistoryPage) {
        let mut messages = VecDeque::with_capacity(page.messages.len() + self.messages.len());
        messages.extend(page.messages.iter().cloned());
        messages.extend(self.messages.drain(..));
        self.messages = messages;
        self.history_before = page.next_before_entry_id.clone();
        self.overflowed = false;
        // Older pages are prepended. Preserve the newly loaded prefix and trim only the
        // newest tail when a caller asks for more than the visible window.
        while self.messages.len() > self.max_messages {
            self.messages.pop_back();
        }
    }

    pub fn reset_history(&mut self) {
        self.messages.clear();
        self.history_before = None;
        self.overflowed = false;
    }

    pub fn snapshot(&self, conversation_id: Option<String>) -> ConversationSnapshot {
        ConversationSnapshot {
            conversation_id,
            messages: self.messages.iter().cloned().collect(),
            message_mode: Some("window".into()),
            history_before_entry_id: self.history_before.clone(),
            history: Some(SnapshotHistory {
                before_entry_id: self.history_before.clone(),
            }),
            running: self.running,
            queue: self.queue.clone(),
            pending_ui: self.pending_ui.clone(),
            turn_events: self.turn_events.clone(),
            overflowed: self.overflowed,
            seq: self.seq,
        }
    }

    pub fn apply_message(&mut self, message: ChatMessage) {
        if let Some(existing) = self.messages.iter_mut().find(|item| item.id == message.id) {
            *existing = message;
        } else {
            self.messages.push_back(message);
        }
        self.trim_visible();
    }

    pub fn apply_engine_event(&mut self, event: &serde_json::Value) {
        let Some(record) = event.as_object() else {
            return;
        };
        if let Some(seq) = record.get("seq").and_then(serde_json::Value::as_u64) {
            self.seq = self.seq.max(seq);
        }
        match record.get("type").and_then(serde_json::Value::as_str) {
            Some("conversation_running") => {
                self.running = record
                    .get("running")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true)
            }
            Some("extension_ui_request") => {
                self.pending_ui.push(event.clone());
                trim_values(&mut self.pending_ui, MAX_PENDING_EVENTS);
            }
            Some("extension_ui_dismiss") => {
                let id = record.get("id").and_then(serde_json::Value::as_str);
                self.pending_ui
                    .retain(|item| item.get("id").and_then(serde_json::Value::as_str) != id);
            }
            Some(
                "notice" | "command_output" | "todo_reminder" | "todo_auto_clear"
                | "auto_retry_start" | "auto_retry_end" | "extension_error" | "model_changed",
            ) => {
                self.turn_events.push(event.clone());
                trim_values(&mut self.turn_events, MAX_TURN_EVENTS);
            }
            Some("message") => {
                if let Some(message) = record.get("message").and_then(parse_message) {
                    self.apply_message(message);
                }
            }
            Some("message_update") => self.apply_update(record),
            Some("tool_execution_start")
            | Some("tool_execution_update")
            | Some("tool_execution_end") => self.apply_tool_execution(record),
            Some("agent_start") => self.running = true,
            Some("agent_settled") => self.running = false,
            Some("queue_changed") | Some("queue_state") | Some("conversation_queue") => {
                let queue = record
                    .get("queue")
                    .or_else(|| record.get("state"))
                    .cloned()
                    .unwrap_or_else(|| event.clone());
                if let Ok(queue) = serde_json::from_value::<QueueState>(queue) {
                    self.queue = queue;
                }
            }
            _ => {}
        }
    }

    fn apply_tool_execution(&mut self, record: &serde_json::Map<String, serde_json::Value>) {
        let id = record
            .get("toolCallId")
            .or_else(|| record.get("tool_id"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if id.is_empty() {
            return;
        }
        let status = match record.get("type").and_then(serde_json::Value::as_str) {
            Some("tool_execution_start") => "running",
            Some("tool_execution_end") => {
                if record
                    .get("isError")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    "error"
                } else {
                    "done"
                }
            }
            _ => "running",
        };
        if let Some(message) = self
            .messages
            .iter_mut()
            .rev()
            .find(|message| message.tools.iter().any(|tool| tool.id == id))
        {
            if let Some(tool) = message.tools.iter_mut().find(|tool| tool.id == id) {
                tool.status = status.into();
                tool.args = tool
                    .args
                    .clone()
                    .or_else(|| record.get("args").cloned())
                    .or_else(|| record.get("arguments").cloned());
                tool.result = record
                    .get("result")
                    .or_else(|| record.get("output"))
                    .or_else(|| record.get("partialResult"))
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| tool.result.clone());
                tool.details = record
                    .get("details")
                    .cloned()
                    .or_else(|| tool.details.clone());
                if let Some(parent) = record
                    .get("parentToolCallId")
                    .or_else(|| record.get("parentId"))
                    .and_then(serde_json::Value::as_str)
                {
                    tool.parent_id = Some(parent.into());
                }
            }
        }
    }

    fn apply_update(&mut self, record: &serde_json::Map<String, serde_json::Value>) {
        let id = record
            .get("messageId")
            .or_else(|| record.get("id"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("running")
            .to_owned();
        let mut message = self
            .messages
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .unwrap_or_else(|| ChatMessage {
                id: id.clone(),
                role: "assistant".into(),
                text: String::new(),
                thinking: None,
                tools: Vec::new(),
                parts: Some(Vec::new()),
                created_at: now_ms(),
                completed_at: None,
                run_started_at: Some(now_ms()),
                kind: Some("message".into()),
                custom_type: None,
                error: None,
                stop: None,
                retry: None,
                deferred_content: None,
                stop_cause: None,
                compact: None,
            });
        let update = record
            .get("assistantMessageEvent")
            .or_else(|| record.get("event"))
            .and_then(serde_json::Value::as_object);
        if let Some(update) = update {
            let kind = update
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let delta = update
                .get("delta")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let parts = message.parts.get_or_insert_with(Vec::new);
            match kind {
                "text_delta" => {
                    message.text.push_str(delta);
                    append_part_text(parts, delta);
                }
                "thinking_delta" => {
                    message
                        .thinking
                        .get_or_insert_with(String::new)
                        .push_str(delta);
                    append_part_thinking(parts, delta);
                }
                "toolcall_delta" | "tool_call_delta" => update_tool_delta(&mut message, update),
                "message_end" => {
                    message.completed_at = update
                        .get("completedAt")
                        .or_else(|| update.get("completed_at"))
                        .and_then(serde_json::Value::as_i64)
                        .or_else(|| Some(now_ms()));
                }
                _ => {}
            }
        }
        self.apply_message(message);
    }

    fn trim_visible(&mut self) {
        while self.messages.len() > self.max_messages {
            self.messages.pop_front();
            self.overflowed = true;
        }
    }
}

pub(crate) fn trim_values(values: &mut Vec<serde_json::Value>, max: usize) {
    if values.len() > max {
        let drop_count = values.len() - max;
        values.drain(..drop_count);
    }
}

fn append_part_text(parts: &mut Vec<MessagePart>, delta: &str) {
    if delta.is_empty() {
        return;
    }
    if let Some(MessagePart::Text { text }) = parts.last_mut() {
        text.push_str(delta);
    } else {
        parts.push(MessagePart::Text { text: delta.into() });
    }
}

fn append_part_thinking(parts: &mut Vec<MessagePart>, delta: &str) {
    if delta.is_empty() {
        return;
    }
    if let Some(MessagePart::Thinking { text, .. }) = parts.last_mut() {
        text.push_str(delta);
    } else {
        parts.push(MessagePart::Thinking {
            text: delta.into(),
            started_at: Some(now_ms()),
            ended_at: None,
        });
    }
}

fn update_tool_delta(
    message: &mut ChatMessage,
    update: &serde_json::Map<String, serde_json::Value>,
) {
    let partial = update
        .get("partial")
        .or_else(|| update.get("tool"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_array());
    let Some(items) = partial else {
        return;
    };
    for item in items {
        let Some(object) = item.as_object() else {
            continue;
        };
        let id = object
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("tool");
        let tool = message.tools.iter_mut().find(|tool| tool.id == id);
        if let Some(tool) = tool {
            tool.args = object
                .get("arguments")
                .cloned()
                .or_else(|| object.get("args").cloned());
        } else {
            message.tools.push(ToolCall {
                id: id.into(),
                name: object
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("tool")
                    .into(),
                args: object
                    .get("arguments")
                    .cloned()
                    .or_else(|| object.get("args").cloned()),
                result: None,
                status: "running".into(),
                details: None,
                parent_id: None,
                omitted: None,
                images: None,
            });
        }
        if !message.parts.as_ref().is_some_and(|parts| {
            parts
                .iter()
                .any(|part| matches!(part, MessagePart::Tool { tool_id } if tool_id == id))
        }) {
            message
                .parts
                .get_or_insert_with(Vec::new)
                .push(MessagePart::Tool { tool_id: id.into() });
        }
    }
}

fn parse_message(value: &serde_json::Value) -> Option<ChatMessage> {
    serde_json::from_value(value.clone()).ok()
}
