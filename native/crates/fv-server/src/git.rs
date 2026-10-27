//! Git, as the right pane's 变更 view reads it: what changed, one file's patch, the commit graph,
//! and the three writes the pane offers (stage, unstage, discard, commit).
//!
//! This is the Electron app's `main/workspace-git.ts` and `main/source-control.ts`, and every rule
//! in them exists for a reason worth keeping:
//!
//! - **Reads never take the index lock.** `--no-optional-locks` on every read: the pane polls
//!   `status` in the background, and an agent's own `git add` in the same tree would otherwise
//!   find `index.lock` held and fail. A background poll must not break the user's work.
//! - **Paths are literal pathspecs** (`--literal-pathspecs`). A file named `*.txt` or `:(glob)x` is
//!   a file, not a pattern; without this, a rename or a delete would silently act on more than the
//!   row that was clicked.
//! - **NUL records** (`-z`) rather than newline parsing: they preserve Unicode, spaces and rename
//!   destinations verbatim, and a path with a newline in it stays one path.
//! - **An untracked file's diff is `--no-index` against `/dev/null`**, and exit code 1 from that
//!   call means "a patch was produced", not "it failed". Reading it as a failure is how an
//!   untracked file ends up with an empty view.
//! - **A revision from a client is validated as a bare hash.** History opens immutable commits;
//!   it never accepts a revision *expression*, because `HEAD~1^{tree}` in a field that is supposed
//!   to be a commit id is a way to ask git for something other than a commit.
//! - **Pagination pins its tips.** The first page records the commits it started from, and later
//!   pages use them: a commit landing between two pages would otherwise shift every row and the
//!   reader would see one commit twice and miss another.

use std::path::Path;
use std::process::Command;

use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::*;

/// Largest patch the pane will carry in one message.
const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;
/// Commits per history page, plus one to know whether there is more.
const PAGE: usize = 50;

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn failed(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, message)
}

/// One git call. `diff_exit` is for `--no-index`, which exits 1 when it produced a patch.
fn git(cwd: &str, args: &[&str], diff_exit: bool) -> Result<String, String> {
    if cwd.is_empty() || cwd.contains('\0') {
        return Err("invalid repository path".into());
    }
    let out = Command::new("git")
        // Reads must never take `index.lock`: the pane polls, and the agent's own `git add` in
        // the same tree must not fail because of it.
        .args(["--no-optional-locks", "--literal-pathspecs", "-C", cwd])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    if diff_exit && out.status.code() == Some(1) {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        err
    })
}

fn has_head(cwd: &str) -> bool {
    git(cwd, &["rev-parse", "--verify", "HEAD"], false).is_ok()
}

/// The branch, the ahead/behind counts and every changed file.
///
/// The header line is `## main...origin/main [ahead 1]`, `## No commits yet on main` in a fresh
/// repository, and `## HEAD (no branch)` when detached — the decorations are stripped so the pane
/// can print a bare ref name.
pub fn status(cwd: &str) -> Result<GitStatus, ErrorObject> {
    let empty = GitStatus {
        cwd: cwd.into(),
        is_repository: false,
        branch: None,
        ahead: 0,
        behind: 0,
        changed: 0,
        staged: 0,
        additions: 0,
        deletions: 0,
        files: Vec::new(),
    };
    let porcelain = match git(
        cwd,
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        false,
    ) {
        Ok(out) => out,
        // Not a repository (or no git at all): the pane says so rather than showing an error.
        Err(_) => return Ok(empty),
    };
    let prefix = git(cwd, &["rev-parse", "--show-prefix"], false)
        .map(|p| p.trim_end_matches(['\r', '\n']).to_string())
        .unwrap_or_default();
    let Some((header, rest)) = split_header(&porcelain) else {
        return Ok(empty);
    };
    let branch = parse_branch(&header);
    let ahead = count_after(&header, "ahead ");
    let behind = count_after(&header, "behind ");

    let mut files = parse_porcelain(rest);
    // Porcelain paths are repository-root relative even when the workspace is a subdirectory;
    // rebase them onto the directory the pane is showing.
    if !prefix.is_empty() {
        for file in &mut files {
            file.path = strip_prefix(&file.path, &prefix);
        }
    }
    let staged = files
        .iter()
        .filter(|f| f.index != " " && f.index != "?")
        .count();
    let (additions, deletions) = line_stats(cwd);
    Ok(GitStatus {
        cwd: cwd.into(),
        is_repository: true,
        branch,
        ahead,
        behind,
        changed: files.len() as u32,
        staged: staged as u32,
        additions,
        deletions,
        files,
    })
}

fn split_header(porcelain: &str) -> Option<(String, &str)> {
    let end = porcelain.find('\0')?;
    let header = &porcelain[..end];
    if !header.starts_with("## ") {
        return None;
    }
    Some((header[3..].to_string(), &porcelain[end + 1..]))
}

fn parse_branch(header: &str) -> Option<String> {
    let text = header.split("...").next().unwrap_or(header).trim();
    let name = text
        .strip_prefix("No commits yet on ")
        .unwrap_or(text)
        .trim_end_matches(" (no branch)")
        .trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn count_after(header: &str, needle: &str) -> u32 {
    header
        .find(needle)
        .and_then(|i| header[i + needle.len()..].split_whitespace().next())
        .and_then(|n| n.trim_end_matches(']').parse().ok())
        .unwrap_or(0)
}

/// `git status --porcelain=v1 -z`: `XY <path>` records, and a rename's origin follows its
/// destination as its own record.
fn parse_porcelain(records: &str) -> Vec<GitFileChange> {
    let mut files = Vec::new();
    let mut items = records.split('\0');
    while let Some(record) = items.next() {
        if record.len() < 4 {
            continue;
        }
        let index = &record[0..1];
        let worktree = &record[1..2];
        let path = record[3..].to_string();
        files.push(GitFileChange {
            path,
            index: index.to_string(),
            worktree: worktree.to_string(),
        });
        // A rename or copy record is followed by the original path; the pane shows the
        // destination, so that record is consumed and dropped.
        if matches!(index, "R" | "C") || matches!(worktree, "R" | "C") {
            let _ = items.next();
        }
    }
    files
}

fn strip_prefix(path: &str, prefix: &str) -> String {
    path.strip_prefix(prefix).unwrap_or(path).to_string()
}

/// Line totals across the tracked working tree relative to `HEAD`.
///
/// An unborn branch has no `HEAD`, so its staged and unstaged layers are summed instead — the
/// closest line-level answer available before the first commit.
fn line_stats(cwd: &str) -> (u32, u32) {
    let read = |args: &[&str]| -> (u32, u32) {
        match git(cwd, args, false) {
            Ok(out) => count_numstat(&out),
            Err(_) => (0, 0),
        }
    };
    if has_head(cwd) {
        read(&["diff", "--numstat", "HEAD", "--"])
    } else {
        let (a1, d1) = read(&["diff", "--numstat", "--cached", "--"]);
        let (a2, d2) = read(&["diff", "--numstat", "--"]);
        (a1 + a2, d1 + d2)
    }
}

fn count_numstat(output: &str) -> (u32, u32) {
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for line in output.lines() {
        let mut fields = line.split('\t');
        if let Some(n) = fields.next().and_then(|n| n.parse::<u32>().ok()) {
            additions += n;
        }
        if let Some(n) = fields.next().and_then(|n| n.parse::<u32>().ok()) {
            deletions += n;
        }
    }
    (additions, deletions)
}

/// The base and target a comparison is made against.
///
/// Without a revision the pane compares against the upstream's merge base, so a branch view shows
/// the branch's own work rather than every commit the upstream has moved on by. With a revision it
/// is one immutable commit against its first parent (a root commit against the empty tree).
fn comparison(cwd: &str, revision: Option<&str>) -> Result<GitComparison, String> {
    let Some(revision) = revision else {
        let base = git(cwd, &["merge-base", "@{upstream}", "HEAD"], false)?
            .trim()
            .to_string();
        return Ok(GitComparison {
            base,
            target: "HEAD".into(),
            files: Vec::new(),
        });
    };
    // A commit id, never an expression: `HEAD~1^{tree}` in a field meant for a hash is a way to
    // ask git for something that is not a commit.
    if revision.len() < 40
        || revision.len() > 64
        || !revision.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("invalid commit id".into());
    }
    let hash = git(
        cwd,
        &["rev-parse", "--verify", &format!("{revision}^{{commit}}")],
        false,
    )?
    .trim()
    .to_string();
    let parents = git(cwd, &["rev-list", "--parents", "-n", "1", &hash], false)?;
    let base = parents.split_whitespace().nth(1).unwrap_or("").to_string();
    Ok(GitComparison {
        base,
        target: hash,
        files: Vec::new(),
    })
}

fn diff_args(plan: &GitComparison) -> Vec<String> {
    if plan.target == "HEAD" {
        vec!["diff".into(), plan.base.clone(), "HEAD".into()]
    } else if plan.base.is_empty() {
        vec![
            "diff-tree".into(),
            "--root".into(),
            "--no-commit-id".into(),
            "-r".into(),
            plan.target.clone(),
        ]
    } else {
        vec![
            "diff-tree".into(),
            "--no-commit-id".into(),
            "-r".into(),
            plan.base.clone(),
            plan.target.clone(),
        ]
    }
}

/// The files a branch (or one commit) changed, as the 变更 view lists them for that scope.
pub fn comparison_files(cwd: &str, revision: Option<&str>) -> Result<GitComparison, ErrorObject> {
    let mut plan = comparison(cwd, revision).map_err(invalid)?;
    let mut args: Vec<String> = diff_args(&plan);
    args.extend(
        ["--name-status", "--no-renames", "--no-relative", "-z", "--"]
            .iter()
            .map(|s| s.to_string()),
    );
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git(cwd, &borrowed, false).map_err(failed)?;
    let prefix = git(cwd, &["rev-parse", "--show-prefix"], false)
        .map(|p| p.trim_end_matches(['\r', '\n']).to_string())
        .unwrap_or_default();
    let records: Vec<&str> = output.split('\0').collect();
    let mut files = Vec::new();
    for pair in records.chunks(2) {
        let [status, path] = pair else { continue };
        if status.is_empty() || path.is_empty() {
            continue;
        }
        files.push(GitFileChange {
            path: if prefix.is_empty() {
                path.to_string()
            } else {
                strip_prefix(path, &prefix)
            },
            // A branch/commit comparison has no index/worktree split: the change is the commit's.
            index: " ".into(),
            worktree: status.chars().next().unwrap_or('M').to_string(),
        });
    }
    plan.files = files;
    Ok(plan)
}

/// One file's patch, from whichever of the three layers the pane asked for.
pub fn diff(params: GitDiffParams) -> Result<GitDiff, ErrorObject> {
    let cwd = &params.cwd;
    if params.path.as_deref().is_some_and(|p| p.contains('\0')) {
        return Err(invalid("invalid file path"));
    }
    let options = [
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=5",
    ];
    let path = params.path.clone();
    let mut args: Vec<String> = Vec::new();

    if params.revision.is_some() || params.source == DiffSource::Branch {
        let plan = comparison(cwd, params.revision.as_deref()).map_err(invalid)?;
        args.extend(diff_args(&plan));
        args.push("-p".into());
        args.push("--no-renames".into());
        args.extend(options.iter().map(|s| s.to_string()));
        args.push("--".into());
        if let Some(path) = &path {
            args.push(path.clone());
        }
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let text = git(cwd, &borrowed, false).map_err(failed)?;
        return Ok(GitDiff { text: cap(text) });
    }

    // An untracked file has no diff against anything: it is a patch from the empty file. `--no-index`
    // exits 1 when it produced one, which is success.
    if let Some(path) = &path
        && params.source != DiffSource::Staged
    {
        let current = status(cwd)?;
        let wanted = current.files.iter().find(|f| f.path == *path).cloned();
        let untracked = wanted.as_ref().is_some_and(|f| f.index == "?");
        // A repository with no commits yet: a staged add has nothing to diff against, so the
        // patch still comes from the empty file.
        let staged_before_first_commit = params.source == DiffSource::LastTurn
            && wanted.as_ref().is_some_and(|f| f.index == "A")
            && !has_head(cwd);
        if untracked || staged_before_first_commit {
            let absolute = Path::new(cwd).join(path);
            let borrowed = [
                "diff",
                "--no-index",
                options[0],
                options[1],
                options[2],
                options[3],
                "--",
                "/dev/null",
                &absolute.display().to_string(),
            ];
            let text = git(cwd, &borrowed, true).map_err(failed)?;
            return Ok(GitDiff { text: cap(text) });
        }
    }

    args.push("diff".into());
    args.extend(options.iter().map(|s| s.to_string()));
    match params.source {
        DiffSource::Staged => args.push("--cached".into()),
        DiffSource::LastTurn if has_head(cwd) => args.push("HEAD".into()),
        _ => {}
    }
    args.push("--".into());
    if let Some(path) = &path {
        args.push(path.clone());
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let text = git(cwd, &borrowed, false).map_err(failed)?;
    Ok(GitDiff { text: cap(text) })
}

/// A patch is a message, not a file transfer: past this the pane says it was cut.
fn cap(text: String) -> String {
    if text.len() <= MAX_PATCH_BYTES {
        return text;
    }
    let mut cut = MAX_PATCH_BYTES;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!(
        "{}\n\n… 补丁过大，只显示前 {} MB。",
        &text[..cut],
        MAX_PATCH_BYTES / (1024 * 1024)
    )
}

/// The commit graph, with real parents and every ref that points at a commit.
///
/// `tips` pins the commits the first page started from: a commit landing between two pages would
/// otherwise shift every row, and the reader would see one commit twice and miss another.
pub fn history(params: GitHistoryParams) -> Result<GitHistory, ErrorObject> {
    let cwd = &params.cwd;
    let skip = params.skip.unwrap_or(0).min(100_000);
    git(cwd, &["rev-parse", "--git-dir"], false).map_err(failed)?;
    let head = git(cwd, &["rev-parse", "--verify", "HEAD"], false)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let branch = git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], false)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let ref_text = git(
        cwd,
        &[
            "for-each-ref",
            "--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)%00%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        false,
    )
    .map_err(failed)?;

    // Every ref, keyed by the commit it points at (an annotated tag's peeled commit).
    let mut refs: std::collections::HashMap<String, Vec<GitReference>> =
        std::collections::HashMap::new();
    for line in ref_text.lines().filter(|l| !l.is_empty()) {
        let fields: Vec<&str> = line.split('\0').collect();
        let [object, object_type, peeled, peeled_type, name, symbolic] = fields[..] else {
            continue;
        };
        let hash = if object_type == "commit" {
            object
        } else if peeled_type == "commit" {
            peeled
        } else {
            continue;
        };
        if hash.is_empty() || name.is_empty() || !symbolic.is_empty() {
            continue;
        }
        let kind = if name.starts_with("refs/heads/") {
            GitRefKind::Local
        } else if name.starts_with("refs/remotes/") {
            GitRefKind::Remote
        } else if name.starts_with("refs/tags/") {
            GitRefKind::Tag
        } else {
            continue;
        };
        let short = name
            .trim_start_matches("refs/heads/")
            .trim_start_matches("refs/remotes/")
            .trim_start_matches("refs/tags/")
            .to_string();
        let current = kind == GitRefKind::Local && short == branch;
        refs.entry(hash.to_string())
            .or_default()
            .push(GitReference {
                name: short,
                kind,
                current,
            });
    }

    let tips = match params.tips {
        Some(tips) => {
            if tips.len() > 2048 || tips.iter().any(|t| !is_hash(t)) {
                return Err(invalid("invalid history cursor"));
            }
            tips
        }
        None => {
            let mut roots: Vec<String> = Vec::new();
            if !head.is_empty() {
                roots.push(head.clone());
            }
            if params.scope == HistoryScope::All {
                for hash in refs.keys() {
                    if !roots.contains(hash) {
                        roots.push(hash.clone());
                    }
                }
            }
            roots
        }
    };
    if tips.is_empty() {
        return Ok(GitHistory {
            commits: Vec::new(),
            has_more: false,
            tips,
            head: (!head.is_empty()).then_some(head),
            branch: (!branch.is_empty()).then_some(branch),
        });
    }
    let mut args: Vec<String> = vec![
        "log".into(),
        "--topo-order".into(),
        format!("--max-count={}", PAGE + 1),
        format!("--skip={skip}"),
        "--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%B".into(),
        "-z".into(),
    ];
    args.extend(tips.iter().cloned());
    args.push("--".into());
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git(cwd, &borrowed, false).map_err(failed)?;

    let fields: Vec<&str> = output.split('\0').collect();
    let mut commits = Vec::new();
    for chunk in fields.chunks(6) {
        let [hash, parents, subject, author, date, body] = chunk else {
            continue;
        };
        if hash.is_empty() {
            continue;
        }
        commits.push(GitCommit {
            hash: hash.to_string(),
            parents: parents.split_whitespace().map(str::to_string).collect(),
            subject: subject.to_string(),
            author: author.to_string(),
            date: date.to_string(),
            body: body.trim_end().to_string(),
            refs: refs.get(*hash).cloned().unwrap_or_default(),
            is_head: !head.is_empty() && *hash == head,
        });
    }
    let has_more = commits.len() > PAGE;
    commits.truncate(PAGE);
    Ok(GitHistory {
        commits,
        has_more,
        tips,
        head: (!head.is_empty()).then_some(head),
        branch: (!branch.is_empty()).then_some(branch),
    })
}

fn is_hash(text: &str) -> bool {
    (40..=64).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}

fn valid_paths(paths: &[String]) -> Result<(), ErrorObject> {
    if paths.is_empty() || paths.iter().any(|p| p.is_empty() || p.contains('\0')) {
        return Err(invalid("no valid files selected"));
    }
    Ok(())
}

/// Stage files, or the whole tree with `all`.
pub fn stage(cwd: &str, paths: &[String], all: bool) -> Result<GitStatus, ErrorObject> {
    let mut args: Vec<String> = vec!["add".into()];
    if all || paths.is_empty() {
        args.push("-A".into());
    }
    args.push("--".into());
    if !paths.is_empty() {
        valid_paths(paths)?;
        args.extend(paths.iter().cloned());
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    git(cwd, &borrowed, false).map_err(failed)?;
    status(cwd)
}

/// Unstage files, keeping their working-tree content.
///
/// A rename is unstaged on **both** sides: `git restore --staged` on the destination alone leaves
/// the origin staged as a delete, and the file then reads as two changes instead of one.
pub fn unstage(cwd: &str, paths: &[String]) -> Result<GitStatus, ErrorObject> {
    valid_paths(paths)?;
    let mut all = paths.to_vec();
    // A staged rename's origin is not in the row the user clicked.
    if let Ok(out) = git(
        cwd,
        &[
            "diff",
            "--cached",
            "--name-status",
            "--find-renames",
            "--no-relative",
            "-z",
            "--",
        ],
        false,
    ) {
        let records: Vec<&str> = out.split('\0').collect();
        for pair in records.chunks(3) {
            let [status, from, to] = pair else { continue };
            if status.starts_with('R')
                && paths.iter().any(|p| p == to)
                && !all.iter().any(|p| p == from)
            {
                all.push((*from).to_string());
            }
        }
    }
    let mut args: Vec<String> = if has_head(cwd) {
        vec!["restore".into(), "--staged".into(), "--".into()]
    } else {
        // No HEAD yet: there is nothing to restore *from*, so the entries leave the index.
        vec!["rm".into(), "--cached".into(), "--".into()]
    };
    args.extend(all);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    git(cwd, &borrowed, false).map_err(failed)?;
    status(cwd)
}

/// Discard working-tree changes for these files.
///
/// A file that is only in the index goes back to the index's content, not to `HEAD`: discarding
/// the worktree must not also throw away what the user staged on purpose.
pub fn discard(cwd: &str, paths: &[String]) -> Result<GitStatus, ErrorObject> {
    valid_paths(paths)?;
    let tracked: Vec<String> = paths.to_vec();
    let mut args: Vec<String> = vec!["restore".into(), "--worktree".into(), "--".into()];
    args.extend(tracked.iter().cloned());
    git(
        cwd,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        false,
    )
    .map_err(failed)?;
    status(cwd)
}

/// Delete untracked files.
///
/// Only the paths the status named are removed, and never a directory recursively: an untracked
/// folder can hold work nobody meant to lose, so the pane asks per file.
pub fn delete_untracked(cwd: &str, paths: &[String]) -> Result<GitStatus, ErrorObject> {
    valid_paths(paths)?;
    for path in paths {
        let full = Path::new(cwd).join(path);
        match std::fs::remove_file(&full) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(failed(format!("cannot remove {path}: {e}"))),
        }
    }
    status(cwd)
}

/// Commit the index.
///
/// **This does not stage anything.** The pane's own commit button stages the whole tree first
/// (`stage(cwd, &[], true)`), because a commit action that silently leaves files out is the bug
/// this was written to avoid; but the call itself stays index-only so a caller that staged a part
/// of the tree on purpose gets what it staged.
pub fn commit(cwd: &str, message: &str, amend: bool) -> Result<GitStatus, ErrorObject> {
    if message.trim().is_empty() {
        return Err(invalid("提交信息不能为空"));
    }
    let mut args: Vec<String> = vec!["commit".into(), "-m".into(), message.to_string()];
    if amend {
        args.push("--amend".into());
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    git(cwd, &borrowed, false).map_err(failed)?;
    status(cwd)
}

/// Which way `sync` talks to the remote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sync {
    Pull,
    Push,
}

/// Longest a pull or push may take before it is killed, as in the Electron app.
const SYNC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// `git pull --ff-only` or `git push`, then the repository's status.
///
/// A pull never merges or rebases: when the branches have diverged it fails and says so, rather
/// than leaving a conflicted tree behind a button that looked harmless. Nothing may wait for a
/// person — no terminal prompt, and ssh is told not to ask — and a transfer that stalls is killed
/// after [`SYNC_TIMEOUT`], taking its children with it.
pub fn sync(cwd: &str, direction: Sync) -> Result<GitStatus, ErrorObject> {
    if cwd.is_empty() || cwd.contains('\0') {
        return Err(invalid("invalid repository path"));
    }
    let verb = match direction {
        Sync::Pull => "pull",
        Sync::Push => "push",
    };
    let mut command = Command::new("git");
    command.args(["-C", cwd, verb]);
    if direction == Sync::Pull {
        command.arg("--ff-only");
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so the timeout can end ssh and the credential helpers too.
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| failed(format!("cannot run git: {e}")))?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut text = String::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.take(64 * 1024).read_to_string(&mut text);
        }
        text
    });
    let started = std::time::Instant::now();
    let exit = loop {
        match child.try_wait() {
            Ok(Some(exit)) => break Some(exit),
            Ok(None) if started.elapsed() >= SYNC_TIMEOUT => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(e) => return Err(failed(format!("cannot wait for git: {e}"))),
        }
    };
    let err = reader.join().unwrap_or_default().trim().to_string();
    match exit {
        None => Err(failed(format!(
            "git {verb} timed out after {} seconds",
            SYNC_TIMEOUT.as_secs()
        ))),
        Some(exit) if exit.success() => status(cwd),
        Some(_) => Err(failed(if err.is_empty() {
            format!("git {verb} failed")
        } else {
            err
        })),
    }
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

    fn at(dir: &tempfile::TempDir) -> String {
        dir.path().display().to_string()
    }

    #[test]
    fn a_status_names_the_branch_and_splits_the_two_layers() {
        let dir = repo();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
        let st = status(&at(&dir)).unwrap();
        assert!(st.is_repository);
        assert!(st.branch.is_some(), "{:?}", st.branch);
        assert_eq!(st.changed, 2);
        assert_eq!(st.staged, 0);
        // `diff --numstat HEAD` counts tracked paths only: an untracked file has no side to
        // count against. That is git's own answer, and the pane shows the file row regardless.
        assert_eq!(st.additions, 1);
        let untracked = st.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(untracked.index, "?");
    }

    #[test]
    fn a_directory_that_is_not_a_repository_is_reported_as_such() {
        let dir = tempfile::tempdir().unwrap();
        let st = status(&dir.path().display().to_string()).unwrap();
        assert!(!st.is_repository);
        assert_eq!(st.changed, 0);
    }

    #[test]
    fn an_untracked_files_diff_comes_from_the_empty_file() {
        let dir = repo();
        std::fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
        let patch = diff(GitDiffParams {
            cwd: at(&dir),
            path: Some("new.txt".into()),
            source: DiffSource::Unstaged,
            revision: None,
        })
        .unwrap();
        assert!(patch.text.contains("+fresh"), "{}", patch.text);
        assert!(patch.text.contains("/dev/null"), "{}", patch.text);
    }

    #[test]
    fn staging_then_unstaging_returns_the_file_to_the_worktree_layer() {
        let dir = repo();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        let staged = stage(&at(&dir), &["a.txt".into()], false).unwrap();
        assert_eq!(staged.staged, 1);
        let back = unstage(&at(&dir), &["a.txt".into()]).unwrap();
        assert_eq!(back.staged, 0);
        assert_eq!(back.changed, 1, "the edit is still there, just unstaged");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[test]
    fn discarding_a_worktree_change_keeps_what_was_staged() {
        let dir = repo();
        // Stage one edit, then make a second one on top of it.
        std::fs::write(dir.path().join("a.txt"), "staged\n").unwrap();
        stage(&at(&dir), &["a.txt".into()], false).unwrap();
        std::fs::write(dir.path().join("a.txt"), "staged\nand more\n").unwrap();
        let after = discard(&at(&dir), &["a.txt".into()]).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "staged\n",
            "the worktree goes back to the index, not to HEAD"
        );
        assert_eq!(after.staged, 1);
    }

    #[test]
    fn deleting_untracked_files_touches_only_the_paths_named() {
        let dir = repo();
        std::fs::write(dir.path().join("gone.txt"), "x\n").unwrap();
        std::fs::create_dir(dir.path().join("keep")).unwrap();
        std::fs::write(dir.path().join("keep/inside.txt"), "y\n").unwrap();
        delete_untracked(&at(&dir), &["gone.txt".into()]).unwrap();
        assert!(!dir.path().join("gone.txt").exists());
        assert!(
            dir.path().join("keep/inside.txt").exists(),
            "a directory is never removed recursively"
        );
    }

    #[test]
    fn a_commit_takes_the_index_and_nothing_else() {
        let dir = repo();
        std::fs::write(dir.path().join("a.txt"), "committed\n").unwrap();
        std::fs::write(dir.path().join("other.txt"), "not staged\n").unwrap();
        stage(&at(&dir), &["a.txt".into()], false).unwrap();
        commit(&at(&dir), "only a.txt", false).unwrap();
        // The unstaged file is still untracked, so it was not swept into the commit.
        let st = status(&at(&dir)).unwrap();
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].path, "other.txt");
    }

    #[test]
    fn history_reads_real_parents_and_refs() {
        let dir = repo();
        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        stage(&at(&dir), &[], true).unwrap();
        commit(&at(&dir), "second", false).unwrap();
        let h = history(GitHistoryParams {
            cwd: at(&dir),
            skip: None,
            scope: HistoryScope::All,
            tips: None,
        })
        .unwrap();
        assert_eq!(h.commits.len(), 2);
        assert_eq!(h.commits[0].subject, "second");
        assert!(h.commits[0].is_head);
        assert_eq!(h.commits[0].parents.len(), 1);
        assert!(
            h.commits[0].refs.iter().any(|r| r.current),
            "the branch this is on is marked"
        );
        // The root commit has no parents, and the graph must not invent one.
        assert!(h.commits[1].parents.is_empty());
    }

    #[test]
    fn a_revision_that_is_an_expression_is_refused() {
        let dir = repo();
        let refused = comparison_files(&at(&dir), Some("HEAD~1^{tree}"));
        assert!(refused.is_err(), "only a bare commit id is a commit id");
    }

    #[test]
    fn a_pinned_tip_keeps_pagination_on_the_same_commits() {
        let dir = repo();
        let first = history(GitHistoryParams {
            cwd: at(&dir),
            skip: None,
            scope: HistoryScope::All,
            tips: None,
        })
        .unwrap();
        let tip = first.commits[0].hash.clone();
        // A new commit lands between the pages.
        std::fs::write(dir.path().join("a.txt"), "three\n").unwrap();
        stage(&at(&dir), &[], true).unwrap();
        commit(&at(&dir), "third", false).unwrap();
        // The first page started at `tip`; the second page reads from the same tip, so it
        // reaches the commit *before* it rather than picking up the one that just landed.
        let second = history(GitHistoryParams {
            cwd: at(&dir),
            skip: Some(1),
            scope: HistoryScope::All,
            tips: Some(vec![tip.clone()]),
        })
        .unwrap();
        assert_eq!(
            second.commits.len(),
            0,
            "the pinned tip has one commit behind the first page, and it was already shown"
        );
        assert_eq!(second.tips, vec![tip.clone()]);
        assert_eq!(second.tips, vec![tip.clone()]);
    }

    /// A bare "origin" and two clones of it, `a` and `b`, with one commit pushed.
    fn remote_pair() -> (tempfile::TempDir, String, String) {
        let root = tempfile::tempdir().unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
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
        let origin = root.path().join("origin.git");
        std::fs::create_dir(&origin).unwrap();
        git(&origin, &["init", "-q", "--bare", "-b", "main"]);
        let a = root.path().join("a");
        let b = root.path().join("b");
        for (dir, name) in [(&a, "a"), (&b, "b")] {
            std::fs::create_dir(dir).unwrap();
            git(dir, &["init", "-q", "-b", "main"]);
            git(dir, &["remote", "add", "origin", origin.to_str().unwrap()]);
            git(dir, &["config", "user.name", name]);
            git(dir, &["config", "user.email", "t@t"]);
        }
        std::fs::write(a.join("f.txt"), "one\n").unwrap();
        git(&a, &["add", "."]);
        git(&a, &["commit", "-qm", "one"]);
        git(&a, &["push", "-q", "-u", "origin", "main"]);
        git(&b, &["pull", "-q", "origin", "main"]);
        git(&b, &["branch", "--set-upstream-to=origin/main"]);
        let (a, b) = (a.display().to_string(), b.display().to_string());
        (root, a, b)
    }

    fn commit_file(dir: &str, name: &str, body: &str) {
        std::fs::write(std::path::Path::new(dir).join(name), body).unwrap();
        stage(dir, &[], true).unwrap();
        commit(dir, &format!("add {name}"), false).unwrap();
    }

    #[test]
    fn push_publishes_and_pull_fast_forwards() {
        let (_root, a, b) = remote_pair();
        commit_file(&a, "two.txt", "two\n");
        assert_eq!(status(&a).unwrap().ahead, 1);
        let pushed = sync(&a, Sync::Push).unwrap();
        assert_eq!(pushed.ahead, 0, "push leaves nothing ahead");
        let pulled = sync(&b, Sync::Pull).unwrap();
        assert_eq!(pulled.behind, 0);
        assert!(std::path::Path::new(&b).join("two.txt").exists());
    }

    #[test]
    fn a_pull_of_diverged_branches_fails_and_changes_nothing() {
        let (_root, a, b) = remote_pair();
        commit_file(&a, "from_a.txt", "a\n");
        sync(&a, Sync::Push).unwrap();
        commit_file(&b, "from_b.txt", "b\n");
        let before = git(&b, &["rev-parse", "HEAD"], false).unwrap();
        let error = sync(&b, Sync::Pull).unwrap_err();
        assert!(!error.message.is_empty());
        assert_eq!(
            git(&b, &["rev-parse", "HEAD"], false).unwrap(),
            before,
            "no merge commit"
        );
        assert!(
            status(&b).unwrap().files.is_empty(),
            "no conflicted tree left behind"
        );
    }

    #[test]
    fn a_rejected_push_reports_git_and_a_bad_path_is_refused() {
        let (_root, a, b) = remote_pair();
        commit_file(&a, "x.txt", "x\n");
        sync(&a, Sync::Push).unwrap();
        commit_file(&b, "y.txt", "y\n");
        assert!(
            sync(&b, Sync::Push).is_err(),
            "behind the remote: not a fast-forward"
        );
        assert!(sync("", Sync::Pull).is_err());
    }
}
