//! Regression checks for the offline model-ID fallback and protocol help.
use super::onboarding;
use fv_protocol::types::{ApiProtocol, UiLanguage};

#[test]
fn manual_model_ids_preserve_provider_routing_and_unknown_capabilities() {
    assert!(onboarding::manual_model(" \n ").is_none());
    let model = onboarding::manual_model("  org/model-v2:latest  ").expect("manual model");
    assert_eq!(model.id, "org/model-v2:latest");
    assert_eq!(
        model.protocol, None,
        "inherit the configured provider protocol"
    );
    assert!(!model.supports_images, "do not invent image capability");
    assert_eq!(
        model.context_window, None,
        "let backend metadata resolve context"
    );
}

#[test]
fn each_protocol_help_names_its_actual_endpoint() {
    for (protocol, expected) in [
        (ApiProtocol::Chat, "/chat/completions"),
        (ApiProtocol::Responses, "/responses"),
        (ApiProtocol::Anthropic, "/v1/messages"),
        (ApiProtocol::Google, "/models/{model}:streamGenerateContent"),
    ] {
        for language in [UiLanguage::Chinese, UiLanguage::English] {
            assert!(onboarding::protocol_example(protocol, language).contains(expected));
        }
    }
}
