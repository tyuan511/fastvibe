mod common;

use common::*;
use fv_agent::{ModelEvent, ModelRequest, ToolSpec};
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};
use fv_provider::{GenaiModel, ModelConfig, Protocol};
use serde_json::json;

const TURN: &str = r#"data: {"candidates":[{"content":{"role":"model","parts":[{"text":"The file is small.","thought":true}]}}],"usageMetadata":{"promptTokenCount":40,"totalTokenCount":40}}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Reading a.txt."}]}}],"usageMetadata":{"promptTokenCount":40,"totalTokenCount":40}}

data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read","args":{"path":"a.txt"}},"thoughtSignature":"gem-sig"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":6,"totalTokenCount":52,"cachedContentTokenCount":15,"thoughtsTokenCount":6}}

"#;

fn config(url: &str) -> ModelConfig {
    // Typed the way a relay is: with /v1, which Google's API calls v1beta.
    ModelConfig::new(
        "relay/gemini-test",
        "gemini-test",
        Protocol::Google,
        &format!("{url}/v1"),
        "g-key",
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
async fn a_gemini_turn_keeps_its_thought_signature() {
    let mock = serve(vec![Reply::sse(TURN)]).await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    let events = events(collect(&model, request()).await);

    assert!(events.contains(&ModelEvent::Text("Reading a.txt.".into())));
    let arguments: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            ModelEvent::ToolCallArgs { delta, .. } => {
                Some(serde_json::from_str::<serde_json::Value>(delta).unwrap())
            }
            _ => None,
        })
        .collect();
    assert_eq!(arguments, [json!({"path":"a.txt"})]);
    let msg = done(&events);
    assert_eq!(msg.stop, StopReason::ToolUse);
    assert!(
        msg.content.iter().any(|b| matches!(b, ContentBlock::ToolCall { name, arguments, .. } if name == "read" && arguments == &json!({"path": "a.txt"}))),
        "{:?}",
        msg.content
    );
    // Gemini requires the signature back on the next request or it refuses the tool turn.
    assert!(
        msg.content.iter().any(
            |b| matches!(b, ContentBlock::Thinking { signature: Some(s), .. } if s == "gem-sig")
        ),
        "{:?}",
        msg.content
    );
    assert_eq!(msg.usage.cache_read_tokens, 15);
    assert_eq!(msg.usage.input_tokens, 25);
}

#[tokio::test]
async fn the_request_uses_v1beta_the_model_path_and_the_google_key_header() {
    let mock = serve(vec![Reply::sse(TURN), Reply::sse(TURN)]).await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    collect(&model, request()).await;

    let mut second = request();
    second.messages.push(Message::Assistant(AssistantMessage {
        duration_ms: None,
        content: vec![
            ContentBlock::Thinking {
                text: String::new(),
                signature: Some("gem-sig".into()),
            },
            ContentBlock::ToolCall {
                id: "call_1".into(),
                name: "read".into(),
                arguments: json!({"path": "a.txt"}),
            },
        ],
        stop: StopReason::ToolUse,
        usage: Default::default(),
        model: Some("relay/gemini-test".into()),
    }));
    second.messages.push(Message::ToolResult {
        call_id: "call_1".into(),
        name: "read".into(),
        content: "hello".into(),
        is_error: false,
    });
    collect(&model, second).await;

    let sent = mock.captured.lock().unwrap().clone();
    assert_eq!(
        sent[0].path,
        "/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
    );
    assert_eq!(sent[0].header("x-goog-api-key"), Some("g-key"));
    assert!(sent[0].body["tools"].to_string().contains("\"read\""));
    assert!(
        sent[0].body["systemInstruction"]
            .to_string()
            .contains("Be brief.")
    );

    let contents = sent[1].body["contents"].to_string();
    assert!(
        contents.contains("gem-sig"),
        "thought signature not sent back: {contents}"
    );
    assert!(
        contents.contains("functionCall") && contents.contains("functionResponse"),
        "{contents}"
    );
}
