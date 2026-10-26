//! Isolated model diagnostics. Output, arguments, error bodies and credentials never leave
//! this layer; the only public result is a bounded verdict and timing.
use crate::ModelConfig;
use crate::convert::{Streamed, assistant_from_end, to_chat_request};
use futures_util::StreamExt;
use fv_agent::{ModelRequest, ToolSpec};
use fv_core::Message;
use genai::chat::{ChatOptions, ChatStreamEvent};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeStatus {
    Passed,
    Partial,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeTools {
    Passed,
    Unconfirmed,
    Failed,
    NotTested,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeError {
    Auth,
    Protocol,
    RateLimit,
    Network,
    Timeout,
    Model,
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbeReport {
    pub status: ProbeStatus,
    pub tools: ProbeTools,
    pub first_token_ms: Option<u64>,
    pub elapsed_ms: u64,
    pub error: Option<ProbeError>,
}
impl ProbeReport {
    pub fn failed(error: ProbeError) -> Self {
        Self {
            status: ProbeStatus::Failed,
            tools: ProbeTools::NotTested,
            first_token_ms: None,
            elapsed_ms: 0,
            error: Some(error),
        }
    }
}
#[derive(Clone, Copy)]
pub struct ProbeBudget {
    pub request: Duration,
    pub total: Duration,
    pub output_tokens: u32,
}
impl Default for ProbeBudget {
    fn default() -> Self {
        Self {
            request: Duration::from_secs(20),
            total: Duration::from_secs(45),
            output_tokens: 256,
        }
    }
}
const MAX_TEXT_BYTES: usize = 128 * 1024;
const MAX_EVENTS: usize = 4096;
const TOOL: &str = "fastvibe_probe";
fn elapsed(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u64::MAX as u128) as u64
}

/// No retry: an auth/rate/protocol failure describes this attempt. Streams and requests are
/// dropped on timeout or when the caller disappears, never left running behind the verdict.
pub(crate) async fn run(
    client: &genai::Client,
    config: &ModelConfig,
    options: ChatOptions,
    budget: ProbeBudget,
) -> ProbeReport {
    let start = Instant::now();
    let mut result = ProbeReport::failed(ProbeError::Unknown);
    let options = options
        .with_capture_usage(false)
        .with_capture_reasoning_content(false)
        .with_stream_header_timeout(budget.request)
        .with_stream_read_timeout(budget.request)
        .with_max_tokens(
            config
                .max_output_tokens
                .map_or(budget.output_tokens, |m| m.min(budget.output_tokens))
                .max(1),
        );
    let check = async {
        match tokio::time::timeout(
            budget.request,
            phase(
                client,
                config,
                &options,
                false,
                start,
                &mut result.first_token_ms,
            ),
        )
        .await
        {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => return,
            Ok(Err(error)) => {
                result.error = Some(error);
                return;
            }
            Err(_) => {
                result.error = Some(ProbeError::Timeout);
                return;
            }
        }
        result.status = ProbeStatus::Partial;
        result.tools = ProbeTools::Unconfirmed;
        result.error = None;
        match tokio::time::timeout(
            budget.request,
            phase(client, config, &options, true, start, &mut None),
        )
        .await
        {
            Ok(Ok(true)) => {
                result.status = ProbeStatus::Passed;
                result.tools = ProbeTools::Passed;
            }
            Ok(Ok(false)) => {}
            Ok(Err(error)) => {
                result.tools = ProbeTools::Failed;
                result.error = Some(error);
            }
            Err(_) => {
                result.tools = ProbeTools::Failed;
                result.error = Some(ProbeError::Timeout);
            }
        }
    };
    if tokio::time::timeout(budget.total, check).await.is_err() {
        result.error = Some(ProbeError::Timeout);
        if result.status == ProbeStatus::Partial {
            result.tools = ProbeTools::Failed;
        }
    }
    result.elapsed_ms = elapsed(start);
    result
}
async fn phase(
    client: &genai::Client,
    config: &ModelConfig,
    options: &ChatOptions,
    tool: bool,
    start: Instant,
    first: &mut Option<u64>,
) -> Result<bool, ProbeError> {
    let request = ModelRequest {
        system: String::new(),
        messages: vec![Message::User {
            text: if tool {
                "Call fastvibe_probe once with value equal to ok. Do not answer in text."
            } else {
                "Reply with OK only."
            }
            .into(),
        }],
        tools: if tool {
            vec![ToolSpec {
                name: TOOL.into(),
                description: "A harmless connectivity test. No action will be performed.".into(),
                schema: serde_json::json!({"type":"object","properties":{"value":{"type":"string","enum":["ok"]}},"required":["value"],"additionalProperties":false}),
            }]
        } else {
            Vec::new()
        },
        max_output_tokens: None,
    };
    let chat = to_chat_request(&request, &config.label, false);
    let response = client
        .exec_chat_stream(&config.model_id, chat, Some(options))
        .await
        .map_err(classify)?;
    let mut stream = response.stream;
    let mut accumulated = Streamed::default();
    let mut bytes = 0usize;
    let mut events = 0usize;
    while let Some(event) = stream.next().await {
        let event = event.map_err(classify)?;
        events += 1;
        if events > MAX_EVENTS {
            return Err(ProbeError::Protocol);
        }
        match event {
            ChatStreamEvent::Chunk(chunk) => {
                bytes = bytes.saturating_add(chunk.content.len());
                if !tool && !chunk.content.is_empty() {
                    first.get_or_insert_with(|| elapsed(start));
                }
                if bytes > MAX_TEXT_BYTES {
                    return Err(ProbeError::Protocol);
                }
                accumulated.text.push_str(&chunk.content);
            }
            ChatStreamEvent::ReasoningChunk(chunk) => {
                bytes = bytes.saturating_add(chunk.content.len());
                if bytes > MAX_TEXT_BYTES {
                    return Err(ProbeError::Protocol);
                }
            }
            ChatStreamEvent::End(end) => {
                let message = assistant_from_end(end, accumulated, &config.label);
                return Ok(if tool {
                    message.tool_calls().any(|call| {
                        call.name == TOOL
                            && call
                                .arguments
                                .get("value")
                                .and_then(serde_json::Value::as_str)
                                == Some("ok")
                    })
                } else {
                    !message.text().is_empty()
                });
            }
            _ => {}
        }
    }
    Err(ProbeError::Protocol)
}
fn classify(error: genai::Error) -> ProbeError {
    classify_ref(&error)
}
fn classify_ref(error: &genai::Error) -> ProbeError {
    use genai::Error as E;
    if let Some(status) = error.status() {
        return match status.as_u16() {
            401 | 403 => ProbeError::Auth,
            429 => ProbeError::RateLimit,
            400 | 404 | 405 | 422 => ProbeError::Protocol,
            408 => ProbeError::Timeout,
            _ => ProbeError::Unknown,
        };
    }
    match error {
        E::RequiresApiKey { .. } | E::NoAuthData { .. } | E::NoAuthResolver { .. } => {
            ProbeError::Auth
        }
        E::WebStream { error, .. } => {
            if error.is::<genai::webc::StreamTimeout>() {
                return ProbeError::Timeout;
            }
            if let Some(inner) = error.downcast_ref::<genai::Error>() {
                classify_ref(inner)
            } else if let Some(inner) = error.downcast_ref::<reqwest::Error>() {
                if inner.is_timeout() {
                    ProbeError::Timeout
                } else {
                    ProbeError::Network
                }
            } else {
                ProbeError::Network
            }
        }
        E::WebModelCall { webc_error, .. } | E::WebAdapterCall { webc_error, .. } => {
            match webc_error {
                genai::webc::Error::Reqwest(e) => {
                    if e.is_timeout() {
                        ProbeError::Timeout
                    } else {
                        ProbeError::Network
                    }
                }
                _ => ProbeError::Protocol,
            }
        }
        E::StreamParse { .. }
        | E::InvalidJsonResponseElement { .. }
        | E::ChatResponseGeneration { .. }
        | E::SerdeJson(_)
        | E::JsonValueExt(_)
        | E::AdapterNotSupported { .. }
        | E::AdapterKindMismatch { .. } => ProbeError::Protocol,
        // Streaming error events may contain arbitrary provider text. Do not guess an HTTP
        // status from a body, especially one that could contain echoed credentials.
        _ => ProbeError::Unknown,
    }
}
