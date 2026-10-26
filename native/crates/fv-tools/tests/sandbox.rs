//! Commands and patches under a sandbox and an approval policy: what runs, what is refused, and
//! when the user is asked. The sandbox is the real one; the user is a script.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures_util::future::{BoxFuture, FutureExt};
use fv_agent::{
    ApprovalKind, ApprovalPolicy, ApprovalRequest, Approver, Decision, Permissions, Policy,
    SandboxMode, Tool, ToolCtx,
};
use fv_tools::{ApplyPatchTool, ExecCommandTool};
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// Answers with `answer` and remembers what it was asked.
struct Script {
    answer: Decision,
    asked: Mutex<Vec<ApprovalRequest>>,
}

impl Script {
    fn new(answer: Decision) -> Arc<Self> {
        Arc::new(Self {
            answer,
            asked: Mutex::default(),
        })
    }

    fn asked(&self) -> Vec<ApprovalRequest> {
        self.asked.lock().unwrap().clone()
    }
}

impl Approver for Script {
    fn approve(&self, request: ApprovalRequest) -> BoxFuture<'static, Decision> {
        self.asked.lock().unwrap().push(request);
        let answer = self.answer;
        async move { answer }.boxed()
    }
}

fn ctx(root: &Path, mode: SandboxMode, approval: ApprovalPolicy, user: &Arc<Script>) -> ToolCtx {
    let mut c = ToolCtx::new(CancellationToken::new(), Some(root.to_path_buf()));
    c.call_id = "call-1".into();
    c.permissions = Some(Arc::new(Permissions {
        policy: Policy {
            mode,
            writable_roots: vec![root.to_path_buf()],
            network: false,
        },
        approval,
        approver: Some(user.clone() as Arc<dyn Approver>),
    }));
    c
}

async fn exec(c: ToolCtx, args: serde_json::Value) -> fv_agent::ToolOutput {
    ExecCommandTool::default().call(c, args).await
}

async fn patch(c: ToolCtx, text: &str) -> fv_agent::ToolOutput {
    ApplyPatchTool.call(c, json!({ "input": text })).await
}

fn skip() -> bool {
    if fv_sandbox::available() {
        return false;
    }
    eprintln!("no Seatbelt here: skipped");
    true
}

fn outside_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("outside.txt");
    (dir, file)
}

#[tokio::test]
async fn a_command_writes_in_the_folder_without_asking_and_is_stopped_outside_it() {
    if skip() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let (_keep, outside) = outside_file();
    let user = Script::new(Decision::Approved);
    let mode = (SandboxMode::WorkspaceWrite, ApprovalPolicy::OnRequest);

    let ok = exec(
        ctx(root.path(), mode.0, mode.1, &user),
        json!({"cmd": "echo hi > a.txt", "login": false}),
    )
    .await;
    assert!(!ok.is_error, "{}", ok.content);
    assert!(root.path().join("a.txt").exists());

    let blocked = exec(
        ctx(root.path(), mode.0, mode.1, &user),
        json!({"cmd": format!("echo hi > {}", outside.display()), "login": false}),
    )
    .await;
    assert!(blocked.is_error);
    assert!(!outside.exists());
    // The model is told how to ask, and nobody was bothered meanwhile.
    assert!(
        blocked.content.contains("require_escalated"),
        "{}",
        blocked.content
    );
    assert!(user.asked().is_empty());
}

#[tokio::test]
async fn asking_to_leave_the_sandbox_runs_the_command_only_if_the_user_agrees() {
    if skip() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let (_keep, outside) = outside_file();
    let args = json!({
        "cmd": format!("echo hi > {}", outside.display()),
        "login": false,
        "sandbox_permissions": "require_escalated",
        "justification": "write the report where it is wanted"
    });

    let no = Script::new(Decision::Denied);
    let out = exec(
        ctx(
            root.path(),
            SandboxMode::WorkspaceWrite,
            ApprovalPolicy::OnRequest,
            &no,
        ),
        args.clone(),
    )
    .await;
    assert!(out.is_error);
    assert!(!outside.exists(), "ran although the user said no");
    let asked = no.asked();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].call_id, "call-1");
    assert_eq!(
        asked[0].reason.as_deref(),
        Some("write the report where it is wanted")
    );
    assert!(
        matches!(&asked[0].kind, ApprovalKind::Command { command, .. } if command.contains("outside.txt"))
    );

    let yes = Script::new(Decision::Approved);
    let out = exec(
        ctx(
            root.path(),
            SandboxMode::WorkspaceWrite,
            ApprovalPolicy::OnRequest,
            &yes,
        ),
        args.clone(),
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "hi\n");

    // With approvals off there is nobody to leave it for.
    std::fs::remove_file(&outside).unwrap();
    let never = Script::new(Decision::Approved);
    let out = exec(
        ctx(
            root.path(),
            SandboxMode::WorkspaceWrite,
            ApprovalPolicy::Never,
            &never,
        ),
        args,
    )
    .await;
    assert!(out.is_error && !outside.exists());
    assert!(never.asked().is_empty());
}

#[tokio::test]
async fn on_failure_the_command_runs_again_outside_once_the_user_agrees() {
    if skip() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let (_keep, outside) = outside_file();
    let args = json!({"cmd": format!("echo hi > {}", outside.display()), "login": false});

    let no = Script::new(Decision::Denied);
    let out = exec(
        ctx(
            root.path(),
            SandboxMode::WorkspaceWrite,
            ApprovalPolicy::OnFailure,
            &no,
        ),
        args.clone(),
    )
    .await;
    assert!(out.is_error && !outside.exists());
    assert_eq!(no.asked().len(), 1, "asked once, after it failed");

    let yes = Script::new(Decision::Approved);
    let out = exec(
        ctx(
            root.path(),
            SandboxMode::WorkspaceWrite,
            ApprovalPolicy::OnFailure,
            &yes,
        ),
        args,
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert!(outside.exists());
}

#[tokio::test]
async fn untrusted_asks_for_everything_that_is_not_a_plain_read() {
    if skip() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let user = Script::new(Decision::Denied);
    let mode = (SandboxMode::WorkspaceWrite, ApprovalPolicy::Untrusted);

    let read = exec(
        ctx(root.path(), mode.0, mode.1, &user),
        json!({"cmd": "ls", "login": false}),
    )
    .await;
    assert!(!read.is_error, "{}", read.content);
    assert!(user.asked().is_empty());

    let write = exec(
        ctx(root.path(), mode.0, mode.1, &user),
        json!({"cmd": "touch made", "login": false}),
    )
    .await;
    assert!(write.is_error);
    assert!(!root.path().join("made").exists());
    assert_eq!(user.asked().len(), 1);
}

#[tokio::test]
async fn full_access_runs_anything_and_asks_nothing() {
    let root = tempfile::tempdir().unwrap();
    let (_keep, outside) = outside_file();
    let user = Script::new(Decision::Denied);
    let out = exec(
        ctx(
            root.path(),
            SandboxMode::DangerFullAccess,
            ApprovalPolicy::OnRequest,
            &user,
        ),
        json!({"cmd": format!("echo hi > {}", outside.display()), "login": false}),
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert!(outside.exists());
    assert!(user.asked().is_empty());
}

#[tokio::test]
async fn a_patch_inside_the_folder_is_applied_and_one_outside_waits_for_the_user() {
    let root = tempfile::tempdir().unwrap();
    let (keep, outside) = outside_file();
    let user = Script::new(Decision::Denied);
    let mode = (SandboxMode::WorkspaceWrite, ApprovalPolicy::OnRequest);

    let inside = patch(
        ctx(root.path(), mode.0, mode.1, &user),
        "*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch\n",
    )
    .await;
    assert!(!inside.is_error, "{}", inside.content);
    assert!(user.asked().is_empty());

    let text = format!(
        "*** Begin Patch\n*** Add File: {}\n+two\n*** End Patch\n",
        outside.display()
    );
    let refused = patch(ctx(root.path(), mode.0, mode.1, &user), &text).await;
    assert!(refused.is_error && !outside.exists());
    let asked = user.asked();
    assert_eq!(asked.len(), 1);
    assert!(
        matches!(&asked[0].kind, ApprovalKind::Patch { files } if files.iter().any(|f| f.ends_with("outside.txt")))
    );

    let yes = Script::new(Decision::Approved);
    let done = patch(ctx(root.path(), mode.0, mode.1, &yes), &text).await;
    assert!(!done.is_error, "{}", done.content);
    assert!(outside.exists());

    // With approvals off, it is refused without asking, and nothing is half-written.
    std::fs::remove_file(&outside).unwrap();
    let never = Script::new(Decision::Approved);
    let out = patch(
        ctx(root.path(), mode.0, ApprovalPolicy::Never, &never),
        &text,
    )
    .await;
    assert!(out.is_error && !outside.exists());
    assert!(never.asked().is_empty());
    drop(keep);
}

#[tokio::test]
async fn read_only_and_the_repositorys_own_directory_stop_a_patch_too() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join(".git")).unwrap();
    let user = Script::new(Decision::Denied);

    let ro = patch(
        ctx(
            root.path(),
            SandboxMode::ReadOnly,
            ApprovalPolicy::Never,
            &user,
        ),
        "*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch\n",
    )
    .await;
    assert!(ro.is_error && !root.path().join("a.txt").exists());

    let git = patch(
        ctx(
            root.path(),
            SandboxMode::WorkspaceWrite,
            ApprovalPolicy::Never,
            &user,
        ),
        "*** Begin Patch\n*** Add File: .git/hooks-evil\n+x\n*** End Patch\n",
    )
    .await;
    assert!(git.is_error && !root.path().join(".git/hooks-evil").exists());
}
