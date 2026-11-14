use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub path: PathBuf,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectStore {
    pub projects: Vec<Project>,
    pub active: Option<Uuid>,
}

impl ProjectStore {
    pub fn add(&mut self, path: impl Into<PathBuf>) -> &Project {
        let path = path.into();
        let id = Uuid::new_v4();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .to_owned();
        self.projects.push(Project {
            id,
            name,
            path,
            archived: false,
        });
        self.active = Some(id);
        self.projects.last().unwrap()
    }
    pub fn active(&self) -> Option<&Project> {
        self.active
            .and_then(|id| self.projects.iter().find(|project| project.id == id))
    }
    pub fn set_active(&mut self, id: Uuid) -> bool {
        if self
            .projects
            .iter()
            .any(|project| project.id == id && !project.archived)
        {
            self.active = Some(id);
            true
        } else {
            false
        }
    }
    pub fn rename(&mut self, id: Uuid, name: impl Into<String>) -> bool {
        let name = name.into().trim().to_owned();
        if name.is_empty() {
            return false;
        }
        if let Some(project) = self.projects.iter_mut().find(|project| project.id == id) {
            project.name = name;
            true
        } else {
            false
        }
    }
    pub fn archive(&mut self, id: Uuid, archived: bool) -> bool {
        if let Some(project) = self.projects.iter_mut().find(|project| project.id == id) {
            project.archived = archived;
            if archived && self.active == Some(id) {
                self.active = self
                    .projects
                    .iter()
                    .find(|item| !item.archived && item.id != id)
                    .map(|item| item.id);
            }
            true
        } else {
            false
        }
    }
    pub fn remove(&mut self, id: Uuid) -> bool {
        let before = self.projects.len();
        self.projects.retain(|project| project.id != id);
        if self.active == Some(id) {
            self.active = self
                .projects
                .iter()
                .find(|item| !item.archived)
                .map(|item| item.id);
        }
        self.projects.len() != before
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
    fn round_trips_project_store() {
        let path = std::env::temp_dir().join(format!("fastvibe-project-{}.json", Uuid::new_v4()));
        let mut store = ProjectStore::default();
        store.add("/tmp/example-project");
        store.save(&path).unwrap();
        let restored = ProjectStore::load(&path).unwrap();
        assert_eq!(restored.projects, store.projects);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn supports_project_lifecycle_operations() {
        let mut store = ProjectStore::default();
        let id = store.add("/tmp/example-project").id;
        assert!(store.rename(id, "Renamed"));
        assert!(store.archive(id, true));
        assert!(store.active.is_none());
        assert!(store.archive(id, false));
        assert!(store.set_active(id));
        assert!(store.remove(id));
    }
}
