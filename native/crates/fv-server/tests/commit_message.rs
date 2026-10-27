//! 提交信息的 AI 生成 over the wire: the conversation's model is shown the repository's changes
//! and its answer comes back as one clean English subject.

use std::sync::Arc;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::PROTOCOL_VERSION;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_server::{ServerState, UnixServer};

fn git(root: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

async fn start(
    answer: &'static str,
) -> (
    tempfile::TempDir,
    Client,
    Arc<ScriptedModel>,
    String,
    String,
) {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.name", "t"]);
    git(&repo, &["config", "user.email", "t@t"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("a.rs"), "fn a() {}\n").unwrap();
    std::fs::write(repo.join("Cargo.lock"), "# lock\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    // One modified source file, one lock file, one brand new file.
    std::fs::write(repo.join("a.rs"), "fn a() { println!(\"changed\"); }\n").unwrap();
    std::fs::write(repo.join("Cargo.lock"), "# lock\n# more\n").unwrap();
    std::fs::write(repo.join("new.txt"), "brand new text\n").unwrap();

    let model = Arc::new(ScriptedModel::new([Reply::new().text(answer).done()]));
    let agent = fv_server::agent_with_builtin_tools(Arc::new(fv_agent::testing::NoModel));
    let state = Arc::new(ServerState::new(dir.path().join("data"), agent).unwrap());
    state.set_suggestion_model(model.clone());
    let cwd = repo.display().to_string();
    let thread = state
        .create_thread(Some(cwd.clone()), None, None, None)
        .unwrap();
    let sock = dir.path().join("s.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    let (client, _) = Client::connect_unix(&sock).await.unwrap();
    client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "t".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    (dir, client, model, cwd, thread.id)
}

#[tokio::test]
async fn the_model_sees_the_changes_and_its_answer_becomes_one_subject() {
    let (_dir, client, model, cwd, thread) =
        start("\"feat: print a message.\"\nThis explains itself.").await;
    let reply = client
        .call::<WorkspaceGitGenerateCommitMessage>(GitGenerateCommitMessageParams {
            cwd,
            conversation_id: thread,
            include_unstaged: true,
        })
        .await
        .unwrap();
    assert_eq!(reply.message, "feat: print a message");

    let asked = model.requests();
    assert_eq!(asked.len(), 1);
    let fv_core::Message::User { text } = &asked[0].messages[0] else {
        panic!("a user message")
    };
    assert!(text.contains("Always write the subject in English"));
    assert!(text.contains("Changed files: 3"), "{text}");
    assert!(
        text.contains("println!(\"changed\")"),
        "the source patch is shown"
    );
    assert!(
        text.contains("brand new text"),
        "an untracked file's first lines are shown"
    );
    assert!(
        text.contains("Cargo.lock — patch omitted (lock file)"),
        "a lock file is listed, not read: {text}"
    );
    assert!(
        !text.contains("# more"),
        "lock file content stays out of the prompt"
    );
}

#[tokio::test]
async fn nothing_staged_means_nothing_to_describe_and_the_model_is_not_asked() {
    let (_dir, client, model, cwd, thread) = start("unused").await;
    let error = client
        .call::<WorkspaceGitGenerateCommitMessage>(GitGenerateCommitMessageParams {
            cwd,
            conversation_id: thread,
            include_unstaged: false,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("no changes"), "{error}");
    assert!(model.requests().is_empty());
}

#[tokio::test]
async fn an_unknown_conversation_is_refused() {
    let (_dir, client, _model, cwd, _thread) = start("unused").await;
    let refused = client
        .call::<WorkspaceGitGenerateCommitMessage>(GitGenerateCommitMessageParams {
            cwd,
            conversation_id: "nope".into(),
            include_unstaged: true,
        })
        .await;
    assert!(refused.is_err());
}
