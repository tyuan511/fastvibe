//! 会话标题: a conversation whose first message says more than a name is named by its own model,
//! the way the Electron app's `session-title` extension does it.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Reply, serve};
use fv_agent::testing::ScriptedModel;
use fv_client::Client;
use fv_protocol::methods::*;
use fv_protocol::types::*;
use fv_protocol::{PROTOCOL_VERSION, ServerNotification};
use fv_server::{ServerState, UnixServer};

const KEY: &str = "sk-title-test";

/// One streamed chat-completions answer saying `text`.
fn turn(text: &str) -> Reply {
    Reply::sse(&format!(
        "data: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m1\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text:?}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m1\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m1\",\"choices\":[],\"usage\":{{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}}}\n\ndata: [DONE]\n\n"
    ))
}

async fn run(dir: &std::path::Path) -> std::path::PathBuf {
    let agent = fv_server::agent_with_builtin_tools(Arc::new(ScriptedModel::new([])));
    let state = Arc::new(ServerState::new(dir.to_path_buf(), agent).unwrap());
    // 回复推荐 spends the same model's next reply, so it would race the title request.
    common::disable_reply_suggestions(&state);
    let sock = dir.join("title.sock");
    tokio::spawn(UnixServer::bind(state, &sock).await.unwrap().run());
    sock
}

async fn connect(sock: &std::path::Path, name: &str) -> Client {
    let (c, _n) = Client::connect_unix(sock).await.unwrap();
    c.call::<Initialize>(InitializeParams {
        client_info: ClientInfo {
            name: name.into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    })
    .await
    .unwrap();
    c
}

async fn provider(c: &Client, base_url: &str) {
    c.call::<ProviderUpsert>(ProviderUpsertParams {
        expected: None,
        id: None,
        name: "Relay".into(),
        protocol: ApiProtocol::Chat,
        base_url: base_url.into(),
        api_key: Some(KEY.into()),
        enabled: true,
        models: vec![ModelInfo {
            id: "m1".into(),
            ..Default::default()
        }],
    })
    .await
    .unwrap();
}

async fn thread_with_model(c: &Client) -> String {
    c.call::<ThreadStart>(ThreadStartParams {
        cwd: None,
        project: None,
        model: Some("relay/m1".into()),
        thinking: None,
    })
    .await
    .unwrap()
    .thread
    .id
}

async fn send(c: &Client, thread: &str, text: &str) {
    c.call::<TurnStart>(TurnStartParams {
        thread_id: thread.into(),
        text: text.into(),
    })
    .await
    .unwrap();
}

async fn title(c: &Client, thread: &str) -> String {
    c.call::<ThreadList>(ThreadListParams {
        include_archived: false,
    })
    .await
    .unwrap()
    .threads
    .into_iter()
    .find(|t| t.id == thread)
    .map(|t| t.title)
    .unwrap_or_default()
}

/// The catalog's title once the side request has had time to land.
async fn settled_title(c: &Client, thread: &str) -> String {
    let mut last = String::new();
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let now = title(c, thread).await;
        if !now.is_empty() && now == last {
            return now;
        }
        last = now;
    }
    last
}

#[tokio::test]
async fn a_first_message_that_is_more_than_a_name_is_named_by_the_model() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![turn("好的，我来改。"), turn("修复会话标题生成")]).await;
    let c = connect(&run(dir.path()).await, "t").await;
    provider(&c, &format!("{}/v1", mock.url)).await;
    let thread = thread_with_model(&c).await;
    send(
        &c,
        &thread,
        "现在新会话没有正常生成标题 需要按照 electron 版本的标题生成插件做一下",
    )
    .await;

    assert_eq!(
        settled_title(&c, &thread).await,
        "修复会话标题生成",
        "the prompt's first line is only the fallback"
    );
    let captured = mock.captured.lock().unwrap();
    assert_eq!(captured.len(), 2, "one turn, one naming request");
    let naming = &captured[1];
    assert_eq!(naming.body["max_tokens"], 128);
    let system = naming.body["messages"][0]["content"]
        .as_str()
        .unwrap_or_default();
    assert!(system.contains("You name chat sessions"), "{system}");
    let prompt = naming.body["messages"][1]["content"]
        .as_str()
        .unwrap_or_default();
    assert!(prompt.contains("electron 版本"), "{prompt}");
}

#[tokio::test]
async fn a_short_first_message_is_already_the_title_and_costs_no_request() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![turn("好")]).await;
    let c = connect(&run(dir.path()).await, "t").await;
    provider(&c, &format!("{}/v1", mock.url)).await;
    let thread = thread_with_model(&c).await;
    send(&c, &thread, "修一下标题").await;

    assert_eq!(settled_title(&c, &thread).await, "修一下标题");
    assert_eq!(
        mock.captured.lock().unwrap().len(),
        1,
        "the fallback already is the title"
    );
}

#[tokio::test]
async fn an_answer_that_is_a_sentence_leaves_the_fallback_alone() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![
        turn("好的"),
        turn("The user is asking me to fix how chat titles are generated here"),
        turn("Still explaining instead of naming the chat"),
    ])
    .await;
    let c = connect(&run(dir.path()).await, "t").await;
    provider(&c, &format!("{}/v1", mock.url)).await;
    let thread = thread_with_model(&c).await;
    let prompt = "请把会话标题的生成按 electron 版的插件重做一遍，注意重试与短消息";
    send(&c, &thread, prompt).await;

    assert_eq!(settled_title(&c, &thread).await, prompt);
    assert_eq!(
        mock.captured.lock().unwrap().len(),
        3,
        "a prose answer is asked again once, then the fallback stays"
    );
}

#[tokio::test]
async fn a_later_message_never_renames_the_chat() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![
        turn("好"),
        turn("修复会话标题生成"),
        turn("第二条回复"),
        turn("这个名字不该被用上"),
    ])
    .await;
    let c = connect(&run(dir.path()).await, "t").await;
    provider(&c, &format!("{}/v1", mock.url)).await;
    let thread = thread_with_model(&c).await;
    send(
        &c,
        &thread,
        "现在新会话没有正常生成标题 需要按照 electron 版本做一下",
    )
    .await;
    assert_eq!(settled_title(&c, &thread).await, "修复会话标题生成");

    send(
        &c,
        &thread,
        "再补一句说明，让这条消息足够长到会被当成命名材料",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(title(&c, &thread).await, "修复会话标题生成");
}

#[tokio::test]
async fn a_rename_while_the_request_is_out_wins() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![turn("好"), turn("模型起的名字")]).await;
    let c = connect(&run(dir.path()).await, "t").await;
    provider(&c, &format!("{}/v1", mock.url)).await;
    let thread = thread_with_model(&c).await;
    send(
        &c,
        &thread,
        "现在新会话没有正常生成标题 需要按照 electron 版本做一下",
    )
    .await;
    c.call::<ThreadUpdate>(ThreadUpdateParams {
        thread_id: thread.clone(),
        title: Some("我自己起的名字".into()),
        archived: None,
        pinned: None,
    })
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(title(&c, &thread).await, "我自己起的名字");
}

/// The client is told, so the sidebar redraws the row without a manual refresh.
#[tokio::test]
async fn every_client_hears_the_new_name() {
    let dir = tempfile::tempdir().unwrap();
    let mock = serve(vec![turn("好"), turn("修复会话标题生成")]).await;
    let sock = run(dir.path()).await;
    let a = connect(&sock, "a").await;
    let (b, mut notes) = Client::connect_unix(&sock).await.unwrap();
    b.call::<Initialize>(InitializeParams {
        client_info: ClientInfo {
            name: "b".into(),
            version: "0".into(),
        },
        protocol_version: PROTOCOL_VERSION,
        capabilities: Default::default(),
    })
    .await
    .unwrap();
    provider(&a, &format!("{}/v1", mock.url)).await;
    let thread = thread_with_model(&a).await;
    send(
        &a,
        &thread,
        "现在新会话没有正常生成标题 需要按照 electron 版本做一下",
    )
    .await;

    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let n = notes.recv().await.expect("closed");
            if matches!(n, ServerNotification::CatalogChanged(_))
                && title(&b, &thread).await == "修复会话标题生成"
            {
                return;
            }
        }
    })
    .await
    .expect("the name reaches the other client");
}
