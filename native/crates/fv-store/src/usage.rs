//! Raw request accounting, independent of active history and conversation deletion.
//! Prices are deliberately absent: the server re-prices records with the current catalog.

use fv_core::{AssistantMessage, Usage};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::{Db, StoreError};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOrigin {
    pub thread_id: String,
    pub entry_id: String,
}

impl UsageOrigin {
    pub(crate) fn key(&self) -> String {
        if self.entry_id.starts_with("turn:") {
            self.entry_id.clone()
        } else {
            format!("{}\0{}", self.thread_id, self.entry_id)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub origin: UsageOrigin,
    pub at: i64,
    pub model: Option<String>,
    pub usage: Usage,
    pub tool_calls: u64,
}

impl UsageRecord {
    pub fn assistant(origin: UsageOrigin, at: i64, reply: &AssistantMessage) -> Self {
        Self {
            origin,
            at,
            model: reply.model.clone(),
            usage: reply.usage.clone(),
            tool_calls: reply.tool_calls().count() as u64,
        }
    }
}

impl Db {
    pub fn record_usage(&self, records: &[UsageRecord]) -> Result<(), StoreError> {
        if records.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().unwrap();
        // The ledger may become the only copy when a transcript is unlinked. Its commit
        // must sync the WAL before deletion can succeed, including the no-op backfill path.
        conn.pragma_update(None, "synchronous", "FULL")?;
        let transaction = conn.transaction()?;
        {
            let mut insert = transaction.prepare_cached("INSERT OR IGNORE INTO usage_ledger (request_key, thread_id, entry_id, at, data) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for record in records {
                insert.execute(params![
                    record.origin.key(),
                    record.origin.thread_id,
                    record.origin.entry_id,
                    record.at,
                    serde_json::to_string(record)?
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn usage_records(&self) -> Result<Vec<UsageRecord>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut query =
            conn.prepare("SELECT data FROM usage_ledger ORDER BY at, thread_id, entry_id")?;
        query
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect()
    }
}
