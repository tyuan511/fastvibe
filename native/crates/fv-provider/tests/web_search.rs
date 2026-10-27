mod common;
use common::*;
use fv_agent::{Model, ModelEvent, ModelRequest, ToolSpec};
use fv_core::{ContentBlock, Message, SearchStatus, StopReason};
use fv_provider::{GenaiModel, ModelConfig, Protocol};
use serde_json::{Value, json};
fn event(kind: &str, payload: Value) -> String {
    format!("event: {kind}\ndata: {payload}\n\n")
}
fn reply() -> String {
    let call = json!({"id":"ws","type":"web_search_call","status":"completed","action":{"type":"search","queries":["latest native docs"],"sources":[{"type":"url","url":"https://example.com/docs","title":"Docs"},{"type":"url","url":"javascript:evil","title":"unsafe"}]}});
    let citation = json!({"type":"url_citation","start_index":1,"end_index":3,"url":"https://example.com/docs","title":"Docs"});
    let text = "😀中文 answer";
    let message = json!({"id":"msg","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[citation]}]});
    [event("response.web_search_call.in_progress",json!({"type":"response.web_search_call.in_progress","item_id":"ws","output_index":0})),event("response.web_search_call.searching",json!({"type":"response.web_search_call.searching","item_id":"ws","output_index":0})),event("response.output_item.done",json!({"type":"response.output_item.done","output_index":0,"item":call})),event("response.output_text.delta",json!({"type":"response.output_text.delta","item_id":"msg","output_index":1,"content_index":0,"delta":text})),event("response.output_text.annotation.added",json!({"type":"response.output_text.annotation.added","item_id":"msg","output_index":1,"content_index":0,"annotation_index":0,"annotation":citation})),event("response.output_item.done",json!({"type":"response.output_item.done","output_index":1,"item":message})),event("response.completed",json!({"type":"response.completed","response":{"id":"resp","status":"completed","model":"gpt-test","output":[call,message],"usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}))].concat()
}
fn config(url: &str, protocol: Protocol) -> ModelConfig {
    let mut c = ModelConfig::new(
        "custom/gpt-test",
        "gpt-test",
        protocol,
        url,
        "search-test-key",
    );
    c.web_search = true;
    c.max_retries = 0;
    c
}
fn request() -> ModelRequest {
    ModelRequest {
        system: "Search when useful.".into(),
        messages: vec![Message::User {
            text: "Find current docs".into(),
        }],
        tools: vec![
            ToolSpec {
                name: "web_search".into(),
                description: "hosted".into(),
                schema: json!({"type":"object"}),
            },
            ToolSpec {
                name: "local_tool".into(),
                description: "local".into(),
                schema: json!({"type":"object"}),
            },
        ],
        max_output_tokens: None,
    }
}
#[tokio::test]
async fn hosted_search_coexists_with_local_functions_and_retains_sources_citations_and_usage() {
    let mock = serve(vec![Reply::sse(&reply())]).await;
    let model = GenaiModel::new(config(&mock.url, Protocol::OpenAiResponses)).unwrap();
    assert!(model.supports_web_search());
    let all = events(collect(&model, request()).await);
    let reply = done(&all);
    assert!(
        matches!(all.first(),Some(ModelEvent::HostedSearch(c))if c.status==SearchStatus::InProgress)
    );
    assert_eq!(reply.text(), "😀[中文](<https://example.com/docs>) answer");
    assert_eq!(reply.tool_calls().count(), 0);
    let calls = reply
        .content
        .iter()
        .filter_map(|b| {
            if let ContentBlock::HostedSearch(c) = b {
                Some(c)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].status, SearchStatus::Completed);
    assert_eq!(calls[0].sources.len(), 1);
    assert_eq!(reply.usage.input_tokens, 12);
    assert_eq!(reply.usage.output_tokens, 4);
    let captured = mock.captured.lock().unwrap();
    let request = &captured[0];
    assert_eq!(request.path, "/responses");
    assert_eq!(
        request.header("authorization"),
        Some("Bearer search-test-key")
    );
    let tools = request.body["tools"].as_array().unwrap();
    assert!(tools.iter().any(|t| t["type"] == "web_search"));
    assert!(
        tools
            .iter()
            .any(|t| t["type"] == "function" && t["name"] == "local_tool")
    );
    assert!(
        !tools
            .iter()
            .any(|t| t["type"] == "function" && t["name"] == "web_search")
    );
    let include = request.body["include"].as_array().unwrap();
    assert!(include.contains(&json!("reasoning.encrypted_content")));
    assert!(include.contains(&json!("web_search_call.action.sources")));
}
#[tokio::test]
async fn a_disabled_model_or_removed_grant_and_other_protocols_never_send_hosted_search() {
    let plain = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"status\":\"completed\",\"output\":[]}}\n\n";
    let mock = serve(vec![Reply::sse(plain), Reply::sse(plain)]).await;
    let mut c = config(&mock.url, Protocol::OpenAiResponses);
    c.web_search = false;
    let _ = collect(&GenaiModel::new(c).unwrap(), request()).await;
    let mut r = request();
    r.tools.retain(|t| t.name != "web_search");
    let _ = collect(
        &GenaiModel::new(config(&mock.url, Protocol::OpenAiResponses)).unwrap(),
        r,
    )
    .await;
    for captured in mock.captured.lock().unwrap().iter() {
        assert!(
            captured.body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["name"] != "web_search" && t["type"] != "web_search")
        );
        assert!(
            !captured.body["include"]
                .as_array()
                .unwrap()
                .contains(&json!("web_search_call.action.sources"))
        );
    }
    let chat = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let mock = serve(vec![Reply::sse(chat)]).await;
    let model = GenaiModel::new(config(&mock.url, Protocol::OpenAiChat)).unwrap();
    assert!(!model.supports_web_search());
    let _ = collect(&model, request()).await;
    assert_eq!(
        mock.captured.lock().unwrap()[0].body["tools"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[tokio::test]
async fn full_output_without_deltas_is_authoritative_and_hosted_metadata_is_not_replayed_as_a_function()
 {
    let message = json!({"id":"m","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"final only","annotations":[{"type":"url_citation","start_index":0,"end_index":5,"url":"https://example.com","title":"Source"}]}]});
    let body = event(
        "response.completed",
        json!({"type":"response.completed","response":{"id":"r","status":"completed","model":"gpt-test","output":[message]}}),
    );
    let mock = serve(vec![Reply::sse(&body), Reply::sse(&body)]).await;
    let model = GenaiModel::new(config(&mock.url, Protocol::OpenAiResponses)).unwrap();
    let first = done(&events(collect(&model, request()).await)).clone();
    assert_eq!(first.text(), "[final](<https://example.com/>) only");
    let mut next = request();
    next.messages.push(Message::Assistant(first));
    let _ = collect(&model, next).await;
    let captured = mock.captured.lock().unwrap();
    let input = captured[1].body["input"].as_array().unwrap();
    assert!(
        !input
            .iter()
            .any(|i| i["type"] == "function_call" || i["type"] == "function_call_output")
    );
}
#[tokio::test]
async fn a_truncated_search_is_not_reported_as_a_success() {
    let body = event(
        "response.web_search_call.in_progress",
        json!({"type":"response.web_search_call.in_progress","item_id":"ws","output_index":0}),
    );
    let mock = serve(vec![Reply::sse(&body)]).await;
    let model = GenaiModel::new(config(&mock.url, Protocol::OpenAiResponses)).unwrap();
    let all = collect(&model, request()).await;
    assert!(
        all.iter()
            .any(|e| matches!(e, Ok(ModelEvent::HostedSearch(_))))
    );
    assert!(all.iter().any(|e| e.is_err()
        || matches!(e,Ok(ModelEvent::Done(a))if matches!(a.stop,StopReason::Error{..}))));
    assert_eq!(mock.captured.lock().unwrap().len(), 1);
}

// A peer which stops after search progress. This exercises the live metadata path:
// genai has produced no normalized text/tool event yet.
async fn stalled_peer(close_early: bool) -> (String, tokio::task::JoinHandle<usize>) {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            buf.extend_from_slice(&chunk[..n]);
            if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..at]);
                let len = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if buf.len() >= at + 4 + len {
                    break;
                }
            }
        }
        let progress = event(
            "response.web_search_call.in_progress",
            json!({"type":"response.web_search_call.in_progress","item_id":"live","output_index":0}),
        );
        socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 100000\r\nconnection: close\r\n\r\n{progress}").as_bytes()).await.unwrap();
        if close_early {
            socket.shutdown().await.unwrap();
            drop(socket);
            // Retry backoff is below one second. Observe the listening socket too,
            // rather than confusing connection-refused retries with no retry.
            usize::from(
                tokio::time::timeout(std::time::Duration::from_secs(1), listener.accept())
                    .await
                    .is_ok(),
            ) + 1
        } else {
            let closed =
                tokio::time::timeout(std::time::Duration::from_secs(3), socket.read(&mut chunk))
                    .await
                    .unwrap();
            assert!(
                matches!(closed, Ok(0) | Err(_)),
                "dropping the stream must close the pending HTTP body"
            );
            1
        }
    });
    (url, task)
}
#[tokio::test]
async fn search_progress_is_delivered_before_text_and_drop_cancels_the_request() {
    use futures_util::StreamExt;
    let (url, peer) = stalled_peer(false).await;
    let model = GenaiModel::new(config(&url, Protocol::OpenAiResponses)).unwrap();
    let mut stream = model.stream(request());
    let first = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(first, ModelEvent::HostedSearch(c) if c.status == SearchStatus::InProgress));
    drop(stream);
    assert_eq!(peer.await.unwrap(), 1);
}
#[tokio::test]
async fn a_transport_failure_after_hosted_activity_is_never_retried() {
    let (url, peer) = stalled_peer(true).await;
    let mut cfg = config(&url, Protocol::OpenAiResponses);
    cfg.max_retries = 2;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        collect(&GenaiModel::new(cfg).unwrap(), request()),
    )
    .await
    .unwrap();
    assert!(
        result
            .iter()
            .any(|e| matches!(e, Ok(ModelEvent::HostedSearch(_))))
    );
    assert!(result.iter().any(|e| e.is_err()
        || matches!(e, Ok(ModelEvent::Done(a)) if matches!(a.stop,StopReason::Error{..}))));
    assert_eq!(peer.await.unwrap(), 1);
}

#[tokio::test]
async fn citations_use_content_part_offsets_even_before_text_done_arrives() {
    let a = json!({"type":"url_citation","start_index":0,"end_index":2,"url":"https://example.com/docs","title":"Docs"});
    let body = [
        event("response.output_text.delta",json!({"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"😀Intro "})),
        event("response.output_text.delta",json!({"type":"response.output_text.delta","output_index":1,"content_index":1,"delta":"中文 result"})),
        event("response.output_text.annotation.added",json!({"type":"response.output_text.annotation.added","output_index":1,"content_index":1,"annotation":a})),
        event("response.completed",json!({"type":"response.completed","response":{"id":"r","status":"completed","output":[]}})),
    ].concat();
    let mock = serve(vec![Reply::sse(&body)]).await;
    let all = events(
        collect(
            &GenaiModel::new(config(&mock.url, Protocol::OpenAiResponses)).unwrap(),
            request(),
        )
        .await,
    );
    assert_eq!(
        done(&all).text(),
        "😀Intro [中文](<https://example.com/docs>) result"
    );
    assert!(all.iter().any(
        |e| matches!(e, ModelEvent::Citations(c) if c[0].start_index==7 && c[0].end_index==9)
    ));
}
