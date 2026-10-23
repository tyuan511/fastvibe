mod common;

use common::*;
use fv_agent::{ModelEvent, ModelRequest, ToolSpec};
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason, Usage};
use fv_provider::{GenaiModel, ModelConfig, Protocol, ThinkingLevel};
use serde_json::json;

const TOOL_TURN: &str = r#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"usage":{"input_tokens":25,"cache_read_input_tokens":10,"cache_creation_input_tokens":5,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I should read the file."}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Let me look."}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"a.txt\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":2}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}

"#;

fn config(url: &str) -> ModelConfig {
    // The base is typed the way a user types an Anthropic relay: no version segment.
    ModelConfig::new(
        "relay/claude-test",
        "claude-test",
        Protocol::Anthropic,
        url,
        "sk-test",
    )
}

fn request() -> ModelRequest {
    ModelRequest {
        system: "You are terse.".into(),
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
async fn a_tool_turn_streams_and_comes_back_whole() {
    let mock = serve(vec![Reply::sse(TOOL_TURN)]).await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    let events = events(collect(&model, request()).await);

    // Deltas as they arrived...
    assert!(events.contains(&ModelEvent::Thinking("I should read the file.".into())));
    assert!(events.contains(&ModelEvent::Text("Let me look.".into())));
    assert!(events.iter().any(
        |e| matches!(e, ModelEvent::ToolCallStart { id, name } if id == "toolu_1" && name == "read")
    ));

    // ...and the authoritative message at the end.
    let msg = done(&events);
    assert_eq!(msg.stop, StopReason::ToolUse);
    assert_eq!(msg.model.as_deref(), Some("relay/claude-test"));
    assert_eq!(
        msg.content,
        vec![
            ContentBlock::Thinking {
                text: "I should read the file.".into(),
                signature: Some("sig-abc".into())
            },
            ContentBlock::Text {
                text: "Let me look.".into()
            },
            ContentBlock::ToolCall {
                id: "toolu_1".into(),
                name: "read".into(),
                arguments: json!({"path": "a.txt"})
            },
        ]
    );
    // Input is reported without the cached part, so the hit rate means something.
    assert_eq!(
        msg.usage,
        Usage {
            input_tokens: 25,
            output_tokens: 42,
            cache_read_tokens: 10,
            cache_write_tokens: 5
        }
    );
}

#[tokio::test]
async fn the_request_has_the_shape_the_protocol_wants() {
    let mock = serve(vec![Reply::sse(TOOL_TURN)]).await;
    let mut cfg = config(&mock.url);
    cfg.thinking = Some(ThinkingLevel::High);
    cfg.max_output_tokens = Some(4096);
    let model = GenaiModel::new(cfg).unwrap();
    collect(&model, request()).await;

    let sent = mock.captured.lock().unwrap()[0].clone();
    // The version segment was added to the stored base; genai appended the final path.
    assert_eq!(sent.path, "/v1/messages");
    assert_eq!(sent.header("x-api-key"), Some("sk-test"));
    assert!(sent.header("anthropic-version").is_some());
    assert_eq!(sent.body["model"], "claude-test");
    assert_eq!(sent.body["stream"], true);
    assert_eq!(sent.body["max_tokens"], 4096);
    assert!(
        sent.body["system"].to_string().contains("You are terse."),
        "{}",
        sent.body["system"]
    );
    assert_eq!(sent.body["tools"][0]["name"], "read");
    assert_eq!(sent.body["messages"][0]["role"], "user");
    assert!(
        sent.body["thinking"].is_object(),
        "thinking was not requested: {}",
        sent.body
    );
}

#[tokio::test]
async fn thinking_signatures_go_back_to_their_author_only() {
    let assistant = |model: &str| {
        Message::Assistant(AssistantMessage {
            content: vec![
                ContentBlock::Thinking {
                    text: "hmm".into(),
                    signature: Some("sig-abc".into()),
                },
                ContentBlock::ToolCall {
                    id: "toolu_1".into(),
                    name: "read".into(),
                    arguments: json!({"path": "a.txt"}),
                },
            ],
            stop: StopReason::ToolUse,
            usage: Default::default(),
            model: Some(model.into()),
        })
    };
    let history = |model: &str| {
        let mut r = request();
        r.messages.push(assistant(model));
        r.messages.push(Message::ToolResult {
            call_id: "toolu_1".into(),
            name: "read".into(),
            content: "file text".into(),
            is_error: false,
        });
        r
    };

    let mock = serve(vec![Reply::sse(TOOL_TURN), Reply::sse(TOOL_TURN)]).await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    collect(&model, history("relay/claude-test")).await;
    collect(&model, history("other/some-model")).await;

    let sent = mock.captured.lock().unwrap().clone();
    let assistant_blocks = |i: usize| sent[i].body["messages"][1]["content"].to_string();
    let own = assistant_blocks(0);
    assert!(
        own.contains("sig-abc") && own.contains("\"thinking\""),
        "own thinking was not replayed: {own}"
    );
    let foreign = assistant_blocks(1);
    assert!(
        !foreign.contains("sig-abc") && !foreign.contains("thinking"),
        "a foreign signature was replayed: {foreign}"
    );
    // The tool exchange itself is intact either way.
    assert!(foreign.contains("tool_use") && foreign.contains("toolu_1"));
    let result = sent[1].body["messages"][2].to_string();
    assert!(
        result.contains("tool_result") && result.contains("file text"),
        "{result}"
    );
}

#[tokio::test]
async fn rate_limits_are_retried_and_bad_keys_are_not() {
    let mock = serve(vec![
        Reply::status(
            429,
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#,
        )
        .header("retry-after-ms", "10"),
        Reply::status(
            529,
            r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#,
        )
        .header("retry-after-ms", "10"),
        Reply::sse(TOOL_TURN),
    ])
    .await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    let events = events(collect(&model, request()).await);
    assert_eq!(done(&events).stop, StopReason::ToolUse);
    assert_eq!(
        mock.captured.lock().unwrap().len(),
        3,
        "should have asked three times"
    );

    let mock = serve(vec![Reply::status(
        401,
        r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
    )])
    .await;
    let model = GenaiModel::new(config(&mock.url)).unwrap();
    let results = collect(&model, request()).await;
    let err = results.into_iter().find_map(Result::err).expect("an error");
    assert!(!err.retryable);
    assert!(
        err.message.contains("401") && err.message.contains("invalid x-api-key"),
        "{}",
        err.message
    );
    assert_eq!(
        mock.captured.lock().unwrap().len(),
        1,
        "a rejected key must not be retried"
    );
}

#[tokio::test]
async fn retries_stop_after_the_configured_number() {
    let replies = (0..4)
        .map(|_| Reply::status(503, "{}").header("retry-after-ms", "5"))
        .collect();
    let mock = serve(replies).await;
    let mut cfg = config(&mock.url);
    cfg.max_retries = 2;
    let model = GenaiModel::new(cfg).unwrap();
    let results = collect(&model, request()).await;
    assert!(results.iter().any(Result::is_err));
    assert_eq!(
        mock.captured.lock().unwrap().len(),
        3,
        "one try and two retries"
    );
}
