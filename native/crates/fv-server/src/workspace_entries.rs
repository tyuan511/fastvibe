//! File tree mutations. Project-bounded paths, no replacement on rename, Trash by default.
use fv_protocol::types::*;
use fv_protocol::{ErrorObject, jsonrpc::code};
use std::path::{Component, Path, PathBuf};

pub enum Operation {
    Create(CreateEntryParams),
    Rename(RenameEntryParams),
    Delete(DeleteEntryParams),
    Write(WriteFileParams),
}

pub async fn apply(
    state: std::sync::Arc<crate::ServerState>,
    operation: Operation,
) -> Result<serde_json::Value, ErrorObject> {
    tokio::task::spawn_blocking(move || {
        let _guard = state.workspace_entries_lock.lock().unwrap();
        let (result, change) = match operation {
            Operation::Create(params) => {
                let (entry, change) = create(params)?;
                (serde_json::to_value(entry), Some(change))
            }
            Operation::Rename(params) => {
                let (entry, change) = rename(params)?;
                (serde_json::to_value(entry), Some(change))
            }
            Operation::Delete(params) => (serde_json::to_value(Empty {}), Some(delete(params)?)),
            Operation::Write(params) => {
                let path = crate::workspace::resolve(params.cwd.as_deref(), &params.path);
                crate::workspace::write_file(&path.display().to_string(), &params.text)?;
                (serde_json::to_value(Empty {}), None)
            }
        };
        // Once a filesystem mutation starts, disconnecting its caller cannot roll it back.
        // Publish here too, so other clients still learn what happened after a disconnect.
        if let Some(change) = change {
            state.broadcast(fv_protocol::ServerNotification::WorkspaceEntryChanged(
                change,
            ));
        }
        result.map_err(failed)
    })
    .await
    .map_err(failed)?
}

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}
fn failed(error: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, error.to_string())
}

fn name(raw: &str) -> Result<&str, ErrorObject> {
    let name = raw.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err(invalid("请输入名称"));
    }
    if name.contains(['/', '\\']) || name.chars().any(char::is_control) {
        return Err(invalid("名称不能包含路径分隔符或控制字符"));
    }
    if name.len() > 255 {
        return Err(invalid("名称太长"));
    }
    if name.eq_ignore_ascii_case(".git") {
        return Err(invalid("不能操作 Git 仓库数据"));
    }
    Ok(name)
}

fn normalized(path: &Path) -> Result<PathBuf, ErrorObject> {
    if !path.is_absolute() {
        return Err(invalid("项目目录必须是绝对路径"));
    }
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => (),
            Component::ParentDir => {
                if !result.pop() {
                    return Err(invalid("路径无效"));
                }
            }
            part => result.push(part.as_os_str()),
        }
    }
    Ok(result)
}

struct Target {
    root: PathBuf,
    path: PathBuf,
    kind: EntryKind,
}
impl Target {
    fn check(cwd: &str, raw: &str, directory: bool) -> Result<Self, ErrorObject> {
        if cwd.is_empty() || cwd.contains('\0') || raw.is_empty() || raw.contains('\0') {
            return Err(invalid("路径无效"));
        }
        let root = normalized(Path::new(cwd))?;
        let path = normalized(&root.join(raw))?;
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| invalid("只能操作项目目录内的文件"))?;
        if !directory && relative.as_os_str().is_empty() {
            return Err(invalid("不能重命名或删除项目根目录"));
        }
        if relative.components().any(|part| {
            part.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(".git")
        }) {
            return Err(invalid("不能操作 Git 仓库数据"));
        }
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|e| invalid(format!("路径不可用：{e}")))?;
        if directory && !metadata.is_dir() {
            return Err(invalid("只能在真实文件夹中新建"));
        }
        if !metadata.is_file() && !metadata.is_dir() && !metadata.is_symlink() {
            return Err(invalid("只能操作文件或文件夹"));
        }
        let root_real = root
            .canonicalize()
            .map_err(|e| invalid(format!("项目目录不可用：{e}")))?;
        let parent = if directory {
            &path
        } else {
            path.parent().ok_or_else(|| invalid("路径无效"))?
        };
        let parent_real = parent
            .canonicalize()
            .map_err(|e| invalid(format!("文件夹不可用：{e}")))?;
        if !root_real.is_dir() || !parent_real.starts_with(&root_real) {
            return Err(invalid("只能操作项目目录内的文件"));
        }
        if parent_real
            .strip_prefix(&root_real)
            .unwrap()
            .components()
            .any(|part| {
                part.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(".git")
            })
        {
            return Err(invalid("不能操作 Git 仓库数据"));
        }
        let kind = if metadata.is_dir() {
            EntryKind::Directory
        } else {
            EntryKind::File
        };
        Ok(Self { root, path, kind })
    }
    fn entry(&self) -> DirEntry {
        DirEntry {
            path: self.path.display().to_string(),
            name: self
                .path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            kind: self.kind,
        }
    }
}

pub fn create(params: CreateEntryParams) -> Result<(DirEntry, WorkspaceEntryChange), ErrorObject> {
    let mut target = Target::check(&params.cwd, &params.path, true)?;
    target.path.push(name(&params.name)?);
    target.kind = params.kind;
    match params.kind {
        EntryKind::File => {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target.path)
                .map_err(failed)?;
        }
        EntryKind::Directory => std::fs::create_dir(&target.path).map_err(failed)?,
    }
    let entry = target.entry();
    let change = WorkspaceEntryChange {
        cwd: target.root.display().to_string(),
        path: entry.path.clone(),
        kind: EntryChangeKind::Created,
        entry: Some(entry.clone()),
    };
    Ok((entry, change))
}

pub fn rename(params: RenameEntryParams) -> Result<(DirEntry, WorkspaceEntryChange), ErrorObject> {
    let mut target = Target::check(&params.cwd, &params.path, false)?;
    let destination = target.path.with_file_name(name(&params.name)?);
    let old = target.path.display().to_string();
    if destination != target.path {
        rename_exclusive(&target.path, &destination).map_err(failed)?;
    }
    target.path = destination;
    let entry = target.entry();
    Ok((
        entry.clone(),
        WorkspaceEntryChange {
            cwd: target.root.display().to_string(),
            path: old,
            kind: EntryChangeKind::Renamed,
            entry: Some(entry),
        },
    ))
}

// Kernel exclusion covers the check/rename race for directories as well as files. In
// particular two different hard links must never be mistaken for a case-only rename.
#[cfg(target_os = "macos")]
fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(from.as_os_str().as_bytes())?;
    let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[cfg(target_os = "linux")]
fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(from.as_os_str().as_bytes())?;
    let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
    if unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_exclusive(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "This platform does not yet support exclusive file-tree renames.",
    ))
}

pub fn delete(params: DeleteEntryParams) -> Result<WorkspaceEntryChange, ErrorObject> {
    delete_with(params, |path| {
        #[cfg(target_os = "macos")]
        {
            // Use NSFileManager, never AppleScript/Finder automation. The API can report a
            // Trash failure without asking for control of another desktop application.
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            let mut context = trash::TrashContext::new();
            context.set_delete_method(DeleteMethod::NsFileManager);
            context.delete(path).map_err(failed)
        }
        #[cfg(not(target_os = "macos"))]
        {
            trash::delete(path).map_err(failed)
        }
    })
}

fn delete_with(
    params: DeleteEntryParams,
    trash: impl FnOnce(&Path) -> Result<(), ErrorObject>,
) -> Result<WorkspaceEntryChange, ErrorObject> {
    let target = Target::check(&params.cwd, &params.path, false)?;
    if params.permanent {
        if target.kind == EntryKind::Directory {
            std::fs::remove_dir_all(&target.path).map_err(failed)?;
        } else {
            std::fs::remove_file(&target.path).map_err(failed)?;
        }
    } else {
        trash(&target.path)?;
    }
    Ok(WorkspaceEntryChange {
        cwd: target.root.display().to_string(),
        path: target.path.display().to_string(),
        kind: EntryChangeKind::Deleted,
        entry: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn a_slow_tree_mutation_does_not_block_control_requests_on_its_connection() {
        use fv_protocol::methods::{Initialize, ThreadList, WorkspaceCreateEntry};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir(&root).unwrap();
        let state = std::sync::Arc::new(
            crate::ServerState::new(
                dir.path().join("data"),
                crate::agent_with_builtin_tools(std::sync::Arc::new(fv_agent::testing::NoModel)),
            )
            .unwrap(),
        );
        let (io, server_io) = tokio::io::duplex(65536);
        let (r, w) = tokio::io::split(server_io);
        let server = tokio::spawn(crate::serve_connection(
            state.clone(),
            ClientOrigin::Local,
            r,
            w,
        ));
        let (r, w) = tokio::io::split(io);
        let (client, _) = fv_client::Client::from_io(r, w);
        client
            .call::<Initialize>(InitializeParams {
                client_info: ClientInfo {
                    name: "slow-files".into(),
                    version: "0".into(),
                },
                protocol_version: fv_protocol::PROTOCOL_VERSION,
                capabilities: Default::default(),
            })
            .await
            .unwrap();
        let (ready, acquired) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _guard = state.workspace_entries_lock.lock().unwrap();
            let _ = ready.send(());
            let _ = wait.recv();
        });
        acquired.await.unwrap();
        let mutation = client.call::<WorkspaceCreateEntry>(CreateEntryParams {
            cwd: root.display().to_string(),
            path: ".".into(),
            name: "file".into(),
            kind: EntryKind::File,
        });
        tokio::pin!(mutation);
        assert!(futures_util::poll!(&mut mutation).is_pending());
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.call::<ThreadList>(ThreadListParams {
                include_archived: false,
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!root.join("file").exists());
        drop(release);
        holder.join().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), mutation)
            .await
            .unwrap()
            .unwrap();
        server.abort();
    }
    fn cwd(dir: &tempfile::TempDir) -> String {
        dir.path().display().to_string()
    }
    fn add(
        dir: &tempfile::TempDir,
        name: &str,
        kind: EntryKind,
    ) -> Result<(DirEntry, WorkspaceEntryChange), ErrorObject> {
        create(CreateEntryParams {
            cwd: cwd(dir),
            path: ".".into(),
            name: name.into(),
            kind,
        })
    }
    fn rename_to(
        dir: &tempfile::TempDir,
        path: &str,
        name: &str,
    ) -> Result<(DirEntry, WorkspaceEntryChange), ErrorObject> {
        rename(RenameEntryParams {
            cwd: cwd(dir),
            path: path.into(),
            name: name.into(),
        })
    }
    #[test]
    fn create_and_rename_preserve_contents_and_never_replace_files_or_directories() {
        let dir = tempfile::tempdir().unwrap();
        for kind in [EntryKind::File, EntryKind::Directory] {
            let a = if kind == EntryKind::File {
                "first"
            } else {
                "folder"
            };
            let b = format!("{a}-other");
            add(&dir, a, kind).unwrap();
            add(&dir, &b, kind).unwrap();
            assert!(add(&dir, a, kind).is_err());
            if kind == EntryKind::File {
                std::fs::write(dir.path().join(a), "keep source").unwrap();
                std::fs::write(dir.path().join(&b), "keep target").unwrap();
            }
            assert!(rename_to(&dir, a, &b).is_err());
            assert!(dir.path().join(a).exists());
            let renamed = format!("{a}-new");
            let (entry, change) = rename_to(&dir, a, &renamed).unwrap();
            assert_eq!(entry.kind, kind);
            assert_eq!(change.kind, EntryChangeKind::Renamed);
            assert!(!dir.path().join(a).exists());
            if kind == EntryKind::File {
                assert_eq!(std::fs::read_to_string(&entry.path).unwrap(), "keep source");
                assert_eq!(
                    std::fs::read_to_string(dir.path().join(b)).unwrap(),
                    "keep target"
                );
            }
        }
    }
    #[test]
    fn case_changes_work_but_another_hard_link_is_still_a_collision() {
        let dir = tempfile::tempdir().unwrap();
        add(&dir, "UPPER", EntryKind::File).unwrap();
        rename_to(&dir, "UPPER", "upper").unwrap();
        assert!(
            std::fs::read_dir(dir.path())
                .unwrap()
                .any(|e| e.unwrap().file_name() == "upper")
        );
        std::fs::hard_link(dir.path().join("upper"), dir.path().join("alias")).unwrap();
        assert!(rename_to(&dir, "upper", "alias").is_err());
        assert!(dir.path().join("upper").exists() && dir.path().join("alias").exists());
    }
    #[test]
    fn invalid_names_outside_paths_roots_and_git_metadata_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            "",
            " ",
            ".",
            "..",
            "a/b",
            "a\\b",
            "bad\nname",
            ".git",
            ".GIT",
            &"中".repeat(86),
        ] {
            assert!(add(&dir, bad, EntryKind::File).is_err(), "{bad:?}");
        }
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        for path in ["..", "../outside", ".git", ".GIT"] {
            assert!(
                create(CreateEntryParams {
                    cwd: cwd(&dir),
                    path: path.into(),
                    name: "file".into(),
                    kind: EntryKind::File
                })
                .is_err()
            );
        }
        for path in [".", ".git"] {
            assert!(rename_to(&dir, path, "new").is_err());
            assert!(
                delete(DeleteEntryParams {
                    cwd: cwd(&dir),
                    path: path.into(),
                    permanent: true
                })
                .is_err()
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn parent_symlinks_cannot_escape_or_reach_git_but_a_link_itself_can_be_removed() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep"), "untouched").unwrap();
        symlink(outside.path(), dir.path().join("link")).unwrap();
        for parent in ["link", "link/."] {
            assert!(
                create(CreateEntryParams {
                    cwd: cwd(&dir),
                    path: parent.into(),
                    name: "no".into(),
                    kind: EntryKind::File
                })
                .is_err()
            );
        }
        assert!(rename_to(&dir, "link/keep", "no").is_err());
        assert!(
            delete(DeleteEntryParams {
                cwd: cwd(&dir),
                path: "link/keep".into(),
                permanent: true
            })
            .is_err()
        );
        std::fs::create_dir_all(dir.path().join(".git/objects")).unwrap();
        symlink(dir.path().join(".git"), dir.path().join("git-link")).unwrap();
        assert!(
            create(CreateEntryParams {
                cwd: cwd(&dir),
                path: "git-link/objects".into(),
                name: "no".into(),
                kind: EntryKind::File
            })
            .is_err()
        );
        rename_to(&dir, "link", "renamed-link").unwrap();
        delete(DeleteEntryParams {
            cwd: cwd(&dir),
            path: "renamed-link".into(),
            permanent: true,
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.path().join("keep")).unwrap(),
            "untouched"
        );
    }
    #[test]
    fn trash_failure_never_deletes_permanently_and_success_uses_the_given_path() {
        let dir = tempfile::tempdir().unwrap();
        let (entry, _) = add(&dir, "keep", EntryKind::File).unwrap();
        let params = DeleteEntryParams {
            cwd: cwd(&dir),
            path: "keep".into(),
            permanent: false,
        };
        assert!(delete_with(params.clone(), |_| Err(failed("Trash unavailable"))).is_err());
        assert!(Path::new(&entry.path).exists());
        let recovery = dir.path().join("recovery");
        delete_with(params, |path| {
            assert_eq!(path, Path::new(&entry.path));
            std::fs::rename(path, &recovery).map_err(failed)
        })
        .unwrap();
        assert!(recovery.is_file());
    }
    #[cfg(unix)]
    #[test]
    fn permanent_directory_delete_does_not_follow_links_to_other_directories() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep"), "safe").unwrap();
        add(&dir, "folder", EntryKind::Directory).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("folder/link")).unwrap();
        delete(DeleteEntryParams {
            cwd: cwd(&dir),
            path: "folder".into(),
            permanent: true,
        })
        .unwrap();
        assert!(!dir.path().join("folder").exists());
        assert!(outside.path().join("keep").is_file());
    }
}
