use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, BoxStream};
use futures_util::{Stream, StreamExt};
use fv_agent::{Model, ModelError, ModelEvent, ModelRequest};
use genai::adapter::AdapterKind;
use genai::chat::{ChatOptions, ChatStreamEvent, ReasoningEffort};
use genai::resolver::{AuthData, Endpoint, ServiceTargetResolver};
use genai::{Client, Headers, ModelIden, ServiceTarget};

use crate::config::{ModelConfig, Protocol, ThinkingLevel};
use crate::convert::{Streamed, assistant_from_end, to_chat_request};
use crate::error::classify;
use crate::url::engine_base_url;

/// One configured model, callable as a [`fv_agent::Model`].
pub struct GenaiModel {
    config: ModelConfig,
    client: Client,
}

fn adapter(protocol: Protocol) -> AdapterKind {
    match protocol {
        Protocol::OpenAiChat => AdapterKind::OpenAI,
        Protocol::OpenAiResponses => AdapterKind::OpenAIResp,
        Protocol::Anthropic => AdapterKind::Anthropic,
        Protocol::Google => AdapterKind::Gemini,
    }
}

fn effort(level: ThinkingLevel) -> ReasoningEffort {
    match level {
        ThinkingLevel::Minimal => ReasoningEffort::Minimal,
        ThinkingLevel::Low => ReasoningEffort::Low,
        ThinkingLevel::Medium => ReasoningEffort::Medium,
        ThinkingLevel::High => ReasoningEffort::High,
        ThinkingLevel::Xhigh => ReasoningEffort::XHigh,
        ThinkingLevel::Max => ReasoningEffort::Max,
    }
}

impl GenaiModel {
    pub async fn probe(&self, budget: crate::ProbeBudget) -> crate::ProbeReport {
        crate::probe::run(&self.client, &self.config, self.options(), budget).await
    }

    pub fn new(config: ModelConfig) -> Result<Self, ModelError> {
        // The endpoint, key and protocol are ours, not genai's: it would otherwise guess an
        // adapter from the model name and read the key from an environment variable.
        let base = engine_base_url(config.protocol, &config.base_url);
        let kind = adapter(config.protocol);
        let key = config.api_key.clone();
        let resolver = ServiceTargetResolver::from_resolver_fn(
            move |target: ServiceTarget| -> Result<ServiceTarget, genai::resolver::Error> {
                Ok(ServiceTarget {
                    endpoint: Endpoint::from_owned(base.clone()),
                    auth: AuthData::from_single(key.clone()),
                    model: ModelIden::new(kind, target.model.model_name),
                })
            },
        );
        let client = Client::builder()
            .with_service_target_resolver(resolver)
            .build()
            .map_err(|e| ModelError::fatal(format!("Could not set up the model client: {e}")))?;
        Ok(Self { config, client })
    }

    fn options(&self) -> ChatOptions {
        let mut o = ChatOptions::default()
            .with_capture_usage(true)
            .with_capture_content(true)
            .with_capture_reasoning_content(true)
            .with_capture_tool_calls(true);
        if let Some(level) = self.config.thinking {
            o = o.with_reasoning_effort(effort(level));
        }
        if let Some(max) = self.config.max_output_tokens {
            o = o.with_max_tokens(max);
        }
        if !self.config.headers.is_empty() {
            o = o.with_extra_headers(Headers::from(self.config.headers.clone()));
        }
        o
    }
}

impl Model for GenaiModel {
    fn context_key(&self) -> String {
        use std::hash::{Hash, Hasher};
        let mut key = std::hash::DefaultHasher::new();
        engine_base_url(self.config.protocol, &self.config.base_url).hash(&mut key);
        format!("{:?}", self.config.protocol).hash(&mut key);
        self.config.model_id.hash(&mut key);
        format!("route:{:x}", key.finish())
    }

    fn max_output_tokens(&self) -> Option<u32> {
        self.config.max_output_tokens
    }

    fn supports_web_search(&self) -> bool {
        self.config.web_search && self.config.protocol == Protocol::OpenAiResponses
    }
    fn supports_images(&self) -> bool {
        self.config.images
    }

    fn context_window(&self) -> Option<u32> {
        self.config.context_window
    }

    fn label(&self) -> Option<&str> {
        Some(&self.config.label)
    }

    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        let client = self.client.clone();
        let mut options = self.options();
        if let Some(limit) = request.max_output_tokens {
            options = options.with_max_tokens(
                self.config
                    .max_output_tokens
                    .map_or(limit, |configured| configured.min(limit)),
            );
        }
        let label = self.config.label.clone();
        let model_id = self.config.model_id.clone();
        let max_retries = self.config.max_retries;
        let images_ok = self.config.images;
        let mut chat = to_chat_request(&request, &label, images_ok);
        if self.supports_web_search() && request.tools.iter().any(|t| t.name == "web_search") {
            chat.tools
                .get_or_insert_with(Vec::new)
                .push(genai::chat::Tool::new_web_search());
            options=options.with_extra_body(serde_json::json!({"include":["reasoning.encrypted_content","web_search_call.action.sources"]}));
        }
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let capture = (self.config.protocol == Protocol::OpenAiResponses)
            .then(|| Arc::new(crate::web_search::Capture::new(tx)));
        if let Some(capture) = &capture {
            options = options.with_raw_frame_sink_arc(capture.clone());
        }
        let chat = Arc::new(chat);
        let opened = open_with_retry(
            client,
            model_id,
            chat,
            options,
            max_retries,
            capture.clone(),
        );
        let normal = stream::once(opened)
            .flat_map(move |opened| match opened {
                Ok((prefix, rest)) => {
                    translate(stream::iter(prefix).chain(rest), label.clone()).boxed()
                }
                Err(e) => stream::once(async move { Err(e) }).boxed(),
            })
            .boxed();
        hosted_events(normal.boxed(), rx, capture).boxed()
    }
}

type Opened = (Vec<genai::Result<ChatStreamEvent>>, genai::chat::ChatStream);

/// Start the request, repeating it while it fails before anything has arrived. Once events
/// flow a failure belongs to the caller: repeating would replay half a reply.
///
/// genai reports an HTTP error as an item of the stream rather than when it is opened, and
/// announces `Start` before the status is known, so the stream is read until its first event
/// that means something. What was read comes back as `prefix` to be played in front of the rest.
async fn open_with_retry(
    client: Client,
    model_id: String,
    chat: Arc<genai::chat::ChatRequest>,
    options: ChatOptions,
    max_retries: u32,
    capture: Option<Arc<crate::web_search::Capture>>,
) -> Result<Opened, ModelError> {
    let mut attempt = 0;
    loop {
        let failed = match client
            .exec_chat_stream(&model_id, (*chat).clone(), Some(&options))
            .await
        {
            Err(e) => classify(&e),
            Ok(response) => {
                let mut stream = response.stream;
                let mut prefix = Vec::new();
                loop {
                    match stream.next().await {
                        Some(Ok(e @ (ChatStreamEvent::Start | ChatStreamEvent::Heartbeat))) => {
                            prefix.push(Ok(e))
                        }
                        Some(Err(e)) => break classify(&e),
                        other => {
                            prefix.extend(other);
                            return Ok((prefix, stream));
                        }
                    }
                }
            }
        };
        if !failed.error.retryable
            || attempt >= max_retries
            || capture
                .as_ref()
                .is_some_and(|c| c.activity.load(std::sync::atomic::Ordering::Acquire))
        {
            return Err(failed.error);
        }
        tokio::time::sleep(backoff(attempt, failed.retry_after)).await;
        attempt += 1;
    }
}

/// Exponential backoff with jitter, as codex does (a 200ms base, doubling), unless the provider
/// said how long to wait.
fn backoff(attempt: u32, provider_hint: Option<Duration>) -> Duration {
    if let Some(hint) = provider_hint {
        return hint;
    }
    let base = 200u64.saturating_mul(1 << attempt.min(6));
    // Cheap jitter from the clock: the point is only to keep clients from retrying in step.
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::from(d.subsec_nanos()) % (base / 4 + 1))
        .unwrap_or(0);
    Duration::from_millis(base + jitter)
}

struct TranslateState {
    started_calls: HashSet<String>,
    streamed: Streamed,
}

fn translate(
    chat_stream: impl Stream<Item = genai::Result<ChatStreamEvent>>,
    label: String,
) -> impl Stream<Item = Result<ModelEvent, ModelError>> {
    let state = TranslateState {
        started_calls: HashSet::new(),
        streamed: Streamed::default(),
    };
    chat_stream
        .scan(state, move |state, item| {
            let events: Vec<Result<ModelEvent, ModelError>> = match item {
                Err(e) => vec![Err(classify(&e).error)],
                Ok(ChatStreamEvent::Chunk(c)) => {
                    state.streamed.text.push_str(&c.content);
                    vec![Ok(ModelEvent::Text(c.content))]
                }
                Ok(ChatStreamEvent::ReasoningChunk(c)) => {
                    state.streamed.reasoning.push_str(&c.content);
                    vec![Ok(ModelEvent::Thinking(c.content))]
                }
                Ok(ChatStreamEvent::ToolCallChunk(c)) => {
                    let call = c.tool_call;
                    if state.started_calls.insert(call.call_id.clone()) {
                        vec![Ok(ModelEvent::ToolCallStart {
                            id: call.call_id,
                            name: call.fn_name,
                        })]
                    } else {
                        Vec::new()
                    }
                }
                Ok(ChatStreamEvent::End(end)) => {
                    let streamed = std::mem::take(&mut state.streamed);
                    vec![Ok(ModelEvent::Done(assistant_from_end(
                        end, streamed, &label,
                    )))]
                }
                Ok(
                    ChatStreamEvent::Start
                    | ChatStreamEvent::ThoughtSignatureChunk(_)
                    | ChatStreamEvent::Heartbeat,
                ) => Vec::new(),
            };
            std::future::ready(Some(stream::iter(events)))
        })
        .flatten()
}

fn hosted_events(
    normal: BoxStream<'static, Result<ModelEvent, ModelError>>,
    rx: tokio::sync::mpsc::UnboundedReceiver<ModelEvent>,
    capture: Option<Arc<crate::web_search::Capture>>,
) -> impl Stream<Item = Result<ModelEvent, ModelError>> {
    stream::unfold(
        (normal, rx, capture, false, None),
        |(mut normal, mut rx, capture, mut ended, mut pending)| async move {
            loop {
                if let Ok(event) = rx.try_recv() {
                    return Some((Ok(event), (normal, rx, capture, ended, pending)));
                }
                if let Some(mut event) = pending.take() {
                    if let Ok(ModelEvent::Done(reply)) = &mut event
                        && let Some(capture) = &capture
                    {
                        capture.decorate(reply);
                    }
                    return Some((event, (normal, rx, capture, ended, None)));
                }
                if ended {
                    return None;
                }
                tokio::select! {biased;Some(event)=rx.recv()=>return Some((Ok(event),(normal,rx,capture,false,None))),event=normal.next()=>{if let Some(event)=event{pending=Some(event);}else{ended=true;}}}
            }
        },
    )
}
