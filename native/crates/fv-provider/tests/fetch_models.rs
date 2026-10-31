mod common;

use common::*;
use fv_provider::{FetchedModel, Protocol, fetch_models};

fn ids(models: &[FetchedModel]) -> Vec<&str> {
    models.iter().map(|m| m.id.as_str()).collect()
}

#[tokio::test]
async fn an_openai_style_list_is_read_with_a_bearer_key() {
    let mock = serve(vec![Reply::status(
        200,
        r#"{"object":"list","data":[{"id":"gpt-5","object":"model"},{"id":"deepseek-ai/DeepSeek-V3","object":"model"},{"id":"gpt-5","object":"model"}]}"#,
    )])
    .await;
    let models = fetch_models(Protocol::OpenAiChat, &format!("{}/v1", mock.url), "sk-test")
        .await
        .unwrap();
    assert_eq!(
        ids(&models),
        ["deepseek-ai/DeepSeek-V3", "gpt-5"],
        "sorted, duplicates dropped, slashes kept"
    );
    let sent = mock.captured.lock().unwrap()[0].clone();
    assert_eq!(sent.path, "/v1/models");
    assert_eq!(sent.header("authorization"), Some("Bearer sk-test"));
}

#[tokio::test]
async fn anthropic_is_asked_with_its_own_headers_and_gives_display_names() {
    let mock = serve(vec![Reply::status(
        200,
        r#"{"data":[{"type":"model","id":"claude-sonnet-x","display_name":"Claude Sonnet X"},{"type":"model","id":"claude-haiku-x","display_name":"claude-haiku-x"}],"has_more":false}"#,
    )])
    .await;
    // Typed without a version, as people do.
    let models = fetch_models(Protocol::Anthropic, &mock.url, "sk-ant")
        .await
        .unwrap();
    assert_eq!(ids(&models), ["claude-haiku-x", "claude-sonnet-x"]);
    assert_eq!(models[1].name.as_deref(), Some("Claude Sonnet X"));
    assert_eq!(
        models[0].name, None,
        "a display name that only repeats the id is dropped"
    );
    let sent = mock.captured.lock().unwrap()[0].clone();
    assert!(sent.path.starts_with("/v1/models"), "{}", sent.path);
    assert_eq!(sent.header("x-api-key"), Some("sk-ant"));
    assert!(sent.header("anthropic-version").is_some());
}

#[tokio::test]
async fn google_models_that_cannot_chat_are_left_out() {
    let mock = serve(vec![Reply::status(
        200,
        r#"{"models":[
            {"name":"models/gemini-2.5-pro","displayName":"Gemini 2.5 Pro","supportedGenerationMethods":["generateContent","countTokens"]},
            {"name":"models/text-embedding-004","displayName":"Embedding","supportedGenerationMethods":["embedContent"]},
            {"name":"models/gemini-bare"}
        ]}"#,
    )])
    .await;
    let models = fetch_models(Protocol::Google, &format!("{}/v1", mock.url), "g-key")
        .await
        .unwrap();
    assert_eq!(ids(&models), ["gemini-2.5-pro", "gemini-bare"]);
    assert_eq!(models[0].name.as_deref(), Some("Gemini 2.5 Pro"));
    let sent = mock.captured.lock().unwrap()[0].clone();
    assert!(sent.path.starts_with("/v1beta/models"), "{}", sent.path);
    assert_eq!(sent.header("x-goog-api-key"), Some("g-key"));
}

#[tokio::test]
async fn relays_that_answer_with_other_shapes_are_still_read() {
    let mock = serve(vec![
        Reply::status(200, r#"{"models":[{"id":"a"},{"id":"b"}]}"#),
        Reply::status(200, r#"[{"id":"c"},"d"]"#),
    ])
    .await;
    let first = fetch_models(Protocol::OpenAiChat, &mock.url, "k")
        .await
        .unwrap();
    assert_eq!(ids(&first), ["a", "b"]);
    let second = fetch_models(Protocol::OpenAiChat, &mock.url, "k")
        .await
        .unwrap();
    assert_eq!(ids(&second), ["c", "d"]);
}

#[tokio::test]
async fn failures_are_safe_and_categorized() {
    let mock = serve(vec![
        Reply::status(401, r#"{"error":{"message":"Incorrect API key provided"}}"#),
        Reply::status(200, "<html>not json</html>"),
        Reply::status(200, r#"{"data":[]}"#),
    ])
    .await;
    let err = fetch_models(Protocol::OpenAiChat, &mock.url, "bad")
        .await
        .unwrap_err();
    assert!(
        err.contains("401")
            && err.contains("API key is invalid")
            && !err.contains("Incorrect API key provided"),
        "{err}"
    );
    let err = fetch_models(Protocol::OpenAiChat, &mock.url, "k")
        .await
        .unwrap_err();
    assert!(err.contains("not JSON"), "{err}");
    let err = fetch_models(Protocol::OpenAiChat, &mock.url, "k")
        .await
        .unwrap_err();
    assert!(err.contains("no models"), "{err}");

    assert!(
        fetch_models(Protocol::OpenAiChat, "  ", "k")
            .await
            .unwrap_err()
            .contains("empty")
    );
    let err = fetch_models(Protocol::OpenAiChat, "http://127.0.0.1:1", "k")
        .await
        .unwrap_err();
    assert!(err.contains("could not reach"), "{err}");
}

#[tokio::test]
async fn configured_proxy_is_used_and_body_secrets_never_escape() {
    let proxy = serve(vec![Reply::status(401, "private-upstream-body-sk-typed")]).await;
    let error = fv_provider::fetch_models_with_proxy(
        Protocol::OpenAiChat,
        "http://provider.invalid/v1",
        "sk-typed",
        Some(&proxy.url),
    )
    .await
    .unwrap_err();
    assert_eq!(error.category(), "authentication");
    assert_eq!(error.status(), Some(401));
    assert!(!error.to_string().contains("private-upstream-body"));
    assert!(!error.to_string().contains("sk-typed"));
    assert_eq!(
        proxy.captured.lock().unwrap()[0].path,
        "http://provider.invalid/v1/models"
    );
}

#[tokio::test]
async fn large_answers_and_cross_origin_redirects_are_refused() {
    let oversized = "x".repeat(4 * 1024 * 1024 + 1);
    let mock = serve(vec![
        Reply::status(200, &oversized),
        Reply::status(302, "").header("location", "https://elsewhere.invalid/models"),
    ])
    .await;
    let error = fv_provider::fetch_models_with_proxy(Protocol::OpenAiChat, &mock.url, "k", None)
        .await
        .unwrap_err();
    assert_eq!(error.category(), "tooLarge");
    let error = fv_provider::fetch_models_with_proxy(Protocol::OpenAiChat, &mock.url, "k", None)
        .await
        .unwrap_err();
    assert_eq!(error.status(), Some(302));
    assert_eq!(mock.captured.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn gemini_pages_and_openai_shaped_relays_are_read() {
    let mock = serve(vec![
        Reply::status(
            200,
            r#"{"models":[{"name":"models/a"}],"nextPageToken":"next"}"#,
        ),
        Reply::status(200, r#"{"data":[{"id":"models/b"}]}"#),
    ])
    .await;
    let models = fetch_models(Protocol::Google, &mock.url, "k")
        .await
        .unwrap();
    assert_eq!(ids(&models), ["a", "b"]);
    assert!(
        mock.captured.lock().unwrap()[1]
            .path
            .contains("pageToken=next")
    );
}
