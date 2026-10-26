//! A blocked filesystem read must not make Stop wait for the filesystem to recover.

#![cfg(unix)]

use std::fs::{self, OpenOptions};
use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::ScriptedModel;
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::context::ContextLoader;
use fv_server::{ServerState, UnixServer};

#[tokio::test]
async fn stop_finishes_even_while_project_instructions_are_blocked_in_a_read() {
    let data = tempfile::tempdir().unwrap();
    let repo = data.path().join("repo");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join(".git"), "").unwrap();
    let fifo = repo.join("AGENTS.md");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );

    let model = Arc::new(ScriptedModel::new([]));
    let mut state = ServerState::new(
        data.path().to_path_buf(),
        fv_server::agent_with_builtin_tools(model.clone()),
    )
    .unwrap();
    state.context = ContextLoader::with_roots(data.path(), None, vec![]);
    let sock = data.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(Arc::new(state), &sock)
            .await
            .unwrap()
            .run(),
    );
    let (client, mut notes) = Client::connect_unix(&sock).await.unwrap();
    client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    let id = client
        .call::<ThreadStart>(ThreadStartParams {
            cwd: Some(repo.display().to_string()),
            ..Default::default()
        })
        .await
        .unwrap()
        .thread
        .id;

    // Opening the writer is the handshake: it only returns once the context reader has
    // opened the FIFO. Keeping it open without writing then blocks read_to_string on EOF.
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let writer = OpenOptions::new().write(true).open(fifo);
        let _ = tx.send(writer);
    });
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: id.clone(),
            text: "hello".into(),
        })
        .await
        .unwrap();
    let writer = tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    client
        .call::<TurnInterrupt>(ThreadIdParams { thread_id: id })
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(note) = notes.recv().await {
            if let ServerNotification::ThreadStatusChanged(e) = note
                && !e.body.running
            {
                return;
            }
        }
        panic!("connection closed before the stopped turn settled");
    })
    .await;
    // Release the blocking worker before asserting, including on failure: a Tokio runtime
    // waits for its blocking tasks at shutdown.
    drop(writer);
    assert!(
        result.is_ok(),
        "Stop waited for the instructions read to finish"
    );
    assert!(
        model.requests().is_empty(),
        "a stopped discovery must not call the model"
    );
    server.abort();
}
