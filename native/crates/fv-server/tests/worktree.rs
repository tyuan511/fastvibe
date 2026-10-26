//! Isolated workspaces over the wire: a conversation gets its own checkout, and gives it back.

mod common;

use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use common::disable_reply_suggestions;
use fv_agent::ToolRegistry;
use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};

fn git(dir: &Path, args: &[&str]) {
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
}

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "."]);
    std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-qm", "init"]);
    dir
}

/// HOME is pointed at a temporary directory, so a worktree these tests create lands under it and
/// nothing is written into the real `~/.fastvibe`.
///
/// **HOME is process-wide, so these tests cannot run in parallel** — measured: without the lock,
/// runs of this file failed two and three times out of four as one test's HOME replaced another's
/// mid-call. A `std::sync::Mutex` cannot be held across an `await` (the guard would block the
/// runtime, and clippy refuses it), so the serialisation is done with an async mutex instead.
struct Harness {
    _data: tempfile::TempDir,
    _home: tempfile::TempDir,
    sock: std::path::PathBuf,
    _serial: tokio::sync::OwnedMutexGuard<()>,
}

/// The serialisation itself. `OnceLock` rather than a `static Mutex` because the owned guard needs
/// an `Arc`.
fn home_serial() -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static SERIAL: std::sync::OnceLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
        std::sync::OnceLock::new();
    SERIAL
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

async fn start() -> Harness {
    let serial = home_serial().lock_owned().await;
    let home = tempfile::tempdir().unwrap();
    // SAFETY: the async guard above means only one test is inside this section at a time, and the
    // server's worktree code reads HOME per call rather than caching it.
    unsafe { std::env::set_var("HOME", home.path()) };
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([Reply::new().text("ok").done()]));
    let mut tools = ToolRegistry::new();
    fv_tools::register_builtin(&mut tools);
    let agent = fv_server::agent_with_builtin_tools(model);
    let _ = tools;
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    disable_reply_suggestions(&state);
    let sock = data.path().join("w.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    Harness {
        _data: data,
        _home: home,
        sock,
        _serial: serial,
    }
}

async fn client(sock: &Path) -> Client {
    let (c, _n) = Client::connect_unix(sock).await.unwrap();
    c.call::<Initialize>(InitializeParams {
        client_info: ClientInfo {
            name: "t".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    })
    .await
    .unwrap();
    c
}

async fn thread_in(c: &Client, project: &Path) -> Thread {
    c.call::<ThreadStart>(ThreadStartParams {
        cwd: Some(project.display().to_string()),
        project: Some(project.display().to_string()),
        model: None,
        thinking: None,
    })
    .await
    .unwrap()
    .thread
}

/// A conversation gets its own checkout under the worktree home, on a branch of its own, and the
/// project's own tree is untouched by what it does there.
#[tokio::test]
async fn a_conversation_can_run_in_its_own_checkout() {
    let h = start().await;
    let project = repo();
    let c = client(&h.sock).await;
    let thread = thread_in(&c, project.path()).await;

    let bound = c
        .call::<ThreadWorktreeCreate>(ThreadWorktreeCreateParams {
            thread_id: thread.id.clone(),
            path: None,
            branch: None,
            label: None,
        })
        .await
        .unwrap()
        .thread;
    let worktree = bound.worktree.clone().expect("a bound worktree");
    // Compared as real paths: on macOS a temporary directory is reached through `/private`.
    let real = |p: &Path| std::fs::canonicalize(p).unwrap();
    assert!(
        real(Path::new(&worktree.path)).starts_with(real(h._home.path())),
        "{} is not under the temporary home",
        worktree.path
    );
    assert_eq!(
        bound.cwd.as_deref(),
        Some(worktree.path.as_str()),
        "the conversation runs in the checkout"
    );
    assert!(
        worktree.branch.starts_with("fastvibe/"),
        "{} should be a branch this app made",
        worktree.branch
    );
    assert_eq!(
        std::fs::read_to_string(Path::new(&worktree.path).join("a.txt")).unwrap(),
        "one\n",
        "the checkout carries the project's content"
    );
    // Work done there does not touch the project's own tree.
    std::fs::write(Path::new(&worktree.path).join("b.txt"), "isolated\n").unwrap();
    assert!(!project.path().join("b.txt").exists());

    let listed = c
        .call::<ThreadWorktreeList>(ThreadIdParams {
            thread_id: thread.id.clone(),
        })
        .await
        .unwrap()
        .worktrees;
    assert_eq!(listed.len(), 2, "{listed:?}");
    assert!(
        listed.iter().any(|w| w.current && w.path == worktree.path),
        "the conversation's own checkout is the current one"
    );

    // Unbinding returns it to the project, and leaves the checkout on disk.
    let back = c
        .call::<ThreadWorktreeUnbind>(ThreadWorktreeUnbindParams {
            thread_id: thread.id.clone(),
            remove: false,
        })
        .await
        .unwrap()
        .thread;
    assert_eq!(back.worktree, None);
    assert_eq!(
        back.cwd.as_deref(),
        Some(project.path().display().to_string().as_str()),
        "back to the project, not to a scratch folder"
    );
    assert!(
        Path::new(&worktree.path).exists(),
        "the checkout is still there"
    );
}

/// A branch that already exists is checked out rather than created again.
#[tokio::test]
async fn binding_an_existing_branch_checks_it_out() {
    let h = start().await;
    let project = repo();
    git(project.path(), &["branch", "experiment"]);
    let c = client(&h.sock).await;
    let thread = thread_in(&c, project.path()).await;
    let bound = c
        .call::<ThreadWorktreeCreate>(ThreadWorktreeCreateParams {
            thread_id: thread.id.clone(),
            path: None,
            branch: Some("experiment".into()),
            label: None,
        })
        .await
        .unwrap()
        .thread;
    assert_eq!(
        bound.worktree.as_ref().map(|w| w.branch.as_str()),
        Some("experiment")
    );
}

/// A checkout of a different repository is refused: it would give the conversation a history that
/// has nothing to do with its project.
#[tokio::test]
async fn a_worktree_of_another_project_is_refused() {
    let h = start().await;
    let project = repo();
    let other = repo();
    let c = client(&h.sock).await;
    let thread = thread_in(&c, project.path()).await;
    let refused = c
        .call::<ThreadWorktreeBind>(ThreadWorktreeBindParams {
            thread_id: thread.id.clone(),
            path: other.path().display().to_string(),
        })
        .await;
    assert!(refused.is_err(), "binding another repo's tree must fail");
}

/// A conversation with no project has nothing to isolate.
#[tokio::test]
async fn a_conversation_without_a_project_cannot_be_isolated() {
    let h = start().await;
    let c = client(&h.sock).await;
    let thread = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread;
    let refused = c
        .call::<ThreadWorktreeCreate>(ThreadWorktreeCreateParams {
            thread_id: thread.id.clone(),
            path: None,
            branch: None,
            label: None,
        })
        .await;
    assert!(refused.is_err());
}

#[allow(dead_code)]
fn unused(_: &ServerNotification, _: Duration) {}
