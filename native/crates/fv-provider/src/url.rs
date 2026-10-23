use crate::Protocol;

/// A model id that names a native API pins its own protocol, when the provider is not already
/// speaking it: `claude-*` is Anthropic Messages, `gemini-*` is Google. It is a guess, which is
/// why a model's protocol stays editable. Namespaced ids (`anthropic/claude-…`) do not match.
pub fn infer_protocol(model_id: &str, provider_protocol: Protocol) -> Protocol {
    let id = model_id.to_ascii_lowercase();
    match provider_protocol {
        Protocol::Anthropic | Protocol::Google => provider_protocol,
        _ if id.starts_with("claude-") => Protocol::Anthropic,
        _ if id.starts_with("gemini-") => Protocol::Google,
        _ => provider_protocol,
    }
}

fn is_version(segment: &str, allow_beta: bool) -> bool {
    let Some(rest) = segment.strip_prefix('v') else {
        return false;
    };
    let digits = rest.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    let suffix = &rest[digits.len()..];
    !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit())
        && (suffix.is_empty() || (allow_beta && (suffix == "beta" || suffix == "alpha")))
}

/// The base URL genai wants for a model, from the one the user stored.
///
/// The stored base is what the user typed for their provider's protocol: `https://host/v1` for
/// OpenAI-shaped APIs. genai appends only the final path (`messages`, `chat/completions`,
/// `models/…`), so the version segment has to be in the base, and each native API has its own:
///
/// - OpenAI Chat and Responses: as typed.
/// - Anthropic: `…/v1` (a bare host or a gateway mount point gets `/v1` added; a version the user
///   already gave, such as z.ai's `…/paas/v4`, is kept).
/// - Google: `…/v1beta` (`/v1` becomes `/v1beta`; an existing `v1beta` or `v1alpha` stays).
///
/// A trailing slash is always present, because genai concatenates.
pub fn engine_base_url(protocol: Protocol, stored: &str) -> String {
    let trimmed = stored.trim().trim_end_matches('/');
    let (head, last) = match trimmed.rsplit_once('/') {
        // "https://host" has its "//" before the host: no path segment yet.
        Some((h, l)) if !h.ends_with('/') && !h.is_empty() && !h.ends_with(':') => (h, l),
        _ => ("", ""),
    };
    let with_version = |version: &str| {
        if head.is_empty() {
            format!("{trimmed}/{version}")
        } else {
            format!("{head}/{last}/{version}")
        }
    };
    let url = match protocol {
        Protocol::OpenAiChat | Protocol::OpenAiResponses => trimmed.to_string(),
        Protocol::Anthropic => {
            if !head.is_empty() && is_version(last, false) {
                trimmed.to_string()
            } else {
                with_version("v1")
            }
        }
        Protocol::Google => {
            if !head.is_empty() && last == "v1" {
                format!("{head}/v1beta")
            } else if !head.is_empty() && is_version(last, true) {
                trimmed.to_string()
            } else {
                with_version("v1beta")
            }
        }
    };
    format!("{url}/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_ids_pin_their_protocol_only_where_the_provider_does_not_already() {
        assert_eq!(
            infer_protocol("claude-sonnet-5-5", Protocol::OpenAiChat),
            Protocol::Anthropic
        );
        assert_eq!(
            infer_protocol("Gemini-2.5-pro", Protocol::OpenAiResponses),
            Protocol::Google
        );
        assert_eq!(
            infer_protocol("claude-x", Protocol::Google),
            Protocol::Google
        );
        assert_eq!(
            infer_protocol("anthropic/claude-x", Protocol::OpenAiChat),
            Protocol::OpenAiChat
        );
        assert_eq!(
            infer_protocol("gpt-5", Protocol::OpenAiResponses),
            Protocol::OpenAiResponses
        );
    }

    #[test]
    fn openai_bases_are_taken_as_typed() {
        assert_eq!(
            engine_base_url(Protocol::OpenAiChat, "https://fastvibe.dev/v1"),
            "https://fastvibe.dev/v1/"
        );
        assert_eq!(
            engine_base_url(Protocol::OpenAiResponses, "https://h/v1/"),
            "https://h/v1/"
        );
        assert_eq!(
            engine_base_url(
                Protocol::OpenAiChat,
                "https://open.bigmodel.cn/api/coding/paas/v4"
            ),
            "https://open.bigmodel.cn/api/coding/paas/v4/"
        );
    }

    #[test]
    fn anthropic_gets_its_version_segment_unless_one_is_there() {
        assert_eq!(
            engine_base_url(Protocol::Anthropic, "https://api.anthropic.com"),
            "https://api.anthropic.com/v1/"
        );
        assert_eq!(
            engine_base_url(Protocol::Anthropic, "https://relay.example/v1"),
            "https://relay.example/v1/"
        );
        assert_eq!(
            engine_base_url(Protocol::Anthropic, "https://relay.example/api/anthropic"),
            "https://relay.example/api/anthropic/v1/"
        );
        assert_eq!(
            engine_base_url(
                Protocol::Anthropic,
                "https://open.bigmodel.cn/api/coding/paas/v4"
            ),
            "https://open.bigmodel.cn/api/coding/paas/v4/"
        );
    }

    #[test]
    fn google_moves_to_v1beta() {
        assert_eq!(
            engine_base_url(
                Protocol::Google,
                "https://generativelanguage.googleapis.com"
            ),
            "https://generativelanguage.googleapis.com/v1beta/"
        );
        assert_eq!(
            engine_base_url(Protocol::Google, "https://relay.example/v1"),
            "https://relay.example/v1beta/"
        );
        assert_eq!(
            engine_base_url(Protocol::Google, "https://relay.example/v1beta/"),
            "https://relay.example/v1beta/"
        );
        assert_eq!(
            engine_base_url(Protocol::Google, "https://relay.example/v1alpha"),
            "https://relay.example/v1alpha/"
        );
        assert_eq!(
            engine_base_url(Protocol::Google, "https://relay.example/gemini"),
            "https://relay.example/gemini/v1beta/"
        );
    }
}
