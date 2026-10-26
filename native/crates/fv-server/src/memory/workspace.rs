use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use serde_json::{Value, json};

pub type Tree = BTreeMap<String, String>;
const MAX_TREE: usize = 64 * 1024 * 1024;
const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_EDIT: usize = 1024 * 1024;
pub const DIFF: &str = "phase2_workspace_diff.md";
const STAGE_PREFIX: &str = ".memory-publish-";
const STAGE_MARKER: &str = "fastvibe-memory-publish-v1";

fn mark_stage(path: &Path) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut marker = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path.join(".transaction"))?;
    marker.write_all(STAGE_MARKER.as_bytes())?;
    marker.sync_all()
}

fn managed_stages(parent: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut stages = Vec::new();
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(STAGE_PREFIX)
        {
            continue;
        }
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path)?;
        if !meta.is_dir() || meta.is_symlink() {
            continue;
        }
        let marker = path.join(".transaction");
        if std::fs::symlink_metadata(&marker)
            .is_ok_and(|m| m.is_file() && !m.is_symlink() && m.len() == STAGE_MARKER.len() as u64)
            && std::fs::read_to_string(marker).is_ok_and(|s| s == STAGE_MARKER)
        {
            stages.push(path);
        }
    }
    stages.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    Ok(stages)
}

/// A process can die between the two folder renames. Restore its original folder before
/// serving reads; recovery reads transaction metadata only, including when memory is off.
pub fn recover(root: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(root) {
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let parent = root
        .parent()
        .ok_or_else(|| std::io::Error::other("memory folder has no parent"))?;
    for stage in managed_stages(parent)?.into_iter().rev() {
        let old = stage.join("old");
        if std::fs::symlink_metadata(&old).is_ok_and(|m| m.is_dir() && !m.is_symlink()) {
            std::fs::rename(old, root)?;
            break;
        }
    }
    Ok(())
}

pub fn clear_stages(root: &Path) -> std::io::Result<()> {
    let parent = root
        .parent()
        .ok_or_else(|| std::io::Error::other("memory folder has no parent"))?;
    for stage in managed_stages(parent)? {
        std::fs::remove_dir_all(stage)?;
    }
    Ok(())
}

fn relative(root: &Path, path: &str) -> Result<String, String> {
    let path = Path::new(path);
    let path = if path.is_absolute() {
        path.strip_prefix(root)
            .map_err(|_| "path is outside the memory workspace")?
    } else {
        path
    };
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || path.to_str().is_none()
    {
        return Err("use a normal UTF-8 path within the memory workspace".into());
    }
    if path.components().count() > 16
        || path
            .components()
            .any(|c| c.as_os_str().to_string_lossy().len() > 255)
        || root.as_os_str().to_string_lossy().len() + path.as_os_str().to_string_lossy().len() + 1
            >= libc::PATH_MAX as usize
    {
        return Err("memory path exceeds filesystem depth or length limits".into());
    }
    Ok(path
        .components()
        .collect::<std::path::PathBuf>()
        .to_string_lossy()
        .into_owned())
}

pub fn read_tree(root: &Path) -> Result<Tree, String> {
    fn walk(
        root: &Path,
        dir: &Path,
        tree: &mut Tree,
        size: &mut usize,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 16 {
            return Err("memory workspace nesting exceeds 16 levels".into());
        }
        let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.is_symlink() {
            return Err(format!(
                "memory directory must be a real directory: {}",
                dir.display()
            ));
        }
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if meta.is_symlink() {
                return Err(format!(
                    "memory contains a symbolic link: {}",
                    path.display()
                ));
            }
            if meta.is_dir() {
                walk(root, &path, tree, size, depth + 1)?;
            } else if meta.is_file() {
                let name = relative(root, &path.to_string_lossy())?;
                if name == DIFF {
                    continue;
                }
                if meta.len() > MAX_FILE as u64 || tree.len() >= 4096 {
                    return Err("memory workspace exceeds its file budget".into());
                }
                let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                *size += text.len();
                if *size > MAX_TREE {
                    return Err("memory workspace exceeds 64 MiB".into());
                }
                tree.insert(name, text);
            } else {
                return Err("memory workspace contains a special file".into());
            }
        }
        Ok(())
    }
    match std::fs::symlink_metadata(root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Tree::new()),
        Err(e) => return Err(e.to_string()),
        _ => {}
    }
    let mut tree = Tree::new();
    walk(root, root, &mut tree, &mut 0, 0)?;
    Ok(tree)
}

pub fn valid(tree: &Tree) -> bool {
    tree.get("MEMORY.md").is_some_and(|s| !s.trim().is_empty())
        && tree
            .get("memory_summary.md")
            .is_some_and(|s| s.lines().next() == Some("v1"))
}

pub fn diff(before: &Tree, after: &Tree) -> String {
    use similar::TextDiff;
    let names: BTreeSet<_> = before.keys().chain(after.keys()).collect();
    let mut body = String::from("# Memory workspace changes\n\n");
    for name in &names {
        if before.get(*name) == after.get(*name) {
            continue;
        }
        let status = if !before.contains_key(*name) {
            "added"
        } else if !after.contains_key(*name) {
            "deleted"
        } else {
            "modified"
        };
        body.push_str(&format!("- {status}: {name}\n"));
    }
    for name in names {
        if before.get(name) == after.get(name) {
            continue;
        }
        let old = before.get(name).map(String::as_str).unwrap_or("");
        let new = after.get(name).map(String::as_str).unwrap_or("");
        body.push_str(&format!("\ndiff --git a/{name} b/{name}\n"));
        body.push_str(
            &TextDiff::configure()
                .timeout(std::time::Duration::from_millis(300))
                .diff_lines(old, new)
                .unified_diff()
                .context_radius(3)
                .header(&format!("a/{name}"), &format!("b/{name}"))
                .to_string(),
        );
        if body.len() >= 4 * 1024 * 1024 {
            let mut end = 4 * 1024 * 1024;
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            body.truncate(end);
            body.push_str("\n[workspace diff truncated]\n");
            break;
        }
    }
    body
}

/// Build every new file privately, then publish a complete tree. A failure retains the old
/// folder, and an external edit after the pass began causes a retry rather than lost work.
pub fn prepare(
    root: &Path,
    tree: &Tree,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Prepared, String> {
    if cancel.is_cancelled() {
        return Err("memory publication cancelled".into());
    }
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let parent = root.parent().ok_or("memory folder has no parent")?;
    let stage = tempfile::Builder::new()
        .prefix(STAGE_PREFIX)
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    mark_stage(stage.path()).map_err(|e| e.to_string())?;
    let next = stage.path().join("next");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&next)
        .map_err(|e| e.to_string())?;
    for (name, text) in tree {
        if cancel.is_cancelled() {
            return Err("memory publication cancelled".into());
        }
        if Path::new(name).is_absolute() {
            return Err("memory output paths must be relative".into());
        }
        relative(Path::new("/"), name)?;
        let file = next.join(name);
        if let Some(dir) = file.parent() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .map_err(|e| e.to_string())?;
        }
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(file)
            .map_err(|e| e.to_string())?;
        writer
            .write_all(text.as_bytes())
            .and_then(|_| writer.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(Prepared { stage })
}

pub struct Prepared {
    stage: tempfile::TempDir,
}

impl Prepared {
    pub fn verify(&self, root: &Path, original: &Tree) -> Result<(), String> {
        if &read_tree(root)? != original {
            return Err(
                "memory was edited while consolidation was running; retry to include those edits"
                    .into(),
            );
        }
        Ok(())
    }

    /// Return the old tree's owner so its potentially large cleanup happens after the
    /// manager's short publication lock has been released.
    pub fn promote(self, root: &Path) -> Result<tempfile::TempDir, String> {
        let stage = self.stage;
        let old = stage.path().join("old");
        let next = stage.path().join("next");
        let existed = root.exists();
        if existed {
            std::fs::rename(root, &old).map_err(|e| e.to_string())?;
        }
        if let Err(error) = std::fs::rename(&next, root) {
            if existed && std::fs::rename(&old, root).is_err() {
                let retained = stage.keep();
                return Err(format!(
                    "memory publish failed: {error}; original files retained in {}",
                    retained.join("old").display()
                ));
            }
            return Err(error.to_string());
        }
        let parent = root.parent().ok_or("memory folder has no parent")?;
        std::fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(stage)
    }
}

#[cfg(test)]
fn publish(root: &Path, original: &Tree, tree: &Tree) -> Result<(), String> {
    let prepared = prepare(root, tree, &tokio_util::sync::CancellationToken::new())?;
    prepared.verify(root, original)?;
    drop(prepared.promote(root)?);
    Ok(())
}

/// Consolidation never gets a shell or the application's ordinary tool registry. Its only
/// filesystem is this bounded, in-memory tree, which cannot follow a link or escape its root.
#[derive(Clone)]
pub struct Workspace {
    pub root: std::path::PathBuf,
    pub tree: Arc<Mutex<Tree>>,
}

impl Workspace {
    fn execute(&self, args: &Value) -> Result<String, String> {
        let operation = args["operation"].as_str().ok_or("operation is required")?;
        let path = args["path"].as_str().unwrap_or("");
        let path = if path.is_empty() {
            String::new()
        } else {
            relative(&self.root, path)?
        };
        let mut tree = self.tree.lock().map_err(|e| e.to_string())?;
        let number =
            |key: &str, default: usize| args[key].as_u64().map(|n| n as usize).unwrap_or(default);
        match operation {
            "list" => Ok(tree
                .keys()
                .filter(|p| path.is_empty() || *p == &path || p.starts_with(&format!("{path}/")))
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")),
            "read" => {
                let text = tree.get(&path).ok_or("memory file not found")?;
                let start = number("startLine", 1).max(1);
                let count = number("limit", 200).clamp(1, 1000);
                Ok(text
                    .lines()
                    .enumerate()
                    .skip(start - 1)
                    .take(count)
                    .map(|(i, line)| format!("{}: {line}", i + 1))
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            "search" => {
                let query = args["query"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("query is required")?
                    .to_lowercase();
                let mut matches = Vec::new();
                for (name, text) in tree.iter().filter(|(p, _)| {
                    path.is_empty() || *p == &path || p.starts_with(&format!("{path}/"))
                }) {
                    for (i, line) in text.lines().enumerate() {
                        if line.to_lowercase().contains(&query) {
                            matches.push(format!("{name}:{}: {line}", i + 1));
                        }
                        if matches.len() == 200 {
                            return Ok(matches.join("\n"));
                        }
                    }
                }
                Ok(matches.join("\n"))
            }
            "write" | "replace" | "delete" => {
                if path != "MEMORY.md"
                    && path != "memory_summary.md"
                    && !path.starts_with("skills/")
                {
                    return Err("only MEMORY.md, memory_summary.md and skills/ may be changed; evidence is read-only".into());
                }
                if operation == "delete" {
                    tree.remove(&path);
                    return Ok("deleted".into());
                }
                let text = args["text"].as_str().ok_or("text is required")?;
                if tree.keys().any(|existing| {
                    existing != &path
                        && (existing.starts_with(&format!("{path}/"))
                            || path.starts_with(&format!("{existing}/")))
                }) {
                    return Err("a memory file cannot also be a directory".into());
                }
                let next = if operation == "replace" {
                    let old = args["oldText"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("oldText is required")?;
                    let original = tree.get(&path).ok_or("memory file not found")?;
                    if original.matches(old).count() != 1 {
                        return Err("oldText must match exactly once".into());
                    }
                    original.replacen(old, text, 1)
                } else {
                    text.into()
                };
                let next = super::plan::redact(&next);
                let total = tree.values().map(String::len).sum::<usize>()
                    - tree.get(&path).map_or(0, String::len)
                    + next.len();
                if next.len() > MAX_EDIT
                    || total > MAX_TREE
                    || (tree.len() >= 4096 && !tree.contains_key(&path))
                {
                    return Err("memory edit exceeds workspace budget".into());
                }
                tree.insert(path, next);
                Ok("saved".into())
            }
            _ => Err("unknown memory workspace operation".into()),
        }
    }
}

impl Tool for Workspace {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "memory_workspace".into(),
            description: "Read/list/search and write/replace/delete memory files in the isolated consolidation workspace. Paths may be relative or absolute under the given memory root. Reads are line-numbered; paginate with startLine and limit. Evidence files cannot be changed. No shell, network or external files.".into(),
            schema: json!({"type":"object","properties":{"operation":{"type":"string","enum":["list","read","search","write","replace","delete"]},"path":{"type":"string"},"query":{"type":"string"},"text":{"type":"string"},"oldText":{"type":"string"},"startLine":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1,"maximum":1000}},"required":["operation"],"additionalProperties":false}),
        }
    }

    fn call(&self, ctx: ToolCtx, args: Value) -> BoxFuture<'static, ToolOutput> {
        let workspace = self.clone();
        Box::pin(async move {
            if ctx.cancel.is_cancelled() {
                return ToolOutput::err("cancelled");
            }
            match workspace.execute(&args) {
                Ok(text) => ToolOutput::ok(super::plan::clip(&text, 64_000)),
                Err(error) => ToolOutput::err(error),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_preparation_does_not_leave_private_or_live_files() {
        let data = tempfile::tempdir().unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        let tree = Tree::from([("MEMORY.md".into(), "never publish".into())]);
        assert!(prepare(&data.path().join("memories"), &tree, &cancel).is_err());
        assert_eq!(std::fs::read_dir(data.path()).unwrap().count(), 0);
    }

    #[test]
    fn virtual_workspace_rejects_escape_and_evidence_edits() {
        let workspace = Workspace {
            root: "/memory".into(),
            tree: Arc::new(Mutex::new(Tree::from([(
                "raw_memories.md".into(),
                "evidence".into(),
            )]))),
        };
        for path in [
            "../outside",
            "/outside",
            "skills/../../outside",
            "raw_memories.md",
            "rollout_summaries/x.md",
        ] {
            assert!(
                workspace
                    .execute(&json!({"operation":"write", "path":path, "text":"no"}))
                    .is_err(),
                "{path}"
            );
        }
        for path in [
            format!("skills/{}", "x".repeat(256)),
            format!("skills/{}", vec!["x"; 17].join("/")),
        ] {
            assert!(
                workspace
                    .execute(&json!({"operation":"write", "path":path, "text":"no"}))
                    .is_err()
            );
        }
        workspace
            .execute(&json!({"operation":"write", "path":"/memory/MEMORY.md", "text":"one\ntwo"}))
            .unwrap();
        assert_eq!(
            workspace
                .execute(&json!({"operation":"read", "path":"MEMORY.md", "startLine":2, "limit":1}))
                .unwrap(),
            "2: two"
        );
        assert!(workspace.execute(&json!({"operation":"replace", "path":"MEMORY.md", "oldText":"missing", "text":"no"})).is_err());
        assert!(
            workspace
                .execute(&json!({"operation":"search", "query":"two"}))
                .unwrap()
                .contains("MEMORY.md:2: two")
        );
        assert_eq!(
            workspace.tree.lock().unwrap()["raw_memories.md"],
            "evidence"
        );
        workspace
            .execute(&json!({"operation":"write", "path":"skills//a", "text":"file"}))
            .unwrap();
        assert!(
            workspace
                .execute(&json!({"operation":"write", "path":"skills/a/b", "text":"no"}))
                .is_err()
        );
        assert!(
            workspace
                .execute(&json!({"operation":"write", "path":"skills/", "text":"no"}))
                .is_err()
        );
    }

    #[test]
    fn publish_preserves_external_edits_and_rejects_links_and_absolute_output_paths() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().join("memories");
        let tree = Tree::from([
            ("MEMORY.md".into(), "handbook".into()),
            ("memory_summary.md".into(), "v1\nmap".into()),
        ]);
        publish(&root, &Tree::new(), &tree).unwrap();
        assert_eq!(read_tree(&root).unwrap(), tree);
        std::fs::write(root.join("MEMORY.md"), "manual edit").unwrap();
        assert!(publish(&root, &tree, &tree).unwrap_err().contains("edited"));
        assert_eq!(
            std::fs::read_to_string(root.join("MEMORY.md")).unwrap(),
            "manual edit"
        );
        std::os::unix::fs::symlink(data.path().join("outside"), root.join("link")).unwrap();
        assert!(read_tree(&root).is_err());
        let invalid = Tree::from([(
            data.path().join("escape").display().to_string(),
            "no".into(),
        )]);
        assert!(publish(&root, &tree, &invalid).is_err());
        assert!(!data.path().join("escape").exists());
    }

    #[test]
    fn workspace_diff_carries_deletions_and_valid_artifacts_require_the_summary_schema() {
        let old = Tree::from([("deleted.md".into(), "old".into())]);
        let new = Tree::from([
            ("MEMORY.md".into(), "memo".into()),
            ("memory_summary.md".into(), "v1\nmap".into()),
        ]);
        let diff = diff(&old, &new);
        assert!(diff.contains("deleted: deleted.md") && diff.contains("diff --git a/deleted.md"));
        assert!(valid(&new));
        assert!(!valid(&Tree::from([
            ("MEMORY.md".into(), "memo".into()),
            ("memory_summary.md".into(), "v2\nmap".into())
        ])));
    }

    #[test]
    fn an_interrupted_folder_swap_restores_the_original_and_clear_removes_only_owned_stages() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().join("memories");
        let stage = tempfile::Builder::new()
            .prefix(STAGE_PREFIX)
            .tempdir_in(data.path())
            .unwrap();
        mark_stage(stage.path()).unwrap();
        let old = stage.path().join("old");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("MEMORY.md"), "original").unwrap();
        recover(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("MEMORY.md")).unwrap(),
            "original"
        );
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("MEMORY.md"), "stale").unwrap();
        recover(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("MEMORY.md")).unwrap(),
            "original"
        );
        let unmarked = tempfile::Builder::new()
            .prefix(STAGE_PREFIX)
            .tempdir_in(data.path())
            .unwrap();
        std::fs::write(unmarked.path().join("keep"), "user file").unwrap();
        clear_stages(&root).unwrap();
        assert!(!stage.path().exists());
        assert!(unmarked.path().join("keep").exists());
        assert!(root.join("MEMORY.md").exists());
    }
}
