use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How much of the machine a command may touch (codex's `sandbox_mode`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    /// Read anything, write nothing.
    ReadOnly,
    /// Read anything, write in the working folders and the temporary directories.
    #[default]
    WorkspaceWrite,
    /// No sandbox at all.
    DangerFullAccess,
}

/// When the user is asked before something runs (codex's `approval_policy`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalPolicy {
    /// Ask before anything that is not known to be read-only.
    Untrusted,
    /// Run in the sandbox; ask only to run again outside it, after it was in the way.
    OnFailure,
    /// Run in the sandbox; the model asks when it needs to leave it.
    #[default]
    OnRequest,
    /// Never ask: what the sandbox stops, stays stopped.
    Never,
}

/// A mode with the folders it makes writable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub mode: SandboxMode,
    /// Where `WorkspaceWrite` may write (the working folders, the temporary directories).
    pub writable_roots: Vec<PathBuf>,
    /// Whether commands may use the network (only `WorkspaceWrite` can allow it).
    pub network: bool,
}

/// Directory names that stay read-only inside a writable root: a command may not rewrite the
/// repository's own bookkeeping or this app's.
pub const PROTECTED_NAMES: &[&str] = &[".git", ".fastvibe"];

impl Policy {
    pub fn full_access() -> Self {
        Self {
            mode: SandboxMode::DangerFullAccess,
            writable_roots: Vec::new(),
            network: true,
        }
    }

    pub fn sandboxed(&self) -> bool {
        self.mode != SandboxMode::DangerFullAccess
    }

    /// Whether a write to `path` would be allowed. Symbolic links are followed: a link that
    /// leads out of a writable root does not let a write out with it.
    pub fn can_write(&self, path: &Path) -> bool {
        match self.mode {
            SandboxMode::DangerFullAccess => true,
            SandboxMode::ReadOnly => false,
            SandboxMode::WorkspaceWrite => {
                let target = resolve(path);
                self.writable_roots.iter().any(|root| {
                    let root = resolve(root);
                    target.starts_with(&root)
                        && !PROTECTED_NAMES
                            .iter()
                            .any(|name| target.starts_with(root.join(name)))
                })
            }
        }
    }
}

/// The working folders plus the places programs expect to write scratch files.
pub fn default_writable_roots(folders: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = folders.to_vec();
    roots.push(PathBuf::from("/tmp"));
    if let Some(tmp) = std::env::var_os("TMPDIR") {
        roots.push(PathBuf::from(tmp));
    }
    roots.sort();
    roots.dedup();
    roots
}

/// `path` with `.` and `..` folded away and symbolic links in its existing part resolved; what
/// does not exist yet is appended as written.
pub(crate) fn resolve(path: &Path) -> PathBuf {
    let mut clean = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                clean.pop();
            }
            Component::CurDir => {}
            other => clean.push(other.as_os_str()),
        }
    }
    let mut existing = clean.clone();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(mut real) = existing.canonicalize() {
            for part in rest.iter().rev() {
                real.push(part);
            }
            return real;
        }
        match (
            existing.file_name().map(ToOwned::to_owned),
            existing.parent().map(Path::to_path_buf),
        ) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return clean,
        }
    }
}
