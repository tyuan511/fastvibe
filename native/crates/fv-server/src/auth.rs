use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const FILE_VERSION: u32 = 1;
const HASH_ROUNDS: u32 = 15;
const MAX_FAILURES: u32 = 8;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccessFile {
    version: u32,
    password: Option<PasswordHash>,
    devices: Vec<Device>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PasswordHash {
    salt: String,
    digest: String,
    rounds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    label: String,
    token_digest: String,
    created_at: u64,
    last_seen_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedDevice {
    pub id: String,
    pub label: String,
}

#[derive(Debug)]
pub enum AuthError {
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidPassword,
    RateLimited(Duration),
    NotConfigured,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::InvalidPassword => write!(f, "invalid password"),
            Self::RateLimited(wait) => write!(
                f,
                "too many login attempts; retry in {}s",
                wait.as_secs().max(1)
            ),
            Self::NotConfigured => write!(f, "remote access password is not configured"),
        }
    }
}

impl std::error::Error for AuthError {}
impl From<std::io::Error> for AuthError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<serde_json::Error> for AuthError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Default)]
struct FailureState {
    started: Option<Instant>,
    next_allowed: Option<Instant>,
    count: u32,
}

/// Passwords and device tokens are kept outside settings and never returned from the server.
/// The file is rewritten atomically with mode 0600 on every credential mutation.
pub struct AuthStore {
    path: PathBuf,
    state: Mutex<AccessFile>,
    failures: Mutex<FailureState>,
    login_gate: Mutex<()>,
}

impl AuthStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AuthError> {
        let path = path.as_ref().to_path_buf();
        let state = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AccessFile {
                version: FILE_VERSION,
                password: None,
                devices: Vec::new(),
            },
            Err(error) => return Err(error.into()),
        };
        if state.version != FILE_VERSION {
            return Err(AuthError::Json(serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unsupported remote access file version",
            ))));
        }
        if state.password.as_ref().is_some_and(|hash| {
            hash.rounds != HASH_ROUNDS
                || URL_SAFE_NO_PAD
                    .decode(&hash.salt)
                    .map_or(true, |bytes| bytes.len() != 16)
                || URL_SAFE_NO_PAD
                    .decode(&hash.digest)
                    .map_or(true, |bytes| bytes.len() != 32)
        }) || state.devices.len() > 128
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid remote credential file",
            )
            .into());
        }
        Ok(Self {
            path,
            state: Mutex::new(state),
            failures: Mutex::new(FailureState::default()),
            login_gate: Mutex::new(()),
        })
    }

    pub fn configured(&self) -> bool {
        self.state.lock().unwrap().password.is_some()
    }

    pub fn set_password(&self, password: &str) -> Result<(), AuthError> {
        if password.is_empty() || password.len() > 1024 {
            return Err(AuthError::InvalidPassword);
        }
        let salt = random_bytes(16);
        let hash = PasswordHash {
            salt: URL_SAFE_NO_PAD.encode(&salt),
            digest: URL_SAFE_NO_PAD.encode(derive(password.as_bytes(), &salt, HASH_ROUNDS)),
            rounds: HASH_ROUNDS,
        };
        let mut state = self.state.lock().unwrap();
        let mut next = state.clone();
        next.password = Some(hash);
        next.devices.clear();
        self.write_locked(&next)?;
        *state = next;
        Ok(())
    }

    pub fn clear_password(&self) -> Result<(), AuthError> {
        let mut state = self.state.lock().unwrap();
        let mut next = state.clone();
        next.password = None;
        next.devices.clear();
        self.write_locked(&next)?;
        *state = next;
        Ok(())
    }

    /// Exchange a password for a revocable device token. The plaintext token only exists in the
    /// return value and is never written to disk.
    pub fn login(
        &self,
        password: &str,
        label: &str,
    ) -> Result<(String, AuthenticatedDevice), AuthError> {
        // Only blocking login workers take this gate. Reactor-side token/status reads never
        // wait for the password derivation, and concurrent guesses still share one throttle.
        let _login = self.login_gate.lock().unwrap();
        self.check_rate_limit()?;
        if password.len() > 1024 || label.len() > 256 {
            return Err(AuthError::InvalidPassword);
        }
        let stored = {
            let state = self.state.lock().unwrap();
            if state.devices.len() >= 128 {
                return Err(AuthError::InvalidPassword);
            }
            state.password.clone().ok_or(AuthError::NotConfigured)?
        };
        let salt = URL_SAFE_NO_PAD
            .decode(stored.salt.as_bytes())
            .map_err(|_| AuthError::InvalidPassword)?;
        let actual = derive(password.as_bytes(), &salt, stored.rounds);
        let expected = URL_SAFE_NO_PAD
            .decode(stored.digest.as_bytes())
            .map_err(|_| AuthError::InvalidPassword)?;
        if !constant_time_eq(&actual, &expected) {
            self.record_failure();
            return Err(AuthError::InvalidPassword);
        }
        let mut state = self.state.lock().unwrap();
        if state.password.as_ref() != Some(&stored) || state.devices.len() >= 128 {
            return Err(AuthError::InvalidPassword);
        }
        self.clear_failures();
        let token = format!("fv_{}", Uuid::new_v4().simple());
        let now = now_secs();
        let device = Device {
            id: Uuid::new_v4().to_string(),
            label: clean_label(label),
            token_digest: digest(token.as_bytes()),
            created_at: now,
            last_seen_at: now,
        };
        let public = AuthenticatedDevice {
            id: device.id.clone(),
            label: device.label.clone(),
        };
        let mut next = state.clone();
        next.devices.push(device);
        self.write_locked(&next)?;
        *state = next;
        Ok((token, public))
    }

    pub fn authenticate(&self, token: &str) -> Option<AuthenticatedDevice> {
        if token.is_empty() {
            return None;
        }
        let mut state = self.state.lock().unwrap();
        let digest = digest(token.as_bytes());
        let device = state
            .devices
            .iter_mut()
            .find(|device| constant_time_eq(device.token_digest.as_bytes(), digest.as_bytes()))?;
        device.last_seen_at = now_secs();
        Some(AuthenticatedDevice {
            id: device.id.clone(),
            label: device.label.clone(),
        })
    }

    pub fn revoke(&self, id: &str) -> Result<bool, AuthError> {
        let mut state = self.state.lock().unwrap();
        let mut next = state.clone();
        let before = next.devices.len();
        next.devices.retain(|device| device.id != id);
        if next.devices.len() == before {
            return Ok(false);
        }
        self.write_locked(&next)?;
        *state = next;
        Ok(true)
    }

    pub fn devices(&self) -> Vec<AuthenticatedDevice> {
        self.state
            .lock()
            .unwrap()
            .devices
            .iter()
            .map(|device| AuthenticatedDevice {
                id: device.id.clone(),
                label: device.label.clone(),
            })
            .collect()
    }

    fn check_rate_limit(&self) -> Result<(), AuthError> {
        let state = self.failures.lock().unwrap();
        if let Some(next) = state.next_allowed {
            let remaining = next.saturating_duration_since(Instant::now());
            if !remaining.is_zero() {
                return Err(AuthError::RateLimited(remaining));
            }
        }
        Ok(())
    }

    fn record_failure(&self) {
        let mut state = self.failures.lock().unwrap();
        if state
            .started
            .is_none_or(|started| started.elapsed() >= FAILURE_WINDOW)
        {
            state.started = Some(Instant::now());
            state.count = 0;
        }
        state.count = state.count.saturating_add(1);
        if state.count >= MAX_FAILURES {
            let wait = Duration::from_millis(
                250u64
                    .saturating_mul(2u64.saturating_pow(state.count.saturating_sub(MAX_FAILURES))),
            )
            .min(MAX_BACKOFF);
            state.next_allowed = Some(Instant::now() + wait);
        }
    }

    fn clear_failures(&self) {
        *self.failures.lock().unwrap() = FailureState::default();
    }

    fn write_locked(&self, state: &AccessFile) -> Result<(), AuthError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let temp = self.path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(state)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(temp, &self.path)?;
        Ok(())
    }
}

fn random_bytes(length: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(length);
    while out.len() < length {
        out.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    out.truncate(length);
    out
}

fn derive(password: &[u8], salt: &[u8], rounds: u32) -> [u8; 32] {
    let mut result = [0; 32];
    // Fixed bounded work factor; a corrupt credential file cannot choose an allocation size.
    if rounds != HASH_ROUNDS {
        return result;
    }
    let params = scrypt::Params::new(15, 8, 1, 32).expect("fixed scrypt parameters");
    scrypt::scrypt(password, salt, &params, &mut result).expect("fixed output length");
    result
}

fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b)
        .fold(0u8, |different, (left, right)| different | (left ^ right))
        == 0
}

fn clean_label(label: &str) -> String {
    let label = label.trim();
    if label.is_empty() {
        "FastVibe client".into()
    } else {
        label.chars().take(64).collect()
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_file_contains_only_hashes_and_tokens_are_revocable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        let store = AuthStore::open(&path).unwrap();
        store.set_password("correct horse").unwrap();
        let (token, device) = store.login("correct horse", "phone").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("correct horse"));
        assert!(!text.contains(&token));
        assert_eq!(store.authenticate(&token), Some(device.clone()));
        assert!(store.revoke(&device.id).unwrap());
        assert_eq!(store.authenticate(&token), None);
    }

    #[test]
    fn wrong_passwords_are_throttled() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuthStore::open(dir.path().join("access.json")).unwrap();
        store.set_password("secret").unwrap();
        for _ in 0..MAX_FAILURES {
            assert!(matches!(
                store.login("wrong", "x"),
                Err(AuthError::InvalidPassword)
            ));
        }
        assert!(matches!(
            store.login("wrong", "x"),
            Err(AuthError::RateLimited(_))
        ));
    }
}
