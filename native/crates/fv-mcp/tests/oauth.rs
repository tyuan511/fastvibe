//! OAuth is exercised against a real local AS and protected MCP HTTP peer, including PKCE,
//! callback ownership, restart, confidential client secrets, refresh rotation and revocation.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use fv_agent::{ToolCtx, ToolRegistry};
use fv_mcp::Manager;
use fv_protocol::types::*;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

struct Fixture {
    origin: String,
    directory: tempfile::TempDir,
    _child: tokio::process::Child,
    browser: reqwest::Client,
}

impl Fixture {
    async fn start() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut child = tokio::process::Command::new("python3")
            .arg(format!(
                "{}/tests/fixtures/oauth.py",
                env!("CARGO_MANIFEST_DIR")
            ))
            .arg(directory.path())
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let origin = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let browser = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        Self {
            origin,
            directory,
            _child: child,
            browser,
        }
    }

    fn config(&self) -> McpServerConfig {
        McpServerConfig {
            id: "auth".into(),
            name: "auth".into(),
            transport: McpTransport::Http,
            enabled: true,
            command: None,
            args: vec![],
            env: Default::default(),
            url: Some(format!("{}/mcp", self.origin)),
            headers: Default::default(),
            deferred: false,
        }
    }

    async fn login(&self, manager: &Arc<Manager>, owner: u64) -> (String, String) {
        let begin = manager
            .auth_begin(
                owner,
                McpAuthBeginParams {
                    server_id: "auth".into(),
                    redirect_uri: "http://127.0.0.1:8765/mcp/callback".into(),
                    client_id: None,
                    client_secret: None,
                    scopes: vec![],
                },
            )
            .await
            .unwrap();
        let response = self
            .browser
            .get(&begin.authorization_url)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 302);
        (
            begin.flow_id,
            response.headers()["location"].to_str().unwrap().into(),
        )
    }

    fn requests(&self) -> Vec<Value> {
        std::fs::read_to_string(self.directory.path().join("requests.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn flag(&self, name: &str) {
        std::fs::write(self.directory.path().join(name), "yes").unwrap();
    }
}

fn manager(path: &Path) -> Arc<Manager> {
    Manager::open_with_http_client_builder(path, Arc::new(|| reqwest::Client::builder().no_proxy()))
        .unwrap()
}

async fn ready(manager: &Arc<Manager>) {
    manager.wait_ready(Duration::from_secs(12)).await;
    assert!(manager.list().servers[0].connected, "{:?}", manager.list());
}

fn credentials(path: &Path) -> PathBuf {
    std::fs::read_dir(path.join("mcp-oauth"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .unwrap()
}

fn expire(path: &Path) {
    let mut value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    value["credentials"]["token_received_at"] = json!(0);
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

async fn tool(registry: &ToolRegistry) -> fv_agent::ToolOutput {
    registry
        .get("mcp_auth_echo")
        .unwrap()
        .call(ToolCtx::new(CancellationToken::new(), None), json!({}))
        .await
}

#[tokio::test]
async fn pkce_credentials_refresh_and_confidential_client_identity_survive_restart() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::start().await;
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    let config = fixture.config();
    manager.set(vec![config.clone()]).await.unwrap();
    let (flow_id, callback_url) = fixture.login(&manager, 1).await;
    manager
        .auth_complete(
            1,
            McpAuthCompleteParams {
                flow_id,
                callback_url,
            },
        )
        .await
        .unwrap();
    ready(&manager).await;
    let registry = manager.registry(&ToolRegistry::new());
    assert!(!tool(&registry).await.is_error);
    let path = credentials(dir.path());
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let public = serde_json::to_string(&manager.list()).unwrap();
    assert!(!public.contains("access-1") && !public.contains("fixture-client-secret"));
    assert!(
        !std::fs::read_to_string(dir.path().join("mcp.json"))
            .unwrap()
            .contains("access-1")
    );
    expire(&path);
    assert!(!tool(&registry).await.is_error);
    let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        value["credentials"]["token_response"]["access_token"],
        "access-2"
    );
    assert_eq!(
        value["credentials"]["token_response"]["refresh_token"],
        "refresh-2"
    );
    manager.shutdown().await;
    expire(&path);
    let restarted = crate::manager(dir.path());
    restarted.start();
    ready(&restarted).await;
    assert!(
        !tool(&restarted.registry(&ToolRegistry::new()))
            .await
            .is_error
    );
    // Explicit manual credentials take precedence over a saved OAuth login.
    expire(&path);
    fixture.flag("reject-refresh");
    let mut manual = config.clone();
    manual
        .headers
        .insert("Authorization".into(), "Bearer access-3".into());
    restarted.set(vec![manual]).await.unwrap();
    ready(&restarted).await;
    assert!(
        !tool(&restarted.registry(&ToolRegistry::new()))
            .await
            .is_error
    );
    let grants: Vec<_> = fixture
        .requests()
        .into_iter()
        .filter(|value| value["method"] == "token")
        .collect();
    assert_eq!(grants.len(), 3);
    assert!(grants.iter().all(|value| value["client_secret_ok"] == true));
    assert!(
        grants
            .iter()
            .all(|value| value["resource"] == format!("{}/mcp", fixture.origin))
    );
    let mut changed = config;
    changed.url = Some(format!("{}/other-mcp", fixture.origin));
    restarted.set(vec![changed]).await.unwrap();
    restarted.wait_ready(Duration::from_secs(12)).await;
    assert!(!restarted.list().servers[0].connected);
    assert!(
        !path.exists(),
        "removing a credential binding removes its private file"
    );
    let other: Vec<_> = fixture
        .requests()
        .into_iter()
        .filter(|value| value["path"] == "/other-mcp")
        .collect();
    assert!(!other.is_empty());
    assert!(other.iter().all(|value| value["token"] == ""));
    restarted.shutdown().await;
}

#[tokio::test]
async fn callbacks_check_owner_redirect_state_and_issuer_without_consuming_a_valid_flow() {
    let fixture = Fixture::start().await;
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    manager.set(vec![fixture.config()]).await.unwrap();
    let (flow_id, callback_url) = fixture.login(&manager, 42).await;
    assert!(
        manager
            .auth_complete(
                43,
                McpAuthCompleteParams {
                    flow_id: flow_id.clone(),
                    callback_url: callback_url.clone()
                }
            )
            .await
            .is_err()
    );
    for invalid in [
        callback_url.replace(":8765", ":8766"),
        callback_url.replace("state=", "state=forged"),
        callback_url.replace("iss=", "iss=forged"),
        format!("{callback_url}&code=duplicate"),
    ] {
        assert!(
            manager
                .auth_complete(
                    42,
                    McpAuthCompleteParams {
                        flow_id: flow_id.clone(),
                        callback_url: invalid
                    }
                )
                .await
                .is_err()
        );
    }
    manager
        .auth_complete(
            42,
            McpAuthCompleteParams {
                flow_id: flow_id.clone(),
                callback_url: callback_url.clone(),
            },
        )
        .await
        .unwrap();
    assert!(
        manager
            .auth_complete(
                42,
                McpAuthCompleteParams {
                    flow_id,
                    callback_url
                }
            )
            .await
            .is_err()
    );
    let requests = fixture.requests();
    assert_eq!(
        requests
            .iter()
            .filter(|value| value["grant"] == "authorization_code")
            .count(),
        1
    );
    let (flow_id, callback_url) = fixture.login(&manager, 42).await;
    assert!(manager.auth_cancel(43, &flow_id).is_err());
    manager.auth_cancel(42, &flow_id).unwrap();
    assert!(
        manager
            .auth_complete(
                42,
                McpAuthCompleteParams {
                    flow_id,
                    callback_url
                }
            )
            .await
            .is_err()
    );
    let (flow_id, callback_url) = fixture.login(&manager, 42).await;
    manager.auth_disconnected(42);
    assert!(
        manager
            .auth_complete(
                42,
                McpAuthCompleteParams {
                    flow_id,
                    callback_url
                }
            )
            .await
            .is_err()
    );
    assert_eq!(
        fixture
            .requests()
            .iter()
            .filter(|value| value["grant"] == "authorization_code")
            .count(),
        1
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn transient_refresh_errors_keep_credentials_and_rejected_refresh_requires_login() {
    let fixture = Fixture::start().await;
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    manager.set(vec![fixture.config()]).await.unwrap();
    let (flow_id, callback_url) = fixture.login(&manager, 1).await;
    manager
        .auth_complete(
            1,
            McpAuthCompleteParams {
                flow_id,
                callback_url,
            },
        )
        .await
        .unwrap();
    ready(&manager).await;
    let registry = manager.registry(&ToolRegistry::new());
    let path = credentials(dir.path());
    expire(&path);
    fixture.flag("fail-refresh");
    assert!(tool(&registry).await.is_error);
    assert!(path.exists());
    std::fs::remove_file(fixture.directory.path().join("fail-refresh")).unwrap();
    assert!(!tool(&registry).await.is_error);
    expire(&path);
    fixture.flag("reject-refresh");
    assert!(tool(&registry).await.is_error);
    assert!(!path.exists());
    manager.shutdown().await;
}

#[tokio::test]
async fn logout_during_refresh_cannot_resurrect_tokens_and_stale_authorizations_cannot_commit() {
    let fixture = Fixture::start().await;
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    let config = fixture.config();
    manager.set(vec![config.clone()]).await.unwrap();
    let (flow_id, callback_url) = fixture.login(&manager, 1).await;
    manager
        .auth_complete(
            1,
            McpAuthCompleteParams {
                flow_id,
                callback_url,
            },
        )
        .await
        .unwrap();
    ready(&manager).await;
    let registry = manager.registry(&ToolRegistry::new());
    let path = credentials(dir.path());
    expire(&path);
    fixture.flag("refresh-delay");
    let call = tokio::spawn(async move { tool(&registry).await });
    tokio::time::timeout(Duration::from_secs(10), async {
        while !fixture.directory.path().join("refresh-started").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    manager.auth_forget("auth").await.unwrap();
    assert!(call.await.unwrap().is_error);
    assert!(!path.exists());
    let (flow_id, callback_url) = fixture.login(&manager, 1).await;
    let mut renamed = config;
    renamed.name = "changed while authorizing".into();
    manager.set(vec![renamed]).await.unwrap();
    assert!(
        manager
            .auth_complete(
                1,
                McpAuthCompleteParams {
                    flow_id,
                    callback_url
                }
            )
            .await
            .is_err()
    );
    assert!(!path.exists());
    manager.shutdown().await;
}

#[tokio::test]
async fn canceling_an_exchange_in_flight_cannot_replace_the_existing_login() {
    let fixture = Fixture::start().await;
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path());
    manager.set(vec![fixture.config()]).await.unwrap();
    let (flow_id, callback_url) = fixture.login(&manager, 1).await;
    manager
        .auth_complete(
            1,
            McpAuthCompleteParams {
                flow_id,
                callback_url,
            },
        )
        .await
        .unwrap();
    ready(&manager).await;
    let path = credentials(dir.path());
    let before = std::fs::read(&path).unwrap();
    fixture.flag("token-delay");
    for disconnect in [false, true] {
        let (flow_id, callback_url) = fixture.login(&manager, 2).await;
        let worker = manager.clone();
        let exchange = flow_id.clone();
        let pending = tokio::spawn(async move {
            worker
                .auth_complete(
                    2,
                    McpAuthCompleteParams {
                        flow_id: exchange,
                        callback_url,
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(10), async {
            while !fixture.directory.path().join("token-started").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if disconnect {
            manager.auth_disconnected(2);
        } else {
            manager.auth_cancel(2, &flow_id).unwrap();
        }
        assert!(pending.await.unwrap().unwrap_err().contains("取消"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!tool(&manager.registry(&ToolRegistry::new())).await.is_error);
        std::fs::remove_file(fixture.directory.path().join("token-started")).unwrap();
    }
    manager.shutdown().await;
}
