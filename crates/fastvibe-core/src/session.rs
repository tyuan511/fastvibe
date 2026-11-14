use crate::harness::{HarnessId, RunState};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningLevel {
    #[serde(alias = "off")]
    Default,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Session {
    pub id: Uuid,
    pub project_id: Uuid,
    pub harness: HarnessId,
    pub title: String,
    pub working_directory: PathBuf,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_reasoning")]
    pub reasoning: ReasoningLevel,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub draft: String,
    #[serde(default)]
    pub binding: Option<SessionBinding>,
    #[serde(default = "idle_state")]
    pub state: RunState,
    #[serde(default)]
    pub updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionBinding {
    pub harness: HarnessId,
    pub remote_id: String,
}
fn idle_state() -> RunState {
    RunState::Completed
}

fn default_reasoning() -> ReasoningLevel {
    ReasoningLevel::Default
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionStore {
    pub sessions: Vec<Session>,
    pub active: Option<Uuid>,
}

impl SessionStore {
    pub fn create(
        &mut self,
        project_id: Uuid,
        harness: HarnessId,
        working_directory: PathBuf,
    ) -> &Session {
        let session = Session {
            id: Uuid::new_v4(),
            project_id,
            harness,
            title: "New session".into(),
            working_directory,
            model: "default".into(),
            reasoning: ReasoningLevel::Default,
            archived: false,
            draft: String::new(),
            binding: None,
            state: RunState::Completed,
            updated_ms: 0,
        };
        self.active = Some(session.id);
        self.sessions.push(session);
        self.sessions.last().unwrap()
    }
    pub fn active_mut(&mut self) -> Option<&mut Session> {
        self.active
            .and_then(|id| self.sessions.iter_mut().find(|session| session.id == id))
    }
    pub fn active(&self) -> Option<&Session> {
        self.active
            .and_then(|id| self.sessions.iter().find(|session| session.id == id))
    }
    pub fn set_active(&mut self, id: Uuid) -> bool {
        if self
            .sessions
            .iter()
            .any(|session| session.id == id && !session.archived)
        {
            self.active = Some(id);
            true
        } else {
            false
        }
    }
    pub fn rename(&mut self, id: Uuid, title: impl Into<String>) -> bool {
        let title = title.into().trim().to_owned();
        if title.is_empty() {
            return false;
        }
        if let Some(session) = self.sessions.iter_mut().find(|session| session.id == id) {
            session.title = title;
            true
        } else {
            false
        }
    }
    pub fn archive(&mut self, id: Uuid, archived: bool) -> bool {
        let project_id =
            if let Some(session) = self.sessions.iter_mut().find(|session| session.id == id) {
                let project_id = session.project_id;
                session.archived = archived;
                project_id
            } else {
                return false;
            };
        if archived && self.active == Some(id) {
            self.active = self
                .sessions
                .iter()
                .find(|item| !item.archived && item.project_id == project_id)
                .map(|item| item.id);
        }
        true
    }
    pub fn remove(&mut self, id: Uuid) -> bool {
        let before = self.sessions.len();
        self.sessions.retain(|session| session.id != id);
        if self.active == Some(id) {
            self.active = self
                .sessions
                .iter()
                .find(|item| !item.archived)
                .map(|item| item.id);
        }
        self.sessions.len() != before
    }
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        Ok(serde_json::from_slice(&fs::read(path)?)?)
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
    fn round_trips_session_store() {
        let path = std::env::temp_dir().join(format!("fastvibe-session-{}.json", Uuid::new_v4()));
        let project_id = Uuid::new_v4();
        let mut store = SessionStore::default();
        let session = store.create(project_id, HarnessId::Codex, "/tmp/example-project".into());
        assert_eq!(session.project_id, project_id);
        store.save(&path).unwrap();
        let restored = SessionStore::load(&path).unwrap();
        assert_eq!(restored.active, store.active);
        assert_eq!(restored.sessions.len(), 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn supports_session_lifecycle_operations() {
        let mut store = SessionStore::default();
        let id = store
            .create(
                Uuid::new_v4(),
                HarnessId::Codex,
                "/tmp/example-project".into(),
            )
            .id;
        assert!(store.rename(id, "Renamed"));
        assert!(store.archive(id, true));
        assert!(store.active.is_none());
        assert!(store.archive(id, false));
        assert!(store.set_active(id));
        assert!(store.remove(id));
    }
}
