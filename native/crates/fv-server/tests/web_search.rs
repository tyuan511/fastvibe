//! Hosted search stays on the custom Responses route and survives the native protocol/store.
mod common;
use fv_agent::testing::ScriptedModel;
use fv_client::Client;
use fv_core::ContentBlock;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification, methods::*, models::*, types::*};
use fv_server::{ServerState, UnixServer};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
fn event(kind: &str, p: Value) -> String {
    format!("event: {kind}\ndata: {p}\n\n")
}
fn response(search: bool) -> String {
    let c = json!({"type":"url_citation","start_index":0,"end_index":2,"url":"https://example.com/native","title":"Native docs"});
    let message = json!({"id":"answer","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"原生 search result","annotations":if search{json!([c])}else{json!([])}}]});
    let call = json!({"type":"web_search_call","id":"search-one","status":"completed","action":{"type":"search","query":"native latest","sources":[{"type":"url","url":"https://example.com/native","title":"Native docs"}]}});
    let mut out = String::new();
    if search {
        out += &event(
            "response.web_search_call.in_progress",
            json!({"type":"response.web_search_call.in_progress","item_id":"search-one","output_index":0}),
        );
        out += &event(
            "response.output_item.done",
            json!({"type":"response.output_item.done","output_index":0,"item":call}),
        );
    }
    out += &event(
        "response.output_text.delta",
        json!({"type":"response.output_text.delta","output_index":if search{1}else{0},"content_index":0,"delta":"原生 search result"}),
    );
    out += &event(
        "response.completed",
        json!({"type":"response.completed","response":{"id":"r","status":"completed","model":"gpt-search-test","output":if search{json!([call,message])}else{json!([message])},"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}),
    );
    out
}
async fn start(
    data: &std::path::Path,
) -> (
    Arc<ServerState>,
    Client,
    tokio::sync::mpsc::UnboundedReceiver<ServerNotification>,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let state = Arc::new(
        ServerState::new(
            data.into(),
            fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
        )
        .unwrap(),
    );
    common::disable_reply_suggestions(&state);
    let socket = data.join("search.sock");
    let server = tokio::spawn(
        UnixServer::bind(state.clone(), &socket)
            .await
            .unwrap()
            .run(),
    );
    let (c, n) = Client::connect_unix(&socket).await.unwrap();
    let r = c
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: "search-test".into(),
                version: "0".into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: Default::default(),
        })
        .await
        .unwrap();
    assert!(r.features.iter().any(|f| f == "hostedWebSearch"));
    (state, c, n, server)
}
async fn idle(n: &mut tokio::sync::mpsc::UnboundedReceiver<ServerNotification>, id: &str) {
    tokio::time::timeout(Duration::from_secs(8),async{while let Some(note)=n.recv().await{if matches!(note,ServerNotification::ThreadStatusChanged(e)if e.thread_id==id&&!e.body.running){return;}}panic!("connection closed");}).await.unwrap();
}
#[tokio::test]
async fn custom_search_metadata_inline_links_restart_fork_usage_and_opt_out_use_the_same_native_path()
 {
    let data = tempfile::tempdir().unwrap();
    let mock = common::serve(vec![
        common::Reply::sse(&response(true)),
        common::Reply::sse(&response(false)),
    ])
    .await;
    let (state, c, mut notes, server) = start(data.path()).await;
    let provider = c
        .call::<ProviderUpsert>(ProviderUpsertParams {
            id: None,
            name: "Search relay".into(),
            protocol: ApiProtocol::Responses,
            base_url: mock.url.clone(),
            api_key: Some("custom-secret".into()),
            enabled: true,
            models: vec![ModelInfo {
                id: "gpt-search-test".into(),
                web_search: true,
                ..Default::default()
            }],
            expected: None,
        })
        .await
        .unwrap();
    let model = format!("{}/gpt-search-test", provider.provider.id);
    let thread = c
        .call::<ThreadStart>(ThreadStartParams {
            cwd: None,
            project: None,
            model: Some(model),
            thinking: None,
        })
        .await
        .unwrap()
        .thread
        .id;
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "Find native docs".into(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    let snapshot = c
        .call::<ThreadResume>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap();
    let search = snapshot.turns[0]
        .items
        .iter()
        .filter(|i| matches!(i,Item::ToolCall{name,..}if name=="web_search"))
        .collect::<Vec<_>>();
    assert_eq!(search.len(), 1);
    assert!(
        matches!(search[0],Item::ToolCall{is_error:false,output:Some(out),..}if out.contains("https://example.com/native"))
    );
    let answer = snapshot.turns[0]
        .items
        .iter()
        .filter_map(|i| {
            if let Item::AgentMessage { text, .. } = i {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect::<String>();
    assert_eq!(answer, "[原生](<https://example.com/native>) search result");
    let loaded = state.store.transcripts.read(&thread).unwrap();
    assert_eq!(loaded.messages.len(), 2);
    assert!(
        state
            .store
            .transcripts
            .search(&thread, "native docs")
            .unwrap()
            .is_some()
    );
    assert!(loaded.messages.iter().any(|m|matches!(m,fv_core::Message::Assistant(a)if a.tool_calls().count()==0&&a.content.iter().any(|b|matches!(b,ContentBlock::HostedSearch(_))))));
    assert_eq!(state.store.db.usage_records().unwrap().len(), 1);
    let branch = c
        .call::<ThreadFork>(ThreadIdParams {
            thread_id: thread.clone(),
        })
        .await
        .unwrap()
        .thread
        .id;
    state.shutdown_schedules().await;
    server.abort();
    let _ = server.await;
    drop(c);
    drop(notes);
    let (restored, c, mut notes, server) = start(data.path()).await;
    let resumed = c
        .call::<ThreadResume>(ThreadIdParams { thread_id: branch })
        .await
        .unwrap();
    assert!(resumed.turns[0].items.iter().any(|i|matches!(i,Item::ToolCall{name,output:Some(out),..}if name=="web_search"&&out.contains("Native docs"))));
    let params = ProviderModelParams {
        provider_id: provider.provider.id.clone(),
        model_id: "gpt-search-test".into(),
    };
    let detail = c.call::<ProviderModelGet>(params).await.unwrap();
    assert!(detail.model.web_search);
    let mut edit = detail.model.clone();
    edit.web_search = false;
    edit.edited = true;
    edit.reasoning = Some(false);
    edit.input = Some(vec![ModelInput::Text]);
    edit.thinking_levels = Some(Vec::new());
    c.call::<ProviderModelUpdate>(ProviderModelUpdateParams {
        provider_id: provider.provider.id,
        model_id: edit.id.clone(),
        expected: detail.model,
        model: Some(edit),
    })
    .await
    .unwrap();
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.clone(),
        text: "Search is disabled".into(),
    })
    .await
    .unwrap();
    idle(&mut notes, &thread).await;
    {
        let captured = mock.captured.lock().unwrap();
        assert_eq!(captured.len(), 2);
        assert!(
            captured[0].body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["type"] == "web_search")
        );
        assert!(
            captured[1].body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["type"] != "web_search")
        );
        assert!(
            captured
                .iter()
                .all(|r| r.header("authorization") == Some("Bearer custom-secret"))
        );
    }
    restored.shutdown_schedules().await;
    server.abort();
}
