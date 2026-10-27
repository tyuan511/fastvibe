//! 电脑操控 over the wire: the host application registers its driver daemon, and the driver's
//! tools reach the agent through a managed MCP server — only while the setting is on.

use std::os::unix::fs::PermissionsExt as _;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::NoModel;
use fv_agent::{ToolCtx, ToolRegistry};
use fv_client::{Client, ClientError};
use fv_protocol::PROTOCOL_VERSION;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_server::{ServerState, UnixServer};
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// A `cua-driver` that records how it was started and then behaves as a real MCP peer.
fn fake_driver(data_dir: &std::path::Path) -> std::path::PathBuf {
    let root = data_dir.join("runtime").join("cua-driver");
    std::fs::create_dir_all(&root).unwrap();
    let log = data_dir.join("driver.log");
    let script = format!(
        "#!/bin/sh\necho \"args: $@\" >> '{log}'\necho \"embedded: $CUA_DRIVER_EMBEDDED\" >> '{log}'\n\
         echo \"telemetry: $CUA_DRIVER_RS_TELEMETRY_ENABLED\" >> '{log}'\nexec python3 '{fixture}'\n",
        log = log.display(),
        fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fv-mcp/tests/fixtures/server.py"
        ),
    );
    let binary = root.join("cua-driver");
    std::fs::write(&binary, script).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(root.join("VERSION"), "0.28.2").unwrap();
    binary
}

async fn start(install: bool) -> (tempfile::TempDir, Arc<ServerState>, Client) {
    let dir = tempfile::tempdir().unwrap();
    if install {
        fake_driver(dir.path());
    }
    let state = Arc::new(
        ServerState::new(
            dir.path().into(),
            fv_server::agent_with_builtin_tools(Arc::new(NoModel)),
        )
        .unwrap(),
    );
    let sock = dir.path().join("server.sock");
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    let (client, _) = Client::connect_unix(&sock).await.unwrap();
    client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "host".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    (dir, state, client)
}

fn rpc_message(error: ClientError) -> String {
    match error {
        ClientError::Rpc(e) => e.message,
        other => other.to_string(),
    }
}

async fn switch(client: &Client, on: bool) {
    client
        .call::<SettingsSet>(AppSettingsPatch {
            computer_control: Some(on),
            ..Default::default()
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn the_hosts_daemon_becomes_a_managed_server_and_the_switch_takes_it_away() {
    let (dir, state, client) = start(true).await;
    let status = client.call::<ComputerStatusGet>(Empty {}).await.unwrap();
    assert!(status.installed && !status.running, "{status:?}");
    assert_eq!(status.version.as_deref(), Some("0.28.2"));

    let socket = dir.path().join("cua.sock").display().to_string();
    // Off: nobody may point the server at a daemon.
    let refused = client
        .call::<ComputerHost>(ComputerHostParams {
            socket: Some(socket.clone()),
        })
        .await
        .unwrap_err();
    assert!(rpc_message(refused).contains("off"));

    switch(&client, true).await;
    let relative = client
        .call::<ComputerHost>(ComputerHostParams {
            socket: Some("cua.sock".into()),
        })
        .await
        .unwrap_err();
    assert!(rpc_message(relative).contains("absolute"));

    client
        .call::<ComputerHost>(ComputerHostParams {
            socket: Some(socket.clone()),
        })
        .await
        .unwrap();
    assert!(
        client
            .call::<ComputerStatusGet>(Empty {})
            .await
            .unwrap()
            .running
    );
    state.mcp.wait_ready(Duration::from_secs(12)).await;

    let registry = state.mcp.registry(&ToolRegistry::new());
    let echo = registry
        .get("mcp_computer_echo")
        .expect("the driver's tools are the agent's");
    assert!(
        echo.deferred(),
        "they arrive through tool_search, not on every request"
    );
    let out = echo
        .call(
            ToolCtx::new(CancellationToken::new(), None),
            json!({"text": "hello driver"}),
        )
        .await;
    assert!(
        !out.is_error && out.content.contains("hello driver"),
        "{out:?}"
    );
    // The user's own MCP list is theirs: the managed server is not in it.
    assert!(
        client
            .call::<McpList>(Empty {})
            .await
            .unwrap()
            .servers
            .is_empty()
    );

    let log = std::fs::read_to_string(dir.path().join("driver.log")).unwrap();
    assert!(
        log.contains(&format!("args: mcp --embedded --socket {socket}")),
        "{log}"
    );
    assert!(
        log.contains("embedded: 1") && log.contains("telemetry: 0"),
        "{log}"
    );

    // Saving the user's MCP list must not drop the application's own server.
    client
        .call::<McpSet>(McpSetParams { servers: vec![] })
        .await
        .unwrap();
    assert!(
        state
            .mcp
            .registry(&ToolRegistry::new())
            .get("mcp_computer_echo")
            .is_some()
    );

    switch(&client, false).await;
    assert!(
        !client
            .call::<ComputerStatusGet>(Empty {})
            .await
            .unwrap()
            .running
    );
    assert!(
        state
            .mcp
            .registry(&ToolRegistry::new())
            .get("mcp_computer_echo")
            .is_none(),
        "switching it off takes the tools away at once"
    );
}

#[tokio::test]
async fn nothing_registers_without_an_installed_driver_of_the_pinned_version() {
    let (dir, _state, client) = start(false).await;
    switch(&client, true).await;
    let socket = dir.path().join("cua.sock").display().to_string();
    let missing = client
        .call::<ComputerHost>(ComputerHostParams {
            socket: Some(socket.clone()),
        })
        .await
        .unwrap_err();
    assert!(rpc_message(missing).contains("not installed"));

    // A driver of another release is not an install: the daemon and its proxy must match.
    fake_driver(dir.path());
    std::fs::write(dir.path().join("runtime/cua-driver/VERSION"), "0.1.0").unwrap();
    let status = client.call::<ComputerStatusGet>(Empty {}).await.unwrap();
    assert!(
        !status.installed && status.version.as_deref() == Some("0.1.0"),
        "{status:?}"
    );
    let stale = client
        .call::<ComputerHost>(ComputerHostParams {
            socket: Some(socket),
        })
        .await
        .unwrap_err();
    assert!(rpc_message(stale).contains("not installed"));
}

/// The names of the tools a turn's request carried, for a server whose model is scripted.
async fn tools_in_a_turn(
    model: &Arc<fv_agent::testing::ScriptedModel>,
    client: &Client,
) -> Vec<String> {
    let before = model.requests().len();
    let thread = client
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: thread,
            text: "hi".into(),
        })
        .await
        .unwrap();
    for _ in 0..200 {
        if model.requests().len() > before {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let request = model.requests().remove(before);
    request.tools.iter().map(|t| t.name.clone()).collect()
}

#[tokio::test]
async fn the_basic_computer_tool_follows_the_switch_and_yields_to_the_driver() {
    use fv_agent::testing::{Reply, ScriptedModel};
    let dir = tempfile::tempdir().unwrap();
    fake_driver(dir.path());
    let model = Arc::new(ScriptedModel::new(
        (0..3)
            .map(|_| Reply::new().text("ok").done())
            .collect::<Vec<_>>(),
    ));
    let state = Arc::new(
        ServerState::new(
            dir.path().into(),
            fv_server::agent_with_builtin_tools(model.clone()),
        )
        .unwrap(),
    );
    let sock = dir.path().join("server.sock");
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
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
    client
        .call::<SettingsSet>(AppSettingsPatch {
            reply_suggestions: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();

    let off = tools_in_a_turn(&model, &client).await;
    assert!(
        !off.iter().any(|n| n == "computer"),
        "switched off, the agent has no desktop tools: {off:?}"
    );

    switch(&client, true).await;
    let on = tools_in_a_turn(&model, &client).await;
    assert!(
        on.iter().any(|n| n == "computer"),
        "on without a driver, the basic tool is the fallback: {on:?}"
    );

    let socket = dir.path().join("cua.sock").display().to_string();
    client
        .call::<ComputerHost>(ComputerHostParams {
            socket: Some(socket),
        })
        .await
        .unwrap();
    state.mcp.wait_ready(Duration::from_secs(12)).await;
    let running = tools_in_a_turn(&model, &client).await;
    assert!(
        !running.iter().any(|n| n == "computer"),
        "the driver replaces it: {running:?}"
    );
}
