use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fv_core::Message;
use fv_protocol::types::TurnStatus;
use serde::{Deserialize, Serialize};

use crate::StoreError;
use crate::turn_record::{RecordedError, TurnRecord};

/// A conversation's transcript: `sessions/<id>.jsonl`. The first line is a header; every other
/// line is one message, linked to the one before it by `parentId`. The file is only ever
/// appended to, so a crash can cut the last line short but cannot damage an earlier one.
pub struct TranscriptStore {
    dir: PathBuf,
    /// The id of the last entry of each transcript touched this run, to link the next one to.
    tails: Mutex<Tails>,
}

#[derive(Default)]
struct Tails {
    ids: HashMap<String, String>,
    // Turn cancellation can finish after catalog deletion. Such a late completion must
    // not recreate the transcript that was just removed.
    deleted: HashSet<String>,
}

impl Tails {
    fn check_live(&self, id: &str) -> Result<(), StoreError> {
        if self.deleted.contains(id) {
            Err(
                std::io::Error::new(std::io::ErrorKind::NotFound, "the conversation was deleted")
                    .into(),
            )
        } else {
            Ok(())
        }
    }
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
    /// Everything from message `keep` on is superseded: a retry or an edit rewrote the history
    /// from that point. The messages are *not* deleted — the file stays append-only, so a crash
    /// still cannot damage an earlier line — and a reader drops what follows from `keep` on.
    #[serde(rename_all = "camelCase")]
    Rewind {
        keep: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before_turn: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TurnStarted { turn_id: String, timestamp: i64 },
    #[serde(rename_all = "camelCase")]
    TurnCompleted {
        turn_id: String,
        timestamp: i64,
        status: TurnStatus,
        error: Option<RecordedError>,
    },
}

pub struct Loaded {
    pub messages: Vec<Message>,
    /// When each message was written, milliseconds since the epoch (parallel to `messages`).
    pub timestamps: Vec<i64>,
    /// Lines that could not be read and were skipped (at most the last one, after a crash,
    /// unless the file was edited by hand).
    pub skipped: usize,
    pub(crate) turn_records: Vec<TurnRecord>,
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

    /// Scan one line at a time: do not load a large transcript into a search index or hydrate
    /// a runtime. Private thoughts, tool arguments, image data and compaction summaries are
    /// deliberately excluded; the original visible messages remain searchable after compaction.
    pub fn search(&self, conversation_id: &str, query: &str) -> Result<Option<String>, StoreError> {
        let file = match std::fs::File::open(self.path(conversation_id)) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        for line in BufReader::new(file).lines() {
            let line = line?;
            let Ok(Line::Message { message, .. }) = serde_json::from_str::<Line>(&line) else {
                continue;
            };
            let hit = match &message {
                Message::User { text } => crate::search_snippet(text, query),
                Message::Assistant(a) => a.content.iter().find_map(|b| match b {
                    fv_core::ContentBlock::Text { text } => {
                        crate::search_snippet(&fv_core::strip_memory_citation(text), query)
                    }
                    _ => None,
                }),
                Message::ToolResult { content, .. } => crate::search_snippet(content, query),
                _ => None,
            };
            if hit.is_some() {
                return Ok(hit);
            }
        }
        Ok(None)
    }

    pub fn append(&self, conversation_id: &str, messages: &[Message]) -> Result<(), StoreError> {
        self.append_timed(conversation_id, messages, &vec![now_ms(); messages.len()])
    }

    pub fn start_turn(&self, conversation_id: &str, turn_id: &str) -> Result<(), StoreError> {
        self.start_turn_at(conversation_id, turn_id, now_ms())
    }

    fn start_turn_at(
        &self,
        conversation_id: &str,
        turn_id: &str,
        timestamp: i64,
    ) -> Result<(), StoreError> {
        self.append_record(
            conversation_id,
            Line::TurnStarted {
                turn_id: turn_id.into(),
                timestamp,
            },
        )
    }

    pub fn finish_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
        status: TurnStatus,
        error: Option<RecordedError>,
    ) -> Result<(), StoreError> {
        self.append_record(
            conversation_id,
            Line::TurnCompleted {
                turn_id: turn_id.into(),
                timestamp: now_ms(),
                status,
                error,
            },
        )
    }

    /// Copy active history and its boundaries together. Forks must not silently discard an
    /// error or turn a steer into a separate user turn. Picture paths may have been remapped.
    pub fn copy_loaded(
        &self,
        conversation_id: &str,
        loaded: &Loaded,
        messages: &[Message],
    ) -> Result<(), StoreError> {
        assert_eq!(messages.len(), loaded.messages.len());
        let mut cursor = 0;
        for record in &loaded.turn_records {
            self.append_timed(
                conversation_id,
                &messages[cursor..record.start],
                &loaded.timestamps[cursor..record.start],
            )?;
            self.start_turn_at(conversation_id, &record.id, record.started_at)?;
            self.append_timed(
                conversation_id,
                &messages[record.start..record.end],
                &loaded.timestamps[record.start..record.end],
            )?;
            if let Some(timestamp) = record.completed_at {
                self.append_record(
                    conversation_id,
                    Line::TurnCompleted {
                        turn_id: record.id.clone(),
                        timestamp,
                        status: record.status,
                        error: record.error.clone(),
                    },
                )?;
            }
            cursor = record.end;
        }
        self.append_timed(
            conversation_id,
            &messages[cursor..],
            &loaded.timestamps[cursor..],
        )
    }

    fn append_record(&self, conversation_id: &str, record: Line) -> Result<(), StoreError> {
        let guard = self.tails.lock().unwrap();
        guard.check_live(conversation_id)?;
        let path = self.path(conversation_id);
        // Repair a torn final line even when the same process previously touched the file.
        ensure_newline(&path)?;
        let mut out = String::new();
        if !path.exists() {
            out.push_str(&serde_json::to_string(&Line::Session {
                version: 1,
                id: conversation_id.into(),
                created_at: now_ms(),
            })?);
            out.push('\n');
        }
        out.push_str(&serde_json::to_string(&record)?);
        out.push('\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(out.as_bytes())?;
        file.sync_data()?;
        Ok(())
    }

    /// Copying history preserves the original message times.
    pub fn append_timed(
        &self,
        conversation_id: &str,
        messages: &[Message],
        timestamps: &[i64],
    ) -> Result<(), StoreError> {
        assert_eq!(messages.len(), timestamps.len());
        if messages.is_empty() {
            return Ok(());
        }
        let path = self.path(conversation_id);
        let mut tails = self.tails.lock().unwrap();
        tails.check_live(conversation_id)?;
        let mut tail = match tails.ids.get(conversation_id) {
            Some(t) => Some(t.clone()),
            None => last_entry_id(&path)?,
        };
        ensure_newline(&path)?;

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
        for (message, timestamp) in messages.iter().zip(timestamps) {
            let id = uuid::Uuid::new_v4().to_string();
            let line = Line::Message {
                id: id.clone(),
                parent_id: tail.clone(),
                timestamp: *timestamp,
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
            tails.ids.insert(conversation_id.to_string(), t);
        }
        Ok(())
    }

    /// Cut the history back to its first `keep` messages: the turn at that point is about to be
    /// run again (a retry) or re-sent with new words (an edit). The record is a marker rather
    /// than a smaller file, so the earlier lines stay exactly as they were written.
    pub fn rewind(&self, conversation_id: &str, keep: usize) -> Result<(), StoreError> {
        self.rewind_before(conversation_id, keep, None)
    }

    pub fn rewind_before(
        &self,
        conversation_id: &str,
        keep: usize,
        before_turn: Option<&str>,
    ) -> Result<(), StoreError> {
        let mut tails = self.tails.lock().unwrap();
        tails.check_live(conversation_id)?;
        let path = self.path(conversation_id);
        if !path.exists() {
            return Err(StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "there is no transcript to rewind",
            )));
        }
        ensure_newline(&path)?;
        let mut out = serde_json::to_string(&Line::Rewind {
            keep,
            before_turn: before_turn.map(str::to_owned),
        })?;
        out.push('\n');
        let mut file = OpenOptions::new().append(true).open(&path)?;
        file.write_all(out.as_bytes())?;
        file.sync_data()?;
        // The next message chains to the last one kept, not to a line the marker dropped.
        tails.ids.remove(conversation_id);
        Ok(())
    }

    pub fn read(&self, conversation_id: &str) -> Result<Loaded, StoreError> {
        let path = self.path(conversation_id);
        if !path.exists() {
            return Ok(Loaded {
                messages: Vec::new(),
                timestamps: Vec::new(),
                skipped: 0,
                turn_records: Vec::new(),
            });
        }
        let reader = BufReader::new(std::fs::File::open(&path)?);
        let (mut messages, mut timestamps, mut skipped) = (Vec::new(), Vec::new(), 0);
        let mut turn_records: Vec<TurnRecord> = Vec::new();
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Line>(&line) {
                Ok(Line::Message {
                    message, timestamp, ..
                }) => {
                    messages.push(message);
                    timestamps.push(timestamp);
                    if let Some(record) = turn_records.last_mut()
                        && record.completed_at.is_none()
                    {
                        record.end = messages.len();
                    }
                }
                Ok(Line::Rewind { keep, before_turn }) => {
                    messages.truncate(keep);
                    timestamps.truncate(keep);
                    if let Some(index) = before_turn
                        .as_deref()
                        .and_then(|id| turn_records.iter().position(|r| r.id == id))
                    {
                        turn_records.truncate(index);
                    } else {
                        turn_records.retain(|r| r.start < keep);
                    }
                    for record in &mut turn_records {
                        if record.end > keep {
                            record.end = keep;
                            record.completed_at = None;
                            record.status = TurnStatus::Interrupted;
                            record.error = None;
                        }
                    }
                }
                Ok(Line::TurnStarted { turn_id, timestamp }) => turn_records.push(TurnRecord {
                    id: turn_id,
                    start: messages.len(),
                    end: messages.len(),
                    started_at: timestamp,
                    completed_at: None,
                    status: TurnStatus::Interrupted,
                    error: None,
                }),
                Ok(Line::TurnCompleted {
                    turn_id,
                    timestamp,
                    status,
                    error,
                }) => {
                    if let Some(record) = turn_records.last_mut()
                        && record.id == turn_id
                        && record.completed_at.is_none()
                    {
                        record.end = messages.len();
                        record.completed_at = Some(timestamp);
                        record.status = status;
                        record.error = error;
                    }
                }
                Ok(Line::Session { .. }) => {}
                Err(_) => skipped += 1,
            }
        }
        Ok(Loaded {
            messages,
            timestamps,
            skipped,
            turn_records,
        })
    }

    pub fn delete(&self, conversation_id: &str) -> Result<(), StoreError> {
        let mut tails = self.tails.lock().unwrap();
        match std::fs::remove_file(self.path(conversation_id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => {
                tails.ids.remove(conversation_id);
                tails.deleted.insert(conversation_id.into());
                Ok(())
            }
        }
    }
}

/// The id of the last readable message entry, to chain new ones to. A line cut short by a crash
/// does not parse and is passed over; the next append starts on a fresh line either way.
fn last_entry_id(path: &Path) -> Result<Option<String>, StoreError> {
    if !path.exists() {
        return Ok(None);
    }
    // A file whose last line has no newline (cut mid-write) would glue the next line onto it.
    ensure_newline(path)?;
    // The ids in the order they were written, cut back wherever a rewind marker says so: a new
    // message chains to the last one that survived, or the branch it was written for is
    // unreachable from the file's leaf.
    let mut ids: Vec<String> = Vec::new();
    let reader = BufReader::new(std::fs::File::open(path)?);
    for line in reader.lines() {
        match serde_json::from_str::<Line>(&line?) {
            Ok(Line::Message { id, .. }) => ids.push(id),
            Ok(Line::Rewind { keep, .. }) => ids.truncate(keep),
            _ => {}
        }
    }
    Ok(ids.pop())
}

fn ensure_newline(path: &Path) -> Result<(), StoreError> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match OpenOptions::new().read(true).append(true).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if file.metadata()?.len() > 0 {
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            file.write_all(b"\n")?;
        }
    }
    Ok(())
}
