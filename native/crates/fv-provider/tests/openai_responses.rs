mod common;

use common::*;
use fv_agent::{ModelEvent, ModelRequest, ToolSpec};
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};
use fv_provider::{GenaiModel, ModelConfig, Protocol};
use serde_json::json;

const TURN: &str = r#"event: response.created
data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-test","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}

event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":"Planning the read."}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"Planning the read."}],"encrypted_content":"enc-xyz"}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"On it."}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"On it.","annotations":[]}]}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"","status":"in_progress"}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\"path\":\"a.txt\"}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":2,"arguments":"{\"path\":\"a.txt\"}"}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"{\"path\":\"a.txt\"}","status":"completed"}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-test","output":[],"usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":20},"output_tokens":10,"output_tokens_details":{"reasoning_tokens":4},"total_tokens":60}}}

"#;

fn config(url: &str) -> ModelConfig {
    ModelConfig::new(
        "relay/gpt-test",
        "gpt-test",
        Protocol::OpenAiResponses,
        &format!("{url}/v1"),
        "sk-test",
    )
}

fn request() -> ModelRequest {
    ModelRequest {
        max_output_tokens: None,
        system: "Be brief.".into(),
        messages: vec![Message::User {
            text: "read a.txt".into(),
        }],
        tools: vec![ToolSpec {
            name: "read".into(),
            description: "Read a file".into(),
            schema: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        }],
    }
}

#[tokio::test]
async fn a_responses_turn_comes_back_as_blocks_with_usage() {
    let mock = serve(vec![Reply::sse(TURN)]).await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    let events = events(collect(&model, request()).await);

    assert!(events.contains(&ModelEvent::Text("On it.".into())));
    let msg = done(&events);
    assert_eq!(msg.stop, StopReason::ToolUse);
    let kinds: Vec<&str> = msg
        .content
        .iter()
        .map(|b| match b {
            ContentBlock::Thinking { .. } => "thinking",
            ContentBlock::Text { .. } => "text",
            ContentBlock::ToolCall { .. } => "tool",
        })
        .collect();
    assert_eq!(kinds, ["thinking", "text", "tool"], "{:?}", msg.content);
    assert!(
        matches!(&msg.content[2], ContentBlock::ToolCall { id, name, arguments } if id == "call_1" && name == "read" && arguments == &json!({"path": "a.txt"}))
    );
    // The encrypted reasoning has to survive to be sent back on the next request.
    assert!(
        matches!(&msg.content[0], ContentBlock::Thinking { signature: Some(s), .. } if s == "enc-xyz"),
        "{:?}",
        msg.content[0]
    );
    assert_eq!(msg.usage.input_tokens, 30);
    assert_eq!(msg.usage.cache_read_tokens, 20);
    assert_eq!(msg.usage.output_tokens, 10);
}

#[tokio::test]
async fn the_request_goes_to_responses_and_carries_the_encrypted_reasoning_back() {
    let mock = serve(vec![Reply::sse(TURN), Reply::sse(TURN)]).await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    collect(&model, request()).await;

    let mut second = request();
    second.messages.push(Message::Assistant(AssistantMessage {
        duration_ms: None,
        content: vec![
            ContentBlock::Thinking {
                text: "Planning the read.".into(),
                signature: Some("enc-xyz".into()),
            },
            ContentBlock::ToolCall {
                id: "call_1".into(),
                name: "read".into(),
                arguments: json!({"path": "a.txt"}),
            },
        ],
        stop: StopReason::ToolUse,
        usage: Default::default(),
        model: Some("relay/gpt-test".into()),
    }));
    second.messages.push(Message::ToolResult {
        call_id: "call_1".into(),
        name: "read".into(),
        content: "hello".into(),
        is_error: false,
    });
    collect(&model, second).await;

    let sent = mock.captured.lock().unwrap().clone();
    assert_eq!(sent[0].path, "/v1/responses");
    assert_eq!(sent[0].header("authorization"), Some("Bearer sk-test"));
    assert_eq!(sent[0].body["model"], "gpt-test");
    assert_eq!(sent[0].body["stream"], true);
    assert_eq!(sent[0].body["store"], false);

    let input = sent[1].body["input"].to_string();
    assert!(
        input.contains("enc-xyz"),
        "encrypted reasoning not replayed: {input}"
    );
    assert!(
        input.contains("function_call") && input.contains("call_1"),
        "{input}"
    );
    assert!(
        input.contains("function_call_output") && input.contains("hello"),
        "{input}"
    );
}
