//! Private, per-client pane recovery. Runtime entities and terminal output are never serialized.
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

use fv_protocol::types::{FilePreview, TerminalSession};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Layout {
    pub version: u32,
    pub selected: Option<String>,
    pub collapsed: bool,
    /// What the pane was dragged to; `None` follows the window. Older files wrote the old fixed
    /// default (380) for a pane nobody had sized, which `restore_panes` reads as `None`.
    pub width: Option<f32>,
    pub maximized: bool,
    /// Visibility of the conversation resources when the column has enough room.
    pub resources_open: bool,
    pub panes: BTreeMap<String, Pane>,
    #[serde(default)]
    pub browser_bookmarks: Vec<Bookmark>,
    #[serde(default)]
    pub browser_history: Vec<HistoryEntry>,
    #[serde(default)]
    pub browser_downloads: Vec<Download>,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            version: 1,
            selected: None,
            collapsed: true,
            width: None,
            maximized: false,
            resources_open: true,
            panes: BTreeMap::new(),
            browser_bookmarks: Vec::new(),
            browser_history: Vec::new(),
            browser_downloads: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Download {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub received: u64,
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub can_resume: bool,
    pub url: String,
    pub path: PathBuf,
    pub complete: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    pub title: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub title: String,
    pub url: String,
    pub visited_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pane {
    pub tabs: Vec<Tab>,
    pub active: Option<String>,
    pub expanded: Vec<String>,
    pub tree_width: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tab {
    pub id: String,
    pub title: String,
    pub kind: TabKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TabKind {
    File {
        path: String,
        file: File,
    },
    /// An auxiliary conversation backed by an existing child thread.
    Chat {
        thread_id: String,
    },
    Git,
    Browser {
        url: String,
    },
    Terminal {
        session: Option<TerminalSession>,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct File {
    pub editing: bool,
    pub showing: bool,
    /// Only unsaved editable text is cached. Clean files are read afresh from the server.
    pub recovery: Option<Recovery>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Recovery {
    pub preview: FilePreview,
    pub baseline: Option<String>,
    pub text: String,
}

pub struct Storage {
    path: PathBuf,
    gate: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
    retry: bool,
    pub last: Layout,
}

pub struct Save {
    path: PathBuf,
    gate: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
    serial: u64,
    layout: Layout,
}

impl Storage {
    pub fn changed(&self, layout: &Layout) -> bool {
        self.retry || layout != &self.last
    }

    pub fn invalidate(&mut self) {
        self.retry = true;
    }

    pub fn is_current(&self, serial: u64) -> bool {
        serial == self.generation.load(Ordering::SeqCst)
    }

    pub fn open(path: PathBuf) -> io::Result<Self> {
        let last = match std::fs::read(&path) {
            Ok(bytes) => {
                let layout: Layout = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
                if layout.version != 1 {
                    return Err(io::Error::other("unsupported workspace layout version"));
                }
                layout
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Layout::default(),
            Err(e) => return Err(e),
        };
        Ok(Self {
            path,
            last,
            gate: Arc::default(),
            generation: Arc::default(),
            retry: false,
        })
    }

    pub fn save(&mut self, layout: Layout) -> Save {
        self.retry = false;
        self.last = layout.clone();
        Save {
            path: self.path.clone(),
            gate: self.gate.clone(),
            generation: self.generation.clone(),
            serial: self.generation.fetch_add(1, Ordering::SeqCst) + 1,
            layout,
        }
    }
}

impl Save {
    pub fn serial(&self) -> u64 {
        self.serial
    }

    pub fn run(self) -> io::Result<()> {
        // Shutdown and background saves may be scheduled on different executors. An older job
        // can never replace a newer one, even if the older executor only starts after shutdown.
        let _guard = self
            .gate
            .lock()
            .map_err(|_| io::Error::other("workspace save lock poisoned"))?;
        if self.serial != self.generation.load(Ordering::SeqCst) {
            return Ok(());
        }
        let parent = self
            .path
            .parent()
            .ok_or_else(|| io::Error::other("layout has no parent"))?;
        std::fs::create_dir_all(parent)?;
        let name = format!(
            ".gui-workspace-{}-{}-{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            self.serial
        );
        let temp = parent.join(name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        let result = (|| {
            let bytes = serde_json::to_vec(&self.layout).map_err(io::Error::other)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temp, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::{File, Layout, Pane, Recovery, Storage, Tab, TabKind};
    use fv_protocol::types::{FilePreview, FilePreviewKind};

    fn layout() -> Layout {
        let mut layout = Layout {
            selected: Some("chat-a".into()),
            collapsed: false,
            width: Some(720.0),
            maximized: true,
            ..Default::default()
        };
        layout.panes.insert(
            "chat-a".into(),
            Pane {
                tabs: vec![Tab {
                    id: "tab-1".into(),
                    title: "中文.rs".into(),
                    kind: TabKind::File {
                        path: "/project/中文.rs".into(),
                        file: File {
                            editing: true,
                            showing: true,
                            recovery: Some(Recovery {
                                preview: FilePreview::Text {
                                    kind: FilePreviewKind::Code,
                                    path: "/project/中文.rs".into(),
                                    name: "中文.rs".into(),
                                    language: Some("rust".into()),
                                    text: "old".into(),
                                    revision: None,
                                },
                                baseline: Some("old".into()),
                                text: "未保存 🦀\n".into(),
                            }),
                        },
                    },
                }],
                active: Some("tab-1".into()),
                expanded: vec!["/project/src".into()],
                tree_width: 225.0,
            },
        );
        layout
    }

    #[test]
    fn reopen_preserves_layout_and_unicode_draft_without_leaving_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gui-workspace.json");
        let mut storage = Storage::open(path.clone()).unwrap();
        assert_eq!(storage.last, Layout::default());
        let expected = layout();
        storage.save(expected.clone()).run().unwrap();
        drop(storage);
        assert_eq!(Storage::open(path.clone()).unwrap().last, expected);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn late_background_save_cannot_overwrite_shutdown_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("layout.json");
        let mut storage = Storage::open(path.clone()).unwrap();
        let earlier = storage.save(layout());
        let newest = Layout {
            selected: Some("chat-b".into()),
            ..layout()
        };
        storage.save(newest.clone()).run().unwrap();
        earlier.run().unwrap();
        assert_eq!(Storage::open(path).unwrap().last, newest);
    }

    #[test]
    fn corrupt_and_future_layouts_are_reported_and_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("layout.json");
        for bytes in [b"{broken".as_slice(), b"{\"version\":100}".as_slice()] {
            std::fs::write(&path, bytes).unwrap();
            assert!(Storage::open(path.clone()).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn browser_library_roundtrips_and_old_layouts_default_empty() {
        let old: Layout = serde_json::from_value(serde_json::json!({
            "version": 1,
            "selected": null,
            "collapsed": true,
            "width": 380.0,
            "maximized": false,
            "panes": {}
        }))
        .unwrap();
        assert!(old.browser_bookmarks.is_empty() && old.browser_history.is_empty());
        assert!(old.resources_open);
        let mut current = Layout {
            resources_open: false,
            ..Default::default()
        };
        current.browser_bookmarks.push(super::Bookmark {
            title: "Docs".into(),
            url: "https://example.com".into(),
        });
        current.browser_history.push(super::HistoryEntry {
            title: "Docs".into(),
            url: "https://example.com".into(),
            visited_at: 7,
        });
        let restored: Layout =
            serde_json::from_value(serde_json::to_value(&current).unwrap()).unwrap();
        assert_eq!(restored, current);
    }

    #[test]
    fn failed_atomic_replace_preserves_existing_target_and_cleans_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("layout.json");
        let mut storage = Storage::open(path.clone()).unwrap();
        // A directory cannot be replaced by a file. Simulates a failure after writing the temp.
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep"), "original").unwrap();
        assert!(storage.save(layout()).run().is_err());
        assert_eq!(
            std::fs::read_to_string(path.join("keep")).unwrap(),
            "original"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
