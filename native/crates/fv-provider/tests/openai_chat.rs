mod common;

use common::*;
use fv_agent::{ModelEvent, ModelRequest, ToolSpec};
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason, Usage};
use fv_provider::{GenaiModel, ModelConfig, Protocol, ThinkingLevel};
use serde_json::json;

/// What a DeepSeek / Qwen style gateway sends: reasoning in `reasoning_content`, a tool call
/// whose arguments arrive in pieces, and usage in a final chunk with no choices.
const TOOL_TURN: &str = r#"data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{"reasoning_content":"The user wants a file."},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{"content":"Reading "},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{"content":"it now."},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":60}}}

data: [DONE]

"#;

const TEXT_TURN: &str = r#"data: {"id":"c2","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{"role":"assistant","content":"All "},"finish_reason":null}]}

data: {"id":"c2","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[{"index":0,"delta":{"content":"done."},"finish_reason":"stop"}]}

data: {"id":"c2","object":"chat.completion.chunk","created":1,"model":"qwen-test","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}

data: [DONE]

"#;

fn config(url: &str) -> ModelConfig {
    ModelConfig::new(
        "gateway/qwen-test",
        "qwen-test",
        Protocol::OpenAiChat,
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
async fn a_request_output_budget_reaches_the_provider_without_raising_its_configured_limit() {
    let mock = serve(vec![Reply::sse(TEXT_TURN), Reply::sse(TEXT_TURN)]).await;
    let mut cfg = config(&mock.url);
    cfg.max_output_tokens = Some(128);
    let model = GenaiModel::new(cfg).unwrap();
    let mut req = request();
    req.max_output_tokens = Some(64);
    collect(&model, req.clone()).await;
    req.max_output_tokens = Some(512);
    collect(&model, req).await;
    let captured = mock.captured.lock().unwrap();
    let limit = |body: &serde_json::Value| {
        body["max_tokens"]
            .as_u64()
            .or_else(|| body["max_completion_tokens"].as_u64())
    };
    assert_eq!(limit(&captured[0].body), Some(64));
    assert_eq!(limit(&captured[1].body), Some(128));
}

#[test]
fn learned_windows_are_isolated_by_physical_route_model_and_declared_window() {
    use fv_agent::Model;
    let mut cfg = config("http://localhost:12345");
    cfg.context_window = Some(100_000);
    let model = GenaiModel::new(cfg.clone()).unwrap();
    let budget = fv_agent::ContextBudget::default();
    assert!(budget.reject(&model, 30_000, 4096));
    let learned = budget.window(&model);
    let mut same = cfg.clone();
    same.label = "different-provider-alias".into();
    same.api_key = "changed-credential".into();
    let same = GenaiModel::new(same).unwrap();
    assert_eq!(same.context_key(), model.context_key());
    assert_eq!(budget.window(&same), learned);
    let mut other = cfg.clone();
    other.base_url = "http://localhost:54321/v1".into();
    assert_eq!(budget.window(&GenaiModel::new(other).unwrap()), 100_000);
    let mut other = cfg.clone();
    other.model_id = "other-model".into();
    assert_eq!(budget.window(&GenaiModel::new(other).unwrap()), 100_000);
    let mut other = cfg.clone();
    other.protocol = Protocol::OpenAiResponses;
    assert_eq!(budget.window(&GenaiModel::new(other).unwrap()), 100_000);
    let mut other = cfg;
    other.context_window = Some(200_000);
    assert_eq!(budget.window(&GenaiModel::new(other).unwrap()), 200_000);
}

#[tokio::test]
async fn reasoning_text_and_a_tool_call_come_back_as_blocks() {
    let mock = serve(vec![Reply::sse(TOOL_TURN)]).await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    let events = events(collect(&model, request()).await);

    assert!(events.contains(&ModelEvent::Thinking("The user wants a file.".into())));
    assert!(events.contains(&ModelEvent::Text("Reading ".into())));
    let msg = done(&events);
    assert_eq!(msg.stop, StopReason::ToolUse);
    assert_eq!(
        msg.content,
        vec![
            ContentBlock::Thinking {
                text: "The user wants a file.".into(),
                signature: None
            },
            ContentBlock::Text {
                text: "Reading it now.".into()
            },
            ContentBlock::ToolCall {
                id: "call_1".into(),
                name: "read".into(),
                arguments: json!({"path": "a.txt"})
            },
        ]
    );
    assert_eq!(
        msg.usage,
        Usage {
            input_tokens: 40,
            output_tokens: 20,
            cache_read_tokens: 60,
            cache_write_tokens: 0
        }
    );
}

#[tokio::test]
async fn the_request_goes_to_chat_completions_with_a_bearer_key() {
    let mock = serve(vec![Reply::sse(TEXT_TURN)]).await;
    let mut cfg = config(&mock.url);
    cfg.thinking = Some(ThinkingLevel::Medium);
    let model = GenaiModel::new(cfg).unwrap();
    let events = events(collect(&model, request()).await);
    assert_eq!(done(&events).stop, StopReason::Stop);
    assert_eq!(
        done(&events).content,
        vec![ContentBlock::Text {
            text: "All done.".into()
        }]
    );

    let sent = mock.captured.lock().unwrap()[0].clone();
    assert_eq!(sent.path, "/v1/chat/completions");
    assert_eq!(sent.header("authorization"), Some("Bearer sk-test"));
    assert_eq!(sent.body["model"], "qwen-test");
    assert_eq!(sent.body["stream"], true);
    assert_eq!(sent.body["messages"][0]["role"], "system");
    assert_eq!(sent.body["tools"][0]["function"]["name"], "read");
    assert_eq!(sent.body["reasoning_effort"], "medium", "{}", sent.body);
}

#[tokio::test]
async fn a_tool_exchange_is_sent_back_in_the_openai_shape() {
    let mock = serve(vec![Reply::sse(TEXT_TURN)]).await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    let mut req = request();
    req.messages.push(Message::Assistant(AssistantMessage {
        duration_ms: None,
        content: vec![
            ContentBlock::Text {
                text: "Reading it now.".into(),
            },
            ContentBlock::ToolCall {
                id: "call_1".into(),
                name: "read".into(),
                arguments: json!({"path": "a.txt"}),
            },
        ],
        stop: StopReason::ToolUse,
        usage: Default::default(),
        model: Some("gateway/qwen-test".into()),
    }));
    req.messages.push(Message::ToolResult {
        call_id: "call_1".into(),
        name: "read".into(),
        content: "hello".into(),
        is_error: false,
    });
    collect(&model, req).await;

    let sent = mock.captured.lock().unwrap()[0].clone();
    let messages = sent.body["messages"].as_array().unwrap();
    let assistant = messages
        .iter()
        .find(|m| m["role"] == "assistant")
        .expect("assistant message");
    assert_eq!(assistant["tool_calls"][0]["id"], "call_1");
    assert_eq!(assistant["tool_calls"][0]["function"]["name"], "read");
    // OpenAI wants the arguments as a JSON string.
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        "{\"path\":\"a.txt\"}"
    );
    let tool = messages
        .iter()
        .find(|m| m["role"] == "tool")
        .expect("tool message");
    assert_eq!(tool["tool_call_id"], "call_1");
    assert_eq!(tool["content"], "hello");
}

#[tokio::test]
async fn a_cut_off_reply_is_reported_as_length() {
    let body = r#"data: {"id":"c3","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"A very long"},"finish_reason":"length"}]}

data: {"id":"c3","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":4096,"total_tokens":4101}}

data: [DONE]

"#;
    let mock = serve(vec![Reply::sse(body)]).await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    let events = events(collect(&model, request()).await);
    assert_eq!(done(&events).stop, StopReason::Length);
}
