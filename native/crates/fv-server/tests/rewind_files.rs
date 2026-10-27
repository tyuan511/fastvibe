//! `turn/rewind` with `rewindFiles`: a retry runs against the code the prompt was about, not
//! the half-applied result of the attempt it retries.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{AgentContext, ToolRegistry};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use tokio::sync::mpsc::UnboundedReceiver;

type Notes = UnboundedReceiver<ServerNotification>;

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

/// A repository with one commit and a file the "turn" will edit.
fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "."]);
    std::fs::write(dir.path().join("app.txt"), "original\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-qm", "init"]);
    dir
}

async fn start(workspace: &Path) -> (tempfile::TempDir, std::path::PathBuf) {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([
        // First attempt: the model writes the file through a shell command, which is the case a
        // per-tool-name checkpoint would miss.
        Reply::new()
            .tool(
                "c1",
                "exec_command",
                serde_json::json!({"cmd": "printf 'edited by the first attempt\\n' > app.txt && touch made.txt"}),
            )
            .done(),
        Reply::new().text("first").done(),
        Reply::new().text("second").done(),
    ]));
    let mut tools = ToolRegistry::new();
    fv_tools::register_builtin(&mut tools);
    let agent = AgentContext {
        context: Default::default(),
        hooks: None,
        model,
        tools: Arc::new(tools),
        system: "sys".into(),
        cwd: Some(workspace.to_path_buf()),
        ui: None,
        loaded: Default::default(),
        permissions: None,
        steer: None,
        memory: None,
        budget: Default::default(),
        compaction: None,
    };
    let state = Arc::new(ServerState::new(data.path().to_path_buf(), agent).unwrap());
    let sock = data.path().join("r.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    (data, sock)
}

async fn client(sock: &Path) -> (Client, Notes) {
    let (c, n) = Client::connect_unix(sock).await.unwrap();
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
    (c, n)
}

async fn until_idle(notes: &mut Notes) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(20), notes.recv())
            .await
            .expect("timed out")
            .expect("closed");
        let idle = matches!(&n, ServerNotification::ThreadStatusChanged(e) if !e.body.running);
        seen.push(n);
        if idle {
            return seen;
        }
    }
}

async fn run_to_idle(c: &Client, notes: &mut Notes, thread: &str, text: &str) -> TurnId {
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.into(),
        text: text.into(),
    })
    .await
    .unwrap();
    let events = until_idle(notes).await;
    events
        .iter()
        .find_map(|n| match n {
            ServerNotification::TurnStarted(e) => Some(e.body.turn_id.clone()),
            _ => None,
        })
        .expect("a turn started")
}

/// The retry puts the workspace back: the edited file is restored and the file the *command*
/// created is removed, so the second attempt sees what the first one saw.
#[tokio::test]
async fn a_retry_can_put_the_workspace_back_to_before_the_turn() {
    let workspace = workspace();
    let (_data, sock) = start(workspace.path()).await;
    let (c, mut notes) = client(&sock).await;
    let thread = c
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            project: None,
            model: None,
            thinking: None,
        })
        .await
        .unwrap()
        .thread
        .id;
    let turn = run_to_idle(&c, &mut notes, &thread, "go").await;
    assert!(
        std::fs::read_to_string(workspace.path().join("app.txt"))
            .unwrap()
            .contains("edited by the first attempt"),
        "the turn really changed the file"
    );

    let answer = c
        .call::<TurnRewind>(TurnRewindParams {
            thread_id: thread.clone(),
            turn_id: turn,
            text: None,
            rewind_files: true,
        })
        .await
        .unwrap();
    assert!(answer.files.had_checkpoint);
    assert_eq!(answer.files.restored, 1);
    assert_eq!(answer.files.removed, 1);
    assert!(answer.files.skipped.is_empty());
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("app.txt")).unwrap(),
        "original\n"
    );
    assert!(!workspace.path().join("made.txt").exists());
}

/// "Keep my files" is a real answer: a plain retry leaves the tree exactly as the turn left it.
#[tokio::test]
async fn a_retry_without_rewind_files_leaves_the_workspace_alone() {
    let workspace = workspace();
    let (_data, sock) = start(workspace.path()).await;
    let (c, mut notes) = client(&sock).await;
    let thread = c
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            project: None,
            model: None,
            thinking: None,
        })
        .await
        .unwrap()
        .thread
        .id;
    let turn = run_to_idle(&c, &mut notes, &thread, "go").await;
    let answer = c
        .call::<TurnRewind>(TurnRewindParams {
            thread_id: thread.clone(),
            turn_id: turn,
            text: None,
            rewind_files: false,
        })
        .await
        .unwrap();
    assert_eq!(answer.files, Default::default());
    assert!(workspace.path().join("made.txt").exists());
}

/// A conversation with no working directory has nothing to snapshot, and the retry still works:
/// the checkpoint is best-effort, never a precondition.
#[tokio::test]
async fn a_conversation_with_no_workspace_rewinds_only_the_conversation() {
    let workspace = workspace();
    let (_data, sock) = start(workspace.path()).await;
    let (c, mut notes) = client(&sock).await;
    let thread = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    let turn = run_to_idle(&c, &mut notes, &thread, "go").await;
    let answer = c
        .call::<TurnRewind>(TurnRewindParams {
            thread_id: thread.clone(),
            turn_id: turn,
            text: None,
            rewind_files: true,
        })
        .await
        .unwrap();
    assert!(!answer.files.had_checkpoint);
    assert!(answer.files.skipped.is_empty());
}
