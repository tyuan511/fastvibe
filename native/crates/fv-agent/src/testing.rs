//! Models for tests and for running the server before a real provider is configured.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason, Usage};
use serde_json::Value;

use crate::model::{Model, ModelError, ModelEvent, ModelRequest};

/// One step of a scripted reply.
#[derive(Clone, Debug)]
pub enum Step {
    Event(ModelEvent),
    Wait(Duration),
    Fail(ModelError),
    /// Never produce anything again (a provider that stalls).
    Hang,
}

/// A model that plays back prepared replies, one per request, and remembers what it was asked.
#[derive(Default)]
pub struct ScriptedModel {
    replies: Mutex<VecDeque<Vec<Step>>>,
    pub requests: Mutex<Vec<ModelRequest>>,
}

impl ScriptedModel {
    pub fn new(replies: impl IntoIterator<Item = Vec<Step>>) -> Self {
        Self {
            replies: Mutex::new(replies.into_iter().collect()),
            requests: Mutex::default(),
        }
    }

    pub fn requests(&self) -> Vec<ModelRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl Model for ScriptedModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        self.requests.lock().unwrap().push(request);
        let steps = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| {
            vec![Step::Fail(ModelError::fatal(
                "the script has no more replies",
            ))]
        });
        stream::unfold(steps.into_iter(), |mut steps| async move {
            loop {
                match steps.next()? {
                    Step::Event(e) => return Some((Ok(e), steps)),
                    Step::Fail(e) => return Some((Err(e), steps)),
                    Step::Wait(d) => tokio::time::sleep(d).await,
                    Step::Hang => std::future::pending::<()>().await,
                }
            }
        })
        .boxed()
    }
}

/// Builds a reply's steps: deltas as they would stream, then the complete message.
#[derive(Default)]
pub struct Reply {
    steps: Vec<Step>,
    content: Vec<ContentBlock>,
}

impl Reply {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn thinking(mut self, text: &str) -> Self {
        self.steps
            .push(Step::Event(ModelEvent::Thinking(text.into())));
        self.content.push(ContentBlock::Thinking {
            text: text.into(),
            signature: None,
        });
        self
    }

    /// Streams `text` word by word.
    pub fn text(mut self, text: &str) -> Self {
        for word in text.split_inclusive(' ') {
            self.steps.push(Step::Event(ModelEvent::Text(word.into())));
        }
        self.content.push(ContentBlock::Text { text: text.into() });
        self
    }

    pub fn tool(mut self, id: &str, name: &str, arguments: Value) -> Self {
        self.steps.push(Step::Event(ModelEvent::ToolCallStart {
            id: id.into(),
            name: name.into(),
        }));
        self.steps.push(Step::Event(ModelEvent::ToolCallArgs {
            id: id.into(),
            delta: arguments.to_string(),
        }));
        self.content.push(ContentBlock::ToolCall {
            id: id.into(),
            name: name.into(),
            arguments,
        });
        self
    }

    pub fn wait(mut self, d: Duration) -> Self {
        self.steps.push(Step::Wait(d));
        self
    }

    pub fn then_hang(mut self) -> Vec<Step> {
        self.steps.push(Step::Hang);
        self.steps
    }

    pub fn then_fail(mut self, message: &str) -> Vec<Step> {
        self.steps.push(Step::Fail(ModelError::fatal(message)));
        self.steps
    }

    pub fn done(mut self) -> Vec<Step> {
        let has_tools = self
            .content
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolCall { .. }));
        let stop = if has_tools {
            StopReason::ToolUse
        } else {
            StopReason::Stop
        };
        let message = AssistantMessage {
            content: self.content,
            stop,
            usage: Usage {
                input_tokens: 10,
                output_tokens: 5,
                ..Usage::default()
            },
            model: None,
        };
        self.steps.push(Step::Event(ModelEvent::Done(message)));
        self.steps
    }
}

/// Answers every message by echoing it back, a few words at a time. For trying the server
/// by hand before any provider is configured (`fastvibe-server --model echo`).
pub struct EchoModel;

impl Model for EchoModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        let last = request
            .messages
            .iter()
            .rev()
            .find_map(|m| match m {
                Message::User { text } => Some(text.clone()),
                _ => None,
            })
            .unwrap_or_default();
        let reply = format!("echo: {last}");
        let mut steps = Vec::new();
        for word in reply.split_inclusive(' ') {
            steps.push(Step::Wait(Duration::from_millis(30)));
            steps.push(Step::Event(ModelEvent::Text(word.into())));
        }
        steps.push(Step::Event(ModelEvent::Done(AssistantMessage {
            content: vec![ContentBlock::Text { text: reply }],
            stop: StopReason::Stop,
            usage: Usage::default(),
            model: None,
        })));
        ScriptedModel::new([steps]).stream(request)
    }
}

/// The model of a server nobody has configured: every request says so.
pub struct NoModel;

impl Model for NoModel {
    fn stream(&self, _: ModelRequest) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        stream::once(async {
            Err(ModelError::fatal(
                "No model is configured. Add a provider and choose a model first.",
            ))
        })
        .boxed()
    }
}
