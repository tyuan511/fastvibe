//! The public MCP table feeds the agent's actual request/tool/result path.

use std::sync::Arc;
use std::time::Duration;

use fv_agent::testing::{Reply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use serde_json::json;

mod common;

#[tokio::test]
async fn mcp_configuration_discovery_and_resource_tools_reach_a_real_model_turn() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ScriptedModel::new([
        Reply::new()
            .tool("search", "tool_search", json!({"query":"wire echo image"}))
            .done(),
        Reply::new()
            .tool(
                "echo",
                "mcp_wire_echo",
                json!({"text":"via the public table"}),
            )
            .done(),
        Reply::new()
            .tool(
                "read",
                "read_mcp_resource",
                json!({"server":"wire","uri":"fixture://first"}),
            )
            .done(),
        Reply::new()
            .tool("image", "mcp_wire_image", json!({}))
            .done(),
        Reply::new().text("finished").done(),
    ]));
    let state = Arc::new(
        ServerState::new(
            dir.path().into(),
            fv_server::agent_with_builtin_tools(model.clone()),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let sock = dir.path().join("server.sock");
    let server = tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    let (client, mut notes) = Client::connect_unix(&sock).await.unwrap();
    client.notify("initialized", json!({})).await.unwrap();
    let rejected = client
        .call::<McpResources>(McpResourceListParams {
            server_id: None,
            cursor: None,
        })
        .await
        .unwrap_err();
    assert!(
        matches!(rejected, fv_client::ClientError::Rpc(e) if e.code == fv_protocol::jsonrpc::code::NOT_INITIALIZED)
    );
    client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "test".into(),
                version: "1".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    client.call::<McpImport>(McpImportParams { json: json!({"mcpServers":{"Wire":{
        "command":"python3", "args":[format!("{}/../fv-mcp/tests/fixtures/server.py", env!("CARGO_MANIFEST_DIR"))], "id":"wire"
    }}}).to_string() }).await.unwrap();
    // Map imports mint stable server ids themselves. Set the test's explicit namespace via
    // the native configuration method, the same one the full editor calls.
    let mut cfg = client
        .call::<McpList>(Empty {})
        .await
        .unwrap()
        .servers
        .remove(0)
        .config;
    cfg.id = "wire".into();
    client
        .call::<McpSet>(McpSetParams { servers: vec![cfg] })
        .await
        .unwrap();
    let original = client
        .call::<McpList>(Empty {})
        .await
        .unwrap()
        .servers
        .remove(0)
        .config;
    let mut edited = original.clone();
    edited.name = "Wire edited in the form".into();
    client
        .call::<McpUpdate>(McpUpdateParams {
            server_id: "wire".into(),
            expected: Some(original.clone()),
            config: Some(edited.clone()),
        })
        .await
        .unwrap();
    let stale = client
        .call::<McpUpdate>(McpUpdateParams {
            server_id: "wire".into(),
            expected: Some(original),
            config: None,
        })
        .await
        .unwrap_err();
    assert!(
        matches!(stale, fv_client::ClientError::Rpc(e) if e.code == fv_protocol::jsonrpc::code::INVALID_PARAMS)
    );
    assert_eq!(
        client.call::<McpList>(Empty {}).await.unwrap().servers[0].config,
        edited
    );
    client
        .call::<McpReconnect>(McpServerParams {
            server_id: "wire".into(),
        })
        .await
        .unwrap();
    state.mcp.wait_ready(Duration::from_secs(12)).await;
    let status = client.call::<McpList>(Empty {}).await.unwrap();
    assert!(status.servers[0].connected, "{status:?}");
    assert_eq!(status.servers[0].tools.len(), 7);
    let resources = client
        .call::<McpResources>(McpResourceListParams {
            server_id: Some("wire".into()),
            cursor: None,
        })
        .await
        .unwrap();
    assert!(resources.data.to_string().contains("fixture://first"));
    let id = client
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    client
        .call::<TurnStart>(TurnStartParams {
            thread_id: id.clone(),
            text: "exercise MCP".into(),
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Some(ServerNotification::ThreadStatusChanged(e)) = notes.recv().await
                && e.thread_id == id
                && !e.body.running
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    let snapshot = client
        .call::<ThreadResume>(ThreadIdParams { thread_id: id })
        .await
        .unwrap();
    assert!(
        snapshot
            .turns
            .iter()
            .flat_map(|t| &t.items)
            .all(|i| !matches!(i, Item::Error { .. })),
        "{:?}",
        snapshot.turns
    );
    let requests = model.requests();
    assert_eq!(requests.len(), 5);
    assert!(
        requests[0]
            .project_context()
            .is_some_and(|c| c.contains("Use the fixture tools for testing."))
    );
    assert!(!requests[0].tools.iter().any(|s| s.name == "mcp_wire_echo"));
    assert!(requests[0].tools.iter().any(|s| s.name == "tool_search"));
    assert!(requests[1].tools.iter().any(|s| s.name == "mcp_wire_echo"));
    assert!(requests[2].messages.iter().any(|m| matches!(m, fv_core::Message::ToolResult { content, is_error:false, .. } if content.contains("via the public table"))));
    assert!(requests[3].messages.iter().any(|m| matches!(m, fv_core::Message::ToolResult { content, is_error:false, .. } if content.contains("resource fixture"))));
    assert!(
        requests[4]
            .messages
            .iter()
            .any(|m| matches!(m, fv_core::Message::ToolImages { images, .. } if images.len() == 1))
    );
    let settings =
        serde_json::to_string(&client.call::<SettingsGet>(Empty {}).await.unwrap()).unwrap();
    assert!(!settings.contains("Wire") && !settings.contains("python3"));
    state.mcp.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn a_slow_resource_read_does_not_block_control_requests_on_the_same_connection() {
    let dir = tempfile::tempdir().unwrap();
    let read_log = dir.path().join("read");
    let model = Arc::new(ScriptedModel::new([]));
    let state = Arc::new(
        ServerState::new(
            dir.path().into(),
            fv_server::agent_with_builtin_tools(model),
        )
        .unwrap(),
    );
    let sock = dir.path().join("server.sock");
    let server = tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    let (client, _) = Client::connect_unix(&sock).await.unwrap();
    let client = Arc::new(client);
    client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "test".into(),
                version: "1".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    client.call::<McpImport>(McpImportParams { json: json!({"slow": {
        "command":"python3", "args":[format!("{}/../fv-mcp/tests/fixtures/server.py", env!("CARGO_MANIFEST_DIR"))],
        "env":{"READ_LOG":read_log.display().to_string()}
    }}).to_string() }).await.unwrap();
    state.mcp.wait_ready(Duration::from_secs(12)).await;
    let id = client.call::<McpList>(Empty {}).await.unwrap().servers[0]
        .config
        .id
        .clone();
    let reader = client.clone();
    let pending = tokio::spawn(async move {
        reader
            .call::<McpReadResource>(McpResourceParams {
                server_id: id,
                uri: "fixture://slow".into(),
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !read_log.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        client.call::<TurnInterrupt>(ThreadIdParams {
            thread_id: "unused".into(),
        }),
    )
    .await;
    assert!(
        result.is_ok(),
        "control request was stuck behind resources/read"
    );
    assert!(!pending.is_finished());
    pending.abort();
    state.mcp.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn oauth_uses_the_callers_connection_and_does_not_block_stop_during_discovery() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let dir = tempfile::tempdir().unwrap();
    let fixture_dir = tempfile::tempdir().unwrap();
    let mut child = tokio::process::Command::new("python3")
        .arg(format!(
            "{}/../fv-mcp/tests/fixtures/oauth.py",
            env!("CARGO_MANIFEST_DIR")
        ))
        .arg(fixture_dir.path())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let origin = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .next_line()
        .await
        .unwrap()
        .unwrap();
    let mut state = ServerState::new(
        dir.path().into(),
        fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([]))),
    )
    .unwrap();
    state.mcp = fv_mcp::Manager::open_with_http_client_builder(
        dir.path(),
        Arc::new(|| reqwest::Client::builder().no_proxy()),
    )
    .unwrap();
    let state = Arc::new(state);
    let socket = dir.path().join("server.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (first, _) = Client::connect_unix(&socket).await.unwrap();
    let (second, _) = Client::connect_unix(&socket).await.unwrap();
    let first = Arc::new(first);
    for client in [first.as_ref(), &second] {
        client
            .call::<Initialize>(InitializeParams {
                client_info: ClientInfo {
                    name: "oauth-test".into(),
                    version: "1".into(),
                },
                protocol_version: PROTOCOL_VERSION,
                capabilities: Default::default(),
            })
            .await
            .unwrap();
    }
    first
        .call::<McpSet>(McpSetParams {
            servers: vec![McpServerConfig {
                id: "auth".into(),
                name: "auth".into(),
                enabled: true,
                transport: McpTransport::Http,
                command: None,
                args: vec![],
                env: Default::default(),
                url: Some(format!("{origin}/mcp")),
                headers: Default::default(),
                deferred: false,
            }],
        })
        .await
        .unwrap();
    std::fs::write(fixture_dir.path().join("metadata-delay"), "yes").unwrap();
    let owner = first.clone();
    let pending = tokio::spawn(async move {
        owner
            .call::<McpAuthBegin>(McpAuthBeginParams {
                server_id: "auth".into(),
                redirect_uri: "http://127.0.0.1:8765/mcp/callback".into(),
                client_id: None,
                client_secret: None,
                scopes: vec![],
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(40), async {
        while !fixture_dir.path().join("metadata-started").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(500),
            first.call::<TurnInterrupt>(ThreadIdParams {
                thread_id: "unused".into()
            })
        )
        .await
        .is_ok()
    );
    assert!(!pending.is_finished());
    std::fs::remove_file(fixture_dir.path().join("metadata-delay")).unwrap();
    let begin = pending.await.unwrap().unwrap();
    let browser = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = browser.get(begin.authorization_url).send().await.unwrap();
    assert_eq!(response.status(), 302);
    let callback_url = response.headers()["location"].to_str().unwrap().to_string();
    assert!(
        second
            .call::<McpAuthComplete>(McpAuthCompleteParams {
                flow_id: begin.flow_id.clone(),
                callback_url: callback_url.clone()
            })
            .await
            .is_err()
    );
    first
        .call::<McpAuthComplete>(McpAuthCompleteParams {
            flow_id: begin.flow_id,
            callback_url,
        })
        .await
        .unwrap();
    state.mcp.wait_ready(Duration::from_secs(12)).await;
    let status = first.call::<McpList>(Empty {}).await.unwrap();
    assert!(status.servers[0].connected, "{status:?}");
    assert!(status.servers[0].oauth_credentials);
    let settings =
        serde_json::to_string(&first.call::<SettingsGet>(Empty {}).await.unwrap()).unwrap();
    assert!(!settings.contains("access-") && !settings.contains("fixture-client-secret"));
    let signed_out = first
        .call::<McpAuthForget>(McpServerParams {
            server_id: "auth".into(),
        })
        .await
        .unwrap();
    assert!(!signed_out.servers[0].oauth_credentials);
    state.mcp.shutdown().await;
    server.abort();
}
