use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fv_core::Message;
use serde::{Deserialize, Serialize};

use crate::StoreError;

/// A conversation's transcript: `sessions/<id>.jsonl`. The first line is a header; every other
/// line is one message, linked to the one before it by `parentId`. The file is only ever
/// appended to, so a crash can cut the last line short but cannot damage an earlier one.
pub struct TranscriptStore {
    dir: PathBuf,
    /// The id of the last entry of each transcript touched this run, to link the next one to.
    tails: Mutex<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Line {
    #[serde(rename_all = "camelCase")]
    Session {
        version: u32,
        id: String,
        created_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    Message {
        id: String,
        parent_id: Option<String>,
        timestamp: i64,
        message: Message,
    },
}

pub struct Loaded {
    pub messages: Vec<Message>,
    /// Lines that could not be read and were skipped (at most the last one, after a crash,
    /// unless the file was edited by hand).
    pub skipped: usize,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl TranscriptStore {
    pub fn new(dir: PathBuf) -> Result<Self, StoreError> {
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            dir,
            tails: Mutex::default(),
        })
    }

    pub fn path(&self, conversation_id: &str) -> PathBuf {
        // Ids are generated here, but a path built from an id must never leave the directory.
        let safe: String = conversation_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        self.dir.join(format!("{safe}.jsonl"))
    }

    pub fn exists(&self, conversation_id: &str) -> bool {
        self.path(conversation_id).exists()
    }

    pub fn append(&self, conversation_id: &str, messages: &[Message]) -> Result<(), StoreError> {
        if messages.is_empty() {
            return Ok(());
        }
        let path = self.path(conversation_id);
        let mut tails = self.tails.lock().unwrap();
        let mut tail = match tails.get(conversation_id) {
            Some(t) => Some(t.clone()),
            None => last_entry_id(&path)?,
        };

        let mut out = String::new();
        let creating = !path.exists();
        if creating {
            let header = Line::Session {
                version: 1,
                id: conversation_id.to_string(),
                created_at: now_ms(),
            };
            out.push_str(&serde_json::to_string(&header)?);
            out.push('\n');
        }
        for message in messages {
            let id = uuid::Uuid::new_v4().to_string();
            let line = Line::Message {
                id: id.clone(),
                parent_id: tail.clone(),
                timestamp: now_ms(),
                message: message.clone(),
            };
            out.push_str(&serde_json::to_string(&line)?);
            out.push('\n');
            tail = Some(id);
        }
        // One write per call: the lines of a batch land together or the batch is cut at a line.
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(out.as_bytes())?;
        file.sync_data()?;
        if let Some(t) = tail {
            tails.insert(conversation_id.to_string(), t);
        }
        Ok(())
    }

    pub fn read(&self, conversation_id: &str) -> Result<Loaded, StoreError> {
        let path = self.path(conversation_id);
        if !path.exists() {
            return Ok(Loaded {
                messages: Vec::new(),
                skipped: 0,
            });
        }
        let reader = BufReader::new(std::fs::File::open(&path)?);
        let (mut messages, mut skipped) = (Vec::new(), 0);
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Line>(&line) {
                Ok(Line::Message { message, .. }) => messages.push(message),
                Ok(Line::Session { .. }) => {}
                Err(_) => skipped += 1,
            }
        }
        Ok(Loaded { messages, skipped })
    }

    pub fn delete(&self, conversation_id: &str) -> Result<(), StoreError> {
        self.tails.lock().unwrap().remove(conversation_id);
        match std::fs::remove_file(self.path(conversation_id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

/// The id of the last readable message entry, to chain new ones to. A line cut short by a crash
/// does not parse and is passed over; the next append starts on a fresh line either way.
fn last_entry_id(path: &Path) -> Result<Option<String>, StoreError> {
    if !path.exists() {
        return Ok(None);
    }
    let mut tail = None;
    let reader = BufReader::new(std::fs::File::open(path)?);
    for line in reader.lines() {
        if let Ok(Line::Message { id, .. }) = serde_json::from_str::<Line>(&line?) {
            tail = Some(id);
        }
    }
    // A file whose last line has no newline (cut mid-write) would glue the next line onto it.
    if let Ok(bytes) = std::fs::read(path)
        && bytes.last().is_some_and(|b| *b != b'\n')
    {
        let mut f = OpenOptions::new().append(true).open(path)?;
        f.write_all(b"\n")?;
    }
    Ok(tail)
}
