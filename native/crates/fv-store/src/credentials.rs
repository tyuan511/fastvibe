use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::StoreError;

/// Provider API keys, in a file of their own (`credentials.json`, 0600).
///
/// Nothing in the protocol returns what is in here, and nothing in the database refers to it:
/// a key is written when the user sets it, read when a request to its provider is made, and
/// deleted with the provider. It is not in settings, which are handed to every client.
pub struct CredentialStore {
    pub(crate) path: PathBuf,
    pub(crate) lock: Mutex<()>,
    cached: Mutex<Option<Arc<File>>>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct File {
    version: u32,
    providers: BTreeMap<String, String>,
}

impl CredentialStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
            cached: Mutex::new(None),
        }
    }

    fn read_uncached(&self) -> Result<File, StoreError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(File::default()),
            Err(e) => Err(e.into()),
        }
    }

    fn read(&self) -> Result<Arc<File>, StoreError> {
        if let Some(file) = self.cached.lock().unwrap().clone() {
            return Ok(file);
        }
        let file = Arc::new(self.read_uncached()?);
        *self.cached.lock().unwrap() = Some(file.clone());
        Ok(file)
    }

    /// Replace the file in one step: a crash leaves the old keys or the new ones, never half.
    fn write(&self, mut file: File) -> Result<(), StoreError> {
        file.version = 1;
        let tmp = self.path.with_extension("json.tmp");
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        out.write_all(serde_json::to_string_pretty(&file)?.as_bytes())?;
        out.sync_all()?;
        std::fs::rename(&tmp, &self.path)?;
        *self.cached.lock().unwrap() = Some(Arc::new(file));
        Ok(())
    }

    pub(crate) fn invalidate_cache(&self) {
        *self.cached.lock().unwrap() = None;
    }

    pub fn get(&self, provider_id: &str) -> Result<Option<String>, StoreError> {
        let _g = self.lock.lock().unwrap();
        Ok(self
            .read()?
            .providers
            .get(provider_id)
            .filter(|k| !k.is_empty())
            .cloned())
    }

    pub fn has(&self, provider_id: &str) -> Result<bool, StoreError> {
        Ok(self.get(provider_id)?.is_some())
    }

    pub fn set(&self, provider_id: &str, key: &str) -> Result<(), StoreError> {
        let _g = self.lock.lock().unwrap();
        let mut file = (*self.read()?).clone();
        file.providers
            .insert(provider_id.to_string(), key.to_string());
        self.write(file)
    }

    pub fn remove(&self, provider_id: &str) -> Result<(), StoreError> {
        let _g = self.lock.lock().unwrap();
        let mut file = (*self.read()?).clone();
        if file.providers.remove(provider_id).is_some() {
            self.write(file)?;
        }
        Ok(())
    }
}
