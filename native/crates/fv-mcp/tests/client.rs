use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fv_agent::{ToolCtx, ToolRegistry};
use fv_mcp::Manager;
use fv_protocol::types::*;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn config(id: &str) -> McpServerConfig {
    McpServerConfig {
        id: id.into(),
        name: id.into(),
        enabled: true,
        transport: McpTransport::Stdio,
        command: Some("python3".into()),
        args: vec![format!(
            "{}/tests/fixtures/server.py",
            env!("CARGO_MANIFEST_DIR")
        )],
        env: Default::default(),
        headers: Default::default(),
        url: None,
        deferred: true,
    }
}

async fn ready(manager: &Arc<Manager>) {
    manager.wait_ready(Duration::from_secs(12)).await;
    let servers = manager.list().servers;
    assert!(
        servers.iter().all(|s| !s.config.enabled || s.connected),
        "{servers:?}"
    );
}

async fn call(registry: &ToolRegistry, name: &str, arguments: Value) -> fv_agent::ToolOutput {
    registry
        .get(name)
        .unwrap()
        .call(ToolCtx::new(CancellationToken::new(), None), arguments)
        .await
}

#[tokio::test]
async fn shared_connections_tools_images_errors_resources_and_restart() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    let mut cfg = config("fixture");
    let starts = dir.path().join("starts");
    cfg.env
        .insert("START_LOG".into(), starts.display().to_string());
    manager.set(vec![cfg]).await.unwrap();
    ready(&manager).await;
    let a = manager.registry(&ToolRegistry::new());
    let b = manager.registry(&ToolRegistry::new());
    assert!(a.specs().iter().all(|s| !s.name.starts_with("mcp_fixture")));
    assert_eq!(a.deferred_specs().len(), 7);
    let first = call(&a, "mcp_fixture_echo", json!({"text":"hello"})).await;
    let second = call(&b, "mcp_fixture_echo", json!({"text":"again"})).await;
    let a: Value = serde_json::from_str(&first.content).unwrap();
    let b: Value = serde_json::from_str(&second.content).unwrap();
    assert_eq!(a["structuredContent"]["pid"], b["structuredContent"]["pid"]);
    assert_eq!(std::fs::read_to_string(&starts).unwrap().lines().count(), 1);
    let registry = manager.registry(&ToolRegistry::new());
    let image = call(&registry, "mcp_fixture_image", json!({})).await;
    assert_eq!(image.images.len(), 1);
    assert!(!image.content.contains("iVBOR"));
    let mut no_vision = ToolCtx::new(CancellationToken::new(), None);
    no_vision.vision = false;
    let omitted = registry
        .get("mcp_fixture_image")
        .unwrap()
        .call(no_vision, json!({}))
        .await;
    assert!(omitted.images.is_empty());
    assert!(omitted.content.contains("does not accept images"));
    assert!(
        call(&registry, "mcp_fixture_failure", json!({}))
            .await
            .is_error
    );
    let large = call(&registry, "mcp_fixture_large", json!({})).await;
    assert!(large.content.len() < 70_000);
    let path = large.content.split("Full result: ").nth(1).unwrap();
    assert!(std::fs::read_to_string(path).unwrap().contains("THE_END"));
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let list = manager
        .resources(Some("fixture"), false, None)
        .await
        .unwrap();
    assert_eq!(list["servers"][0]["result"]["nextCursor"], "second");
    let page = manager
        .resources(Some("fixture"), false, Some("second".into()))
        .await
        .unwrap();
    assert_eq!(
        page["servers"][0]["result"]["resources"][0]["uri"],
        "fixture://second"
    );
    assert!(
        manager
            .resources(None, true, None)
            .await
            .unwrap()
            .to_string()
            .contains("uriTemplate")
    );
    assert!(
        manager
            .read_resource("fixture", "fixture://first")
            .await
            .unwrap()
            .to_string()
            .contains("resource fixture")
    );
    assert_eq!(
        std::fs::metadata(dir.path().join("mcp.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    manager.shutdown().await;
    let restarted = Manager::open(dir.path()).unwrap();
    assert_eq!(restarted.list().servers.len(), 1);
    restarted.start();
    ready(&restarted).await;
    restarted.shutdown().await;
}

async fn wait_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancellation_is_sent_to_the_peer_and_a_later_call_still_works() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    let mut cfg = config("cancel");
    let called = dir.path().join("called");
    let cancelled = dir.path().join("cancelled");
    cfg.env
        .insert("CALL_LOG".into(), called.display().to_string());
    cfg.env
        .insert("CANCEL_LOG".into(), cancelled.display().to_string());
    manager.set(vec![cfg]).await.unwrap();
    ready(&manager).await;
    let registry = manager.registry(&ToolRegistry::new());
    let cancel = CancellationToken::new();
    let ctx = ToolCtx::new(cancel.clone(), None);
    let tool = registry.get("mcp_cancel_slow").unwrap();
    let task = tokio::spawn(tool.call(ctx, json!({})));
    wait_file(&called).await;
    cancel.cancel();
    assert!(task.await.unwrap().is_error);
    wait_file(&cancelled).await;
    assert!(!call(&registry, "mcp_cancel_echo", json!({})).await.is_error);
    manager.shutdown().await;
}

#[tokio::test]
async fn config_changes_do_not_revive_old_connections_or_interrupt_other_servers() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    let mut a = config("a");
    let b = config("b");
    a.env.insert("INIT_DELAY".into(), "0.2".into());
    manager.set(vec![a.clone(), b.clone()]).await.unwrap();
    manager.set(vec![b.clone()]).await.unwrap();
    ready(&manager).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(manager.list().servers.len(), 1);
    let before = manager.registry(&ToolRegistry::new());
    let pid = call(&before, "mcp_b_echo", json!({})).await.content;
    a.env.remove("INIT_DELAY");
    manager.set(vec![a, b]).await.unwrap();
    ready(&manager).await;
    assert_eq!(
        call(
            &manager.registry(&ToolRegistry::new()),
            "mcp_b_echo",
            json!({})
        )
        .await
        .content,
        pid
    );
    manager.set(vec![]).await.unwrap();
    assert!(
        call(&before, "list_mcp_resources", json!({"server":"b"}))
            .await
            .content
            .contains("fixture://first")
    );
    assert!(
        !call(&before, "mcp_b_echo", json!({})).await.is_error,
        "a live turn retains its own connection"
    );
    manager.shutdown().await;
    assert!(call(&before, "mcp_b_echo", json!({})).await.is_error);
    manager.start();
    assert!(manager.list().servers.is_empty());
}

#[tokio::test]
async fn a_server_that_exits_is_reported_down_and_reconnect_restores_it() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    manager.set(vec![config("exit")]).await.unwrap();
    ready(&manager).await;
    let mut changes = manager.subscribe();
    let registry = manager.registry(&ToolRegistry::new());
    assert!(call(&registry, "mcp_exit_exit", json!({})).await.is_error);
    tokio::time::timeout(Duration::from_secs(3), async {
        while manager.list().servers[0].error.is_none() {
            changes.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(!manager.list().servers[0].connected);
    assert!(
        manager.list().servers[0]
            .diagnostics
            .as_ref()
            .unwrap()
            .contains("fixture exiting")
    );
    manager.reconnect("exit").await.unwrap();
    assert!(manager.list().servers[0].connected);
    manager.shutdown().await;
}

#[tokio::test]
async fn imported_configs_merge_and_keep_ids_and_a_bad_file_is_not_silently_erased() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    manager
        .import(r#"{"mcpServers":{"alpha":{"command":"unused","enabled":false}}}"#)
        .await
        .unwrap();
    let id = manager.list().servers[0].config.id.clone();
    manager
        .import(r#"{"servers":{"alpha":{"command":"updated","enabled":false}}}"#)
        .await
        .unwrap();
    assert_eq!(manager.list().servers[0].config.id, id);
    let (a, b) = tokio::join!(
        manager.import(r#"{"one":{"command":"unused","enabled":false}}"#),
        manager.import(r#"{"two":{"command":"unused","enabled":false}}"#)
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(manager.list().servers.len(), 3);
    assert!(
        manager
            .import(r#"{"old":{"type":"sse","url":"https://example.com"}}"#)
            .await
            .is_err()
    );
    assert_eq!(manager.list().servers.len(), 3);
    manager.shutdown().await;
    std::fs::write(dir.path().join("mcp.json"), "bad json").unwrap();
    assert!(Manager::open(dir.path()).is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("mcp.json")).unwrap(),
        "bad json"
    );
}

fn image_paths(content: &str) -> Vec<std::path::PathBuf> {
    let value: Value = serde_json::from_str(content).unwrap();
    value["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|part| {
            part["data"]
                .as_str()?
                .strip_prefix("[image saved: ")?
                .split_once(';')
                .map(|(path, _)| path.into())
        })
        .collect()
}

#[tokio::test]
async fn images_skipped_by_model_or_attachment_budget_remain_available_as_private_files() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    manager.set(vec![config("images")]).await.unwrap();
    ready(&manager).await;
    let registry = manager.registry(&ToolRegistry::new());
    let mut no_vision = ToolCtx::new(CancellationToken::new(), None);
    no_vision.vision = false;
    let output = registry
        .get("mcp_images_image")
        .unwrap()
        .call(no_vision, json!({}))
        .await;
    assert!(!output.is_error, "{}", output.content);
    let paths = image_paths(&output.content);
    assert_eq!(paths.len(), 1);
    assert!(
        std::fs::read(&paths[0])
            .unwrap()
            .starts_with(b"\x89PNG\r\n")
    );
    assert_eq!(
        std::fs::metadata(&paths[0]).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let many = call(&registry, "mcp_images_image", json!({"text":"many-images"})).await;
    assert_eq!(many.images.len(), 8);
    assert_eq!(image_paths(&many.content).len(), 2);
    for path in image_paths(&many.content) {
        assert_eq!(
            std::fs::read(path).unwrap(),
            std::fs::read(&paths[0]).unwrap()
        );
    }
    let large = call(&registry, "mcp_images_image", json!({"text":"large-image"})).await;
    assert!(!large.is_error, "{}", large.content);
    assert!(large.images.is_empty());
    let saved = image_paths(&large.content);
    assert_eq!(saved.len(), 1);
    assert_eq!(
        std::fs::read(&saved[0]).unwrap(),
        vec![b'x'; 9 * 1024 * 1024]
    );
    assert!(large.content.len() < 1024);
    manager.shutdown().await;
    assert!(paths[0].exists(), "artifacts outlive the connection");
}

#[tokio::test]
async fn image_persistence_failure_is_an_explicit_tool_error() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("mcp-results"), "not a directory").unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    manager.set(vec![config("images")]).await.unwrap();
    ready(&manager).await;
    let registry = manager.registry(&ToolRegistry::new());
    let mut ctx = ToolCtx::new(CancellationToken::new(), None);
    ctx.vision = false;
    let result = registry
        .get("mcp_images_image")
        .unwrap()
        .call(ctx, json!({}))
        .await;
    assert!(result.is_error);
    assert!(result.content.contains("could not preserve image"));
    manager.shutdown().await;
}

#[tokio::test]
async fn tool_notifications_refresh_future_catalogs_without_mutating_live_turn_schemas() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    let path = dir.path().join("catalog.json");
    let mut cfg = config("catalog");
    cfg.env
        .insert("CATALOG_FILE".into(), path.display().to_string());
    manager.set(vec![cfg]).await.unwrap();
    ready(&manager).await;
    let original = manager.registry(&ToolRegistry::new());
    std::fs::write(&path, r#"[{"name":"echo","description":"new schema","inputSchema":{"type":"object","properties":{"version":{"type":"integer"}}}},"new"]"#).unwrap();
    let mut changes = manager.subscribe();
    assert!(
        !call(
            &original,
            "mcp_catalog_echo",
            json!({"text":"refresh-tools"})
        )
        .await
        .is_error
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        while !manager.list().servers[0].tools.iter().any(|n| n == "new") {
            changes.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let updated = manager.registry(&ToolRegistry::new());
    assert!(original.get("mcp_catalog_new").is_none());
    assert!(updated.get("mcp_catalog_new").is_some());
    assert!(
        original.get("mcp_catalog_echo").unwrap().spec().schema["properties"]
            .get("version")
            .is_none()
    );
    assert!(
        updated.get("mcp_catalog_echo").unwrap().spec().schema["properties"]
            .get("version")
            .is_some()
    );
    // Invalid updates preserve the last valid catalog and expose an error.
    std::fs::write(&path, r#"["echo","echo"]"#).unwrap();
    call(
        &original,
        "mcp_catalog_echo",
        json!({"text":"refresh-tools"}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while manager.list().servers[0].error.is_none() {
            changes.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(manager.list().servers[0].connected);
    assert!(
        manager
            .registry(&ToolRegistry::new())
            .get("mcp_catalog_new")
            .is_some()
    );
    assert!(
        manager.list().servers[0]
            .error
            .as_ref()
            .unwrap()
            .contains("冲突")
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn stderr_is_drained_bounded_redacted_and_available_even_when_startup_fails() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    let mut cfg = config("diagnostics");
    cfg.env.insert("DIAGNOSTIC_BURST".into(), "yes".into());
    cfg.env.insert(
        "FIXTURE_CREDENTIAL".into(),
        "very-private-fixture-key".into(),
    );
    manager.set(vec![cfg.clone()]).await.unwrap();
    ready(&manager).await;
    let diagnostics = manager.list().servers[0].diagnostics.clone().unwrap();
    assert!(diagnostics.len() <= 33 * 1024);
    assert!(diagnostics.contains("TAIL_MARKER"));
    assert!(diagnostics.contains("[redacted]"));
    assert!(!diagnostics.contains("very-private-fixture-key"));
    cfg.env.insert("FAIL_INIT".into(), "yes".into());
    manager.set(vec![cfg]).await.unwrap();
    manager.wait_ready(Duration::from_secs(12)).await;
    let status = manager.list().servers.remove(0);
    assert!(!status.connected);
    assert!(status.error.is_some());
    assert!(
        status
            .diagnostics
            .unwrap()
            .contains("fixture cannot initialize")
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn individual_edits_preserve_other_servers_and_reject_stale_writes() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(dir.path()).unwrap();
    let mut a = config("a");
    a.enabled = false;
    let mut b = config("b");
    b.enabled = false;
    let create = |config: McpServerConfig| McpUpdateParams {
        server_id: config.id.clone(),
        expected: None,
        config: Some(config),
    };
    let (one, two) = tokio::join!(
        manager.update(create(a.clone())),
        manager.update(create(b.clone()))
    );
    one.unwrap();
    two.unwrap();
    assert_eq!(manager.list().servers.len(), 2);
    let mut renamed = a.clone();
    renamed.name = "renamed".into();
    manager
        .update(McpUpdateParams {
            server_id: a.id.clone(),
            expected: Some(a.clone()),
            config: Some(renamed.clone()),
        })
        .await
        .unwrap();
    let conflict = manager
        .update(McpUpdateParams {
            server_id: a.id.clone(),
            expected: Some(a),
            config: None,
        })
        .await
        .unwrap_err();
    assert!(conflict.contains("其它位置修改"));
    assert_eq!(manager.list().servers.len(), 2);
    assert!(manager.list().servers.iter().any(|s| s.config == renamed));
    assert!(
        manager.update(create(b.clone())).await.is_err(),
        "create cannot overwrite an existing id"
    );
    manager
        .update(McpUpdateParams {
            server_id: b.id.clone(),
            expected: Some(b),
            config: None,
        })
        .await
        .unwrap();
    assert_eq!(manager.list().servers.len(), 1);
    manager.shutdown().await;
    assert_eq!(
        Manager::open(dir.path()).unwrap().list().servers[0].config,
        renamed
    );
}
