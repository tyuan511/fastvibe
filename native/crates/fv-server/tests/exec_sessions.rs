#![cfg(unix)]

//! Real command sessions through model turns and the public client protocol.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::BoxStream;
use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{Model, ModelError, ModelEvent, ModelRequest};
use fv_client::Client;
use fv_core::Message;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

struct Commands;
impl Model for Commands {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        let command = request
            .messages
            .iter()
            .rev()
            .find_map(|m| match m {
                Message::User { text } => Some(serde_json::from_str::<Value>(text).unwrap()),
                _ => None,
            })
            .unwrap();
        let steps = if matches!(request.messages.last(), Some(Message::ToolResult { .. })) {
            if command["hang"].as_bool() == Some(true) {
                Reply::new().then_hang()
            } else {
                Reply::new().text("done").done()
            }
        } else {
            Reply::new()
                .tool(
                    &format!("cmd-{}", request.messages.len()),
                    command["name"].as_str().unwrap(),
                    command["args"].clone(),
                )
                .done()
        };
        ScriptedModel::new([steps]).stream(request)
    }
}

type Notes = UnboundedReceiver<ServerNotification>;
struct Harness {
    dir: tempfile::TempDir,
    sock: PathBuf,
    state: Arc<ServerState>,
    server: tokio::task::JoinHandle<std::io::Result<()>>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.state.close_command_sessions();
        self.server.abort();
    }
}
impl Harness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(
            ServerState::new(
                dir.path().into(),
                fv_server::agent_with_builtin_tools(Arc::new(Commands)),
            )
            .unwrap(),
        );
        state
            .store
            .db
            .set_setting(
                "app.settings",
                Some(
                    &serde_json::to_string(&AppSettings {
                        reply_suggestions: false,
                        sandbox_mode: SandboxMode::DangerFullAccess,
                        approval_policy: ApprovalPolicy::Never,
                        ..Default::default()
                    })
                    .unwrap(),
                ),
            )
            .unwrap();
        let sock = dir.path().join("s.sock");
        let server = tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
        Self {
            dir,
            sock,
            state,
            server,
        }
    }
    async fn client(&self) -> (Client, Notes, InitializeResponse) {
        let (client, notes) = Client::connect_unix(&self.sock).await.unwrap();
        let hello = client
            .call::<Initialize>(InitializeParams {
                client_info: ClientInfo {
                    name: "exec-test".into(),
                    version: "0".into(),
                },
                protocol_version: PROTOCOL_VERSION,
                capabilities: Default::default(),
            })
            .await
            .unwrap();
        (client, notes, hello)
    }
    async fn thread(&self, client: &Client) -> String {
        client
            .call::<ThreadStart>(ThreadStartParams {
                cwd: Some(self.dir.path().display().to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .thread
            .id
    }
}
async fn start(client: &Client, thread: &str, command: Value) {
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread.into(),
            text: command.to_string(),
        })
        .await
        .unwrap();
}
async fn output(notes: &mut Notes, finish_turn: bool) -> (String, bool) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut result = None;
        while let Some(note) = notes.recv().await {
            match note {
                ServerNotification::ItemCompleted(e) => {
                    if let Item::ToolCall {
                        output: Some(text),
                        is_error,
                        ..
                    } = e.body.item
                    {
                        result = Some((text, is_error));
                        if !finish_turn {
                            return result.unwrap();
                        }
                    }
                }
                ServerNotification::ThreadStatusChanged(e) if !e.body.running => {
                    return result.expect("tool result before idle");
                }
                _ => (),
            }
        }
        panic!("connection closed");
    })
    .await
    .unwrap()
}
fn session(text: &str) -> u64 {
    text.split("session ID ")
        .nth(1)
        .unwrap_or_else(|| panic!("{text}"))
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}
fn launch(cmd: &str, tty: bool) -> Value {
    json!({"name":"exec_command","args":{"cmd":cmd,"tty":tty,"shell":"/bin/sh","login":false,"yield_time_ms":250}})
}
async fn dead(path: &Path) {
    let pid = std::fs::read_to_string(path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !std::process::Command::new("/bin/kill")
                .args(["-0", pid.trim()])
                .output()
                .unwrap()
                .status
                .success()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn sessions_survive_turn_completion_and_reconnection_but_cannot_cross_threads() {
    let h = Harness::new().await;
    let (client, mut notes, _) = h.client().await;
    let a = h.thread(&client).await;
    let b = h.thread(&client).await;
    start(
        &client,
        &a,
        launch(
            "printf READY; read -r line; printf 'reply:%s\\n' \"$line\"",
            true,
        ),
    )
    .await;
    let (text, failed) = output(&mut notes, true).await;
    assert!(!failed && text.contains("READY"), "{text}");
    let id = session(&text);
    // A new GUI connection must reuse the conversation's pool rather than a window's pool.
    drop(client);
    let (client, mut notes, hello) = h.client().await;
    assert_eq!(
        hello.has_running_turns,
        Some(true),
        "upgrades must not kill yielded commands"
    );
    start(
        &client,
        &b,
        json!({"name":"write_stdin","args":{"session_id":id,"chars":"stolen\n"}}),
    )
    .await;
    let (text, failed) = output(&mut notes, true).await;
    assert!(failed && text.contains("another conversation"), "{text}");
    start(
        &client,
        &a,
        json!({"name":"write_stdin","args":{"session_id":id,"chars":"你好\n","yield_time_ms":250}}),
    )
    .await;
    let (text, failed) = output(&mut notes, true).await;
    assert!(
        !failed && text.contains("reply:你好") && text.contains("exited with code 0"),
        "{text}"
    );
    assert!(!text.contains("READY"), "output is incremental");
    assert!(!h.state.has_running_turns());
}

#[tokio::test]
async fn deleting_a_thread_and_stopping_the_server_kill_yielded_command_groups() {
    let h = Harness::new().await;
    let (client, mut notes, _) = h.client().await;
    for (tty, delete) in [(false, true), (true, false)] {
        let thread = h.thread(&client).await;
        start(
            &client,
            &thread,
            launch("echo $$ > parent; sleep 60 & echo $! > child; wait", tty),
        )
        .await;
        let (text, failed) = output(&mut notes, true).await;
        assert!(!failed, "{text}");
        session(&text);
        let _retained_runtime = h.state.runtime(&thread);
        if delete {
            client
                .call::<ThreadDelete>(ThreadIdParams { thread_id: thread })
                .await
                .unwrap();
        } else {
            h.state.close_command_sessions();
        }
        for name in ["parent", "child"] {
            dead(&h.dir.path().join(name)).await;
        }
    }
}

#[tokio::test]
async fn interrupting_a_turn_after_a_command_yields_kills_its_processes() {
    let h = Harness::new().await;
    let (client, mut notes, _) = h.client().await;
    let thread = h.thread(&client).await;
    let mut command = launch("echo $$ > parent; sleep 60 & echo $! > child; wait", true);
    command["hang"] = json!(true);
    start(&client, &thread, command).await;
    let (text, failed) = output(&mut notes, false).await;
    assert!(!failed, "{text}");
    session(&text);
    client
        .call::<TurnInterrupt>(ThreadIdParams { thread_id: thread })
        .await
        .unwrap();
    for name in ["parent", "child"] {
        dead(&h.dir.path().join(name)).await;
    }
}

#[tokio::test]
async fn stdio_server_handles_sigterm_through_its_clean_shutdown_path() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = tokio::process::Command::new(env!("CARGO_BIN_EXE_fastvibe-server"))
        .args(["--listen", "stdio", "--data-dir"])
        .arg(dir.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let (client, _notes) =
        Client::from_io(server.stdout.take().unwrap(), server.stdin.take().unwrap());
    tokio::time::timeout(
        Duration::from_secs(45),
        client.call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "shutdown-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        }),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        std::process::Command::new("/bin/kill")
            .args(["-TERM", &server.id().unwrap().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let status = tokio::time::timeout(Duration::from_secs(5), server.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(
        status.success(),
        "SIGTERM must reach cleanup, not exit by signal: {status}"
    );
}
