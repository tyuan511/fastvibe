use std::sync::{Arc, Mutex};
use std::time::Duration;

use fv_agent::{ToolCtx, ToolRegistry};
use fv_mcp::Manager;
use fv_protocol::types::*;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn streamable_http_uses_configured_headers_and_the_same_tool_path_as_stdio() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/start", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let (head, offset, length) = loop {
                    let n = socket.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..at]).to_string();
                        let length = head
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        break (head, at + 4, length);
                    }
                };
                while bytes.len() < offset + length {
                    let n = socket.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                }
                let value: Value =
                    serde_json::from_slice(&bytes[offset..offset + length]).unwrap_or(Value::Null);
                seen.lock().unwrap().push((head.clone(), value.clone()));
                if head.starts_with("POST /start ") {
                    socket.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /mcp\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                    return;
                }
                let method = value["method"].as_str().unwrap_or("");
                let id = value.get("id");
                let response = match method {
                    "initialize" => {
                        json!({"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"http-fixture","version":"1"}}})
                    }
                    "tools/list" => {
                        json!({"result":{"tools":[{"name":"hello","description":"HTTP greeting","inputSchema":{"type":"object"}}]}})
                    }
                    "tools/call" => {
                        json!({"result":{"content":[{"type":"text","text":"hello from HTTP"}]}})
                    }
                    "ping" => json!({"result":{}}),
                    _ => json!({"error":{"code":-32601,"message":"not supported"}}),
                };
                let (status, body) = if head.starts_with("GET ") {
                    (405, String::new())
                } else if let Some(id) = id {
                    let mut response = response.as_object().unwrap().clone();
                    response.insert("jsonrpc".into(), json!("2.0"));
                    response.insert("id".into(), id.clone());
                    (200, serde_json::to_string(&response).unwrap())
                } else {
                    (202, String::new())
                };
                let head = format!(
                    "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                socket.write_all(body.as_bytes()).await.unwrap();
            });
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open_with_http_client_builder(
        dir.path(),
        Arc::new(|| reqwest::Client::builder().no_proxy()),
    )
    .unwrap();
    let config = McpServerConfig {
        id: "http".into(),
        name: "HTTP".into(),
        transport: McpTransport::Http,
        enabled: true,
        command: None,
        args: vec![],
        env: Default::default(),
        url: Some(url),
        deferred: false,
        headers: [
            ("Authorization".into(), "Bearer fixture-only".into()),
            ("x-extra".into(), "a:b=c".into()),
        ]
        .into(),
    };
    manager.set(vec![config]).await.unwrap();
    manager.wait_ready(Duration::from_secs(12)).await;
    assert!(
        manager.list().servers[0].connected,
        "{:?}; requests: {:?}",
        manager.list(),
        requests.lock().unwrap()
    );
    let registry = manager.registry(&ToolRegistry::new());
    assert!(registry.specs().iter().any(|s| s.name == "mcp_http_hello"));
    let result = registry
        .get("mcp_http_hello")
        .unwrap()
        .call(ToolCtx::new(CancellationToken::new(), None), json!({}))
        .await;
    assert!(!result.is_error, "{}", result.content);
    assert!(result.content.contains("hello from HTTP"));
    {
        let requests = requests.lock().unwrap();
        assert!(
            requests
                .iter()
                .any(|(head, v)| head.starts_with("POST /mcp ") && v["method"] == "tools/call")
        );
        assert!(
            requests
                .iter()
                .any(|(head, _)| head.starts_with("POST /start "))
        );
        assert!(
            requests
                .iter()
                .filter(|(_, v)| v.get("id").is_some())
                .all(|(head, _)| {
                    let head = head.to_lowercase();
                    head.contains("authorization: bearer fixture-only")
                        && head.contains("x-extra: a:b=c")
                })
        );
    }
    manager.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn redirects_never_forward_custom_credentials_to_another_origin() {
    let forbidden = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = format!("http://{}/stolen", forbidden.local_addr().unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let response = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            tokio::spawn(async move {
                let mut buf = [0; 4096];
                let _ = socket.read(&mut buf).await;
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open_with_http_client_builder(
        dir.path(),
        Arc::new(|| reqwest::Client::builder().no_proxy()),
    )
    .unwrap();
    manager
        .set(vec![McpServerConfig {
            id: "redirect".into(),
            name: "redirect".into(),
            enabled: true,
            transport: McpTransport::Http,
            command: None,
            args: vec![],
            env: Default::default(),
            url: Some(url),
            deferred: true,
            headers: [("x-private-key".into(), "fixture-secret".into())].into(),
        }])
        .await
        .unwrap();
    manager.wait_ready(Duration::from_secs(12)).await;
    assert!(!manager.list().servers[0].connected);
    assert!(
        tokio::time::timeout(Duration::from_millis(200), forbidden.accept())
            .await
            .is_err(),
        "custom credentials must never reach a different origin"
    );
    manager.shutdown().await;
    server.abort();
}
