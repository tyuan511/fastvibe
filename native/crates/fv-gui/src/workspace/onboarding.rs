//! Settings onboarding helpers kept separate from the large settings view.
//!
//! The native client intentionally exposes only the configuration paths that are backed by the
//! current protocol. Remote access and SSH are visible as honest previews until their backend
//! methods land; this module must not grow fake controls for them.

use crate::ui::px;
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon};
use fv_protocol::types::{ApiProtocol, UiLanguage};
use fv_theme::Token;
use gpui_kit::*;

use super::card;

pub(super) fn unavailable_pane(
    p: &crate::theme::Palette,
    language: UiLanguage,
    title: &str,
    detail: &str,
) -> AnyElement {
    let english = language == UiLanguage::English;
    card(p)
        .child(
            div()
                .px(px(20.0))
                .py(px(28.0))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .size(px(40.0))
                        .rounded(px(12.0))
                        .bg(p.c(Token::Muted))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon("lock", 18.0, p.c(Token::MutedForeground))),
                )
                .child(
                    div()
                        .text_size(px(TEXT_SM))
                        .font_weight(FontWeight::MEDIUM)
                        .child(title.to_string()),
                )
                .child(
                    div()
                        .max_w(px(440.0))
                        .text_size(px(TEXT_XS))
                        .text_align(TextAlign::Center)
                        .muted(p)
                        .child(detail.to_string()),
                )
                .child(
                    div()
                        .mt(px(4.0))
                        .px(px(8.0))
                        .py(px(4.0))
                        .rounded(px(6.0))
                        .bg(p.c(Token::Muted))
                        .text_size(px(TEXT_XS))
                        .muted(p)
                        .child(trs!(english, "settings.preview_unavailable")),
                ),
        )
        .into_any_element()
}

pub(super) fn manual_model(id: &str) -> Option<fv_protocol::types::ModelInfo> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    Some(fv_protocol::types::ModelInfo {
        id: id.into(),
        name: Some(id.into()),
        // Unknown capabilities remain conservative until a catalog sync or user edit.
        supports_images: false,
        ..Default::default()
    })
}

pub(super) fn protocol_example(protocol: ApiProtocol, language: UiLanguage) -> &'static str {
    let english = language == UiLanguage::English;
    match (protocol, english) {
        (ApiProtocol::Chat, false) => "例如：https://api.openai.com/v1（/chat/completions）",
        (ApiProtocol::Chat, true) => "Example: https://api.openai.com/v1 (/chat/completions)",
        (ApiProtocol::Responses, false) => "例如：https://api.openai.com/v1（/responses）",
        (ApiProtocol::Responses, true) => "Example: https://api.openai.com/v1 (/responses)",
        (ApiProtocol::Anthropic, false) => "例如：https://api.anthropic.com（/v1/messages）",
        (ApiProtocol::Anthropic, true) => "Example: https://api.anthropic.com (/v1/messages)",
        (ApiProtocol::Google, false) => {
            "例如：https://generativelanguage.googleapis.com/v1beta（/models/{model}:streamGenerateContent）"
        }
        (ApiProtocol::Google, true) => {
            "Example: https://generativelanguage.googleapis.com/v1beta (/models/{model}:streamGenerateContent)"
        }
    }
}
