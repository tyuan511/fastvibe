//! A multi-folder project's Git calls must stay in the repository they name, including
//! identical relative paths in both roots.
use fv_agent::testing::NoModel;
use fv_client::Client;
use fv_protocol::PROTOCOL_VERSION;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use std::path::Path;
use std::sync::Arc;

fn git(root: &Path, args: &[&str]) -> String {
    let result = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}
fn repository(path: &Path) {
    std::fs::create_dir(path).unwrap();
    git(path, &["init", "-b", "main"]);
    git(path, &["config", "user.name", "Test"]);
    git(path, &["config", "user.email", "test@example.invalid"]);
    git(path, &["config", "commit.gpgsign", "false"]);
    git(path, &["config", "core.fsmonitor", "false"]);
    git(
        path,
        &[
            "config",
            "core.hooksPath",
            &path.join(".git/no-hooks").display().to_string(),
        ],
    );
    std::fs::write(path.join("same.txt"), "base\n").unwrap();
    git(path, &["add", "same.txt"]);
    git(path, &["commit", "-m", "initial"]);
}
#[tokio::test]
async fn status_stage_commit_diff_and_history_stay_with_the_selected_project_folder() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("first");
    let b = dir.path().join("second");
    repository(&a);
    repository(&b);
    std::fs::write(a.join("same.txt"), "first changed\n").unwrap();
    std::fs::write(b.join("same.txt"), "second changed\n").unwrap();
    let a_path = a.display().to_string();
    let b_path = b.display().to_string();
    let state = Arc::new(
        fv_server::ServerState::new(
            dir.path().join("data"),
            fv_server::agent_with_builtin_tools(Arc::new(NoModel)),
        )
        .unwrap(),
    );
    let (io, server_io) = tokio::io::duplex(65536);
    let (r, w) = tokio::io::split(server_io);
    let server = tokio::spawn(fv_server::serve_connection(
        state,
        ClientOrigin::Local,
        r,
        w,
    ));
    let (r, w) = tokio::io::split(io);
    let (client, _) = Client::from_io(r, w);
    client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "git-projects".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    let project = client
        .call::<ProjectCreate>(ProjectCreateParams {
            name: Some("two repositories".into()),
            folders: vec![a_path.clone(), b_path.clone()],
        })
        .await
        .unwrap();
    assert_eq!(project.folders, vec![b_path.clone()]);
    let staged = client
        .call::<WorkspaceGitStage>(GitPathsParams {
            cwd: b_path.clone(),
            paths: vec!["same.txt".into()],
            all: false,
        })
        .await
        .unwrap();
    assert_eq!(staged.files[0].index, "M");
    let first = client
        .call::<WorkspaceGitStatus>(CwdParams {
            cwd: a_path.clone(),
        })
        .await
        .unwrap();
    assert_eq!(first.files[0].index, " ");
    assert_eq!(first.files[0].worktree, "M");
    client
        .call::<WorkspaceGitCommit>(GitCommitParams {
            cwd: b_path.clone(),
            message: "only second".into(),
            amend: false,
        })
        .await
        .unwrap();
    assert_eq!(git(&a, &["log", "-1", "--format=%s"]).trim(), "initial");
    assert_eq!(git(&b, &["log", "-1", "--format=%s"]).trim(), "only second");
    for (cwd, subject) in [(&a_path, "initial"), (&b_path, "only second")] {
        let history = client
            .call::<WorkspaceGitHistory>(GitHistoryParams {
                cwd: cwd.clone(),
                skip: Some(0),
                scope: HistoryScope::All,
                tips: None,
            })
            .await
            .unwrap();
        assert_eq!(history.commits[0].subject, subject);
    }
    let first = client
        .call::<WorkspaceGitDiff>(GitDiffParams {
            cwd: a_path,
            path: Some("same.txt".into()),
            source: DiffSource::Unstaged,
            revision: None,
        })
        .await
        .unwrap();
    assert!(first.text.contains("+first changed"));
    assert!(!first.text.contains("second changed"));
    let second = client
        .call::<WorkspaceGitDiff>(GitDiffParams {
            cwd: b_path,
            path: Some("same.txt".into()),
            source: DiffSource::Unstaged,
            revision: None,
        })
        .await
        .unwrap();
    assert!(second.text.is_empty());
    server.abort();
}
