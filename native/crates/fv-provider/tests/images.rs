//! Pictures a tool returned, as each protocol's request carries them.

mod common;

use base64::Engine;
use common::*;
use fv_agent::{ModelRequest, ToolSpec};
use fv_core::{AssistantMessage, ContentBlock, ImagePart, ImageSource, Message, StopReason};
use fv_provider::{GenaiModel, ModelConfig, Protocol};
use serde_json::{Value, json};

/// 1x1 transparent PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xff, 0xff, 0x3f,
    0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn request(source: ImageSource) -> ModelRequest {
    ModelRequest {
        system: "sys".into(),
        messages: vec![
            Message::User {
                text: "look at a.png and list the dir".into(),
            },
            Message::Assistant(AssistantMessage {
                content: vec![
                    ContentBlock::ToolCall {
                        id: "p1".into(),
                        name: "view_image".into(),
                        arguments: json!({"path": "a.png"}),
                    },
                    ContentBlock::ToolCall {
                        id: "f1".into(),
                        name: "exec_command".into(),
                        arguments: json!({"cmd": "ls"}),
                    },
                ],
                stop: StopReason::ToolUse,
                usage: Default::default(),
                model: Some("p/m".into()),
            }),
            Message::ToolResult {
                call_id: "p1".into(),
                name: "view_image".into(),
                content: "Image loaded: a.png (1x1, 1 KB)".into(),
                is_error: false,
            },
            Message::ToolResult {
                call_id: "f1".into(),
                name: "exec_command".into(),
                content: "a.png".into(),
                is_error: false,
            },
            Message::ToolImages {
                call_id: "p1".into(),
                name: "view_image".into(),
                images: vec![ImagePart {
                    mime: "image/png".into(),
                    source,
                }],
            },
        ],
        tools: vec![ToolSpec {
            name: "view_image".into(),
            description: "d".into(),
            schema: json!({"type": "object"}),
        }],
    }
}

fn model(protocol: Protocol, url: &str, images: bool) -> GenaiModel {
    let base = match protocol {
        Protocol::OpenAiChat | Protocol::OpenAiResponses | Protocol::Google => format!("{url}/v1"),
        Protocol::Anthropic => url.to_string(),
    };
    let mut cfg = ModelConfig::new("p/m", "m", protocol, &base, "k");
    cfg.images = images;
    cfg.max_retries = 0;
    GenaiModel::new(cfg).unwrap()
}

async fn sent_body(protocol: Protocol, req: ModelRequest, images: bool) -> Value {
    let mock = serve(vec![Reply::sse("data: [DONE]\n\n")]).await;
    let m = model(protocol, &mock.url, images);
    let _ = collect(&m, req).await;
    let sent = mock.captured.lock().unwrap().clone();
    sent.into_iter().next().expect("a request was made").body
}

fn at(haystack: &str, needle: &str) -> usize {
    haystack
        .find(needle)
        .unwrap_or_else(|| panic!("`{needle}` not in {haystack}"))
}

#[tokio::test]
async fn chat_completions_puts_the_picture_after_every_tool_message() {
    let body = sent_body(
        Protocol::OpenAiChat,
        request(ImageSource::Base64 { data: b64(PNG) }),
        true,
    )
    .await;
    let text = body["messages"].to_string();
    let data_url = format!("data:image/png;base64,{}", b64(PNG));
    assert!(text.contains(&data_url), "{text}");
    // Both tool messages come before the picture, so neither is cut off from its call.
    assert!(
        at(&text, "\"tool_call_id\":\"f1\"") < at(&text, &data_url),
        "{text}"
    );
    assert!(at(&text, "\"tool_call_id\":\"p1\"") < at(&text, "\"tool_call_id\":\"f1\""));
    let last = body["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(last["role"], "user");
}

#[tokio::test]
async fn responses_sends_an_input_image() {
    let body = sent_body(
        Protocol::OpenAiResponses,
        request(ImageSource::Base64 { data: b64(PNG) }),
        true,
    )
    .await;
    let text = body["input"].to_string();
    assert!(
        text.contains("input_image") && text.contains(&b64(PNG)),
        "{text}"
    );
    assert!(
        at(&text, "function_call_output") < at(&text, "input_image"),
        "{text}"
    );
}

#[tokio::test]
async fn anthropic_sends_an_image_block_after_the_tool_results() {
    let body = sent_body(
        Protocol::Anthropic,
        request(ImageSource::Base64 { data: b64(PNG) }),
        true,
    )
    .await;
    let text = body["messages"].to_string();
    assert!(
        text.contains("\"media_type\":\"image/png\"") && text.contains(&b64(PNG)),
        "{text}"
    );
    let last_result = text.rfind("tool_result").expect("tool results");
    assert!(last_result < at(&text, "\"type\":\"image\""), "{text}");
}

#[tokio::test]
async fn gemini_sends_inline_data() {
    let body = sent_body(
        Protocol::Google,
        request(ImageSource::Base64 { data: b64(PNG) }),
        true,
    )
    .await;
    let text = body["contents"].to_string();
    assert!(
        text.contains("inline_data") && text.contains(&b64(PNG)) && text.contains("image/png"),
        "{text}"
    );
}

#[tokio::test]
async fn a_picture_stored_as_a_file_is_read_when_the_request_is_built() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shot.png");
    std::fs::write(&path, PNG).unwrap();
    let body = sent_body(
        Protocol::OpenAiChat,
        request(ImageSource::File {
            path: path.display().to_string(),
        }),
        true,
    )
    .await;
    assert!(body["messages"].to_string().contains(&b64(PNG)));
}

#[tokio::test]
async fn a_missing_file_or_a_blind_model_leaves_a_sentence_instead() {
    let body = sent_body(
        Protocol::OpenAiChat,
        request(ImageSource::File {
            path: "/no/such/shot.png".into(),
        }),
        true,
    )
    .await;
    let text = body["messages"].to_string();
    assert!(
        text.contains("no longer available") && !text.contains("image_url"),
        "{text}"
    );

    let body = sent_body(
        Protocol::OpenAiChat,
        request(ImageSource::Base64 { data: b64(PNG) }),
        false,
    )
    .await;
    let text = body["messages"].to_string();
    assert!(
        text.contains("cannot see images") && !text.contains(&b64(PNG)),
        "{text}"
    );
}

#[test]
fn the_model_reports_whether_it_can_see() {
    use fv_agent::Model;
    assert!(model(Protocol::OpenAiChat, "http://x", true).supports_images());
    assert!(!model(Protocol::OpenAiChat, "http://x", false).supports_images());
}
