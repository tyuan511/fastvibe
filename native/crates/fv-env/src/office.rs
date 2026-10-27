//! The immutable OfficeCLI resource shipped with FastVibe. Never searches PATH,
//! installs into the user's account, or mutates the process environment.
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::OnceLock,
};
#[derive(Clone, Debug)]
pub struct OfficeInstall {
    pub binary: PathBuf,
    pub version: String,
}
impl OfficeInstall {
    pub fn discover_at(root: &Path) -> Option<Self> {
        let pinned: serde_json::Value =
            serde_json::from_str(include_str!("../../../../scripts/officecli.json")).ok()?;
        let shipped: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("manifest.json")).ok()?).ok()?;
        let version = pinned["version"].as_str()?;
        if shipped["version"].as_str() != Some(version) {
            return None;
        }
        let os = if cfg!(target_os = "macos") {
            "mac"
        } else if cfg!(target_os = "windows") {
            "win"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            return None;
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else if cfg!(target_arch = "x86_64") {
            "x64"
        } else {
            return None;
        };
        let key = format!("{os}-{arch}");
        let name = if cfg!(windows) {
            "officecli.exe"
        } else {
            "officecli"
        };
        let binary = [root.join(name), root.join(&key).join(name)]
            .into_iter()
            .find(|p| p.is_file())?;
        let binary = std::fs::canonicalize(binary).ok()?;
        let metadata = std::fs::metadata(&binary).ok()?;
        if metadata.len() > 128 * 1024 * 1024 {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return None;
            }
        }
        let expected = pinned["assets"][&key]["sha256"].as_str()?;
        let actual = format!("{:x}", Sha256::digest(std::fs::read(&binary).ok()?));
        if actual != expected {
            return None;
        }
        Some(Self {
            binary,
            version: version.into(),
        })
    }
    pub fn apply(&self, environment: &mut BTreeMap<OsString, OsString>, data_dir: &Path) {
        let Some(dir) = self.binary.parent() else {
            return;
        };
        let old = environment
            .get(std::ffi::OsStr::new("PATH"))
            .cloned()
            .unwrap_or_default();
        let paths = std::iter::once(dir.to_path_buf())
            .chain(std::env::split_paths(&old).filter(|p| p != dir));
        let Ok(path) = std::env::join_paths(paths) else {
            return;
        };
        environment.insert("PATH".into(), path);
        environment.insert(
            "FASTVIBE_OFFICECLI_BIN".into(),
            self.binary.clone().into_os_string(),
        );
        for (name, value) in [
            ("OFFICECLI_SKIP_UPDATE", "1"),
            ("OFFICECLI_NO_AUTO_INSTALL", "1"),
            ("OFFICECLI_RESIDENT_FLUSH", "each"),
        ] {
            environment.insert(name.into(), value.into());
        }
        if let Ok(data_dir) = std::path::absolute(data_dir) {
            let _ = std::fs::create_dir_all(data_dir.join("officecli-state"));
            environment.insert(
                "OFFICECLI_STATE_DIR".into(),
                data_dir.join("officecli-state").into_os_string(),
            );
        }
    }
}
pub fn office_install() -> Option<&'static OfficeInstall> {
    static INSTALL: OnceLock<Option<OfficeInstall>> = OnceLock::new();
    INSTALL
        .get_or_init(|| {
            if let Some(root) =
                std::env::var_os("FASTVIBE_RESOURCES_PATH").filter(|p| !p.is_empty())
            {
                return OfficeInstall::discover_at(&PathBuf::from(root).join("officecli"));
            }
            if let Ok(exe) = std::env::current_exe()
                && let Some(bin) = exe.parent()
            {
                for root in [bin.join("../Resources/officecli"), bin.join("officecli")] {
                    if let Some(install) = OfficeInstall::discover_at(&root) {
                        return Some(install);
                    }
                }
            }
            OfficeInstall::discover_at(
                &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../resources/officecli"),
            )
        })
        .as_ref()
}
pub fn snapshot_for(data_dir: &Path) -> BTreeMap<OsString, OsString> {
    let mut environment = crate::snapshot();
    if let Some(install) = office_install() {
        install.apply(&mut environment, data_dir);
    }
    environment
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn child_environment_is_scoped_to_the_app_and_keeps_the_users_path_behind_the_bundle() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = temp.path().join("bundle");
        let user = temp.path().join("user-bin");
        let install = OfficeInstall {
            binary: bundle.join("officecli"),
            version: "test".into(),
        };
        let before = BTreeMap::from([(
            "PATH".into(),
            std::env::join_paths([&user, &bundle]).unwrap(),
        )]);
        let mut env = before.clone();
        install.apply(&mut env, &temp.path().join("data-a"));
        assert_eq!(
            env[std::ffi::OsStr::new("PATH")],
            std::env::join_paths([&bundle, &user]).unwrap()
        );
        assert_eq!(
            env[std::ffi::OsStr::new("OFFICECLI_RESIDENT_FLUSH")],
            "each"
        );
        assert_eq!(
            env[std::ffi::OsStr::new("OFFICECLI_STATE_DIR")],
            temp.path()
                .join("data-a")
                .join("officecli-state")
                .into_os_string()
        );
        let mut other = before;
        install.apply(&mut other, &temp.path().join("data-b"));
        assert_ne!(
            env[std::ffi::OsStr::new("OFFICECLI_STATE_DIR")],
            other[std::ffi::OsStr::new("OFFICECLI_STATE_DIR")]
        );
        assert_eq!(
            env[std::ffi::OsStr::new("FASTVIBE_OFFICECLI_BIN")],
            install.binary.into_os_string()
        );
        assert!(!env.contains_key(std::ffi::OsStr::new("HOME")));
    }
    #[test]
    fn an_unpinned_or_tampered_resource_is_never_executed_or_added_to_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("manifest.json"),
            include_str!("../../../../scripts/officecli.json"),
        )
        .unwrap();
        std::fs::write(
            dir.path().join(if cfg!(windows) {
                "officecli.exe"
            } else {
                "officecli"
            }),
            "not the pinned executable",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                dir.path().join("officecli"),
                std::fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        assert!(OfficeInstall::discover_at(dir.path()).is_none());
    }
}
