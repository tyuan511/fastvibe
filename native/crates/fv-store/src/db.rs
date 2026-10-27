use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::Mutex;

use fv_protocol::types::{ApiProtocol, ModelInfo, Thread};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    Sql(rusqlite::Error),
    Json(serde_json::Error),
    /// The database was written by a newer build; opening it could damage it.
    TooNew {
        found: i64,
        known: i64,
    },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "{e}"),
            StoreError::Sql(e) => write!(f, "{e}"),
            StoreError::Json(e) => write!(f, "{e}"),
            StoreError::TooNew { found, known } => write!(
                f,
                "this database is from a newer version of FastVibe (schema {found}, this build knows {known}); update the app"
            ),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}
impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sql(e)
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Json(e)
    }
}

/// Migrations in order; each runs once, in its own transaction. Numbers already used are never
/// removed or reused: the schema version is the index of the last step that ran.
const MIGRATIONS: &[&str] = &[
    // 1: the catalog. `data` is the whole record as JSON, so adding a field to a conversation
    // needs no migration; only what is queried or sorted on gets a column.
    "CREATE TABLE conversations (
         id         TEXT PRIMARY KEY,
         updated_at INTEGER NOT NULL,
         archived   INTEGER NOT NULL DEFAULT 0,
         data       TEXT NOT NULL
     );
     CREATE INDEX conversations_updated ON conversations(updated_at DESC);",
    // 2: model providers (their API keys are NOT here: they live in `credentials.json`) and a
    // small key-value table for settings such as the default model.
    "CREATE TABLE providers (
         id       TEXT PRIMARY KEY,
         position INTEGER NOT NULL,
         data     TEXT NOT NULL
     );
     CREATE TABLE settings (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
     );",
    // 3: prompts queued behind a reply, one row per prompt so reordering is an update and a
    // crash cannot rewrite a neighbour's entry. The pause flag sits beside them: a queue that
    // stopped on its own must not start draining again just because the app restarted.
    "CREATE TABLE queue_items (
         thread_id TEXT NOT NULL,
         id        TEXT NOT NULL,
         position  INTEGER NOT NULL,
         at        INTEGER NOT NULL,
         text      TEXT NOT NULL,
         PRIMARY KEY (thread_id, id)
     );
     CREATE TABLE queue_pauses (
         thread_id TEXT PRIMARY KEY,
         reason    TEXT NOT NULL DEFAULT 'failed'
     );",
    // 4: no foreign key to conversations: paid requests outlive deleted chats and rewinds.
    "CREATE TABLE usage_ledger (
         request_key TEXT PRIMARY KEY,
         thread_id TEXT NOT NULL,
         entry_id TEXT NOT NULL,
         at INTEGER NOT NULL,
         data TEXT NOT NULL
     );
     CREATE INDEX usage_ledger_at ON usage_ledger(at);",
    // 5: child threads share transcripts and usage, but have their own catalog and ownership.
    "CREATE TABLE subagents (
         agent_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
         parent_id TEXT NOT NULL,
         root_id TEXT NOT NULL,
         data TEXT NOT NULL
     );
     CREATE INDEX subagents_root ON subagents(root_id);",
    // 6: schedules and immutable run snapshots.
    "CREATE TABLE scheduled_tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL);
     CREATE TABLE scheduled_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,position INTEGER NOT NULL UNIQUE,status TEXT NOT NULL,data TEXT NOT NULL);
     CREATE INDEX scheduled_runs_task ON scheduled_runs(task_id,position DESC);
     CREATE UNIQUE INDEX scheduled_one_active ON scheduled_runs((1)) WHERE status='running';
     CREATE UNIQUE INDEX scheduled_one_queued ON scheduled_runs(task_id) WHERE status='queued';
     CREATE TABLE schedule_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);",

];

/// A provider as stored: everything but its key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProvider {
    pub id: String,
    pub name: String,
    pub protocol: ApiProtocol,
    pub base_url: String,
    pub enabled: bool,
    pub models: Vec<ModelInfo>,
}

/// A prompt waiting behind a reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedPrompt {
    pub id: String,
    pub text: String,
    pub at: i64,
}

pub struct Db {
    pub(crate) conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        // The file is private from its first byte: it names the user's projects.
        if !path.exists() {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let conn = Connection::open(path)?;
        // Order matters: `auto_vacuum` is ignored once the journal mode is WAL, and silently so.
        conn.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;",
        )?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    pub fn list_threads(&self, include_archived: bool) -> Result<Vec<Thread>, StoreError> {
        self.query_threads(include_archived, false)
    }

    /// Accounting must still resolve a child thread instead of labelling its usage deleted.
    pub fn list_threads_including_children(
        &self,
        include_archived: bool,
    ) -> Result<Vec<Thread>, StoreError> {
        self.query_threads(include_archived, true)
    }

    fn query_threads(
        &self,
        include_archived: bool,
        include_children: bool,
    ) -> Result<Vec<Thread>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT data FROM conversations WHERE (?1 OR archived = 0) AND (?2 OR NOT EXISTS (SELECT 1 FROM subagents WHERE agent_id = conversations.id)) ORDER BY updated_at DESC, id",
        )?;
        let rows = stmt.query_map(params![include_archived, include_children], |r| {
            r.get::<_, String>(0)
        })?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn get_thread(&self, id: &str) -> Result<Option<Thread>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let data: Option<String> = conn
            .query_row(
                "SELECT data FROM conversations WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    pub fn put_thread(&self, thread: &Thread) -> Result<(), StoreError> {
        let data = serde_json::to_string(thread)?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO conversations (id, updated_at, archived, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET updated_at = ?2, archived = ?3, data = ?4",
            params![thread.id, thread.updated_at, thread.archived, data],
        )?;
        Ok(())
    }

    pub fn delete_thread(&self, id: &str) -> Result<bool, StoreError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM queue_items WHERE thread_id = ?1", [id])?;
        tx.execute("DELETE FROM queue_pauses WHERE thread_id = ?1", [id])?;
        let removed = tx.execute("DELETE FROM conversations WHERE id = ?1", [id])? > 0;
        tx.commit()?;
        Ok(removed)
    }

    pub fn list_providers(&self) -> Result<Vec<StoredProvider>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT data FROM providers ORDER BY position, id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn get_provider(&self, id: &str) -> Result<Option<StoredProvider>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let data: Option<String> = conn
            .query_row(
                "SELECT data FROM providers WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    /// Create a provider (at the end of the list) or replace one (keeping its place).
    pub fn put_provider(&self, provider: &StoredProvider) -> Result<(), StoreError> {
        let data = serde_json::to_string(provider)?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO providers (id, position, data)
             VALUES (?1, COALESCE((SELECT MAX(position) + 1 FROM providers), 0), ?2)
             ON CONFLICT(id) DO UPDATE SET data = ?2",
            params![provider.id, data],
        )?;
        Ok(())
    }

    pub fn delete_provider(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM providers WHERE id = ?1", params![id])?
            > 0)
    }

    /// Put the providers in this order; ones not named keep their relative order after them.
    pub fn reorder_providers(&self, ids: &[String]) -> Result<(), StoreError> {
        let current: Vec<String> = self.list_providers()?.into_iter().map(|p| p.id).collect();
        let mut order: Vec<&String> = ids.iter().filter(|i| current.contains(i)).collect();
        for id in &current {
            if !order.contains(&id) {
                order.push(id);
            }
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (position, id) in order.into_iter().enumerate() {
            tx.execute(
                "UPDATE providers SET position = ?1 WHERE id = ?2",
                params![position as i64, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Set a setting; `None` removes it.
    pub fn set_setting(&self, key: &str, value: Option<&str>) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        match value {
            Some(v) => conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![key, v],
            )?,
            None => conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?,
        };
        Ok(())
    }

    pub fn queue(&self, thread_id: &str) -> Result<Vec<QueuedPrompt>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, text, at FROM queue_items WHERE thread_id = ?1 ORDER BY position, id",
        )?;
        let rows = stmt.query_map(params![thread_id], |r| {
            Ok(QueuedPrompt {
                id: r.get(0)?,
                text: r.get(1)?,
                at: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Why this thread's queue is standing still, if it is. Stored rather than inferred: a queue
    /// that stopped before the last restart must not start draining because the process changed.
    pub fn queue_pause(&self, thread_id: &str) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT reason FROM queue_pauses WHERE thread_id = ?1",
                params![thread_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn set_queue_pause(&self, thread_id: &str, reason: Option<&str>) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        match reason {
            Some(reason) => conn.execute(
                "INSERT INTO queue_pauses (thread_id, reason) SELECT ?1, ?2
                 WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?1)
                 ON CONFLICT(thread_id) DO UPDATE SET reason = ?2",
                params![thread_id, reason],
            )?,
            None => conn.execute(
                "DELETE FROM queue_pauses WHERE thread_id = ?1",
                params![thread_id],
            )?,
        };
        Ok(())
    }

    /// Append to the end of the queue.
    pub fn push_queued(&self, thread_id: &str, item: &QueuedPrompt) -> Result<(), StoreError> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO queue_items (thread_id, id, position, at, text)
             SELECT ?1, ?2, COALESCE((SELECT MAX(position) + 1 FROM queue_items WHERE thread_id = ?1), 0), ?3, ?4
             WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?1)",
            params![thread_id, item.id, item.at, item.text],
        )?;
        Ok(())
    }

    /// Put a prompt back at the front, for a send that could not happen after all.
    pub fn requeue_front(&self, thread_id: &str, item: &QueuedPrompt) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE queue_items SET position = position + 1 WHERE thread_id = ?1",
            params![thread_id],
        )?;
        tx.execute(
            "INSERT INTO queue_items (thread_id, id, position, at, text) SELECT ?1, ?2, 0, ?3, ?4
             WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?1)
             ON CONFLICT(thread_id, id) DO UPDATE SET position = 0",
            params![thread_id, item.id, item.at, item.text],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn remove_queued(&self, thread_id: &str, id: &str) -> Result<bool, StoreError> {
        Ok(self.conn.lock().unwrap().execute(
            "DELETE FROM queue_items WHERE thread_id = ?1 AND id = ?2",
            params![thread_id, id],
        )? > 0)
    }

    /// The most recently queued prompt, for a turn that starts with one.
    pub fn queued(&self, thread_id: &str, id: &str) -> Result<Option<QueuedPrompt>, StoreError> {
        Ok(self
            .queue(thread_id)?
            .into_iter()
            .find(|item| item.id == id))
    }

    /// Flush the write-ahead log into the main file; for a clean shutdown.
    pub fn checkpoint(&self) -> Result<(), StoreError> {
        self.conn
            .lock()
            .unwrap()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }
}

fn migrate(conn: &Connection) -> Result<(), StoreError> {
    let known = MIGRATIONS.len() as i64;
    let found: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if found > known {
        return Err(StoreError::TooNew { found, known });
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(found as usize) {
        let version = index as i64 + 1;
        // The version is read again inside the transaction: two processes opening a fresh
        // database at once must not both create its tables.
        let tx = conn.unchecked_transaction()?;
        let current: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current < version {
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", version)?;
        }
        tx.commit()?;
    }
    Ok(())
}
