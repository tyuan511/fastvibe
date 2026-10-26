mod common;
use common::{Reply, serve};
use fv_provider::{
    GenaiModel, ModelConfig, ProbeBudget, ProbeError, ProbeStatus, ProbeTools, Protocol,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
fn model(url: &str) -> GenaiModel {
    let mut cfg = ModelConfig::new(
        "p/m",
        "m",
        Protocol::OpenAiChat,
        &format!("{url}/v1"),
        "probe-private-key",
    );
    cfg.max_retries = 10;
    GenaiModel::new(cfg).unwrap()
}
fn text() -> String {
    "data: {\"id\":\"p\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".into()
}
fn tool(name: &str, value: serde_json::Value) -> String {
    let arguments = serde_json::json!({"value":value}).to_string();
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        serde_json::json!({"id":"p","object":"chat.completion.chunk","created":1,"model":"m",
        "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-p","type":"function","function":{"name":name,"arguments":arguments}}]},"finish_reason":"tool_calls"}]})
    )
}
#[tokio::test]
async fn two_isolated_calls_check_text_and_exact_tool_arguments_without_any_tool_results() {
    let mock = serve(vec![
        Reply::sse(&text()),
        Reply::sse(&tool("fastvibe_probe", serde_json::json!("ok"))),
    ])
    .await;
    let result = model(&mock.url).probe(ProbeBudget::default()).await;
    assert_eq!(result.status, ProbeStatus::Passed);
    assert_eq!(result.tools, ProbeTools::Passed);
    assert_eq!(result.error, None);
    assert!(result.first_token_ms.is_some());
    let sent = mock.captured.lock().unwrap();
    assert_eq!(sent.len(), 2);
    assert!(
        sent[0].body.get("tools").is_none()
            || sent[0].body["tools"].as_array().is_some_and(Vec::is_empty)
    );
    assert_eq!(
        sent[1].body["tools"][0]["function"]["name"],
        "fastvibe_probe"
    );
    assert_eq!(
        sent[1].body["tools"][0]["function"]["parameters"]["properties"]["value"]["enum"][0],
        "ok"
    );
    for request in sent.iter() {
        assert_eq!(
            request.header("authorization"),
            Some("Bearer probe-private-key")
        );
        assert!(
            request.body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m["role"] == "user")
        );
        let max = request.body["max_tokens"]
            .as_u64()
            .or_else(|| request.body["max_completion_tokens"].as_u64())
            .unwrap();
        assert!(max <= 256);
        assert!(
            request.body.get("reasoning_effort").is_none(),
            "no guessed thinking-off parameter"
        );
    }
}
#[tokio::test]
async fn text_instead_of_tools_wrong_tool_or_wrong_literal_never_becomes_a_pass() {
    for second in [
        text(),
        tool("exec_command", serde_json::json!("ok")),
        tool("fastvibe_probe", serde_json::json!("wrong")),
        tool("fastvibe_probe", serde_json::json!(true)),
    ] {
        let mock = serve(vec![Reply::sse(&text()), Reply::sse(&second)]).await;
        let result = model(&mock.url).probe(ProbeBudget::default()).await;
        assert_eq!(result.status, ProbeStatus::Partial);
        assert_eq!(result.tools, ProbeTools::Unconfirmed);
        assert_eq!(result.error, None);
        assert_eq!(mock.captured.lock().unwrap().len(), 2);
    }
}
#[tokio::test]
async fn typed_http_failures_are_redacted_classified_and_never_retried() {
    for (status, code) in [
        (401, ProbeError::Auth),
        (403, ProbeError::Auth),
        (429, ProbeError::RateLimit),
        (400, ProbeError::Protocol),
        (404, ProbeError::Protocol),
        (405, ProbeError::Protocol),
        (422, ProbeError::Protocol),
        (408, ProbeError::Timeout),
        (503, ProbeError::Unknown),
    ] {
        let mock = serve(vec![Reply::status(
            status,
            "private response probe-private-key 401 429 TLS connect",
        )])
        .await;
        let result = model(&mock.url).probe(ProbeBudget::default()).await;
        assert_eq!(result.status, ProbeStatus::Failed);
        assert_eq!(result.tools, ProbeTools::NotTested);
        assert_eq!(result.error, Some(code));
        assert!(!format!("{result:?}").contains("private"));
        assert_eq!(
            mock.captured.lock().unwrap().len(),
            1,
            "a diagnostic does not retry even when the normal model does"
        );
    }
}
#[tokio::test]
async fn a_failed_tool_probe_is_partial_and_bad_or_empty_streams_do_not_pass() {
    let mock = serve(vec![
        Reply::sse(&text()),
        Reply::status(422, "private bad schema"),
    ])
    .await;
    let result = model(&mock.url).probe(ProbeBudget::default()).await;
    assert_eq!(result.status, ProbeStatus::Partial);
    assert_eq!(result.tools, ProbeTools::Failed);
    assert_eq!(result.error, Some(ProbeError::Protocol));
    for body in ["", "data: [DONE]\n\n", "data: not-json\n\n"] {
        let mock = serve(vec![Reply::sse(body)]).await;
        let result = model(&mock.url).probe(ProbeBudget::default()).await;
        assert_eq!(result.status, ProbeStatus::Failed);
        assert_ne!(result.tools, ProbeTools::Passed);
        assert_eq!(mock.captured.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn streaming_errors_after_text_are_not_misreported_as_a_working_model() {
    let body = "data: {\"id\":\"p\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\ndata: {\"error\":{\"message\":\"probe-private-key\",\"code\":\"bad_request\"}}\n\n";
    let mock = serve(vec![Reply::sse(body)]).await;
    let result = model(&mock.url).probe(ProbeBudget::default()).await;
    assert_eq!(result.status, ProbeStatus::Failed);
    assert!(result.error.is_some());
    assert_eq!(mock.captured.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn an_overlong_reply_is_cut_short_instead_of_accumulating_unbounded_text() {
    let body = format!(
        "data: {}\n\n",
        serde_json::json!({"id":"p","object":"chat.completion.chunk","created":1,"model":"m",
        "choices":[{"index":0,"delta":{"content":"x".repeat(128*1024+1)},"finish_reason":null}]})
    );
    let mock = serve(vec![Reply::sse(&body)]).await;
    let result = model(&mock.url).probe(ProbeBudget::default()).await;
    assert_eq!(result.status, ProbeStatus::Failed);
    assert_eq!(result.error, Some(ProbeError::Protocol));
}
async fn hanging(
    body: Option<String>,
) -> (
    String,
    tokio::task::JoinHandle<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (seen, ready) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut b = [0; 16384];
        let _ = s.read(&mut b).await.unwrap();
        let _ = seen.send(());
        if let Some(body) = body {
            s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n",body.len()).as_bytes()).await.unwrap();
        }
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), s.read_to_end(&mut rest))
            .await
            .expect("cancelled stream closes its socket")
            .unwrap();
    });
    (format!("http://{addr}"), task, ready)
}
#[tokio::test]
async fn header_and_total_deadlines_cancel_the_live_connection() {
    let (url, server, _ready) = hanging(None).await;
    let report = model(&url)
        .probe(ProbeBudget {
            request: Duration::from_millis(150),
            total: Duration::from_secs(1),
            ..Default::default()
        })
        .await;
    assert_eq!(report.error, Some(ProbeError::Timeout));
    assert!(report.elapsed_ms < 1500);
    server.await.unwrap();
    let (url, server, _ready) = hanging(Some(": ping\n\n".into())).await;
    let report = model(&url)
        .probe(ProbeBudget {
            request: Duration::from_secs(2),
            total: Duration::from_millis(150),
            ..Default::default()
        })
        .await;
    assert_eq!(report.error, Some(ProbeError::Timeout));
    assert!(report.elapsed_ms < 1500);
    server.await.unwrap();
}
#[tokio::test]
async fn a_dropped_test_future_cancels_the_request_and_network_failures_are_safe() {
    let (url, server, ready) = hanging(None).await;
    let probe_model = std::sync::Arc::new(model(&url));
    let task = {
        let model = probe_model.clone();
        tokio::spawn(async move { model.probe(ProbeBudget::default()).await })
    };
    tokio::time::timeout(Duration::from_secs(3), ready)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    server.await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let result = model(&format!("http://{addr}"))
        .probe(ProbeBudget::default())
        .await;
    assert_eq!(result.error, Some(ProbeError::Network));
}
#[tokio::test]
async fn diagnostics_use_each_of_the_four_protocols_and_portable_literal_schemas() {
    let anthropic_text = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"a\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"m\",\"content\":[],\"usage\":{\"input_tokens\":5,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    let anthropic_tool = anthropic_text
        .replace(
            "{\"type\":\"text\",\"text\":\"\"}",
            "{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"fastvibe_probe\",\"input\":{}}",
        )
        .replace(
            "{\"type\":\"text_delta\",\"text\":\"OK\"}",
            "{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"value\\\":\\\"ok\\\"}\"}",
        )
        .replace("end_turn", "tool_use");
    let gemini_text = "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"OK\"}]},\"finishReason\":\"STOP\"}]}\n\n";
    let gemini_tool = "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"functionCall\":{\"name\":\"fastvibe_probe\",\"args\":{\"value\":\"ok\"}}}]},\"finishReason\":\"STOP\"}]}\n\n";
    let responses_text = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"m\",\"output\":[]}}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg\",\"role\":\"assistant\",\"status\":\"in_progress\",\"content\":[]}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"output_index\":0,\"content_index\":0,\"delta\":\"OK\"}\n\nevent: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"OK\",\"annotations\":[]}]}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"object\":\"response\",\"model\":\"m\",\"status\":\"completed\",\"output\":[]}}\n\n";
    let responses_tool = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"m\",\"output\":[]}}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc\",\"call_id\":\"call\",\"name\":\"fastvibe_probe\",\"arguments\":\"\",\"status\":\"in_progress\"}}\n\nevent: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc\",\"output_index\":0,\"delta\":\"{\\\"value\\\":\\\"ok\\\"}\"}\n\nevent: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc\",\"call_id\":\"call\",\"name\":\"fastvibe_probe\",\"arguments\":\"{\\\"value\\\":\\\"ok\\\"}\",\"status\":\"completed\"}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"object\":\"response\",\"model\":\"m\",\"status\":\"completed\",\"output\":[]}}\n\n";
    for (protocol, first, second, path) in [
        (
            Protocol::OpenAiChat,
            text(),
            tool("fastvibe_probe", serde_json::json!("ok")),
            "/v1/chat/completions",
        ),
        (
            Protocol::OpenAiResponses,
            responses_text.into(),
            responses_tool.into(),
            "/v1/responses",
        ),
        (
            Protocol::Anthropic,
            anthropic_text.into(),
            anthropic_tool,
            "/v1/messages",
        ),
        (
            Protocol::Google,
            gemini_text.into(),
            gemini_tool.into(),
            "/v1beta/models/m:streamGenerateContent",
        ),
    ] {
        let mock = serve(vec![Reply::sse(&first), Reply::sse(&second)]).await;
        let cfg = ModelConfig::new(
            "p/m",
            "m",
            protocol,
            &format!("{}/v1", mock.url),
            "private-key",
        );
        let result = GenaiModel::new(cfg)
            .unwrap()
            .probe(ProbeBudget::default())
            .await;
        assert_eq!(
            result.status,
            ProbeStatus::Passed,
            "{protocol:?} {result:?}"
        );
        let sent = mock.captured.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|r| r.path.starts_with(path)));
        let schema = match protocol {
            Protocol::OpenAiChat => &sent[1].body["tools"][0]["function"]["parameters"],
            Protocol::OpenAiResponses => &sent[1].body["tools"][0]["parameters"],
            Protocol::Anthropic => &sent[1].body["tools"][0]["input_schema"],
            Protocol::Google => {
                &sent[1].body["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"]
            }
        };
        assert_eq!(
            schema["properties"]["value"]["enum"][0], "ok",
            "{protocol:?} {}",
            sent[1].body
        );
    }
}

#[tokio::test]
async fn a_tool_deadline_keeps_partial_success_and_heartbeats_do_not_extend_it() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let beats = Arc::new(AtomicUsize::new(0));
    let emitted = beats.clone();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let mut data = [0; 16384];
        let _ = first.read(&mut data).await.unwrap();
        let body = text();
        first.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        drop(first);
        let (mut stream, _) = listener.accept().await.unwrap();
        let _ = stream.read(&mut data).await.unwrap();
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                tokio::select! {
                    n=stream.read(&mut data)=>{if !matches!(n,Ok(n) if n>0) {break;}},
                    _=tokio::time::sleep(Duration::from_millis(20))=>{
                        if stream.write_all(b"8\r\n: ping\n\n\r\n").await.is_err(){break;}
                        emitted.fetch_add(1,Ordering::Relaxed);
                    },
                }
            }
        })
        .await
        .expect("timed out request closes the chatty stream");
    });
    let report = model(&url)
        .probe(ProbeBudget {
            request: Duration::from_millis(350),
            total: Duration::from_secs(2),
            ..Default::default()
        })
        .await;
    assert_eq!(report.status, ProbeStatus::Partial);
    assert_eq!(report.tools, ProbeTools::Failed);
    assert_eq!(report.error, Some(ProbeError::Timeout));
    assert!(report.first_token_ms.is_some());
    assert!(report.elapsed_ms < 1500);
    server.await.unwrap();
    assert!(beats.load(Ordering::Relaxed) >= 3);
}
