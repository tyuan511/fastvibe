//! What the server keeps on disk: a SQLite database for the catalog (what conversations
//! exist) and one append-only JSONL file per conversation for what was said in it.
//!
//! The split follows the Electron app's: data that is queried and reordered lives in the
//! database; a transcript is a log that only grows, so it stays a file that a crash can at
//! worst cut short.

mod checkpoint;
mod credentials;
mod db;
mod history;
mod images;
mod search;
mod stats;
mod transcript;
mod turn_record;
mod usage;
pub use usage::{UsageOrigin, UsageRecord};

pub use checkpoint::{Checkpoint, Restored, capture, clear, restore};
pub use credentials::CredentialStore;
pub use db::{Db, QueuedPrompt, StoreError, StoredProvider};
pub use history::{turns_from_history, turns_from_timed_history};
pub use images::ImageStore;
pub use search::search_snippet;
pub use stats::{record_stats, stats_from_history};
pub use transcript::{Loaded, TranscriptStore};
pub use turn_record::RecordedError;

use std::path::Path;

/// Both halves, opened on one data directory.
pub struct Store {
    pub db: std::sync::Arc<Db>,
    pub transcripts: TranscriptStore,
    pub images: ImageStore,
    pub credentials: CredentialStore,
}

impl Store {
    pub fn open(data_dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(data_dir)?;
        let db = std::sync::Arc::new(Db::open(&data_dir.join("fastvibe.db"))?);
        let transcripts = TranscriptStore::with_usage(data_dir.join("sessions"), db.clone())?;
        Ok(Self {
            db,
            transcripts,
            images: ImageStore::new(data_dir.join("tool-images"))?,
            credentials: CredentialStore::new(data_dir.join("credentials.json")),
        })
    }
}
