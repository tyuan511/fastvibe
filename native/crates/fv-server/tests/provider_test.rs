//! Real RPC/HTTP diagnostics, including no history/tools side effects, stale configuration,
//! same-connection controls, process-wide concurrency and disconnect cancellation.
mod common;
use fv_agent::testing::{Reply as AgentReply, ScriptedModel};
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::provider_test::*;
use fv_protocol::types::*;
use fv_protocol::usage::{UsageParams, UsageRange};
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
type Notes = tokio::sync::mpsc::UnboundedReceiver<ServerNotification>;
const KEY: &str = "probe-private-key";
fn text() -> String {
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"id":"c","object":"chat.completion.chunk","created":1,"model":"m",
    "choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]})
    )
}
fn tool(name: &str, args: Value) -> String {
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"id":"c","object":"chat.completion.chunk","created":1,"model":"m",
    "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":name,"arguments":args.to_string()}}]},"finish_reason":"tool_calls"}]})
    )
}
fn init() -> InitializeParams {
    InitializeParams {
        client_info: ClientInfo {
            name: "provider-test".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    }
}
async fn connect(path: &Path) -> (Client, Notes, InitializeResponse) {
    let (c, n) = Client::connect_unix(path).await.unwrap();
    let info = c.call::<Initialize>(init()).await.unwrap();
    assert!(info.features.iter().any(|f| f == "providerModelTest"));
    (c, n, info)
}
async fn server(
    dir: &Path,
    model: Arc<ScriptedModel>,
) -> (
    Arc<ServerState>,
    std::path::PathBuf,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let state =
        Arc::new(ServerState::new(dir.into(), fv_server::agent_with_builtin_tools(model)).unwrap());
    common::disable_reply_suggestions(&state);
    let path = dir.join("probe.sock");
    let run = tokio::spawn(UnixServer::bind(state.clone(), &path).await.unwrap().run());
    (state, path, run)
}
fn provider(url: &str, key: Option<&str>) -> ProviderUpsertParams {
    ProviderUpsertParams {
        id: None,
        name: "relay".into(),
        protocol: ApiProtocol::Chat,
        base_url: format!("{url}/v1"),
        api_key: key.map(str::to_owned),
        enabled: true,
        models: vec![ModelInfo {
            id: "m".into(),
            ..Default::default()
        }],
        expected: None,
    }
}
fn check(id: &str) -> ProviderTestParams {
    ProviderTestParams {
        provider_id: id.into(),
        model_id: "m".into(),
    }
}
#[tokio::test]
async fn results_are_private_and_diagnostics_create_neither_history_usage_nor_tool_side_effects() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(ScriptedModel::new([]));
    let (state, path, run) = server(dir.path(), script.clone()).await;
    let (c, _, _) = connect(&path).await;
    let (observer, mut notes, _) = connect(&path).await;
    let sentinel = dir.path().join("must-not-exist");
    let mock = common::serve(vec![
        common::Reply::sse(&text()),
        common::Reply::sse(&tool("fastvibe_probe", json!({"value":"ok"}))),
        common::Reply::sse(&text()),
        common::Reply::sse(&tool(
            "exec_command",
            json!({"cmd":format!("touch {}",sentinel.display())}),
        )),
    ])
    .await;
    let p = c
        .call::<ProviderUpsert>(provider(&mock.url, Some(KEY)))
        .await
        .unwrap()
        .provider;
    c.call::<SettingsSet>(AppSettingsPatch {
        custom_system_prompt: Some("PRIVATE USER INSTRUCTIONS".into()),
        ..Default::default()
    })
    .await
    .unwrap();
    // Barrier: earlier configuration notices have been delivered before this read returns.
    observer.call::<SettingsGet>(Empty {}).await.unwrap();
    while notes.try_recv().is_ok() {}
    let before = state.store.db.get_provider(&p.id).unwrap();
    let result = c.call::<ProviderModelTest>(check(&p.id)).await.unwrap();
    assert_eq!(result.status, ProviderTestStatus::Passed);
    assert_eq!(result.tools, ProviderTestTools::Passed);
    assert!(result.first_token_ms.is_some());
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 7);
    assert!(!json.to_string().contains(KEY));
    let unexpected = c.call::<ProviderModelTest>(check(&p.id)).await.unwrap();
    assert_eq!(unexpected.status, ProviderTestStatus::Partial);
    assert_eq!(unexpected.tools, ProviderTestTools::Unconfirmed);
    assert!(!sentinel.exists());
    assert!(script.requests().is_empty());
    assert_eq!(state.store.db.get_provider(&p.id).unwrap(), before);
    assert!(
        c.call::<ThreadList>(ThreadListParams {
            include_archived: false
        })
        .await
        .unwrap()
        .threads
        .is_empty()
    );
    let usage = c
        .call::<StatsUsage>(UsageParams {
            range: UsageRange::All,
            timezone: "UTC".into(),
        })
        .await
        .unwrap();
    assert_eq!(usage.totals.metrics.requests, 0);
    assert!(state.store.db.usage_records().unwrap().is_empty());
    assert_eq!(
        std::fs::read_dir(dir.path().join("sessions"))
            .unwrap()
            .count(),
        0
    );
    while let Ok(note) = notes.try_recv() {
        assert!(!matches!(
            note,
            ServerNotification::ThreadStarted(_)
                | ServerNotification::UsageChanged(_)
                | ServerNotification::CatalogChanged(_)
        ));
    }
    let sent = mock.captured.lock().unwrap();
    assert_eq!(sent.len(), 4);
    assert!(
        sent.iter()
            .all(|r| !r.body.to_string().contains("PRIVATE USER INSTRUCTIONS"))
    );
    for origin in [ClientOrigin::Ssh, ClientOrigin::Lan, ClientOrigin::Official] {
        assert!(fv_server::allows(
            origin,
            &fv_protocol::ClientRequest::ProviderModelTest {
                id: fv_protocol::RequestId::Number(1),
                params: check(&p.id)
            }
        ));
    }
    run.abort();
}
#[tokio::test]
async fn absent_auth_and_models_do_not_call_network_and_upstream_secrets_never_return() {
    let dir = tempfile::tempdir().unwrap();
    let (_, path, run) = server(dir.path(), Arc::new(ScriptedModel::new([]))).await;
    let (c, _, _) = connect(&path).await;
    let mock = common::serve(vec![common::Reply::status(
        401,
        &format!("private body {KEY} Authorization Bearer"),
    )])
    .await;
    let p = c
        .call::<ProviderUpsert>(provider(&mock.url, None))
        .await
        .unwrap()
        .provider;
    let auth = c.call::<ProviderModelTest>(check(&p.id)).await.unwrap();
    assert_eq!(auth.error_code, Some(ProviderTestError::Auth));
    assert_eq!(auth.tools, ProviderTestTools::NotTested);
    let missing = c
        .call::<ProviderModelTest>(ProviderTestParams {
            model_id: "missing".into(),
            ..check(&p.id)
        })
        .await
        .unwrap();
    assert_eq!(missing.error_code, Some(ProviderTestError::Model));
    assert!(mock.captured.lock().unwrap().is_empty());
    let mut params = provider(&mock.url, Some(KEY));
    params.id = Some(p.id.clone());
    params.enabled = false;
    c.call::<ProviderUpsert>(params).await.unwrap();
    assert_eq!(
        c.call::<ProviderModelTest>(check(&p.id))
            .await
            .unwrap()
            .error_code,
        Some(ProviderTestError::Model)
    );
    assert!(mock.captured.lock().unwrap().is_empty());
    let mut params = provider(&mock.url, Some(KEY));
    params.id = Some(p.id.clone());
    c.call::<ProviderUpsert>(params).await.unwrap();
    let report = c.call::<ProviderModelTest>(check(&p.id)).await.unwrap();
    assert_eq!(report.error_code, Some(ProviderTestError::Auth));
    let shown = serde_json::to_string(&report).unwrap();
    for secret in [KEY, "private body", "Authorization", "Bearer"] {
        assert!(!shown.contains(secret));
    }
    assert_eq!(mock.captured.lock().unwrap().len(), 1);
    run.abort();
}
async fn read_request(stream: &mut tokio::net::TcpStream) -> Value {
    let mut data = Vec::new();
    let (head, len) = loop {
        let mut b = [0; 8192];
        let n = stream.read(&mut b).await.unwrap();
        assert!(n > 0);
        data.extend_from_slice(&b[..n]);
        if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&data[..pos]);
            let len = header
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            break (pos + 4, len);
        }
    };
    while data.len() < head + len {
        let mut b = [0; 8192];
        let n = stream.read(&mut b).await.unwrap();
        assert!(n > 0);
        data.extend_from_slice(&b[..n]);
    }
    serde_json::from_slice(&data[head..head + len]).unwrap()
}
async fn answer(stream: &mut tokio::net::TcpStream, body: &str) {
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
#[tokio::test]
async fn checks_do_not_block_stop_and_key_rotation_invalidates_an_in_flight_success() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(ScriptedModel::new([AgentReply::new()
        .text("running")
        .then_hang()]));
    let (state, path, run) = server(dir.path(), script.clone()).await;
    let (c, mut notes, _) = connect(&path).await;
    let thread = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id.clone(),
        text: "hold".into(),
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while script.requests().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (seen, ready) = tokio::sync::oneshot::channel();
    let (release, gate) = tokio::sync::oneshot::channel();
    let http = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        seen.send(()).unwrap();
        gate.await.unwrap();
        answer(&mut stream, &text()).await;
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        answer(&mut stream, &tool("fastvibe_probe", json!({"value":"ok"}))).await;
    });
    let p = c
        .call::<ProviderUpsert>(provider(&url, Some(KEY)))
        .await
        .unwrap()
        .provider;
    let c = Arc::new(c);
    let waiting = {
        let c = c.clone();
        let id = p.id.clone();
        tokio::spawn(async move { c.call::<ProviderModelTest>(check(&id)).await })
    };
    tokio::time::timeout(Duration::from_secs(3), ready)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), c.call::<SettingsGet>(Empty {}))
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        c.call::<TurnInterrupt>(ThreadIdParams {
            thread_id: thread.id.clone(),
        }),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5),async{loop{if matches!(notes.recv().await,Some(ServerNotification::ThreadStatusChanged(e)) if !e.body.running){break;}}}).await.unwrap();
    assert!(
        state.has_running_turns(),
        "a live diagnostic also keeps the daemon from restarting"
    );
    let (_, _, info) = connect(&path).await;
    assert_eq!(info.has_running_turns, Some(true));
    let mut changed = provider(&url, Some("new-private-key"));
    changed.id = Some(p.id.clone());
    c.call::<ProviderUpsert>(changed).await.unwrap();
    release.send(()).unwrap();
    http.await.unwrap();
    let result = waiting.await.unwrap().unwrap();
    assert_eq!(result.status, ProviderTestStatus::Failed);
    assert_eq!(result.error_code, Some(ProviderTestError::Model));
    assert!(!serde_json::to_string(&result).unwrap().contains("private"));
    assert!(!state.has_running_turns());
    run.abort();
}
async fn frame(write: &mut tokio::net::unix::OwnedWriteHalf, id: u64, method: &str, params: Value) {
    write
        .write_all(format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes())
        .await
        .unwrap();
}
async fn response(
    read: &mut tokio::io::BufReader<tokio::net::unix::OwnedReadHalf>,
    id: u64,
) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let mut line = String::new();
            assert!(read.read_line(&mut line).await.unwrap() > 0);
            let frame: Value = serde_json::from_str(&line).unwrap();
            if frame["id"] == id {
                return frame;
            }
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn four_checks_fill_the_global_limit_and_disconnect_frees_every_slot_and_socket() {
    let dir = tempfile::tempdir().unwrap();
    let (state, path, run) = server(dir.path(), Arc::new(ScriptedModel::new([]))).await;
    let (c, _, _) = connect(&path).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (count_tx, mut counts) = tokio::sync::mpsc::channel(4);
    let http = tokio::spawn(async move {
        let mut sockets = Vec::new();
        for _ in 0..4 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            read_request(&mut stream).await;
            count_tx.send(()).await.unwrap();
            sockets.push(stream);
        }
        for mut stream in sockets {
            let mut data = Vec::new();
            let closed =
                tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut data))
                    .await
                    .expect("aborted diagnostic closes transport");
            assert!(
                closed.is_ok()
                    || closed.is_err_and(|e| matches!(
                        e.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                    ))
            );
        }
    });
    let p = c
        .call::<ProviderUpsert>(provider(&url, Some(KEY)))
        .await
        .unwrap()
        .provider;
    let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut read = tokio::io::BufReader::new(read);
    frame(
        &mut write,
        0,
        "initialize",
        serde_json::to_value(init()).unwrap(),
    )
    .await;
    assert!(response(&mut read, 0).await.get("result").is_some());
    for id in 1..=4 {
        frame(
            &mut write,
            id,
            "provider/model/test",
            serde_json::to_value(check(&p.id)).unwrap(),
        )
        .await;
    }
    for _ in 0..4 {
        tokio::time::timeout(Duration::from_secs(5), counts.recv())
            .await
            .unwrap()
            .unwrap();
    }
    frame(
        &mut write,
        5,
        "provider/model/test",
        serde_json::to_value(check(&p.id)).unwrap(),
    )
    .await;
    assert_eq!(
        response(&mut read, 5).await["error"]["code"],
        fv_protocol::jsonrpc::code::OVERLOADED
    );
    frame(&mut write, 6, "settings/get", json!({})).await;
    assert!(response(&mut read, 6).await.get("result").is_some());
    write.shutdown().await.unwrap();
    drop(write);
    drop(read);
    http.await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while state.has_running_turns() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let good = common::serve(vec![
        common::Reply::sse(&text()),
        common::Reply::sse(&tool("fastvibe_probe", json!({"value":"ok"}))),
    ])
    .await;
    let mut replacement = provider(&good.url, Some(KEY));
    replacement.id = Some(p.id.clone());
    c.call::<ProviderUpsert>(replacement).await.unwrap();
    assert_eq!(
        c.call::<ProviderModelTest>(check(&p.id))
            .await
            .unwrap()
            .status,
        ProviderTestStatus::Passed
    );
    run.abort();
}
