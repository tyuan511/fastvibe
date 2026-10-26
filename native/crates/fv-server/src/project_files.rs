//! `@` file mentions: the files of a project, ranked against what the user has typed so far.
//!
//! The Electron app's `engine/project-files.ts`, kept to the same rules — the ranking is the part
//! a reader notices, so it is reproduced rather than reinvented:
//!
//! - **A git work tree is listed with `ls-files`, not walked.** Ignored build output then never
//!   appears in the menu, which is the whole reason to ask git: a `@` list offering
//!   `node_modules/**` is noise the file tree itself refuses to draw.
//! - **Anything else is walked**, skipping the same heavy directories, never following a symlink
//!   (that would leave the project), and stopping at a cap so a huge tree cannot be read whole.
//! - **The list is cached briefly.** The menu filters on every keystroke, and spawning git each
//!   time is the slow part; the file set changes on the order of seconds, not keystrokes.
//! - **The score says why a file is here.** An exact name beats a prefix, a prefix beats a
//!   suffix, a suffix beats a substring, a substring anywhere in the path beats a fuzzy match,
//!   and the fuzzy match is confined to the file **name** and must start at a boundary — a
//!   subsequence across the whole path matches almost everything (`nope` inside
//!   `compact-notice`), which buries the file the user meant.
//! - **A multi-folder project lists every folder**, named after it (`web/src/App.tsx`), so two
//!   `README.md` can be told apart. A file reachable from two roots is listed once, under the
//!   first.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How many rows the composer menu shows. Filtering is the way past this.
pub const RESULT_LIMIT: usize = 12;
/// A non-git walk stops here so a huge tree cannot be read whole into the menu.
const WALK_CAP: usize = 8_000;
const CACHE_TTL: Duration = Duration::from_secs(10);
const CACHE_MAX: usize = 8;

/// Directories the file tree never shows, so the menu does not offer them either.
const HIDDEN: [&str; 2] = [".git", "node_modules"];

/// One `@` mention: what the composer shows, and the path the model is given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileHit {
    /// Project-relative, `/`-separated; a second folder's files are prefixed with its name.
    pub relative: String,
    /// Absolute, so the model can read it.
    pub path: String,
}

struct CacheEntry {
    at: Instant,
    files: Vec<String>,
}

static CACHE: Mutex<Option<HashMap<PathBuf, CacheEntry>>> = Mutex::new(None);

/// Files under `cwd` that match `query`, best first.
///
/// `other_folders` are a multi-folder project's other folders. Their files are ranked together
/// with the working directory's and named after their folder, the way the transcript names them.
pub fn search(cwd: Option<&str>, query: Option<&str>, other_folders: &[String]) -> Vec<FileHit> {
    let Some(root) = project_root(cwd) else {
        return Vec::new();
    };
    let mut roots = vec![root];
    for folder in other_folders {
        // A folder that went missing only drops out of the results; the working directory's own
        // listing failing is what the caller reports.
        if let Some(extra) = project_root(Some(folder))
            && !roots.contains(&extra)
        {
            roots.push(extra);
        }
    }
    let listed: Vec<Vec<String>> = roots
        .iter()
        .enumerate()
        .map(|(index, item)| match list_files(item) {
            Ok(files) => files,
            Err(_) if index > 0 => Vec::new(),
            Err(_) => Vec::new(),
        })
        .collect();

    let mut hits: Vec<FileHit> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for (index, (root, files)) in roots.iter().zip(listed.iter()).enumerate() {
        let prefix = if index == 0 {
            String::new()
        } else {
            format!("{}/", folder_name(root))
        };
        for file in files {
            if !safe_relative(file) {
                continue;
            }
            let path: PathBuf = file
                .split('/')
                .fold(root.clone(), |acc, part| acc.join(part));
            if !seen.insert(path.clone()) {
                continue;
            }
            hits.push(FileHit {
                relative: format!("{prefix}{file}"),
                path: path.display().to_string(),
            });
        }
    }
    rank(hits, &normalize_query(query))
}

/// The same ranking over plain relative strings, for a caller that already has a file list.
#[cfg(test)]
fn rank_files(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let hits: Vec<FileHit> = files
        .iter()
        .filter(|f| safe_relative(f))
        .map(|f| FileHit {
            relative: f.clone(),
            path: f.clone(),
        })
        .collect();
    rank(hits, &normalize_query(Some(query)))
        .into_iter()
        .take(limit)
        .map(|hit| hit.relative)
        .collect()
}

fn rank(mut items: Vec<FileHit>, query: &str) -> Vec<FileHit> {
    let mut scored: Vec<(FileHit, i32)> = items
        .drain(..)
        .map(|item| {
            let score = score_file(&item.relative, query);
            (item, score)
        })
        .collect();
    if !query.is_empty() {
        scored.retain(|(_, score)| *score > 0);
    }
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.relative.cmp(&b.0.relative)));
    scored
        .into_iter()
        .take(RESULT_LIMIT)
        .map(|(item, _)| item)
        .collect()
}

fn normalize_query(query: Option<&str>) -> String {
    let Some(query) = query else {
        return String::new();
    };
    query
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim()
        .chars()
        .take(200)
        .collect::<String>()
        .to_lowercase()
}

fn safe_relative(file: &str) -> bool {
    !file.is_empty()
        && !file.contains('\0')
        && !file.starts_with('/')
        && !file.contains('\\')
        && !file.split('/').any(|part| part == "..")
}

/// Why a file is in the list, as a number. Larger is better; `0` means it does not match.
fn score_file(file: &str, query: &str) -> i32 {
    let path = file.to_lowercase();
    let name = path.rsplit('/').next().unwrap_or(&path);
    if query.is_empty() {
        // No query: shallower files first, so the list opens on the project's surface.
        return 100 - (path.split('/').count() as i32).min(99);
    }
    if name == query || path == query {
        return if name == query { 1000 } else { 950 };
    }
    if name.starts_with(query) {
        return 800 - (name.len() as i32).min(100);
    }
    if path.ends_with(&format!("/{query}")) {
        return 750;
    }
    if let Some(at) = name.find(query) {
        return 600 - at as i32;
    }
    if let Some(at) = path.find(query) {
        return 400 - (at as i32).min(200);
    }
    // Fuzzy only the name, and only from a boundary — see the module note.
    let fuzzy = fuzzy_score(name, query);
    let first = query.chars().next().unwrap_or('\0');
    let boundary = name.find(first).is_some_and(|at| boundary_at(name, at));
    if fuzzy > 0 && boundary {
        200 + fuzzy
    } else {
        0
    }
}

fn boundary_at(text: &str, index: usize) -> bool {
    if index == 0 {
        return true;
    }
    matches!(
        text.as_bytes().get(index - 1).copied(),
        Some(b'/') | Some(b'-') | Some(b'_') | Some(b'.')
    )
}

/// Consecutive hits score higher, and a hit on a path boundary scores higher still.
fn fuzzy_score(text: &str, query: &str) -> i32 {
    let mut score = 0;
    let mut from = 0usize;
    let mut streak = 0i32;
    for ch in query.chars() {
        let Some(found) = text[from..].find(ch).map(|at| from + at) else {
            return 0;
        };
        streak = if found == from { streak + 1 } else { 1 };
        score += streak * 3;
        if boundary_at(text, found) {
            score += 4;
        }
        from = found + ch.len_utf8();
    }
    score
}

fn folder_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.display().to_string())
}

fn project_root(cwd: Option<&str>) -> Option<PathBuf> {
    let cwd = cwd?;
    if cwd.trim().is_empty() || cwd.contains('\0') {
        return None;
    }
    let root = PathBuf::from(cwd);
    std::fs::metadata(&root)
        .ok()
        .filter(|m| m.is_dir())
        .map(|_| root)
}

/// The file list for one root, cached for a moment.
///
/// The menu filters on every keystroke; spawning `git ls-files` each time is the slow part, and
/// the set of files changes on the order of seconds rather than keystrokes.
fn list_files(root: &Path) -> Result<Vec<String>, String> {
    {
        let cache = CACHE.lock().unwrap();
        if let Some(entries) = cache.as_ref()
            && let Some(entry) = entries.get(root)
            && entry.at.elapsed() < CACHE_TTL
        {
            return Ok(entry.files.clone());
        }
    }
    let files = load_files(root)?;
    {
        let mut cache = CACHE.lock().unwrap();
        let entries = cache.get_or_insert_with(HashMap::new);
        entries.insert(
            root.to_path_buf(),
            CacheEntry {
                at: Instant::now(),
                files: files.clone(),
            },
        );
        if entries.len() > CACHE_MAX
            && let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.at)
                .map(|(path, _)| path.clone())
        {
            entries.remove(&oldest);
        }
    }
    Ok(files)
}

fn load_files(root: &Path) -> Result<Vec<String>, String> {
    if let Some(files) = git_files(root) {
        return Ok(files.into_iter().filter(|f| safe_relative(f)).collect());
    }
    walk_files(root)
}

/// `git ls-files`, so ignored build output stays out of the menu. `None` when this is not a work
/// tree (or git is missing) — the walk is the other answer.
fn git_files(root: &Path) -> Option<Vec<String>> {
    let out = Command::new("git")
        .args(["-C"])
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// A breadth-first walk that skips the heavy directories and never follows a symlink.
fn walk_files(root: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    // A queue of relative directories, so the walk order is breadth-first: the project's surface
    // is found before a deep corner, which matters when the cap is reached.
    let mut queue: Vec<String> = vec![String::new()];
    let mut head = 0;
    while head < queue.len() && files.len() < WALK_CAP {
        let dir = queue[head].clone();
        head += 1;
        let full = if dir.is_empty() {
            root.to_path_buf()
        } else {
            dir.split('/')
                .fold(root.to_path_buf(), |acc, part| acc.join(part))
        };
        let Ok(entries) = std::fs::read_dir(&full) else {
            continue;
        };
        let mut dirs: Vec<String> = Vec::new();
        let mut sorted: Vec<_> = entries.flatten().collect();
        sorted.sort_by_key(|e| e.file_name());
        for entry in sorted {
            let name = entry.file_name().to_string_lossy().to_string();
            if HIDDEN.contains(&name.as_str()) {
                continue;
            }
            // `file_type` on a directory entry does not follow symlinks, which is the point: a
            // link can point out of the project.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let relative = if dir.is_empty() {
                name
            } else {
                format!("{dir}/{name}")
            };
            if kind.is_dir() {
                dirs.push(relative);
            } else if kind.is_file() {
                files.push(relative);
            }
            if files.len() >= WALK_CAP {
                break;
            }
        }
        dirs.sort();
        queue.extend(dirs);
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn an_exact_name_outranks_a_prefix_which_outranks_a_substring() {
        let ranked = rank_files(
            &[
                "docs/appendix.md".into(),
                "src/app.ts".into(),
                "src/apple.ts".into(),
                "src/my-app-helper.ts".into(),
            ],
            "app",
            10,
        );
        assert_eq!(
            ranked.first().map(String::as_str),
            Some("src/app.ts"),
            "the exact stem wins: {ranked:?}"
        );
        assert!(
            ranked.iter().position(|f| f == "src/apple.ts")
                < ranked.iter().position(|f| f == "src/my-app-helper.ts"),
            "a prefix beats a substring: {ranked:?}"
        );
    }

    #[test]
    fn a_fuzzy_match_must_start_at_a_boundary() {
        // `nope` is a subsequence of `compact-notice` (n...o...p...e) but starts mid-word, and
        // matching it would bury the file the user meant.
        let ranked = rank_files(
            &["src/compact-notice.ts".into(), "src/nope.ts".into()],
            "nope",
            10,
        );
        assert_eq!(ranked, vec!["src/nope.ts".to_string()]);
    }

    #[test]
    fn a_deep_file_sorts_below_a_shallow_one_when_nothing_is_typed() {
        let ranked = rank_files(
            &["a/b/c/deep.ts".into(), "top.ts".into(), "src/mid.ts".into()],
            "",
            10,
        );
        assert_eq!(ranked.first().map(String::as_str), Some("top.ts"));
        assert_eq!(ranked.last().map(String::as_str), Some("a/b/c/deep.ts"));
    }

    #[test]
    fn an_unsafe_relative_path_is_never_offered() {
        for bad in ["../outside.ts", "/etc/passwd", "a\\b.ts", "a/../b.ts", ""] {
            assert!(!safe_relative(bad), "{bad:?} must not reach the menu");
        }
        assert!(safe_relative("src/app.ts"));
    }

    #[test]
    fn a_git_work_tree_lists_tracked_and_untracked_but_not_ignored_files() {
        let dir = temp();
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
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q", "."]);
        std::fs::write(dir.path().join(".gitignore"), "build/\n").unwrap();
        std::fs::create_dir(dir.path().join("build")).unwrap();
        std::fs::write(dir.path().join("build/out.js"), "x").unwrap();
        std::fs::write(dir.path().join("tracked.ts"), "x").unwrap();
        run(&["add", ".gitignore"]);
        std::fs::write(dir.path().join("fresh.ts"), "x").unwrap();

        let hits = search(Some(&dir.path().display().to_string()), Some(""), &[]);
        let names: Vec<&str> = hits.iter().map(|h| h.relative.as_str()).collect();
        assert!(names.contains(&".gitignore"), "{names:?}");
        assert!(names.contains(&"tracked.ts"), "{names:?}");
        assert!(
            names.contains(&"fresh.ts"),
            "an untracked file is still mentionable: {names:?}"
        );
        assert!(
            !names.contains(&"build/out.js"),
            "ignored output must not appear: {names:?}"
        );
    }

    #[test]
    fn a_second_folder_is_named_after_itself_and_listed_once() {
        let one = temp();
        let two = temp();
        std::fs::write(one.path().join("README.md"), "a").unwrap();
        std::fs::write(two.path().join("README.md"), "b").unwrap();
        let hits = search(
            Some(&one.path().display().to_string()),
            Some("readme"),
            &[two.path().display().to_string()],
        );
        let relatives: Vec<&str> = hits.iter().map(|h| h.relative.as_str()).collect();
        assert_eq!(
            relatives.len(),
            2,
            "two README files, told apart: {relatives:?}"
        );
        let second = two
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(
            relatives.contains(&format!("{second}/README.md").as_str()),
            "{relatives:?}"
        );
    }

    #[test]
    fn an_empty_or_missing_directory_yields_nothing() {
        assert!(search(None, Some("a"), &[]).is_empty());
        assert!(search(Some(""), Some("a"), &[]).is_empty());
        assert!(search(Some("/definitely/not/here"), Some("a"), &[]).is_empty());
    }
}
