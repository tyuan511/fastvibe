use crate::{harness::HarnessId, session::Role};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MessageKind {
    Text,
    Thinking,
    ToolCall,
    Status,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredMessage {
    pub id: Uuid,
    pub session_id: Uuid,
    pub sequence: u64,
    pub role: Role,
    pub kind: MessageKind,
    pub content: String,
    pub harness: HarnessId,
    #[serde(default)]
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageStore {
    pub messages: Vec<StoredMessage>,
    #[serde(default)]
    next_sequence: u64,
}

impl MessageStore {
    pub fn append(
        &mut self,
        session_id: Uuid,
        role: Role,
        kind: MessageKind,
        content: impl Into<String>,
        harness: HarnessId,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.messages.push(StoredMessage {
            id,
            session_id,
            sequence,
            role,
            kind,
            content: content.into(),
            harness,
            tool_name: None,
        });
        id
    }

    pub fn append_tool(
        &mut self,
        session_id: Uuid,
        harness: HarnessId,
        name: impl Into<String>,
        detail: impl Into<String>,
    ) -> Uuid {
        let name = name.into();
        let id = self.append(
            session_id,
            Role::Tool,
            MessageKind::ToolCall,
            format!("`{name}` {}", detail.into()),
            harness,
        );
        if let Some(message) = self.messages.iter_mut().find(|message| message.id == id) {
            message.tool_name = Some(name);
        }
        id
    }

    pub fn append_delta(&mut self, id: Uuid, delta: &str) -> bool {
        if let Some(message) = self.messages.iter_mut().find(|message| message.id == id) {
            message.content.push_str(delta);
            true
        } else {
            false
        }
    }

    pub fn update_content(&mut self, id: Uuid, content: impl Into<String>) -> bool {
        if let Some(message) = self.messages.iter_mut().find(|message| message.id == id) {
            message.content = content.into();
            true
        } else {
            false
        }
    }

    pub fn for_session(&self, session_id: Uuid) -> Vec<StoredMessage> {
        let mut messages = self
            .messages
            .iter()
            .filter(|message| message.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        messages.sort_by_key(|message| message.sequence);
        messages
    }

    pub fn remove_session(&mut self, session_id: Uuid) {
        self.messages
            .retain(|message| message.session_id != session_id);
    }

    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let mut store: Self = serde_json::from_slice(&fs::read(path)?)?;
        store.next_sequence = store
            .messages
            .iter()
            .map(|message| message.sequence)
            .max()
            .map_or(0, |sequence| sequence.saturating_add(1));
        Ok(store)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_vec_pretty(self)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_streaming_messages_owned_by_the_session_store() {
        let session_id = Uuid::new_v4();
        let mut store = MessageStore::default();
        let id = store.append(
            session_id,
            Role::Assistant,
            MessageKind::Text,
            "hello",
            HarnessId::Codex,
        );
        assert!(store.append_delta(id, " world"));
        assert_eq!(store.for_session(session_id)[0].content, "hello world");
    }
}
