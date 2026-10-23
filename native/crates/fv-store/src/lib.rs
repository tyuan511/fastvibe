//! What the server keeps on disk: a SQLite database for the catalog (what conversations
//! exist) and one append-only JSONL file per conversation for what was said in it.
//!
//! The split follows the Electron app's: data that is queried and reordered lives in the
//! database; a transcript is a log that only grows, so it stays a file that a crash can at
//! worst cut short.

mod db;
mod history;
mod transcript;

pub use db::{Db, StoreError};
pub use history::turns_from_history;
pub use transcript::{Loaded, TranscriptStore};

use std::path::Path;

/// Both halves, opened on one data directory.
pub struct Store {
    pub db: Db,
    pub transcripts: TranscriptStore,
}

impl Store {
    pub fn open(data_dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(data_dir)?;
        Ok(Self {
            db: Db::open(&data_dir.join("fastvibe.db"))?,
            transcripts: TranscriptStore::new(data_dir.join("sessions"))?,
        })
    }
}
