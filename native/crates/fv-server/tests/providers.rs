//! Providers and models over the wire: what a client can set, what it can never read back,
//! and which model a conversation ends up calling.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::{Reply, serve};
use fv_agent::testing::ScriptedModel;
use fv_client::{Client, ClientError};
use fv_protocol::jsonrpc::code;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer, serve_connection};
use tokio::sync::mpsc::UnboundedReceiver;

type Notes = UnboundedReceiver<ServerNotification>;

const KEY: &str = "sk-very-secret-key-123";

const TEXT_TURN: &str = r#"data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello "},"finish_reason":null}]}

data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{"content":"there."},"finish_reason":"stop"}]}

data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}

data: [DONE]

"#;

async fn run(dir: &Path, name: &str) -> (Arc<ServerState>, std::path::PathBuf) {
    // The model the server itself was given is a script with nothing in it: a test that reaches
    // it has used the wrong model.
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(dir.to_path_buf(), agent).unwrap());
    let sock = dir.join(format!("{name}.sock"));
    tokio::spawn(UnixServer::bind(state.clone(), &sock).await.unwrap().run());
    (state, sock)
}

async fn connect(sock: &Path) -> (Client, Notes) {
    let (c, n) = Client::connect_unix(sock).await.unwrap();
    c.call::<Initialize>(InitializeParams {
        client_info: ClientInfo {
            name: "t".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    })
    .await
    .unwrap();
    (c, n)
}

fn model(id: &str) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        name: None,
        protocol: None,
        supports_images: true,
        context_window: None,
        max_output_tokens: None,
        ..Default::default()
    }
}

fn upsert(
    name: &str,
    base_url: &str,
    key: Option<&str>,
    models: Vec<ModelInfo>,
) -> ProviderUpsertParams {
    ProviderUpsertParams {
        expected: None,
        id: None,
        name: name.into(),
        protocol: ApiProtocol::Chat,
        base_url: base_url.into(),
        api_key: key.map(str::to_string),
        enabled: true,
        models,
    }
}

fn code_of<T: std::fmt::Debug>(r: Result<T, ClientError>) -> i64 {
    match r {
        Err(ClientError::Rpc(e)) => e.code,
        other => panic!("expected a server error, got {other:?}"),
    }
}

async fn until_idle(notes: &mut Notes) -> Vec<ServerNotification> {
    let mut seen = Vec::new();
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), notes.recv())
            .await
            .expect("timed out")
            .expect("closed");
        let idle = matches!(&n, ServerNotification::ThreadStatusChanged(e) if !e.body.running);
        seen.push(n);
        if idle {
            return seen;
        }
    }
}

fn answer_text(events: &[ServerNotification]) -> String {
    events
        .iter()
        .filter_map(|n| match n {
            ServerNotification::ItemCompleted(e) => match &e.body.item {
                Item::AgentMessage { text, .. } => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn failure_of(events: &[ServerNotification]) -> Option<String> {
    events.iter().find_map(|n| match n {
        ServerNotification::TurnCompleted(e) if e.body.status == TurnStatus::Failed => {
            e.body.error.clone()
        }
        _ => None,
    })
}

#[tokio::test]
async fn a_provider_is_saved_listed_and_its_key_is_never_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let (_, sock) = run(dir.path(), "a").await;
    let (c, _n) = connect(&sock).await;

    let created = c
        .call::<ProviderUpsert>(upsert(
            "My Relay (EU)",
            "https://relay.example/v1",
            Some(KEY),
            vec![model("m1"), model("m2")],
        ))
        .await
        .unwrap()
        .provider;
    assert_eq!(created.id, "my-relay-eu");
    assert!(created.has_key);

    let listed = c.call::<ProviderList>(Empty {}).await.unwrap();
    assert_eq!(listed.providers.len(), 1);
    // Whatever the server says about providers, the key is not in it.
    let wire = serde_json::to_string(&listed).unwrap() + &serde_json::to_string(&created).unwrap();
    assert!(!wire.contains(KEY) && !wire.contains("apiKey"), "{wire}");
    let models = c.call::<ModelList>(Empty {}).await.unwrap().models;
    assert_eq!(
        models.iter().map(|m| m.label.as_str()).collect::<Vec<_>>(),
        ["my-relay-eu/m1", "my-relay-eu/m2"]
    );

    // On disk, the key is in its own private file and nowhere else.
    use std::os::unix::fs::PermissionsExt;
    let creds = dir.path().join("credentials.json");
    assert_eq!(
        std::fs::metadata(&creds).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(std::fs::read_to_string(&creds).unwrap().contains(KEY));
    let db = std::fs::read(dir.path().join("fastvibe.db")).unwrap();
    assert!(!String::from_utf8_lossy(&db).contains(KEY));
}

#[tokio::test]
async fn editing_keeps_or_clears_the_key_as_told_and_ids_stay_unique() {
    let dir = tempfile::tempdir().unwrap();
    let (_, sock) = run(dir.path(), "a").await;
    let (c, _n) = connect(&sock).await;

    let first = c
        .call::<ProviderUpsert>(upsert(
            "Relay",
            "https://r.example/v1",
            Some(KEY),
            vec![model("m1")],
        ))
        .await
        .unwrap()
        .provider;
    let second = c
        .call::<ProviderUpsert>(upsert(
            "Relay",
            "https://r2.example/v1",
            None,
            vec![model("m1")],
        ))
        .await
        .unwrap()
        .provider;
    assert_eq!(
        (first.id.as_str(), second.id.as_str()),
        ("relay", "relay-2")
    );
    assert!(!second.has_key);

    // Saving again without a key keeps the stored one.
    let mut edit = upsert(
        "Relay renamed",
        "https://r.example/v1",
        None,
        vec![model("m1"), model("m3")],
    );
    edit.id = Some("relay".into());
    let edited = c.call::<ProviderUpsert>(edit).await.unwrap().provider;
    assert!(edited.has_key && edited.name == "Relay renamed" && edited.models.len() == 2);

    // An empty key clears it, and the provider drops out of the model list.
    let mut clear = upsert(
        "Relay renamed",
        "https://r.example/v1",
        Some(""),
        vec![model("m1")],
    );
    clear.id = Some("relay".into());
    assert!(
        !c.call::<ProviderUpsert>(clear)
            .await
            .unwrap()
            .provider
            .has_key
    );
    assert!(
        c.call::<ModelList>(Empty {})
            .await
            .unwrap()
            .models
            .is_empty()
    );

    // Disabled providers offer nothing either.
    c.call::<ProviderUpsert>({
        let mut p = upsert("Off", "https://o.example/v1", Some("k"), vec![model("x")]);
        p.enabled = false;
        p
    })
    .await
    .unwrap();
    assert!(
        c.call::<ModelList>(Empty {})
            .await
            .unwrap()
            .models
            .is_empty()
    );
}

#[tokio::test]
async fn bad_providers_are_refused_with_a_reason() {
    let dir = tempfile::tempdir().unwrap();
    let (_, sock) = run(dir.path(), "a").await;
    let (c, _n) = connect(&sock).await;
    assert_eq!(
        code_of(
            c.call::<ProviderUpsert>(upsert("  ", "https://x/v1", None, vec![]))
                .await
        ),
        code::INVALID_PARAMS
    );
    assert_eq!(
        code_of(
            c.call::<ProviderUpsert>(upsert("N", "relay.example/v1", None, vec![]))
                .await
        ),
        code::INVALID_PARAMS
    );
    assert_eq!(
        code_of(
            c.call::<ProviderUpsert>(upsert(
                "N",
                "https://x/v1",
                None,
                vec![model("a"), model("a")]
            ))
            .await
        ),
        code::INVALID_PARAMS
    );
    let mut ghost = upsert("N", "https://x/v1", None, vec![]);
    ghost.id = Some("ghost".into());
    assert_eq!(
        code_of(c.call::<ProviderUpsert>(ghost).await),
        code::INVALID_PARAMS
    );
    assert_eq!(
        code_of(
            c.call::<ProviderDelete>(ProviderIdParams {
                provider_id: "ghost".into()
            })
            .await
        ),
        code::INVALID_PARAMS
    );
}

#[tokio::test]
async fn deleting_a_provider_deletes_its_key_and_a_default_that_named_it() {
    let dir = tempfile::tempdir().unwrap();
    let (_, sock) = run(dir.path(), "a").await;
    let (c, _n) = connect(&sock).await;
    c.call::<ProviderUpsert>(upsert(
        "Relay",
        "https://r.example/v1",
        Some(KEY),
        vec![model("m1")],
    ))
    .await
    .unwrap();
    c.call::<ModelDefaultsSet>(ModelDefaults {
        model: Some("relay/m1".into()),
        thinking: Some(ThinkingLevel::High),
    })
    .await
    .unwrap();

    c.call::<ProviderDelete>(ProviderIdParams {
        provider_id: "relay".into(),
    })
    .await
    .unwrap();
    assert!(
        !std::fs::read_to_string(dir.path().join("credentials.json"))
            .unwrap()
            .contains(KEY)
    );
    let defaults = c.call::<ModelDefaultsGet>(Empty {}).await.unwrap();
    assert_eq!(defaults.model, None);
    assert_eq!(
        defaults.thinking,
        Some(ThinkingLevel::High),
        "the thinking level is not tied to a provider"
    );
}

#[tokio::test]
async fn every_client_is_told_when_providers_change() {
    let dir = tempfile::tempdir().unwrap();
    let (_, sock) = run(dir.path(), "a").await;
    let (a, _na) = connect(&sock).await;
    let (_b, mut nb) = connect(&sock).await;
    a.call::<ProviderUpsert>(upsert(
        "Relay",
        "https://r.example/v1",
        Some(KEY),
        vec![model("m1")],
    ))
    .await
    .unwrap();
    let n = tokio::time::timeout(Duration::from_secs(5), nb.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(n.method(), "providers/changed");
}

#[tokio::test]
async fn a_conversation_calls_its_own_providers_model_with_the_stored_key() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![Reply::sse(TEXT_TURN)]).await;
    let (_, sock) = run(dir.path(), "a").await;
    let (c, mut notes) = connect(&sock).await;
    c.call::<ProviderUpsert>(upsert(
        "Relay",
        &format!("{}/v1", mock.url),
        Some(KEY),
        vec![model("m1")],
    ))
    .await
    .unwrap();

    let thread = c
        .call::<ThreadStart>(ThreadStartParams {
            cwd: None,
            project: None,
            model: Some("relay/m1".into()),
            thinking: Some(ThinkingLevel::Medium),
        })
        .await
        .unwrap()
        .thread;
    assert_eq!(thread.model.as_deref(), Some("relay/m1"));
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.id,
        text: "hi".into(),
    })
    .await
    .unwrap();
    let events = until_idle(&mut notes).await;
    assert_eq!(answer_text(&events), "Hello there.");

    let sent = mock.captured.lock().unwrap()[0].clone();
    assert_eq!(sent.path, "/v1/chat/completions");
    assert_eq!(
        sent.header("authorization"),
        Some(format!("Bearer {KEY}").as_str())
    );
    assert_eq!(sent.body["model"], "m1");
    assert_eq!(sent.body["reasoning_effort"], "medium");
}

#[tokio::test]
async fn a_conversation_with_no_model_uses_the_default_one() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![Reply::sse(TEXT_TURN)]).await;
    let (_, sock) = run(dir.path(), "a").await;
    let (c, mut notes) = connect(&sock).await;
    c.call::<ProviderUpsert>(upsert(
        "Relay",
        &format!("{}/v1", mock.url),
        Some(KEY),
        vec![model("m1")],
    ))
    .await
    .unwrap();

    // Providers exist but nothing is chosen: the turn says so rather than guessing.
    let thread = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "hi".into(),
    })
    .await
    .unwrap();
    let failure = failure_of(&until_idle(&mut notes).await).expect("a failed turn");
    assert!(failure.contains("No model is selected"), "{failure}");

    c.call::<ModelDefaultsSet>(ModelDefaults {
        model: Some("relay/m1".into()),
        thinking: Some(ThinkingLevel::Low),
    })
    .await
    .unwrap();
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread,
        text: "again".into(),
    })
    .await
    .unwrap();
    let events = until_idle(&mut notes).await;
    assert_eq!(answer_text(&events), "Hello there.");
    assert_eq!(
        mock.captured.lock().unwrap()[0].body["reasoning_effort"],
        "low"
    );

    // A default that cannot be used is refused when it is set.
    assert_eq!(
        code_of(
            c.call::<ModelDefaultsSet>(ModelDefaults {
                model: Some("relay/nope".into()),
                thinking: None
            })
            .await
        ),
        code::INVALID_PARAMS
    );
}

#[tokio::test]
async fn a_model_that_has_gone_fails_the_turn_with_the_reason_not_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let (_, sock) = run(dir.path(), "a").await;
    let (c, mut notes) = connect(&sock).await;
    c.call::<ProviderUpsert>(upsert(
        "Relay",
        "https://r.example/v1",
        Some(KEY),
        vec![model("m1")],
    ))
    .await
    .unwrap();
    let thread = c
        .call::<ThreadStart>(ThreadStartParams {
            cwd: None,
            project: None,
            model: Some("relay/m1".into()),
            thinking: None,
        })
        .await
        .unwrap()
        .thread
        .id;
    c.call::<ProviderDelete>(ProviderIdParams {
        provider_id: "relay".into(),
    })
    .await
    .unwrap();

    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "hi".into(),
    })
    .await
    .unwrap();
    let failure = failure_of(&until_idle(&mut notes).await).expect("a failed turn");
    assert!(failure.contains("no longer exists"), "{failure}");

    // Choosing a model that is not there is refused up front.
    assert_eq!(
        code_of(
            c.call::<ThreadModelSet>(ThreadModelParams {
                thread_id: thread,
                model: Some("relay/m1".into()),
                thinking: None
            })
            .await
        ),
        code::INVALID_PARAMS
    );
    assert_eq!(
        code_of(
            c.call::<ThreadStart>(ThreadStartParams {
                cwd: None,
                project: None,
                model: Some("nope/x".into()),
                thinking: None
            })
            .await
        ),
        code::INVALID_PARAMS
    );
}

#[tokio::test]
async fn a_conversations_model_can_be_changed() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![Reply::sse(TEXT_TURN)]).await;
    let (_, sock) = run(dir.path(), "a").await;
    let (c, mut notes) = connect(&sock).await;
    c.call::<ProviderUpsert>(upsert(
        "Relay",
        &format!("{}/v1", mock.url),
        Some(KEY),
        vec![model("m1"), model("m2")],
    ))
    .await
    .unwrap();
    let thread = c
        .call::<ThreadStart>(ThreadStartParams::default())
        .await
        .unwrap()
        .thread
        .id;
    let updated = c
        .call::<ThreadModelSet>(ThreadModelParams {
            thread_id: thread.clone(),
            model: Some("relay/m2".into()),
            thinking: Some(ThinkingLevel::High),
        })
        .await
        .unwrap()
        .thread;
    assert_eq!(
        (updated.model.as_deref(), updated.thinking),
        (Some("relay/m2"), Some(ThinkingLevel::High))
    );
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread,
        text: "hi".into(),
    })
    .await
    .unwrap();
    until_idle(&mut notes).await;
    assert_eq!(mock.captured.lock().unwrap()[0].body["model"], "m2");
}

#[tokio::test]
async fn providers_defaults_and_keys_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (_, sock) = run(dir.path(), "a").await;
        let (c, _n) = connect(&sock).await;
        c.call::<ProviderUpsert>(upsert(
            "Relay",
            "https://r.example/v1",
            Some(KEY),
            vec![model("m1")],
        ))
        .await
        .unwrap();
        c.call::<ModelDefaultsSet>(ModelDefaults {
            model: Some("relay/m1".into()),
            thinking: Some(ThinkingLevel::Max),
        })
        .await
        .unwrap();
    }
    let (_, sock) = run(dir.path(), "b").await;
    let (c, _n) = connect(&sock).await;
    let providers = c.call::<ProviderList>(Empty {}).await.unwrap().providers;
    assert_eq!(providers[0].id, "relay");
    assert!(providers[0].has_key);
    let defaults = c.call::<ModelDefaultsGet>(Empty {}).await.unwrap();
    assert_eq!(
        (defaults.model.as_deref(), defaults.thinking),
        (Some("relay/m1"), Some(ThinkingLevel::Max))
    );
}

#[tokio::test]
async fn the_models_a_provider_has_can_be_fetched_with_its_stored_key_or_a_typed_one() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![
        Reply::status(200, r#"{"data":[{"id":"gpt-a"},{"id":"gpt-b"}]}"#),
        Reply::status(200, r#"{"data":[{"id":"other"}]}"#),
    ])
    .await;
    let (_, sock) = run(dir.path(), "a").await;
    let (c, _n) = connect(&sock).await;
    c.call::<ProviderUpsert>(upsert(
        "Relay",
        &format!("{}/v1", mock.url),
        Some(KEY),
        vec![],
    ))
    .await
    .unwrap();

    let stored = c
        .call::<ProviderFetchModels>(FetchModelsParams {
            provider_id: Some("relay".into()),
            ..empty_fetch()
        })
        .await
        .unwrap();
    assert_eq!(
        stored
            .models
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-a", "gpt-b"]
    );
    assert!(
        stored.models.iter().all(|m| !m.supports_images
            && m.context_window == Some(128_000)
            && m.max_output_tokens == Some(8_192)
            && m.reasoning == Some(false)),
        "unknown fetched ids get conservative metadata"
    );
    assert_eq!(
        mock.captured.lock().unwrap()[0].header("authorization"),
        Some(format!("Bearer {KEY}").as_str())
    );

    // A provider that is not saved yet, with a key typed into the form.
    let typed = c
        .call::<ProviderFetchModels>(FetchModelsParams {
            provider_id: None,
            protocol: Some(ApiProtocol::Chat),
            base_url: Some(format!("{}/v1", mock.url)),
            api_key: Some("sk-typed".into()),
        })
        .await
        .unwrap();
    assert_eq!(typed.models[0].id, "other");
    assert_eq!(
        mock.captured.lock().unwrap()[1].header("authorization"),
        Some("Bearer sk-typed")
    );

    assert_eq!(
        code_of(c.call::<ProviderFetchModels>(empty_fetch()).await),
        code::INVALID_PARAMS
    );
    assert_eq!(
        code_of(
            c.call::<ProviderFetchModels>(FetchModelsParams {
                provider_id: Some("ghost".into()),
                ..empty_fetch()
            })
            .await
        ),
        code::INVALID_PARAMS
    );
}

fn empty_fetch() -> FetchModelsParams {
    FetchModelsParams {
        provider_id: None,
        protocol: None,
        base_url: None,
        api_key: None,
    }
}

#[tokio::test]
async fn a_remote_client_may_configure_providers_but_not_make_the_server_fetch_an_address() {
    let dir = tempfile::tempdir().unwrap();
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(dir.path().to_path_buf(), agent).unwrap());
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(serve_connection(state, ClientOrigin::Lan, sr, sw));
    let (cr, cw) = tokio::io::split(client_io);
    let (c, _n) = Client::from_io(cr, cw);
    c.call::<Initialize>(InitializeParams {
        client_info: ClientInfo {
            name: "phone".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    })
    .await
    .unwrap();

    c.call::<ProviderList>(Empty {}).await.unwrap();
    c.call::<ProviderUpsert>(upsert(
        "Relay",
        "https://r.example/v1",
        Some(KEY),
        vec![model("m1")],
    ))
    .await
    .unwrap();
    assert_eq!(
        code_of(
            c.call::<ProviderFetchModels>(FetchModelsParams {
                provider_id: None,
                protocol: Some(ApiProtocol::Chat),
                base_url: Some("http://169.254.169.254/".into()),
                api_key: None
            })
            .await
        ),
        code::FORBIDDEN
    );
}

/// A model's window, output ceiling and vision come from models.dev, not from what the client
/// happened to send — and a model the catalog prices is billed, while one it does not stays
/// unknown rather than being called free.
#[tokio::test]
async fn catalog_metadata_reaches_the_model_list_and_prices_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    // The snapshot has to be there before the server reads it: this is the refresh an install
    // pulls, and the same decoder the Electron app uses.
    std::fs::write(
        dir.path().join("models-dev.json"),
        serde_json::json!({
            "v": 5,
            "t": 1,
            "s": "https://models.dev/api.json",
            "m": [
                ["catalog/known", "Known", 200_000, 8_000, 3, ["low"], [2.0, 12.0, 0.2, 0.4]],
                ["catalog/unknown", "Unknown", 32_000, 4_000, 1, null, null]
            ],
            // The snapshot's alias map holds every name a model answers to; the bare id is
            // what a provider lists, so it has to be there for a lookup to land.
            "x": {"catalog-known": 0, "known": 0, "catalog-unknown": 1, "unknown": 1}
        })
        .to_string(),
    )
    .unwrap();
    let (_, sock) = run(dir.path(), "meta").await;
    let (c, _n) = connect(&sock).await;
    c.call::<ProviderUpsert>(upsert(
        "catalog",
        "https://relay.example/v1",
        Some(KEY),
        // A client that sends no metadata at all still gets the catalog's.
        vec![model("known"), model("unknown")],
    ))
    .await
    .unwrap();
    let models = c.call::<ModelList>(Empty {}).await.unwrap().models;
    let known = models.iter().find(|m| m.model.id == "known").unwrap();
    assert_eq!(known.model.context_window, Some(200_000));
    assert_eq!(known.model.max_output_tokens, Some(8_000));
    assert!(known.model.supports_images);
    assert_eq!(known.model.name.as_deref(), Some("Known"));
    let unknown = models.iter().find(|m| m.model.id == "unknown").unwrap();
    assert_eq!(unknown.model.context_window, Some(32_000));
    assert!(!unknown.model.supports_images, "text-only in the catalog");

    // Free and unpriced are different answers: only the priced model produces a bill.
    let priced = fv_provider::history_cost(
        &fv_provider::load_catalog(dir.path()),
        &[fv_core::Message::Assistant(fv_core::AssistantMessage {
            duration_ms: None,
            content: vec![],
            stop: fv_core::StopReason::Stop,
            usage: fv_core::Usage {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
                ..Default::default()
            },
            model: Some("catalog/known".into()),
        })],
    )
    .unwrap();
    assert!((priced - 14.0).abs() < 1e-9, "{priced}");
    let unpriced = fv_provider::history_cost(
        &fv_provider::load_catalog(dir.path()),
        &[fv_core::Message::Assistant(fv_core::AssistantMessage {
            duration_ms: None,
            content: vec![],
            stop: fv_core::StopReason::Stop,
            usage: fv_core::Usage {
                input_tokens: 1_000_000,
                ..Default::default()
            },
            model: Some("catalog/unknown".into()),
        })],
    );
    assert_eq!(unpriced, None);
}
