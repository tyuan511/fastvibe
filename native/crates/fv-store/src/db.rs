use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::Mutex;

use fv_protocol::types::Thread;
use rusqlite::{Connection, OptionalExtension, params};

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
];

pub struct Db {
    conn: Mutex<Connection>,
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
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT data FROM conversations WHERE (?1 OR archived = 0) ORDER BY updated_at DESC, id",
        )?;
        let rows = stmt.query_map(params![include_archived], |r| r.get::<_, String>(0))?;
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
        Ok(self
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM conversations WHERE id = ?1", params![id])?
            > 0)
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
