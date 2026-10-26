//! Isolated workspaces: a conversation bound to a git worktree instead of the project's own
//! checkout, so an experiment does not dirty the tree the user is working in.
//!
//! The Electron app's `main/engine/worktree.ts` and `main/pi/git-worktree.ts`. The rules worth
//! keeping, and why each one exists:
//!
//! - **A FastVibe-created worktree lives under `~/.fastvibe/worktree/<project>/`.** Anywhere else
//!   and the app cannot tell its own checkouts from the user's — which is what it needs to know
//!   before it deletes one.
//! - **A branch that already exists is checked out; one that does not is created.** Both are one
//!   `worktree add`, differing only by `-b`, so "bind me to `dev`" works without a second command.
//! - **A branch name is validated, not escaped.** A leading `-` would be read by git as an option
//!   and whitespace cannot be a branch; refusing both is cheaper than quoting them.
//! - **An explicit path that exists is an error; a default path that exists gets a suffix.** The
//!   user who typed a path meant that path; the app choosing a name may step around a leftover.
//! - **A worktree is only deleted when this app created it.** A checkout the user made themselves
//!   is not ours to remove, and `remove` after unbinding says so by doing nothing.
//! - **Binding requires the same repository.** A worktree of a different project would silently
//!   give the conversation a workspace whose history has nothing to do with its project.
//! - **Unbinding returns the conversation to its project**, not to a scratch folder — a
//!   conversation belonged to that project before it was isolated and belongs to it after.

use std::path::{Path, PathBuf};
use std::process::Command;

use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::*;

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn failed(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, message)
}

fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
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

/// The worktree's own root (the directory that holds the checkout).
fn toplevel(path: &str) -> Result<String, String> {
    let root = git(path, &["rev-parse", "--show-toplevel"])?;
    if root.is_empty() {
        return Err("not a git project".into());
    }
    Ok(root)
}

/// The repository a worktree belongs to: every worktree of one repository shares this.
///
/// `--git-common-dir` is a path *inside* the main checkout (`.git`), so its parent is the project
/// root — except in a linked worktree, where the common dir is absolute and points at the main
/// checkout's `.git`. Both cases are handled by checking whether it ends in `.git`.
fn common_root(path: &str) -> Result<String, String> {
    let raw = git(path, &["rev-parse", "--git-common-dir"])?;
    if raw.is_empty() {
        return Err("not a git project".into());
    }
    let common = if Path::new(&raw).is_absolute() {
        PathBuf::from(&raw)
    } else {
        Path::new(path).join(&raw)
    };
    if common.file_name().is_some_and(|name| name == ".git") {
        return Ok(common
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or(raw));
    }
    toplevel(path)
}

fn branch_of(path: &str) -> String {
    git(path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty() && b != "HEAD")
        .unwrap_or_else(|| "HEAD".into())
}

/// `~/.fastvibe/worktree`, under the home directory the app was started with.
pub fn worktree_home() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    home.join(".fastvibe").join("worktree")
}

/// A path segment safe to use as a directory name: lowercase, dashes for everything else, and
/// never a leading or trailing dot (which would hide the directory).
pub fn sanitize_segment(value: &str) -> String {
    let lowered = value.trim().to_lowercase();
    let mut out = String::new();
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out
        .trim_start_matches(['-', '.'])
        .trim_end_matches(['-', '.'])
        .to_string();
    out.chars().take(64).collect()
}

/// `~/.fastvibe/worktree/<project>/<folder>` — where this app puts a project's checkouts.
pub fn default_path(project_name: &str, folder: &str) -> PathBuf {
    let project = sanitize_segment(project_name);
    let folder = sanitize_segment(folder);
    worktree_home()
        .join(if project.is_empty() {
            "project".into()
        } else {
            project
        })
        .join(if folder.is_empty() {
            "run".into()
        } else {
            folder
        })
}

/// Expand a leading `~` so a typed path means what the user expects.
fn expand_user_path(value: &str) -> PathBuf {
    let trimmed = value.trim();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if trimmed == "~"
        && let Some(home) = home
    {
        return home;
    }
    if let Some(rest) = trimmed.strip_prefix("~/")
        && let Some(home) = home
    {
        return home.join(rest);
    }
    PathBuf::from(trimmed)
}

/// Whether this app created a worktree, which is the only case in which it may delete it.
pub fn is_managed(path: &str) -> bool {
    let home = worktree_home();
    let candidate = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let base = std::fs::canonicalize(&home).unwrap_or(home);
    candidate.starts_with(&base)
}

/// Parse `git worktree list --porcelain`.
///
/// The output is blank-line separated records of `key value` lines; a bare word (`bare`,
/// `detached`, `prunable`) is a flag on the record it appears in.
pub fn parse_porcelain(text: &str) -> Vec<GitWorktree> {
    let mut items: Vec<GitWorktree> = Vec::new();
    let mut current: Option<GitWorktree> = None;
    let flush = |items: &mut Vec<GitWorktree>, current: &mut Option<GitWorktree>| {
        if let Some(item) = current.take() {
            items.push(item);
        }
    };
    for line in text.lines() {
        if line.is_empty() {
            flush(&mut items, &mut current);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut items, &mut current);
            current = Some(GitWorktree {
                path: path.to_string(),
                head: None,
                branch: None,
                bare: false,
                detached: false,
                locked: false,
                prunable: false,
                current: false,
            });
            continue;
        }
        let Some(item) = current.as_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            item.head = Some(head.to_string());
        } else if let Some(branch) = line.strip_prefix("branch ") {
            item.branch = Some(branch.trim_start_matches("refs/heads/").to_string());
        } else {
            match line {
                "bare" => item.bare = true,
                "detached" => item.detached = true,
                "prunable" => item.prunable = true,
                _ if line.starts_with("locked") => item.locked = true,
                _ => {}
            }
        }
    }
    flush(&mut items, &mut current);
    items
}

/// Every worktree of the repository `cwd` is in, with the one `cwd` sits in marked.
pub fn list(cwd: &str) -> Vec<GitWorktree> {
    let Ok(text) = git(cwd, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    let here = std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
    parse_porcelain(&text)
        .into_iter()
        .map(|mut item| {
            let there =
                std::fs::canonicalize(&item.path).unwrap_or_else(|_| PathBuf::from(&item.path));
            item.current = there == here;
            item
        })
        .collect()
}

/// Create (or bind) a worktree for a conversation and bind it to the conversation.
pub fn create(
    state: &crate::state::ServerState,
    thread_id: &str,
    params: ThreadWorktreeCreateParams,
) -> Result<Thread, ErrorObject> {
    let thread = state
        .thread(thread_id)?
        .ok_or_else(|| invalid("thread not found"))?;
    if thread.worktree.is_some() {
        return Err(invalid("这个会话已经绑定了隔离工作区，请先解除绑定"));
    }
    let project = thread
        .project
        .clone()
        .ok_or_else(|| invalid("请先绑定一个 Git 项目"))?;
    let root = toplevel(&project).map_err(invalid)?;
    let project_name = Path::new(&root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());

    let label = params
        .label
        .as_deref()
        .filter(|l| !l.trim().is_empty())
        .unwrap_or(&thread.title);
    let safe = sanitize_segment(if label.trim().is_empty() {
        "run"
    } else {
        label
    });
    let short = &thread_id[..thread_id.len().min(8)];
    // A branch that already exists is checked out; one that does not is created from HEAD.
    let branch = match params.branch.as_deref().map(str::trim) {
        Some(branch) if !branch.is_empty() => branch.trim_start_matches('/').to_string(),
        _ => format!("fastvibe/{safe}-{short}"),
    };
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.contains('\0')
        || branch.chars().any(char::is_whitespace)
    {
        return Err(invalid("分支名称无效"));
    }
    let explicit = params
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let mut path = match explicit {
        Some(path) => expand_user_path(path),
        None => default_path(&project_name, &format!("{safe}-{short}")),
    };
    if path.exists() {
        if explicit.is_some() {
            return Err(invalid("该路径已存在"));
        }
        // The app picked this name; stepping around a leftover is friendlier than failing.
        path = PathBuf::from(format!("{}-{short}", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| failed(e.to_string()))?;
    }
    let path_text = path.display().to_string();
    let exists = git(
        &root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok();
    let added = if exists {
        git(&root, &["worktree", "add", &path_text, &branch])
    } else {
        git(
            &root,
            &["worktree", "add", "-b", &branch, &path_text, "HEAD"],
        )
    };
    if let Err(e) = added {
        return Err(failed(e));
    }
    // The worktree's own root is what a session binds to, not the path as typed: git resolves a
    // trailing slash, a `..` and a symlink, and the conversation's cwd must be the real one.
    let bound = toplevel(&path_text).unwrap_or(path_text);
    bind(state, thread_id, bound, branch)
}

/// Bind an existing checkout to a conversation.
pub fn bind_existing(
    state: &crate::state::ServerState,
    thread_id: &str,
    raw_path: &str,
) -> Result<Thread, ErrorObject> {
    let thread = state
        .thread(thread_id)?
        .ok_or_else(|| invalid("thread not found"))?;
    let path = expand_user_path(raw_path);
    if !path.exists() {
        return Err(invalid("工作区路径不存在"));
    }
    let path_text = path.display().to_string();
    let toplevel = toplevel(&path_text).map_err(invalid)?;
    let repo = common_root(&path_text).map_err(invalid)?;
    // A worktree of a different project would give this conversation a workspace whose history
    // has nothing to do with its project.
    if let Some(project) = &thread.project {
        let same = common_root(project).map(|own| own == repo).unwrap_or(false);
        if !same {
            return Err(invalid("该工作区不属于当前项目"));
        }
    }
    let branch = branch_of(&path_text);
    bind(state, thread_id, toplevel, branch)
}

fn bind(
    state: &crate::state::ServerState,
    thread_id: &str,
    path: String,
    branch: String,
) -> Result<Thread, ErrorObject> {
    let mut thread = state
        .thread(thread_id)?
        .ok_or_else(|| invalid("thread not found"))?;
    thread.worktree = Some(ThreadWorktree {
        path: path.clone(),
        branch,
    });
    thread.cwd = Some(path);
    state.store.db.put_thread(&thread).map_err(internal)?;
    state.broadcast(fv_protocol::ServerNotification::CatalogChanged(
        CatalogChanged {},
    ));
    Ok(thread)
}

/// Return a conversation to its project, optionally deleting the checkout this app created.
pub fn unbind(
    state: &crate::state::ServerState,
    thread_id: &str,
    remove: bool,
) -> Result<Thread, ErrorObject> {
    let mut thread = state
        .thread(thread_id)?
        .ok_or_else(|| invalid("thread not found"))?;
    let Some(previous) = thread.worktree.clone() else {
        return Ok(thread);
    };
    thread.worktree = None;
    // Back to the project, not to a scratch folder: the conversation belonged to that project
    // before it was isolated and belongs to it after.
    thread.cwd = thread.project.clone();
    state.store.db.put_thread(&thread).map_err(internal)?;
    state.broadcast(fv_protocol::ServerNotification::CatalogChanged(
        CatalogChanged {},
    ));
    // Only a checkout this app created is this app's to delete.
    if remove && is_managed(&previous.path) {
        let root = thread
            .project
            .as_deref()
            .filter(|p| Path::new(p).exists())
            .unwrap_or(&previous.path);
        let _ = git(root, &["worktree", "remove", "--force", &previous.path]);
        let _ = git(root, &["worktree", "prune"]);
    }
    Ok(thread)
}

fn internal(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_porcelain_record_keeps_its_flags_and_its_branch() {
        let text = "\
worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-wt
HEAD def456
branch refs/heads/fastvibe/run-abcd
locked

worktree /repo-detached
HEAD 789abc
detached
";
        let items = parse_porcelain(text);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].path, "/repo");
        assert_eq!(items[0].branch.as_deref(), Some("main"));
        assert_eq!(items[1].branch.as_deref(), Some("fastvibe/run-abcd"));
        assert!(items[1].locked, "a locked worktree is flagged");
        assert!(items[2].detached);
        assert_eq!(items[2].branch, None);
    }

    #[test]
    fn a_segment_is_lowercase_bounded_and_never_hidden() {
        assert_eq!(sanitize_segment("My Project!"), "my-project");
        assert_eq!(sanitize_segment("  .hidden.  "), "hidden");
        assert_eq!(sanitize_segment("a//b"), "a-b");
        assert_eq!(sanitize_segment(""), "");
        assert!(sanitize_segment(&"x".repeat(200)).chars().count() <= 64);
    }

    #[test]
    fn the_default_path_is_under_the_fastvibe_home() {
        let path = default_path("My Repo", "run-abcd");
        assert!(
            path.starts_with(worktree_home()),
            "{} is not under {:?}",
            path.display(),
            worktree_home()
        );
        assert!(path.ends_with("my-repo/run-abcd"));
    }

    #[test]
    fn only_a_path_this_app_created_is_managed() {
        let home = worktree_home();
        assert!(is_managed(&home.join("proj/run").display().to_string()));
        assert!(!is_managed("/tmp/somewhere-else"));
    }

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
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q", "."]);
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);
        dir
    }

    #[test]
    fn a_listing_marks_the_checkout_the_caller_is_in() {
        let dir = repo();
        let items = list(&dir.path().display().to_string());
        assert_eq!(items.len(), 1);
        assert!(
            items[0].current,
            "the caller's own checkout is the current one"
        );
    }

    #[test]
    fn a_worktree_is_created_into_and_listed_from_the_project() {
        let dir = repo();
        let root = dir.path().display().to_string();
        let target = dir.path().join("wt");
        let added = git(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "fastvibe/test",
                &target.display().to_string(),
                "HEAD",
            ],
        );
        assert!(added.is_ok(), "{added:?}");
        let items = list(&root);
        assert_eq!(items.len(), 2, "{items:?}");
        let created = items.iter().find(|i| i.path.ends_with("wt")).unwrap();
        assert_eq!(created.branch.as_deref(), Some("fastvibe/test"));
        // The new checkout shares the repository, which is what binding requires. Compared as
        // real paths: on macOS `/tmp` is a symlink and git answers with the resolved one.
        let real = |p: &str| std::fs::canonicalize(p).unwrap().display().to_string();
        assert_eq!(
            real(&common_root(&target.display().to_string()).unwrap()),
            real(&common_root(&root).unwrap())
        );
    }
}
