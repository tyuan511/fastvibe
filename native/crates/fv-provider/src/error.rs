use std::time::Duration;

use fv_agent::ModelError;

/// What a failure means for the caller: whether asking again might work, and how long the
/// provider asked us to wait first.
pub struct Classified {
    pub error: ModelError,
    pub retry_after: Option<Duration>,
}

fn status_retryable(code: u16) -> bool {
    matches!(code, 408 | 409 | 425 | 429) || (500..=599).contains(&code)
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let secs = |name: &str| headers.get(name)?.to_str().ok()?.trim().parse::<f64>().ok();
    if let Some(ms) = secs("retry-after-ms") {
        return Some(Duration::from_millis(ms.max(0.0) as u64));
    }
    secs("retry-after").map(|s| Duration::from_secs_f64(s.clamp(0.0, 120.0)))
}

/// Turn a genai failure into a [`ModelError`] with the provider's own words kept.
pub fn classify(err: &genai::Error) -> Classified {
    use genai::Error as E;
    let (retryable, after) = match err {
        E::HttpError {
            status, headers, ..
        } => (status_retryable(status.as_u16()), retry_after(headers)),
        E::WebAdapterCall { webc_error, .. } | E::WebModelCall { webc_error, .. } => {
            match webc_error.status() {
                Some(status) => (
                    status_retryable(status.as_u16()),
                    webc_error.headers().and_then(retry_after),
                ),
                // No status: the connection itself failed (reset, DNS, timeout).
                None => (matches!(webc_error, genai::webc::Error::Reqwest(_)), None),
            }
        }
        // The stream wraps what actually went wrong (an HTTP status, a reset connection).
        E::WebStream { error, .. } => match error.downcast_ref::<genai::Error>() {
            Some(inner) => {
                let c = classify(inner);
                (c.error.retryable, c.retry_after)
            }
            // Nothing recognisable inside: a dropped connection, worth another try.
            None => (true, None),
        },
        _ => (false, None),
    };
    let message = message_of(err);
    Classified {
        error: ModelError {
            overflow: !retryable && is_overflow(&message),
            message,
            retryable,
        },
        retry_after: after,
    }
}

/// Whether a refusal says the request was larger than the model's window. Providers have no
/// common code for it, so this reads their words. A rate limit that talks about tokens (429)
/// is not it: waiting helps that, summarizing does not.
fn is_overflow(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    if m.starts_with("429") || m.starts_with('5') {
        return false;
    }
    if m.starts_with("413") {
        return true;
    }
    [
        "context_length_exceeded",
        "maximum context length",
        "context length",
        "context window",
        "prompt is too long",
        "input is too long",
        "too many tokens",
        "token count",
        "reduce the length of the messages",
        "exceeds the maximum number of tokens",
    ]
    .iter()
    .any(|p| m.contains(p))
}

/// The provider's body when there is one (it says *why*), else genai's description.
fn message_of(err: &genai::Error) -> String {
    use genai::Error as E;
    match err {
        E::HttpError { status, body, .. } => format!("{status}: {}", body.trim()),
        E::WebAdapterCall { webc_error, .. } | E::WebModelCall { webc_error, .. } => {
            match webc_error {
                genai::webc::Error::ResponseFailedStatus { status, body, .. } => {
                    format!("{status}: {}", body.trim())
                }
                other => other.to_string(),
            }
        }
        E::WebStream { error, cause, .. } => match error.downcast_ref::<genai::Error>() {
            Some(inner) => message_of(inner),
            None => cause.clone(),
        },
        E::RequiresApiKey { .. } | E::NoAuthData { .. } => {
            "No API key is set for this provider.".into()
        }
        other => other.to_string(),
    }
}
