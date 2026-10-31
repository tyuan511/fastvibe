//! Recoverable migration publication. The SQLite marker is the durable commit decision.
use crate::{Store, StoreError, StoredProvider, UsageRecord};
use fv_protocol::types::Thread;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MigrationFile {
    pub staged: PathBuf,
    pub target: PathBuf,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    marker: String,
    files: Vec<MigrationFile>,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
    keys: Vec<String>,
}

fn invalid(message: &str) -> StoreError {
    std::io::Error::other(message).into()
}
fn sync_dir(path: &Path) -> Result<(), StoreError> {
    std::fs::File::open(path)?.sync_all()?;
    Ok(())
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Missing publication parent"))?;
    std::fs::create_dir_all(parent)?;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    let temporary = parent.join(format!(".migration-{}", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&temporary, path)?;
    sync_dir(parent)
}
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, StoreError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn document(bytes: Option<&[u8]>) -> Result<serde_json::Value, StoreError> {
    Ok(match bytes {
        Some(bytes) => serde_json::from_slice(bytes)?,
        None => serde_json::json!({"version":1,"providers":{}}),
    })
}
fn cleanup_journal(root: &Path) -> Result<(), StoreError> {
    for name in [
        "credentials-before.json",
        "credentials-after.json",
        "pending.json",
    ] {
        match std::fs::remove_file(root.join(name)) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    sync_dir(root)
}

impl Store {
    /// Called during Store::open, before any caller can observe files or credentials.
    pub fn recover_migration(&self, data_dir: &Path) -> Result<(), StoreError> {
        let _credentials = self.credentials.lock.lock().unwrap();
        self.recover_migration_locked(data_dir)
    }
    fn recover_migration_locked(&self, data_dir: &Path) -> Result<(), StoreError> {
        let root = data_dir.join("migration-publication");
        let Some(bytes) = read_optional(&root.join("pending.json"))? else {
            return Ok(());
        };
        let journal: Journal = serde_json::from_slice(&bytes)?;
        for file in &journal.files {
            if !file.target.starts_with(data_dir) || !file.staged.starts_with(data_dir) {
                return Err(invalid("Migration recovery path leaves data directory"));
            }
        }
        if self.db.get_setting(&journal.marker)?.is_none() {
            // A file is ours only while it is the same inode as the retained staged file.
            for artifact in &journal.files {
                let source = std::fs::metadata(&artifact.staged).ok();
                let target = std::fs::metadata(&artifact.target).ok();
                if let (Some(source), Some(target)) = (source, target)
                    && source.dev() == target.dev()
                    && source.ino() == target.ino()
                {
                    std::fs::remove_file(&artifact.target)?;
                    sync_dir(artifact.target.parent().unwrap())?;
                }
            }
            if journal.after.is_some() {
                let current = read_optional(&self.credentials.path)?;
                let mut value = document(current.as_deref())?;
                let before = document(journal.before.as_deref())?;
                let after = document(journal.after.as_deref())?;
                for key in &journal.keys {
                    if value["providers"].get(key) == after["providers"].get(key) {
                        match before["providers"].get(key) {
                            Some(old) => {
                                value["providers"][key] = old.clone();
                            }
                            None => {
                                value["providers"]
                                    .as_object_mut()
                                    .ok_or_else(|| invalid("Invalid credential document"))?
                                    .remove(key);
                            }
                        }
                    }
                }
                if journal.before.is_none()
                    && value["providers"].as_object().is_some_and(|p| p.is_empty())
                {
                    if self.credentials.path.exists() {
                        std::fs::remove_file(&self.credentials.path)?;
                        sync_dir(data_dir)?;
                    }
                } else {
                    private_write(&self.credentials.path, &serde_json::to_vec(&value)?)?;
                }
            }
        }
        // Empty operation-owned folders may remain after a crash; never remove another
        // writer's contents, or an existing shared sessions/tool-images root.
        for file in &journal.files {
            if let Some(parent) = file.target.parent()
                && parent.parent() == Some(data_dir.join("tool-images").as_path())
            {
                match std::fs::remove_dir(parent) {
                    Ok(()) => sync_dir(parent.parent().unwrap())?,
                    Err(e)
                        if [
                            std::io::ErrorKind::NotFound,
                            std::io::ErrorKind::DirectoryNotEmpty,
                        ]
                        .contains(&e.kind()) => {}
                    Err(e) => return Err(e.into()),
                }
            }
        }
        // Recovery may have rewritten credentials directly, bypassing CredentialStore::write.
        // Drop the parsed snapshot before any subsequent provider lookup.
        self.credentials.invalidate_cache();
        cleanup_journal(&root)
    }

    /// Keys are fill-only: a native key is never overwritten by migration. File destinations
    /// must be absent; hard-link publication cannot replace an unrelated concurrent file.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_migration(
        &self,
        data_dir: &Path,
        marker: &str,
        files: &[MigrationFile],
        keys: &BTreeMap<String, String>,
        threads: &[Thread],
        providers: &[StoredProvider],
        settings: &[(String, String)],
        usage: &[UsageRecord],
    ) -> Result<usize, StoreError> {
        self.publish_migration_inner(
            data_dir,
            marker,
            files,
            keys,
            threads,
            providers,
            settings,
            usage,
            |_| Ok(()),
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn publish_migration_inner(
        &self,
        data_dir: &Path,
        marker: &str,
        files: &[MigrationFile],
        keys: &BTreeMap<String, String>,
        threads: &[Thread],
        providers: &[StoredProvider],
        settings: &[(String, String)],
        usage: &[UsageRecord],
        mut boundary: impl FnMut(&str) -> Result<(), StoreError>,
    ) -> Result<usize, StoreError> {
        let _credentials = self.credentials.lock.lock().unwrap();
        self.recover_migration_locked(data_dir)?;
        if self.db.get_setting(marker)?.is_some() {
            return Ok(0);
        }
        let before = read_optional(&self.credentials.path)?;
        let mut value = document(before.as_deref())?;
        let mut changed = Vec::new();
        for (id, key) in keys {
            if value["providers"]
                .get(id)
                .and_then(|v| v.as_str())
                .is_none_or(|v| v.is_empty())
                && !key.is_empty()
            {
                value["providers"][id] = key.clone().into();
                changed.push(id.clone());
            }
        }
        let after = if changed.is_empty() {
            None
        } else {
            Some(serde_json::to_vec(&value)?)
        };
        for file in files {
            if !file.target.starts_with(data_dir)
                || !file.staged.starts_with(data_dir)
                || file.target.exists()
            {
                return Err(invalid(
                    "Migration artifact destination conflicts with existing data",
                ));
            }
            std::fs::File::open(&file.staged)?.sync_all()?;
            sync_dir(file.staged.parent().unwrap())?;
        }
        let root = data_dir.join("migration-publication");
        std::fs::create_dir_all(&root)?;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        sync_dir(data_dir)?;
        if let Some(bytes) = &before {
            private_write(&root.join("credentials-before.json"), bytes)?;
        }
        if let Some(bytes) = &after {
            private_write(&root.join("credentials-after.json"), bytes)?;
        }
        let journal = Journal {
            marker: marker.into(),
            files: files.to_vec(),
            before,
            after,
            keys: changed.clone(),
        };
        private_write(&root.join("pending.json"), &serde_json::to_vec(&journal)?)?;
        // A test panic here mimics process death: the durable journal is recovered on open.
        let result = (|| {
            boundary("journal")?;
            for file in files {
                let parent = file.target.parent().unwrap();
                std::fs::create_dir_all(parent)?;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
                sync_dir(parent.parent().unwrap())?;
                std::fs::hard_link(&file.staged, &file.target)?;
                sync_dir(parent)?;
                boundary("artifact")?;
            }
            if let Some(bytes) = &journal.after {
                private_write(&self.credentials.path, bytes)?;
            }
            boundary("credentials")?;
            let mut settings = settings.to_vec();
            settings.push((marker.into(), "committed".into()));
            self.db
                .commit_migration(threads, providers, &settings, usage)?;
            boundary("database")?;
            Ok(changed.len())
        })();
        // Marker wins even if finalization fails: recovery must never undo committed rows.
        self.recover_migration_locked(data_dir)?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    fn fixture(root: &Path) -> (Store, Vec<MigrationFile>, BTreeMap<String, String>) {
        let store = Store::open(root).unwrap();
        store.credentials.set("existing", "native-key").unwrap();
        let stage = root.join("private-stage");
        std::fs::create_dir_all(&stage).unwrap();
        let files = [
            ("transcript", "sessions/imported.jsonl"),
            ("image", "tool-images/imported/image.png"),
        ]
        .into_iter()
        .map(|(name, target)| {
            let source = stage.join(name);
            private_write(&source, name.as_bytes()).unwrap();
            MigrationFile {
                staged: source,
                target: root.join(target),
            }
        })
        .collect();
        (
            store,
            files,
            BTreeMap::from([
                ("existing".into(), "must-not-replace".into()),
                ("new".into(), "imported-key".into()),
            ]),
        )
    }
    #[test]
    fn migration_errors_and_crashes_recover_at_each_publication_boundary() {
        for point in ["journal", "artifact", "credentials", "database"] {
            for crash in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let (store, files, keys) = fixture(dir.path());
                if crash {
                    let panicked = catch_unwind(AssertUnwindSafe(|| {
                        let _ = store.publish_migration_inner(
                            dir.path(),
                            "operation",
                            &files,
                            &keys,
                            &[],
                            &[],
                            &[("settings".into(), "value".into())],
                            &[],
                            |at| {
                                if at == point {
                                    panic!("simulated process death");
                                }
                                Ok(())
                            },
                        );
                    }));
                    assert!(panicked.is_err());
                } else {
                    assert!(
                        store
                            .publish_migration_inner(
                                dir.path(),
                                "operation",
                                &files,
                                &keys,
                                &[],
                                &[],
                                &[("settings".into(), "value".into())],
                                &[],
                                |at| if at == point {
                                    Err(invalid("injected failure"))
                                } else {
                                    Ok(())
                                }
                            )
                            .is_err()
                    );
                }
                drop(store);
                let reopened = Store::open(dir.path()).unwrap();
                assert_eq!(
                    reopened.credentials.get("existing").unwrap().as_deref(),
                    Some("native-key")
                );
                let committed = point == "database";
                assert_eq!(reopened.credentials.has("new").unwrap(), committed);
                for file in &files {
                    assert_eq!(file.target.exists(), committed, "{point} crash={crash}");
                }
                assert_eq!(
                    reopened.db.get_setting("settings").unwrap().is_some(),
                    committed
                );
                assert!(
                    !dir.path()
                        .join("migration-publication/pending.json")
                        .exists()
                );
                let count = reopened
                    .publish_migration(
                        dir.path(),
                        "operation",
                        &files,
                        &keys,
                        &[],
                        &[],
                        &[("settings".into(), "value".into())],
                        &[],
                    )
                    .unwrap();
                assert_eq!(count, usize::from(!committed));
                assert_eq!(
                    reopened.credentials.get("new").unwrap().as_deref(),
                    Some("imported-key")
                );
            }
        }
    }
    #[test]
    fn migration_database_failure_rolls_back_keys_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let (store, files, keys) = fixture(dir.path());
        store.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_migration BEFORE INSERT ON settings BEGIN SELECT RAISE(FAIL,'injected database failure'); END;").unwrap();
        assert!(
            store
                .publish_migration(dir.path(), "operation", &files, &keys, &[], &[], &[], &[])
                .is_err()
        );
        assert!(!store.credentials.has("new").unwrap());
        assert!(files.iter().all(|f| !f.target.exists()));
        assert_eq!(
            store.credentials.get("existing").unwrap().as_deref(),
            Some("native-key")
        );
    }
    #[test]
    fn migration_recovery_preserves_replaced_artifact_and_newer_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let (store, files, keys) = fixture(dir.path());
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _ = store.publish_migration_inner(
                dir.path(),
                "operation",
                &files,
                &keys,
                &[],
                &[],
                &[],
                &[],
                |at| {
                    if at == "credentials" {
                        panic!("crash");
                    }
                    Ok(())
                },
            );
        }));
        private_write(&files[0].target, b"unrelated replacement").unwrap();
        private_write(&dir.path().join("credentials.json"),br#"{"version":1,"providers":{"existing":"native-key","new":"newer-native-key","other":"untouched"}}"#).unwrap();
        drop(store);
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(
            std::fs::read(&files[0].target).unwrap(),
            b"unrelated replacement"
        );
        assert!(!files[1].target.exists());
        assert_eq!(
            store.credentials.get("new").unwrap().as_deref(),
            Some("newer-native-key")
        );
        assert_eq!(
            store.credentials.get("other").unwrap().as_deref(),
            Some("untouched")
        );
    }
    #[test]
    fn migration_rejects_existing_targets_without_changing_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let (store, files, keys) = fixture(dir.path());
        private_write(&files[0].target, b"native").unwrap();
        assert!(
            store
                .publish_migration(dir.path(), "operation", &files, &keys, &[], &[], &[], &[])
                .is_err()
        );
        assert_eq!(std::fs::read(&files[0].target).unwrap(), b"native");
        assert!(!store.credentials.has("new").unwrap());
    }
}
