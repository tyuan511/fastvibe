//! Public refresh updates metadata and both cost views, and leaves control requests flowing.
mod common;
use fv_agent::testing::{Reply as AgentReply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::usage::{UsageParams, UsageRange};
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
type Notes = tokio::sync::mpsc::UnboundedReceiver<ServerNotification>;

async fn connect(path: &Path) -> (Client, Notes) {
    let (c, notes) = Client::connect_unix(path).await.unwrap();
    let init = c
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "catalog-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(init.features.iter().any(|f| f == "modelCatalogRefresh"));
    (c, notes)
}
fn injected(dir: &Path, url: String, model: Arc<ScriptedModel>) -> Arc<ServerState> {
    let mut state =
        ServerState::new(dir.into(), fv_server::agent_with_builtin_tools(model)).unwrap();
    state.catalog = fv_provider::CatalogService::with_source(
        dir.into(),
        url,
        Some(reqwest::Client::builder().no_proxy().build().unwrap()),
    );
    let state = Arc::new(state);
    common::disable_reply_suggestions(&state);
    state
}
async fn idle(notes: &mut Notes) -> Vec<ServerNotification> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut result = Vec::new();
        loop {
            let n = notes.recv().await.unwrap();
            let idle = matches!(&n, ServerNotification::ThreadStatusChanged(e) if !e.body.running);
            result.push(n);
            if idle {
                return result;
            }
        }
    })
    .await
    .unwrap()
}
fn catalog() -> String {
    serde_json::json!({"vendor":{"models":{"m1":{"id":"m1", "name":"M1",
        "limit":{"context":64000,"output":4000},"modalities":{"input":["text","image"]},
        "cost":{"input":4,"output":10}}}}})
    .to_string()
}
const TURN: &str = "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m1\",\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\ndata: [DONE]\n\n";
#[tokio::test]
async fn refresh_updates_model_requests_session_prices_usage_and_restart_without_duplicate_changes()
{
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("models-dev.json"),
        serde_json::json!({"v":5,"t":1,"s":"fixture",
        "m":[["m1","M1",128000,8000,1,null,[2,10,0,0]]],"x":{"m1":0}})
        .to_string(),
    )
    .unwrap();
    let source = common::serve(vec![
        common::Reply::status(200, &catalog()),
        common::Reply::status(200, &catalog()),
        common::Reply::status(200, "{}"),
    ])
    .await;
    let model_http = common::serve(vec![common::Reply::sse(TURN), common::Reply::sse(TURN)]).await;
    let state = injected(
        dir.path(),
        source.url.clone(),
        Arc::new(ScriptedModel::new([])),
    );
    let socket = dir.path().join("c.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (a, mut notes) = connect(&socket).await;
    let (b, mut observer) = connect(&socket).await;
    let provider = a
        .call::<ProviderUpsert>(ProviderUpsertParams {
            expected: None,
            id: None,
            name: "relay".into(),
            protocol: ApiProtocol::Chat,
            base_url: format!("{}/v1", model_http.url),
            api_key: Some("private-key".into()),
            enabled: true,
            models: vec![ModelInfo {
                id: "m1".into(),
                name: None,
                protocol: None,
                supports_images: false,
                context_window: None,
                max_output_tokens: None,
                ..Default::default()
            }],
        })
        .await
        .unwrap()
        .provider;
    let label = format!("{}/m1", provider.id);
    let thread = a
        .call::<ThreadStart>(ThreadStartParams {
            model: Some(label),
            ..Default::default()
        })
        .await
        .unwrap()
        .thread;
    a.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id.clone(),
        text: "first".into(),
    })
    .await
    .unwrap();
    idle(&mut notes).await;
    let before = a
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.id.clone(),
        })
        .await
        .unwrap();
    assert!((before.stats.cost.unwrap() - 0.00003).abs() < 1e-12);
    assert_eq!(max_tokens(&model_http, 0), 8000);
    while observer.try_recv().is_ok() {}
    let result = a.call::<ModelCatalogRefresh>(Empty {}).await.unwrap();
    assert!(result.changed);
    assert_eq!(result.catalog.models, 1);
    assert!(!result.catalog.bundled);
    assert_eq!(
        b.call::<ModelCatalogGet>(Empty {}).await.unwrap(),
        result.catalog
    );
    let models = b.call::<ModelList>(Empty {}).await.unwrap();
    assert_eq!(models.models[0].model.context_window, Some(64000));
    assert!(models.models[0].model.supports_images);
    let after = a
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.id.clone(),
        })
        .await
        .unwrap();
    assert!((after.stats.cost.unwrap() - 0.00004).abs() < 1e-12);
    let usage = b
        .call::<StatsUsage>(UsageParams {
            range: UsageRange::All,
            timezone: "UTC".into(),
        })
        .await
        .unwrap();
    assert!((usage.totals.metrics.cost.unwrap() - 0.00004).abs() < 1e-12);
    let mut changed = false;
    while let Ok(n) = observer.try_recv() {
        if let ServerNotification::ModelCatalogChanged(p) = n {
            assert_eq!(serde_json::to_value(p).unwrap(), serde_json::json!({}));
            changed = true;
        }
    }
    assert!(
        changed,
        "other clients receive dataless catalog invalidation"
    );
    a.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id.clone(),
        text: "second".into(),
    })
    .await
    .unwrap();
    idle(&mut notes).await;
    assert_eq!(max_tokens(&model_http, 1), 4000);
    while observer.try_recv().is_ok() {}
    let same = a.call::<ModelCatalogRefresh>(Empty {}).await.unwrap();
    assert!(!same.changed);
    let _ = b.call::<ModelCatalogGet>(Empty {}).await.unwrap();
    while let Ok(n) = observer.try_recv() {
        assert!(
            !matches!(
                n,
                ServerNotification::ProvidersChanged(_) | ServerNotification::UsageChanged(_)
            ),
            "an unchanged download must not rebind models or reprice sessions"
        );
    }
    let bytes = std::fs::read(dir.path().join("models-dev.json")).unwrap();
    assert!(a.call::<ModelCatalogRefresh>(Empty {}).await.is_err());
    assert_eq!(
        bytes,
        std::fs::read(dir.path().join("models-dev.json")).unwrap()
    );
    let restarted = ServerState::new(
        dir.path().into(),
        fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([]))),
    )
    .unwrap();
    let loaded = restarted.catalog.snapshot();
    assert_eq!(loaded.stats().models, 1);
    assert_eq!(loaded.price("m1").unwrap().0.input, 4.0);
    assert_eq!(source.captured.lock().unwrap().len(), 3);
    for origin in [ClientOrigin::Lan, ClientOrigin::Official] {
        assert!(fv_server::allows(
            origin,
            &fv_protocol::ClientRequest::ModelCatalogRefresh {
                id: fv_protocol::RequestId::Number(1),
                params: Empty {}
            }
        ));
        assert!(fv_server::allows(
            origin,
            &fv_protocol::ClientRequest::ModelCatalogGet {
                id: fv_protocol::RequestId::Number(2),
                params: Empty {}
            }
        ));
    }
    server.abort();
}

#[tokio::test]
async fn pending_refresh_does_not_block_control_and_disconnecting_waiter_still_notifies_clients() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (started_tx, started) = tokio::sync::oneshot::channel();
    let (release, gate) = tokio::sync::oneshot::channel();
    let http = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0);
        started_tx.send(()).unwrap();
        gate.await.unwrap();
        let body = catalog();
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(ScriptedModel::new([AgentReply::new()
        .text("alive")
        .then_hang()]));
    let state = injected(
        dir.path(),
        format!("http://{addr}/api.json"),
        script.clone(),
    );
    let socket = dir.path().join("pending.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (a, mut notes) = connect(&socket).await;
    let (_observer_client, mut observer) = connect(&socket).await;
    let thread = a
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread;
    a.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id.clone(),
        text: "hold reply".into(),
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while script.requests().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let a = Arc::new(a);
    let waiter = {
        let a = a.clone();
        tokio::spawn(async move { a.call::<ModelCatalogRefresh>(Empty {}).await })
    };
    tokio::time::timeout(Duration::from_secs(5), started)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), a.call::<SettingsGet>(Empty {}))
        .await
        .unwrap()
        .unwrap();
    assert!(
        state.runtime(&thread.id).is_running(),
        "refresh leaves the active reply running"
    );
    tokio::time::timeout(
        Duration::from_secs(2),
        a.call::<TurnInterrupt>(ThreadIdParams {
            thread_id: thread.id.clone(),
        }),
    )
    .await
    .unwrap()
    .unwrap();
    idle(&mut notes).await;
    waiter.abort();
    let _ = waiter.await;
    drop(a);
    release.send(()).unwrap();
    http.await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(
                observer.recv().await,
                Some(ServerNotification::ModelCatalogChanged(_))
            ) {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(state.catalog.snapshot().price("m1").unwrap().0.input, 4.0);
    assert!(dir.path().join("models-dev.json").is_file());
    server.abort();
}

fn max_tokens(mock: &common::Mock, index: usize) -> u64 {
    let captured = mock.captured.lock().unwrap();
    captured[index].body["max_tokens"]
        .as_u64()
        .or_else(|| captured[index].body["max_completion_tokens"].as_u64())
        .unwrap()
}

#[tokio::test]
async fn stale_catalog_is_refreshed_after_startup_once_for_all_connections() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("models-dev.json"),
        serde_json::json!({"v":5,"t":1,
        "m":[["m1","M1",128000,8000,1,null,[2,10,0,0]]],"x":{"m1":0}})
        .to_string(),
    )
    .unwrap();
    let source = common::serve(vec![common::Reply::status(200, &catalog())]).await;
    let state = injected(
        dir.path(),
        source.url.clone(),
        Arc::new(ScriptedModel::new([])),
    );
    let socket = dir.path().join("timer.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (first, mut notes) = connect(&socket).await;
    let (_second, _other_notes) = connect(&socket).await;
    assert_eq!(
        first
            .call::<ModelCatalogGet>(Empty {})
            .await
            .unwrap()
            .generated_at,
        1
    );
    // Real production startup delay and HTTP I/O; this test never invokes the refresh RPC.
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            if matches!(
                notes.recv().await,
                Some(ServerNotification::ModelCatalogChanged(_))
            ) {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(source.captured.lock().unwrap().len(), 1);
    let info = first.call::<ModelCatalogGet>(Empty {}).await.unwrap();
    assert!(info.generated_at > 1);
    assert_eq!(info.models, 1);
    assert_eq!(state.catalog.snapshot().price("m1").unwrap().0.input, 4.0);
    server.abort();
}
