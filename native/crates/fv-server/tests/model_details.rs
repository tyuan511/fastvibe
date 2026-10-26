mod common;
use fv_agent::testing::ScriptedModel;
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::models::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
type Notes = tokio::sync::mpsc::UnboundedReceiver<ServerNotification>;
const TURN: &str = "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"claude-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"claude-test\",\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\ndata: [DONE]\n\n";
async fn run(
    dir: &Path,
) -> (
    Arc<ServerState>,
    std::path::PathBuf,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let state = Arc::new(
        ServerState::new(
            dir.into(),
            fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([]))),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let path = dir.join("models.sock");
    let server = tokio::spawn(UnixServer::bind(state.clone(), &path).await.unwrap().run());
    (state, path, server)
}
async fn client(path: &Path) -> (Client, Notes) {
    let (c, n) = Client::connect_unix(path).await.unwrap();
    let init = c
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "model-details".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(init.features.iter().any(|f| f == "modelDetails"));
    (c, n)
}
fn params(p: &str, m: &str) -> ProviderModelParams {
    ProviderModelParams {
        provider_id: p.into(),
        model_id: m.into(),
    }
}
fn upsert(url: &str, models: Vec<ModelInfo>) -> ProviderUpsertParams {
    ProviderUpsertParams {
        id: None,
        name: "relay".into(),
        protocol: ApiProtocol::Chat,
        base_url: url.into(),
        api_key: Some("test-key".into()),
        enabled: true,
        models,
        expected: None,
    }
}
fn tuned(base: &ModelInfo) -> ModelInfo {
    ModelInfo {
        name: Some("My model".into()),
        context_window: Some(64000),
        max_output_tokens: Some(64),
        reasoning: Some(true),
        thinking_levels: Some(vec![ThinkingLevel::High]),
        input: Some(vec![ModelInput::Text, ModelInput::File]),
        protocol: None,
        edited: true,
        supports_images: false,
        ..base.clone()
    }
}
async fn edit(
    c: &Client,
    p: &str,
    old: &ModelInfo,
    next: Option<ModelInfo>,
) -> Result<ModelDetail, fv_client::ClientError> {
    c.call::<ProviderModelUpdate>(ProviderModelUpdateParams {
        provider_id: p.into(),
        model_id: old.id.clone(),
        expected: old.clone(),
        model: next,
    })
    .await
}
async fn idle(notes: &mut Notes) -> Vec<ServerNotification> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut out = Vec::new();
        loop {
            let n = notes.recv().await.unwrap();
            let idle = matches!(&n,ServerNotification::ThreadStatusChanged(e) if !e.body.running);
            out.push(n);
            if idle {
                return out;
            }
        }
    })
    .await
    .unwrap()
}
fn snapshot(dir: &Path) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    std::fs::write(dir.join("models-dev.json"),serde_json::json!({"v":5,"t":now,
        "m":[["m","M",200000,8000,3,["low","high"],[2,10,0.1,1,[[200000,4,20,0.2,2]]]]],"x":{"m":0}}).to_string()).unwrap();
}
#[tokio::test]
async fn edits_merge_by_model_reject_stale_writes_and_survive_restart_while_prices_stay_read_only()
{
    let dir = tempfile::tempdir().unwrap();
    snapshot(dir.path());
    let (state, socket, server) = run(dir.path()).await;
    let (a, _) = client(&socket).await;
    let (b, mut notes) = client(&socket).await;
    let provider = a
        .call::<ProviderUpsert>(upsert(
            "https://relay.example/v1",
            vec![
                ModelInfo {
                    id: "m".into(),
                    ..Default::default()
                },
                ModelInfo {
                    id: "other".into(),
                    ..Default::default()
                },
            ],
        ))
        .await
        .unwrap()
        .provider;
    let m = a
        .call::<ProviderModelGet>(params(&provider.id, "m"))
        .await
        .unwrap();
    assert_eq!(m.model.context_window, Some(200000));
    assert_eq!(m.price.unwrap().input, 2.0);
    assert_eq!(m.price_tiers[0].over, 200000);
    let other = b
        .call::<ProviderModelGet>(params(&provider.id, "other"))
        .await
        .unwrap();
    let saved = edit(&a, &provider.id, &m.model, Some(tuned(&m.model)))
        .await
        .unwrap();
    let saved_other = edit(&b, &provider.id, &other.model, Some(tuned(&other.model)))
        .await
        .unwrap();
    assert!(saved.model.edited && saved_other.model.edited);
    assert_eq!(
        saved.price, m.price,
        "editing capability fields cannot edit prices"
    );
    assert!(
        edit(&b, &provider.id, &m.model, Some(tuned(&m.model)))
            .await
            .is_err()
    );
    let list = a.call::<ProviderList>(Empty {}).await.unwrap();
    assert_eq!(
        list.providers[0].models,
        vec![saved.model.clone(), saved_other.model.clone()]
    );
    assert_eq!(
        state
            .store
            .credentials
            .get(&provider.id)
            .unwrap()
            .as_deref(),
        Some("test-key")
    );
    let mut stale = upsert("https://changed.example/v1", provider.models.clone());
    stale.id = Some(provider.id.clone());
    stale.expected = Some(provider.clone());
    stale.api_key = Some("should-not-replace-key".into());
    assert!(a.call::<ProviderUpsert>(stale).await.is_err());
    assert_eq!(
        state
            .store
            .credentials
            .get(&provider.id)
            .unwrap()
            .as_deref(),
        Some("test-key")
    );
    assert_eq!(
        a.call::<ProviderList>(Empty {}).await.unwrap().providers[0].base_url,
        provider.base_url
    );
    let mut saw = false;
    while let Ok(note) = notes.try_recv() {
        if let ServerNotification::ProvidersChanged(p) = note {
            assert_eq!(serde_json::to_value(p).unwrap(), serde_json::json!({}));
            saw = true;
        }
    }
    assert!(saw);
    drop(a);
    drop(b);
    server.abort();
    let _ = server.await;
    drop(state);
    // A newer catalog must update the read-only prices while retaining tuned parameters.
    std::fs::write(dir.path().join("models-dev.json"),serde_json::json!({"v":5,
        "t":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
        "m":[["m","M",400000,16000,1,["low","high"],[5,15,0.2,2]]],"x":{"m":0}}).to_string()).unwrap();
    let restarted = Arc::new(
        ServerState::new(
            dir.path().into(),
            fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([]))),
        )
        .unwrap(),
    );
    assert_eq!(
        restarted
            .store
            .db
            .get_provider(&provider.id)
            .unwrap()
            .unwrap()
            .models,
        vec![saved.model.clone(), saved_other.model]
    );
    let restart_socket = dir.path().join("restarted.sock");
    let server = tokio::spawn(
        UnixServer::bind(restarted, &restart_socket)
            .await
            .unwrap()
            .run(),
    );
    let (a, _) = client(&restart_socket).await;
    let (b, _) = client(&restart_socket).await;
    let restored = a
        .call::<ProviderModelGet>(params(&provider.id, "m"))
        .await
        .unwrap();
    assert_eq!(restored.model, saved.model);
    assert_eq!(restored.price.unwrap().input, 5.0);
    let reset = edit(&a, &provider.id, &saved.model, None).await.unwrap();
    assert!(!reset.model.edited);
    assert_eq!(reset.model.context_window, Some(400000));
    assert_eq!(
        reset.model.thinking_levels,
        Some(vec![ThinkingLevel::Low, ThinkingLevel::High])
    );
    assert_eq!(reset.price, restored.price);
    for origin in [ClientOrigin::Lan, ClientOrigin::Official] {
        assert!(fv_server::allows(
            origin,
            &fv_protocol::ClientRequest::ProviderModelGet {
                id: fv_protocol::RequestId::Number(1),
                params: params(&provider.id, "m")
            }
        ));
        assert!(fv_server::allows(
            origin,
            &fv_protocol::ClientRequest::ProviderModelUpdate {
                id: fv_protocol::RequestId::Number(2),
                params: ProviderModelUpdateParams {
                    provider_id: provider.id.clone(),
                    model_id: "m".into(),
                    expected: reset.model.clone(),
                    model: None
                }
            }
        ));
    }
    a.call::<ProviderDelete>(ProviderIdParams {
        provider_id: provider.id.clone(),
    })
    .await
    .unwrap();
    assert!(
        edit(&b, &provider.id, &reset.model, Some(tuned(&reset.model)))
            .await
            .is_err()
    );
    server.abort();
}
#[tokio::test]
async fn malformed_edits_and_provider_replacements_are_atomic_before_credentials_change() {
    let dir = tempfile::tempdir().unwrap();
    let (state, socket, server) = run(dir.path()).await;
    let (c, _) = client(&socket).await;
    let p = c
        .call::<ProviderUpsert>(upsert(
            "https://relay.example/v1",
            vec![ModelInfo {
                id: "m".into(),
                ..Default::default()
            }],
        ))
        .await
        .unwrap()
        .provider;
    let original = c
        .call::<ProviderModelGet>(params(&p.id, "m"))
        .await
        .unwrap()
        .model;
    let valid = tuned(&original);
    let mut wrong_id = valid.clone();
    wrong_id.id = "renamed".into();
    let mut zero = valid.clone();
    zero.context_window = Some(0);
    let mut no_output = valid.clone();
    no_output.max_output_tokens = None;
    let mut no_efforts = valid.clone();
    no_efforts.thinking_levels = Some(vec![]);
    let mut no_input = valid.clone();
    no_input.input = None;
    for invalid in [wrong_id, zero, no_output, no_efforts, no_input] {
        assert!(edit(&c, &p.id, &original, Some(invalid)).await.is_err());
        assert_eq!(
            c.call::<ProviderModelGet>(params(&p.id, "m"))
                .await
                .unwrap()
                .model,
            original
        );
    }
    let mut invalid_replacement = upsert(
        "https://other.example/v1",
        vec![ModelInfo {
            context_window: Some(0),
            ..original.clone()
        }],
    );
    invalid_replacement.id = Some(p.id.clone());
    invalid_replacement.api_key = Some("bad-replacement-key".into());
    assert!(c.call::<ProviderUpsert>(invalid_replacement).await.is_err());
    assert_eq!(
        state.store.credentials.get(&p.id).unwrap().as_deref(),
        Some("test-key")
    );
    let mut normalized = valid;
    normalized.input = Some(vec![ModelInput::File, ModelInput::Image, ModelInput::Image]);
    normalized.thinking_levels = Some(vec![
        ThinkingLevel::High,
        ThinkingLevel::Low,
        ThinkingLevel::High,
    ]);
    let normalized = edit(&c, &p.id, &original, Some(normalized))
        .await
        .unwrap()
        .model;
    assert_eq!(
        normalized.input,
        Some(vec![ModelInput::Text, ModelInput::Image, ModelInput::File])
    );
    assert!(normalized.supports_images);
    assert_eq!(
        normalized.thinking_levels,
        Some(vec![ThinkingLevel::Low, ThinkingLevel::High])
    );
    server.abort();
}

struct ModelHttp {
    url: String,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    started: tokio::sync::oneshot::Receiver<()>,
    release: tokio::sync::oneshot::Sender<()>,
    worker: tokio::task::JoinHandle<()>,
}
async fn http() -> ModelHttp {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (seen, started) = tokio::sync::oneshot::channel();
    let (release, gate) = tokio::sync::oneshot::channel();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let worker = tokio::spawn(async move {
        let mut seen = Some(seen);
        let mut gate = Some(gate);
        for index in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let (head, len) = loop {
                let mut b = [0; 8192];
                let n = stream.read(&mut b).await.unwrap();
                assert!(n > 0);
                buf.extend_from_slice(&b[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&buf[..pos]);
                    assert!(
                        header.starts_with("POST /v1/chat/completions "),
                        "explicit inheritance routes even a claude id through Chat"
                    );
                    let len = header
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|l| l.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (pos + 4, len);
                }
            };
            while buf.len() < head + len {
                let mut b = [0; 8192];
                let n = stream.read(&mut b).await.unwrap();
                assert!(n > 0);
                buf.extend_from_slice(&b[..n]);
            }
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_slice(&buf[head..head + len]).unwrap());
            if index == 0 {
                seen.take().unwrap().send(()).unwrap();
                gate.take().unwrap().await.unwrap();
            }
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{TURN}",TURN.len()).as_bytes()).await.unwrap();
        }
    });
    ModelHttp {
        url: format!("http://{addr}/v1"),
        requests,
        started,
        release,
        worker,
    }
}
#[tokio::test]
async fn edits_apply_to_the_next_request_clamp_effort_and_do_not_interrupt_the_current_reply() {
    let dir = tempfile::tempdir().unwrap();
    let (state, socket, server) = run(dir.path()).await;
    let (c, mut notes) = client(&socket).await;
    let transport = http().await;
    let p = c
        .call::<ProviderUpsert>(upsert(
            &transport.url,
            vec![ModelInfo {
                id: "claude-test".into(),
                context_window: Some(128000),
                max_output_tokens: Some(128),
                ..Default::default()
            }],
        ))
        .await
        .unwrap()
        .provider;
    let first = c
        .call::<ProviderModelGet>(params(&p.id, "claude-test"))
        .await
        .unwrap();
    let thread = c
        .call::<ThreadStart>(ThreadStartParams {
            model: Some(format!("{}/claude-test", p.id)),
            thinking: Some(ThinkingLevel::Medium),
            ..Default::default()
        })
        .await
        .unwrap()
        .thread;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id.clone(),
        text: "first".into(),
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), transport.started)
        .await
        .unwrap()
        .unwrap();
    let saved = edit(&c, &p.id, &first.model, Some(tuned(&first.model)))
        .await
        .unwrap();
    assert!(state.runtime(&thread.id).is_running());
    transport.release.send(()).unwrap();
    let events = idle(&mut notes).await;
    assert!(events.iter().any(
        |n| matches!(n,ServerNotification::TurnCompleted(e) if e.body.status==TurnStatus::Completed)
    ));
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id.clone(),
        text: "second".into(),
    })
    .await
    .unwrap();
    idle(&mut notes).await;
    let view = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(view.token_usage.unwrap().window, 64000);
    let mut disabled = saved.model.clone();
    disabled.reasoning = Some(false);
    let disabled = edit(&c, &p.id, &saved.model, Some(disabled)).await.unwrap();
    assert_eq!(disabled.model.thinking_levels, Some(vec![]));
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id,
        text: "third".into(),
    })
    .await
    .unwrap();
    idle(&mut notes).await;
    transport.worker.await.unwrap();
    let requests = transport.requests.lock().unwrap();
    let max = |body: &serde_json::Value| {
        body["max_tokens"]
            .as_u64()
            .or_else(|| body["max_completion_tokens"].as_u64())
            .unwrap()
    };
    assert_eq!(max(&requests[0]), 128);
    assert_eq!(requests[0]["reasoning_effort"], "medium");
    assert_eq!(max(&requests[1]), 64);
    assert_eq!(requests[1]["reasoning_effort"], "high");
    assert!(
        requests[2].get("reasoning_effort").is_none(),
        "non-reasoning means omit, never send a disable request"
    );
    server.abort();
}

#[tokio::test]
async fn legacy_inferred_routes_are_migrated_once_without_overriding_later_inheritance() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = fv_store::Store::open(dir.path()).unwrap();
        let legacy = fv_store::StoredProvider {
            id: "legacy".into(),
            name: "Legacy".into(),
            protocol: ApiProtocol::Chat,
            base_url: "https://relay.example/v1".into(),
            enabled: true,
            models: vec![
                ModelInfo {
                    id: "claude-old".into(),
                    ..Default::default()
                },
                ModelInfo {
                    id: "gemini-old".into(),
                    ..Default::default()
                },
                ModelInfo {
                    id: "anthropic/claude-namespaced".into(),
                    ..Default::default()
                },
                ModelInfo {
                    id: "claude-pinned".into(),
                    protocol: Some(ApiProtocol::Responses),
                    ..Default::default()
                },
                ModelInfo {
                    id: "claude-edited".into(),
                    edited: true,
                    ..Default::default()
                },
            ],
        };
        store.db.put_provider(&legacy).unwrap();
        store.credentials.set("legacy", "legacy-key").unwrap();
        store
            .db
            .put_provider(&fv_store::StoredProvider {
                id: "native".into(),
                name: "Native".into(),
                protocol: ApiProtocol::Google,
                models: vec![ModelInfo {
                    id: "claude-old".into(),
                    ..Default::default()
                }],
                ..legacy
            })
            .unwrap();
    }
    let (state, socket, server) = run(dir.path()).await;
    let (c, _) = client(&socket).await;
    let list = c.call::<ProviderList>(Empty {}).await.unwrap().providers;
    let p = list.iter().find(|p| p.id == "legacy").unwrap();
    assert_eq!(
        p.models.iter().map(|m| m.protocol).collect::<Vec<_>>(),
        vec![
            Some(ApiProtocol::Anthropic),
            Some(ApiProtocol::Google),
            None,
            Some(ApiProtocol::Responses),
            None
        ]
    );
    assert_eq!(
        list.iter().find(|p| p.id == "native").unwrap().models[0].protocol,
        None,
        "legacy native-provider routes do not change"
    );
    assert_eq!(
        state.store.credentials.get("legacy").unwrap().as_deref(),
        Some("legacy-key")
    );
    let old = p.models[0].clone();
    let mut explicit = tuned(&old);
    explicit.protocol = None;
    let saved = edit(&c, "legacy", &old, Some(explicit)).await.unwrap();
    assert_eq!(saved.model.protocol, None);
    drop(c);
    server.abort();
    let _ = server.await;
    drop(state);
    let restarted = ServerState::new(
        dir.path().into(),
        fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([]))),
    )
    .unwrap();
    assert_eq!(
        restarted
            .store
            .db
            .get_provider("legacy")
            .unwrap()
            .unwrap()
            .models[0],
        saved.model
    );
    assert_eq!(
        restarted
            .store
            .db
            .get_setting("model_detail_protocol_v1")
            .unwrap()
            .as_deref(),
        Some("1")
    );
}

#[tokio::test]
async fn fetched_native_protocol_pins_and_google_gateway_auth_follow_the_provider_default() {
    let gemini = "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"done\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":2,\"totalTokenCount\":7}}\n\n";
    let mock=common::serve(vec![common::Reply::status(200,r#"{"data":[{"id":"claude-fresh"},{"id":"gemini-fresh"},{"id":"models/gemini-fresh"},{"id":"plain"}]}"#),
        common::Reply::sse(gemini),common::Reply::sse(gemini)]).await;
    let dir = tempfile::tempdir().unwrap();
    let (_, socket, server) = run(dir.path()).await;
    let (c, mut notes) = client(&socket).await;
    let p = c
        .call::<ProviderUpsert>(upsert(&format!("{}/v1", mock.url), Vec::new()))
        .await
        .unwrap()
        .provider;
    let fetched = c
        .call::<ProviderFetchModels>(FetchModelsParams {
            provider_id: Some(p.id.clone()),
            protocol: None,
            base_url: None,
            api_key: None,
        })
        .await
        .unwrap();
    let protocol = |id: &str| fetched.models.iter().find(|m| m.id == id).unwrap().protocol;
    assert_eq!(protocol("claude-fresh"), Some(ApiProtocol::Anthropic));
    assert_eq!(protocol("gemini-fresh"), Some(ApiProtocol::Google));
    assert_eq!(protocol("models/gemini-fresh"), None);
    assert_eq!(protocol("plain"), None);
    c.call::<ProviderUpsert>(ProviderUpsertParams {
        id: Some(p.id.clone()),
        models: fetched.models,
        expected: Some(p.clone()),
        ..upsert(&p.base_url, Vec::new())
    })
    .await
    .unwrap();
    let thread = c
        .call::<ThreadStart>(ThreadStartParams {
            model: Some(format!("{}/gemini-fresh", p.id)),
            ..Default::default()
        })
        .await
        .unwrap()
        .thread;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id.clone(),
        text: "mixed gateway".into(),
    })
    .await
    .unwrap();
    assert!(idle(&mut notes).await.iter().any(
        |n| matches!(n,ServerNotification::TurnCompleted(e) if e.body.status==TurnStatus::Completed)
    ));
    let p = c
        .call::<ProviderList>(Empty {})
        .await
        .unwrap()
        .providers
        .remove(0);
    c.call::<ProviderUpsert>(ProviderUpsertParams {
        id: Some(p.id.clone()),
        protocol: ApiProtocol::Google,
        models: p.models.clone(),
        expected: Some(p.clone()),
        ..upsert(&p.base_url, Vec::new())
    })
    .await
    .unwrap();
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id,
        text: "native Google provider".into(),
    })
    .await
    .unwrap();
    assert!(idle(&mut notes).await.iter().any(
        |n| matches!(n,ServerNotification::TurnCompleted(e) if e.body.status==TurnStatus::Completed)
    ));
    let sent = mock.captured.lock().unwrap();
    assert_eq!(sent.len(), 3);
    assert_eq!(sent[0].path, "/v1/models");
    for request in &sent[1..] {
        assert!(
            request
                .path
                .starts_with("/v1beta/models/gemini-fresh:streamGenerateContent")
        );
        assert_eq!(request.header("x-goog-api-key"), Some("test-key"));
    }
    assert_eq!(sent[1].header("authorization"), Some("Bearer test-key"));
    assert_eq!(sent[2].header("authorization"), None);
    server.abort();
}
