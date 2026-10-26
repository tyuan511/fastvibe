mod common;

use common::*;
use fv_agent::{ModelError, ModelRequest};
use fv_core::Message;
use fv_provider::{GenaiModel, ModelConfig, Protocol};

fn request() -> ModelRequest {
    ModelRequest {
        max_output_tokens: None,
        system: String::new(),
        messages: vec![Message::User { text: "hi".into() }],
        tools: vec![],
    }
}

async fn error_for(protocol: Protocol, status: u16, body: &str) -> ModelError {
    let mock = serve(vec![Reply::status(status, body)]).await;
    let base = match protocol {
        Protocol::Anthropic => mock.url.clone(),
        _ => format!("{}/v1", mock.url),
    };
    let mut cfg = ModelConfig::new("p/m", "m", protocol, &base, "k");
    cfg.max_retries = 0;
    let m = GenaiModel::new(cfg).unwrap();
    collect(&m, request())
        .await
        .into_iter()
        .find_map(Result::err)
        .expect("an error")
}

#[tokio::test]
async fn each_providers_words_for_too_large_are_recognised() {
    let cases = [
        (
            Protocol::OpenAiChat,
            400,
            r#"{"error":{"message":"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}"#,
        ),
        (
            Protocol::OpenAiResponses,
            400,
            r#"{"error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","code":"context_length_exceeded"}}"#,
        ),
        (
            Protocol::Anthropic,
            400,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}"#,
        ),
        (
            Protocol::Google,
            400,
            r#"{"error":{"code":400,"message":"The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}"#,
        ),
        (
            Protocol::OpenAiChat,
            413,
            r#"{"error":"payload too large"}"#,
        ),
    ];
    for (protocol, status, body) in cases {
        let e = error_for(protocol, status, body).await;
        assert!(e.overflow && !e.retryable, "{protocol:?}/{status}: {e:?}");
    }
}

#[tokio::test]
async fn other_refusals_are_not_mistaken_for_it() {
    // A rate limit that mentions tokens: waiting helps, summarizing does not.
    let e = error_for(Protocol::OpenAiChat, 429, r#"{"error":{"message":"Request too large for gpt-4 on tokens per min (TPM): Limit 30000, Requested 45000. Too many tokens."}}"#).await;
    assert!(!e.overflow);
    // A bad tool schema, a bad key.
    let e = error_for(Protocol::OpenAiChat, 400, r#"{"error":{"message":"Invalid schema for function 'read': 'additionalProperties' is required"}}"#).await;
    assert!(!e.overflow && !e.retryable);
    let e = error_for(
        Protocol::Anthropic,
        401,
        r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
    )
    .await;
    assert!(!e.overflow);
    // A server fault.
    let e = error_for(
        Protocol::OpenAiChat,
        500,
        r#"{"error":{"message":"the context window service is down"}}"#,
    )
    .await;
    assert!(!e.overflow);
}

#[test]
fn the_window_is_reported() {
    use fv_agent::Model;
    let mut cfg = ModelConfig::new("p/m", "m", Protocol::OpenAiChat, "http://x/v1", "k");
    assert_eq!(GenaiModel::new(cfg.clone()).unwrap().context_window(), None);
    cfg.context_window = Some(200_000);
    assert_eq!(
        GenaiModel::new(cfg).unwrap().context_window(),
        Some(200_000)
    );
}
