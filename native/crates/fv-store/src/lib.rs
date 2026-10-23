//! What the server keeps on disk: a SQLite database for the catalog (what conversations
//! exist) and one append-only JSONL file per conversation for what was said in it.
//!
//! The split follows the Electron app's: data that is queried and reordered lives in the
//! database; a transcript is a log that only grows, so it stays a file that a crash can at
//! worst cut short.

mod credentials;
mod db;
mod history;
mod images;
mod transcript;

pub use credentials::CredentialStore;
pub use db::{Db, StoreError, StoredProvider};
pub use history::turns_from_history;
pub use images::ImageStore;
pub use transcript::{Loaded, TranscriptStore};

use std::path::Path;

/// Both halves, opened on one data directory.
pub struct Store {
    pub db: Db,
    pub transcripts: TranscriptStore,
    pub images: ImageStore,
    pub credentials: CredentialStore,
}

impl Store {
    pub fn open(data_dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(data_dir)?;
        Ok(Self {
            db: Db::open(&data_dir.join("fastvibe.db"))?,
            transcripts: TranscriptStore::new(data_dir.join("sessions"))?,
            images: ImageStore::new(data_dir.join("tool-images"))?,
            credentials: CredentialStore::new(data_dir.join("credentials.json")),
        })
    }
}
