//! Private desktop SSH profiles. No password, key bytes or App Server token is stored.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<PathBuf>,
    pub server_binary: String,
    pub data_dir: String,
}
impl Profile {
    pub fn ssh(&self) -> fv_daemon::ssh::SshHost {
        fv_daemon::ssh::SshHost {
            host: self.host.clone(),
            user: self.user.clone(),
            port: self.port,
            identity_file: self.identity_file.clone(),
            server_binary: self.server_binary.clone(),
            data_dir: self.data_dir.clone(),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 128
            || !self
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err("Invalid SSH host id".into());
        }
        if self.name.trim().is_empty() || self.name.chars().any(char::is_control) {
            return Err("Enter a host name".into());
        }
        for value in [Some(self.host.as_str()), self.user.as_deref()]
            .into_iter()
            .flatten()
        {
            if value.is_empty()
                || value.starts_with('-')
                || value.chars().any(|c| c.is_control() || c.is_whitespace())
            {
                return Err("Enter a hostname or SSH alias, and an optional username".into());
            }
        }
        if self.port == Some(0) {
            return Err("SSH port must be 1–65535".into());
        }
        for path in [&self.server_binary, &self.data_dir] {
            if !path.starts_with('/') || path.chars().any(char::is_control) {
                return Err("Remote server and data paths must be absolute Unix paths".into());
            }
        }
        if self
            .identity_file
            .as_ref()
            .is_some_and(|p| !p.is_absolute())
        {
            return Err("Identity file must be an absolute local path".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Profiles {
    version: u32,
    pub hosts: Vec<Profile>,
}
impl Default for Profiles {
    fn default() -> Self {
        Self {
            version: 1,
            hosts: Vec::new(),
        }
    }
}
impl Profiles {
    pub fn load(path: &Path) -> Result<Self, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.to_string()),
        };
        let profiles: Self = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if profiles.version != 1 {
            return Err("Unsupported SSH profile version; existing profiles were preserved".into());
        }
        for profile in &profiles.hosts {
            profile.validate()?;
        }
        let mut ids = std::collections::HashSet::new();
        if profiles
            .hosts
            .iter()
            .any(|p| p.id.is_empty() || !ids.insert(&p.id))
        {
            return Err("Invalid SSH profile ids".into());
        }
        Ok(profiles)
    }
    /// Refuse to replace a file changed since the form loaded. Readers never turn corrupt or
    /// newer user configuration into an empty default and then overwrite it.
    pub fn save(&self, path: &Path, expected: &Self) -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if Self::load(path)? != *expected {
            return Err("SSH profiles changed in another window; reopen SSH settings".into());
        }
        if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("SSH profile file must not be a symlink".into());
        }
        let parent = path.parent().ok_or("SSH profile path needs a parent")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temporary = parent.join(format!(".ssh-hosts-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&serde_json::to_vec_pretty(self)?)?;
            file.sync_all()?;
            std::fs::rename(&temporary, path)
        })();
        let _ = std::fs::remove_file(temporary);
        result.map_err(|e: std::io::Error| e.to_string())
    }
}

/// Verify executable format and CPU locally before uploading a user-selected native server.
/// macOS universal executables are intentionally refused: choose the thin target artifact.
pub fn verify_binary(path: &Path, target: &fv_daemon::ssh::SshTarget) -> Result<(), String> {
    use std::io::Read;
    let mut header = [0u8; 64];
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.read_exact(&mut header)
        .map_err(|_| "Selected server is too small to be a native executable".to_string())?;
    let arm = matches!(target.arch.as_str(), "arm64" | "aarch64");
    let valid = match target.os.as_str() {
        "Linux" => {
            &header[..4] == b"\x7fELF"
                && header[4] == 2
                && header[5] == 1
                && u16::from_le_bytes([header[18], header[19]]) == if arm { 183 } else { 62 }
        }
        "Darwin" => {
            header[..4] == [0xcf, 0xfa, 0xed, 0xfe]
                && u32::from_le_bytes(header[4..8].try_into().unwrap())
                    == if arm { 0x0100_000c } else { 0x0100_0007 }
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Choose a native fastvibe-server binary for {} {}",
            target.os, target.arch
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Profile {
        Profile {
            id: "host-1".into(),
            name: "Test host".into(),
            host: "build-alias".into(),
            user: None,
            port: None,
            identity_file: None,
            server_binary: "/opt/fv/server".into(),
            data_dir: "/home/user/.fv".into(),
        }
    }
    #[test]
    fn private_round_trip_and_conflict_preserve_config() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ssh-hosts.json");
        let initial = Profiles::default();
        let mut saved = initial.clone();
        saved.hosts.push(profile());
        saved.save(&path, &initial).unwrap();
        assert_eq!(Profiles::load(&path).unwrap(), saved);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(initial.save(&path, &initial).is_err());
        assert_eq!(Profiles::load(&path).unwrap(), saved);
        std::fs::write(&path, b"{bad-user-config}").unwrap();
        assert!(saved.save(&path, &saved).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{bad-user-config}");
    }
    #[test]
    fn validates_paths_and_binary_architecture() {
        let mut p = profile();
        p.host = "-oProxyCommand=bad".into();
        assert!(p.validate().is_err());
        p = profile();
        p.data_dir = "~/.fv".into();
        assert!(p.validate().is_err());
        p = profile();
        p.id = "../../outside".into();
        assert!(p.validate().is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server");
        let mut bytes = [0u8; 64];
        bytes[..6].copy_from_slice(b"\x7fELF\x02\x01");
        bytes[18..20].copy_from_slice(&183u16.to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        assert!(
            verify_binary(
                &path,
                &fv_daemon::ssh::SshTarget {
                    os: "Linux".into(),
                    arch: "aarch64".into()
                }
            )
            .is_ok()
        );
        assert!(
            verify_binary(
                &path,
                &fv_daemon::ssh::SshTarget {
                    os: "Linux".into(),
                    arch: "x86_64".into()
                }
            )
            .is_err()
        );
    }
}
