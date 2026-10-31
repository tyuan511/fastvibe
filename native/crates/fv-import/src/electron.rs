//! Read-only Electron snapshots. SQLite is read in one transaction, including committed WAL
//! frames, with immutable mode deliberately avoided. No source path is opened for writing.
use crate::ImportError;
use serde_json::Value;
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub struct Snapshot {
    pub root: PathBuf,
    pub tables: BTreeMap<String, Vec<Value>>,
    pub files: BTreeMap<String, Vec<u8>>,
    /// Hashed for scan/commit consistency; never archived or returned to clients.
    pub api_keys: Vec<u8>,
}

pub fn snapshot(root: &Path) -> Result<Snapshot, ImportError> {
    let root = root.canonicalize()?;
    let mut tables = BTreeMap::new();
    let db = root.join("fastvibe.db");
    const MAX: u64 = 256 * 1024 * 1024;
    if [db.clone(), root.join("fastvibe.db-wal")]
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .sum::<u64>()
        > MAX
    {
        return Err(ImportError::InvalidPath("Electron database exceeds the 256 MiB migration snapshot limit; export a smaller dataset before migration".into()));
    }
    if db.is_file() {
        // SQLite's READ_ONLY may still create/update a WAL shared-memory sidecar. Copy db and
        // WAL first, then let SQLite recover the private copy. Detect a writer changing either
        // during the copy instead of silently losing committed WAL frames.
        let scratch = tempfile::tempdir()?;
        let copy = scratch.path().join("source.db");
        let db_before = std::fs::read(&db)?;
        let wal_path = root.join("fastvibe.db-wal");
        let wal_before = match std::fs::read(&wal_path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        std::fs::write(&copy, &db_before)?;
        std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o600))?;
        if let Some(wal) = &wal_before {
            std::fs::write(scratch.path().join("source.db-wal"), wal)?;
            std::fs::set_permissions(
                scratch.path().join("source.db-wal"),
                std::fs::Permissions::from_mode(0o600),
            )?;
        }
        let wal_after = match std::fs::read(&wal_path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if db_before != std::fs::read(&db)? || wal_before != wal_after {
            return Err(ImportError::InvalidPath(
                "Electron database changed during snapshot; close Electron and scan again".into(),
            ));
        }
        let connection = rusqlite::Connection::open(&copy)?;
        connection.execute_batch("PRAGMA query_only=ON; BEGIN DEFERRED;")?;
        // Preserve unsupported data explicitly instead of attempting a schema conversion.
        let names: Vec<String> = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
            .query_map([], |row| row.get(0))?.collect::<Result<_, _>>()?;
        let mut table_bytes = 0usize;
        for name in names {
            if ![
                "legacy_imports",
                "reasoning_blocks",
                "memory_outputs",
                "memory_empty",
                "memory_failures",
                "memory_meta",
                "checkpoints",
                "checkpoint_files",
                "projects",
                "conversations",
                "catalog_meta",
                "queue_items",
                "queue_state",
                "scheduled_tasks",
                "scheduled_runs",
                "schedule_meta",
                "dag_graphs",
                "dag_nodes",
                "dag_meta",
            ]
            .contains(&name.as_str())
            {
                return Err(ImportError::InvalidPath(format!(
                    "Unsupported Electron database table {name}; update the importer before migration"
                )));
            }
            let mut statement =
                connection.prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))?;
            let columns: Vec<String> = statement
                .column_names()
                .iter()
                .map(|s| s.to_string())
                .collect();
            let rows = statement
                .query_map([], |row| {
                    let mut object = serde_json::Map::new();
                    for (index, column) in columns.iter().enumerate() {
                        let value = match row.get_ref(index)? {
                            rusqlite::types::ValueRef::Null => Value::Null,
                            rusqlite::types::ValueRef::Integer(value) => value.into(),
                            rusqlite::types::ValueRef::Real(value) => serde_json::json!(value),
                            rusqlite::types::ValueRef::Text(value) => {
                                Value::String(String::from_utf8_lossy(value).into_owned())
                            }
                            rusqlite::types::ValueRef::Blob(value) => {
                                Value::Array(value.iter().map(|b| Value::from(*b)).collect())
                            }
                        };
                        object.insert(column.clone(), value);
                    }
                    Ok(Value::Object(object))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            table_bytes += serde_json::to_vec(&rows)
                .map_err(|e| ImportError::InvalidPath(e.to_string()))?
                .len();
            if table_bytes > MAX as usize {
                return Err(ImportError::InvalidPath(
                    "Electron table data exceeds the 256 MiB snapshot limit".into(),
                ));
            }
            tables.insert(name, rows);
        }
        connection.execute_batch("COMMIT;")?;
    }
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for name in [
        "settings.json",
        "providers.json",
        "conversations.json",
        "checkpoints.json",
        "dag.json",
        "message-queue.json",
        "scheduled-tasks.json",
        "runtime/engine/usage-ledger.jsonl",
    ] {
        let path = root.join(name);
        if path.is_file() {
            let size = std::fs::metadata(&path)?.len();
            if files.values().map(|bytes| bytes.len() as u64).sum::<u64>() + size
                > 256 * 1024 * 1024
            {
                return Err(ImportError::InvalidPath(
                    "Electron files exceed the 256 MiB snapshot limit; select a smaller source"
                        .into(),
                ));
            }
            files.insert(name.into(), read_inside(&root, &path)?);
        }
    }
    collect(
        &root,
        &root.join("runtime/engine/agent/sessions"),
        &mut files,
    )?;
    collect(&root, &root.join("dag.json.results"), &mut files)?;
    collect(&root, &root.join("runtime/engine/tool-images"), &mut files)?;
    for (name, bytes) in &files {
        if *bytes != read_inside(&root, &root.join(name))? {
            return Err(ImportError::InvalidPath(
                "Electron files changed during snapshot; close Electron and scan again".into(),
            ));
        }
    }
    let key_path = root.join("runtime/engine/agent/.env");
    let api_keys = if key_path.is_file() {
        read_inside(&root, &key_path)?
    } else {
        Vec::new()
    };
    if tables.is_empty() && !files.contains_key("conversations.json") {
        return Err(ImportError::InvalidPath(
            "Not an Electron FastVibe data directory".into(),
        ));
    }
    Ok(Snapshot {
        root,
        tables,
        files,
        api_keys,
    })
}

pub fn read_inside(root: &Path, path: &Path) -> Result<Vec<u8>, ImportError> {
    let path = path.canonicalize()?;
    if !path.starts_with(root) {
        return Err(ImportError::InvalidPath(
            "Source file leaves the Electron data directory".into(),
        ));
    }
    if std::fs::metadata(&path)?.len() > 256 * 1024 * 1024 {
        return Err(ImportError::InvalidPath(
            "Source file exceeds the 256 MiB migration limit".into(),
        ));
    }
    Ok(std::fs::read(path)?)
}

fn collect(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), ImportError> {
    if !dir.exists() {
        return Ok(());
    }
    if std::fs::symlink_metadata(dir)?.file_type().is_symlink() {
        return Err(ImportError::InvalidPath(
            "Migration folders cannot be symlinks".into(),
        ));
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(ImportError::InvalidPath(
                "Symlinks in migration data must be removed before migration".into(),
            ));
        }
        if kind.is_dir() {
            collect(root, &entry.path(), files)?;
        } else if kind.is_file() {
            let path = entry.path();
            let size = std::fs::metadata(&path)?.len();
            if files.values().map(|bytes| bytes.len() as u64).sum::<u64>() + size
                > 256 * 1024 * 1024
            {
                return Err(ImportError::InvalidPath(
                    "Electron files exceed the 256 MiB snapshot limit; select a smaller source"
                        .into(),
                ));
            }
            files.insert(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                read_inside(root, &path)?,
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_rejects_symlinks_and_oversized_files_without_allocating_them() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("conversations.json"), "{}").unwrap();
        let large = std::fs::File::create(dir.path().join("settings.json")).unwrap();
        large.set_len(256 * 1024 * 1024 + 1).unwrap();
        assert!(
            snapshot(dir.path())
                .err()
                .unwrap()
                .to_string()
                .contains("256 MiB")
        );
        std::fs::remove_file(dir.path().join("settings.json")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("dag.json.results")).unwrap();
        assert!(
            snapshot(dir.path())
                .err()
                .unwrap()
                .to_string()
                .contains("symlink")
        );
    }

    #[test]
    fn snapshot_includes_committed_wal_without_touching_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = rusqlite::Connection::open(dir.path().join("fastvibe.db")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE conversations(id TEXT,data TEXT); INSERT INTO conversations VALUES ('c','{}');").unwrap();
        let before = std::fs::read(dir.path().join("fastvibe.db")).unwrap();
        let wal = std::fs::read(dir.path().join("fastvibe.db-wal")).unwrap();
        let snap = snapshot(dir.path()).unwrap();
        assert_eq!(snap.tables["conversations"].len(), 1);
        assert_eq!(
            before,
            std::fs::read(dir.path().join("fastvibe.db")).unwrap()
        );
        assert_eq!(
            wal,
            std::fs::read(dir.path().join("fastvibe.db-wal")).unwrap()
        );
    }
}
