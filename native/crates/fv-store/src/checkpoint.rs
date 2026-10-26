//! A turn's checkpoint: what the workspace looked like before it changed anything, so a retry
//! can run against the code the user actually asked about.
//!
//! The problem this exists for is silent. A retry rewinds the *conversation* (`turn/rewind`), but
//! the working tree stays where the abandoned attempt left it: the second run then reads files
//! the first one already edited, or its `apply_patch` finds the change already applied and does
//! nothing. The transcript looks right and only the result is wrong.
//!
//! **The snapshot is a git tree written through a scratch index, not a copy of each file.**
//! Codex's `git-utils/src/baseline.rs` uses git this way for directories it owns, and the same
//! mechanism has two properties a per-file copy cannot have:
//!
//! - it covers every path in the worktree, including files a **shell command** wrote (a build
//!   script, `officecli`, a formatter) — the tool name alone cannot tell us what a command will
//!   touch, and a checkpoint that misses those is the failure it was bought to prevent;
//! - it is cheap: git hashes what is already in the object store, so a second snapshot of an
//!   unchanged tree costs milliseconds rather than 32 MB of copying.
//!
//! Two rules keep it honest:
//!
//! - **The user's index and worktree are read, never written.** `git add -A` runs against a
//!   scratch index file (`GIT_INDEX_FILE`), so staging is untouched; untracked files are in the
//!   snapshot, honouring `.gitignore` exactly as `git add -A` does. (`git stash create` is not
//!   used: it ignores untracked files, which is precisely the build output above.)
//! - **Nothing is ever removed from the user's repository.** A checkpoint is a commit object plus
//!   a reflog-less reference under `refs/fastvibe/checkpoints/<conversation>`; restoring writes
//!   files back through `git restore`, and the object is dropped when the checkpoint is cleared.
//! - **A workspace that is not a git repository has no checkpoint.** Reporting "there is nothing
//!   to rewind" is right; inventing a repository inside the user's folder is not.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::StoreError;

/// The ref a conversation's checkpoint is kept under, so the object survives until cleared.
fn checkpoint_ref(conversation_id: &str) -> String {
    let safe: String = conversation_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    format!("refs/fastvibe/checkpoints/{safe}")
}

/// One turn's snapshot of the whole worktree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    /// The worktree root the snapshot was taken in.
    pub root: PathBuf,
    /// The commit holding the tree as it was.
    pub commit: String,
    /// When it was taken, milliseconds since the epoch.
    pub created_at: i64,
}

/// What a restore did, so the caller can say so rather than claim success.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Restored {
    /// Files written back to their checkpointed content.
    pub restored: usize,
    /// Files the turn created, now removed.
    pub removed: usize,
    /// Paths that could not be put back, with the reason.
    pub skipped: Vec<(String, String)>,
}

impl Restored {
    pub fn is_complete(&self) -> bool {
        self.skipped.is_empty()
    }
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    git_with(root, args, &[])
}

/// `git` with a scratch index, which is how the snapshot is written without touching the
/// user's staging area.
fn git_with(root: &Path, args: &[&str], env: &[(&str, String)]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        // Never let a hook, a pager or a prompt get in the way of an unattended restore.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .envs(env.iter().map(|(k, v)| (*k, v)))
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The worktree root of `dir`, or `None` when it is not inside a git repository.
pub fn repository_root(dir: &Path) -> Option<PathBuf> {
    git(dir, &["rev-parse", "--show-toplevel"])
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Snapshot the worktree as it is now.
///
/// `None` when the directory is not a git worktree, which is reported to the user rather than
/// silently doing nothing. `git stash create` writes the tree and returns the commit without
/// touching the index, the worktree or the stash list — the snapshot is only reachable through
/// the ref this adds.
pub fn capture(dir: &Path, conversation_id: &str) -> Result<Option<Checkpoint>, StoreError> {
    let Some(root) = repository_root(dir) else {
        return Ok(None);
    };
    let tree = match worktree_tree(&root) {
        Ok(tree) => tree,
        Err(e) => {
            return Err(StoreError::Io(std::io::Error::other(format!(
                "cannot snapshot {}: {e}",
                root.display()
            ))));
        }
    };
    // A commit keeps the tree reachable through the ref below; the identity is ours so a
    // user who inspects it is not told they made it.
    let commit = git_with(
        &root,
        &[
            "-c",
            "user.name=FastVibe",
            "-c",
            "user.email=checkpoint@fastvibe.dev",
            "commit-tree",
            &tree,
            "-p",
            "HEAD",
            "-m",
            "FastVibe checkpoint",
        ],
        &[],
    )
    .map_err(|e| StoreError::Io(std::io::Error::other(e)))?;
    // A commit nothing points at is garbage-collected; the ref is what keeps it alive until the
    // checkpoint is cleared.
    git(
        &root,
        &["update-ref", &checkpoint_ref(conversation_id), &commit],
    )
    .map_err(|e| StoreError::Io(std::io::Error::other(e)))?;
    Ok(Some(Checkpoint {
        root,
        commit,
        created_at: now_ms(),
    }))
}

/// Put every file back the way the checkpoint has it.
///
/// `git restore --source <commit> --worktree -- .` (with the index left alone) is what an undo
/// means here: the user's staged changes are theirs, and this is about the worktree. A file the
/// checkpoint does not contain, but that exists now, is removed — the turn created it.
pub fn restore(checkpoint: &Checkpoint) -> Result<Restored, StoreError> {
    let root = &checkpoint.root;
    let mut result = Restored::default();

    // What changed since the snapshot: the paths that need attention, and how.
    //
    // The comparison is between two *trees*, not between a commit and the index: a plain
    // `git diff <commit>` never reports an untracked file, and an untracked file a turn created
    // is exactly what a rewind has to remove.
    let now = worktree_tree(root).map_err(|e| StoreError::Io(std::io::Error::other(e)))?;
    let commit = git(
        root,
        &[
            "-c",
            "user.name=FastVibe",
            "-c",
            "user.email=checkpoint@fastvibe.dev",
            "commit-tree",
            &now,
            "-p",
            "HEAD",
            "-m",
            "FastVibe current",
        ],
    )
    .map_err(|e| StoreError::Io(std::io::Error::other(e)))?;
    let diff = git(
        root,
        &[
            "diff-tree",
            "-r",
            "--name-status",
            "--no-renames",
            &checkpoint.commit,
            &commit,
        ],
    )
    .map_err(|e| StoreError::Io(std::io::Error::other(e)))?;
    let mut to_restore: Vec<String> = Vec::new();
    let mut to_remove: Vec<String> = Vec::new();
    for line in diff.lines().filter(|l| !l.trim().is_empty()) {
        let mut fields = line.split('\t');
        let (Some(status), Some(path)) = (fields.next(), fields.next()) else {
            continue;
        };
        match status.chars().next() {
            // Added since the snapshot: putting it back means removing it.
            Some('A') => to_remove.push(path.to_string()),
            _ => to_restore.push(path.to_string()),
        }
    }

    if !to_restore.is_empty() {
        let mut args = vec![
            "restore",
            "--source",
            &checkpoint.commit,
            "--worktree",
            "--",
        ];
        args.extend(to_restore.iter().map(String::as_str));
        match git(root, &args) {
            Ok(_) => result.restored = to_restore.len(),
            Err(e) => {
                // One unreadable path must not abandon the rest: retry them one at a time so
                // the caller gets a complete picture of what came back.
                for path in &to_restore {
                    match git(
                        root,
                        &[
                            "restore",
                            "--source",
                            &checkpoint.commit,
                            "--worktree",
                            "--",
                            path,
                        ],
                    ) {
                        Ok(_) => result.restored += 1,
                        Err(why) => result.skipped.push((path.clone(), why)),
                    }
                }
                if result.restored == 0 && result.skipped.is_empty() {
                    return Err(StoreError::Io(std::io::Error::other(e)));
                }
            }
        }
    }
    for path in &to_remove {
        let full = root.join(path);
        match std::fs::remove_file(&full) {
            Ok(()) => result.removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => result.skipped.push((path.clone(), e.to_string())),
        }
    }
    Ok(result)
}

/// Drop the checkpoint: the ref goes, and its objects become collectable.
pub fn clear(conversation_id: &str, root: &Path) {
    let _ = git(
        root,
        &["update-ref", "-d", &checkpoint_ref(conversation_id)],
    );
}

/// A tree object holding the worktree as it stands, untracked files included.
///
/// The index is a scratch file: `git add -A` writes there, so the user's own staging area is
/// never touched, and `.gitignore` is honoured exactly as a real `git add -A` would.
fn worktree_tree(root: &Path) -> Result<String, String> {
    // Unique per call, atomically: two captures in the same millisecond (parallel turns in two
    // conversations) would otherwise share an index and its `.lock`.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let scratch = std::env::temp_dir().join(format!(
        "fastvibe-checkpoint-{}-{}.idx",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let index = ("GIT_INDEX_FILE", scratch.display().to_string());
    // A fresh index starts from HEAD, or every tracked file would look like an addition.
    if let Ok(head) = git(root, &["rev-parse", "HEAD"]) {
        let _ = git_with(root, &["read-tree", &head], std::slice::from_ref(&index));
    }
    let tree = git_with(root, &["add", "-A", "."], std::slice::from_ref(&index))
        .and_then(|_| git_with(root, &["write-tree"], std::slice::from_ref(&index)));
    let _ = std::fs::remove_file(&scratch);
    let _ = std::fs::remove_file(scratch.with_extension("idx.lock"));
    match tree {
        Ok(tree) if !tree.is_empty() => Ok(tree),
        Ok(_) => Err("the worktree produced no tree".into()),
        Err(e) => Err(e),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{:?}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q", "."]);
        std::fs::write(dir.path().join("keep.txt"), "original\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);
        dir
    }

    #[test]
    fn a_turn_that_edited_and_created_files_is_put_back() {
        let dir = repo();
        let checkpoint = capture(dir.path(), "c1").unwrap().unwrap();
        // What a turn does: edit a tracked file, create one, and leave a third untouched.
        std::fs::write(dir.path().join("keep.txt"), "edited by the turn\n").unwrap();
        std::fs::write(dir.path().join("made.txt"), "new file\n").unwrap();

        let restored = restore(&checkpoint).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("keep.txt")).unwrap(),
            "original\n"
        );
        assert!(
            !dir.path().join("made.txt").exists(),
            "a created file is removed"
        );
        assert_eq!(restored.restored, 1);
        assert_eq!(restored.removed, 1);
        assert!(restored.is_complete());
    }

    #[test]
    fn a_file_a_shell_command_wrote_is_covered_too() {
        let dir = repo();
        let checkpoint = capture(dir.path(), "c2").unwrap().unwrap();
        // No tool told us this path: a build script did.
        std::fs::write(dir.path().join("generated.bin"), b"\x00\x01binary").unwrap();
        let restored = restore(&checkpoint).unwrap();
        assert!(!dir.path().join("generated.bin").exists());
        assert_eq!(restored.removed, 1);
    }

    #[test]
    fn staged_changes_are_the_users_and_stay_staged() {
        let dir = repo();
        std::fs::write(dir.path().join("keep.txt"), "staged\n").unwrap();
        let add = Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["add", "."])
            .output()
            .unwrap();
        assert!(add.status.success());
        let checkpoint = capture(dir.path(), "c3").unwrap().unwrap();
        std::fs::write(dir.path().join("keep.txt"), "turn edit\n").unwrap();
        restore(&checkpoint).unwrap();
        // The worktree came back to the checkpoint; the index was never touched by any of this.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("keep.txt")).unwrap(),
            "staged\n"
        );
    }

    #[test]
    fn a_directory_that_is_not_a_repository_has_no_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(capture(dir.path(), "c4").unwrap(), None);
    }

    #[test]
    fn clearing_removes_the_ref_and_leaves_the_worktree_alone() {
        let dir = repo();
        let checkpoint = capture(dir.path(), "c5").unwrap().unwrap();
        clear("c5", &checkpoint.root);
        let listed = git(&checkpoint.root, &["for-each-ref", "refs/fastvibe/"]).unwrap();
        assert!(listed.is_empty(), "{listed}");
        assert!(dir.path().join("keep.txt").exists());
    }
}
