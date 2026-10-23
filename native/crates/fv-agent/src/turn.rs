use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::future::join_all;
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};
use serde_json::Value;
use tokio::sync::{RwLock, mpsc};
use tokio_util::sync::CancellationToken;

use crate::event::{AgentEvent, BlockKind};
use crate::history::normalize;
use crate::model::{Model, ModelEvent, ModelRequest};
use crate::tool::{ToolCtx, ToolRegistry};

pub struct AgentContext {
    pub model: Arc<dyn Model>,
    pub tools: Arc<ToolRegistry>,
    pub system: String,
    pub cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    Completed,
    /// The user stopped it. Not a failure.
    Interrupted,
    Failed(String),
}

type Events = mpsc::UnboundedSender<AgentEvent>;

fn emit(events: &Events, event: AgentEvent) {
    // The receiver going away means nobody is watching; the turn still has to finish its
    // bookkeeping, so a closed channel is not an error.
    let _ = events.send(event);
}

/// Run one user turn to the end: append the user's message, then alternate model requests and
/// tool batches until the model answers without asking for tools.
///
/// `history` is left in a state that can be sent to a model again whatever happened: every
/// tool call that was made has its result (an "aborted" one if it was stopped), and a reply cut
/// short by a stop is kept as far as it got.
pub async fn run_turn(
    ctx: &AgentContext,
    history: &mut Vec<Message>,
    user_text: String,
    events: &Events,
    cancel: &CancellationToken,
) -> TurnOutcome {
    history.push(Message::User { text: user_text });
    // Reads run side by side; a write waits for them and then runs alone. One lock for the
    // whole turn, shared by every batch, as in codex's `tools/parallel.rs`.
    let lock = Arc::new(RwLock::new(()));

    loop {
        if cancel.is_cancelled() {
            return TurnOutcome::Interrupted;
        }
        let request = ModelRequest {
            system: ctx.system.clone(),
            messages: normalize(history),
            tools: ctx.tools.specs(),
        };
        match sample(ctx, request, events, cancel).await {
            Sampled::Done(message) => {
                let stop = message.stop.clone();
                let calls: Vec<_> = message
                    .tool_calls()
                    .map(|c| (c.id.to_string(), c.name.to_string(), c.arguments.clone()))
                    .collect();
                history.push(Message::Assistant(message));
                match stop {
                    StopReason::Error { message } => return TurnOutcome::Failed(message),
                    StopReason::Aborted => return TurnOutcome::Interrupted,
                    StopReason::Length if calls.is_empty() => {
                        return TurnOutcome::Failed(
                            "The reply was cut off at the output limit.".into(),
                        );
                    }
                    _ => {}
                }
                if calls.is_empty() {
                    return TurnOutcome::Completed;
                }
                let results = execute_calls(ctx, calls, &lock, events, cancel).await;
                history.extend(results);
            }
            Sampled::Aborted(partial) => {
                history.extend(partial.map(Message::Assistant));
                return TurnOutcome::Interrupted;
            }
            Sampled::Failed { partial, error } => {
                history.extend(partial.map(Message::Assistant));
                return TurnOutcome::Failed(error);
            }
        }
    }
}

enum Sampled {
    Done(AssistantMessage),
    Aborted(Option<AssistantMessage>),
    Failed {
        partial: Option<AssistantMessage>,
        error: String,
    },
}

async fn sample(
    ctx: &AgentContext,
    request: ModelRequest,
    events: &Events,
    cancel: &CancellationToken,
) -> Sampled {
    let mut stream = ctx.model.stream(request);
    let mut blocks = Blocks::new(events);
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                blocks.close();
                return Sampled::Aborted(blocks.partial());
            }
            next = stream.next() => next,
        };
        match next {
            None => {
                blocks.close();
                return Sampled::Failed {
                    partial: blocks.partial(),
                    error: "The model's response ended before it was complete.".into(),
                };
            }
            Some(Err(e)) => {
                blocks.close();
                return Sampled::Failed {
                    partial: blocks.partial(),
                    error: e.message,
                };
            }
            Some(Ok(ModelEvent::Text(d))) => blocks.delta(Open::Text, d),
            Some(Ok(ModelEvent::Thinking(d))) => blocks.delta(Open::Thinking, d),
            Some(Ok(ModelEvent::ToolCallStart { id, name })) => blocks.tool_start(id, name),
            Some(Ok(ModelEvent::ToolCallArgs { id, delta })) => blocks.tool_args(id, delta),
            Some(Ok(ModelEvent::Done(message))) => {
                blocks.finish(&message);
                emit(events, AgentEvent::MessageDone(message.clone()));
                return Sampled::Done(message);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Open {
    Text,
    Thinking,
}

/// Turns a flat stream of deltas into blocks with ids, and remembers what has arrived so a
/// reply stopped half-way can still be kept.
struct Blocks<'a> {
    events: &'a Events,
    open: Option<(String, Open, String)>,
    /// Tool calls announced while streaming: call id → (name, argument text so far).
    calls: HashMap<String, (String, String)>,
    done: Vec<ContentBlock>,
}

impl<'a> Blocks<'a> {
    fn new(events: &'a Events) -> Self {
        Self {
            events,
            open: None,
            calls: HashMap::new(),
            done: Vec::new(),
        }
    }

    fn delta(&mut self, kind: Open, delta: String) {
        if self.open.as_ref().is_some_and(|(_, k, _)| *k != kind) {
            self.close();
        }
        if self.open.is_none() {
            let id = uuid::Uuid::new_v4().to_string();
            let block_kind = if kind == Open::Text {
                BlockKind::Text
            } else {
                BlockKind::Thinking
            };
            emit(
                self.events,
                AgentEvent::BlockStarted {
                    id: id.clone(),
                    kind: block_kind,
                },
            );
            self.open = Some((id, kind, String::new()));
        }
        if let Some((id, _, buf)) = self.open.as_mut() {
            buf.push_str(&delta);
            emit(
                self.events,
                AgentEvent::BlockDelta {
                    id: id.clone(),
                    delta,
                },
            );
        }
    }

    fn close(&mut self) {
        if let Some((id, kind, text)) = self.open.take() {
            let block = match kind {
                Open::Text => ContentBlock::Text { text },
                Open::Thinking => ContentBlock::Thinking { text },
            };
            self.done.push(block.clone());
            emit(self.events, AgentEvent::BlockDone { id, block });
        }
    }

    fn tool_start(&mut self, id: String, name: String) {
        self.close();
        emit(
            self.events,
            AgentEvent::BlockStarted {
                id: id.clone(),
                kind: BlockKind::ToolCall { name: name.clone() },
            },
        );
        self.calls.insert(id, (name, String::new()));
    }

    fn tool_args(&mut self, id: String, delta: String) {
        if let Some((_, args)) = self.calls.get_mut(&id) {
            args.push_str(&delta);
            emit(self.events, AgentEvent::BlockDelta { id, delta });
        }
    }

    /// The model's complete message arrived: it is the truth, whatever the deltas said.
    fn finish(&mut self, message: &AssistantMessage) {
        self.close();
        let announced: HashSet<String> = self.calls.keys().cloned().collect();
        for block in &message.content {
            if let ContentBlock::ToolCall { id, name, .. } = block {
                if !announced.contains(id) {
                    emit(
                        self.events,
                        AgentEvent::BlockStarted {
                            id: id.clone(),
                            kind: BlockKind::ToolCall { name: name.clone() },
                        },
                    );
                }
                emit(
                    self.events,
                    AgentEvent::BlockDone {
                        id: id.clone(),
                        block: block.clone(),
                    },
                );
            }
        }
    }

    /// What had arrived, as a message; `None` when nothing had. Tool calls cut off mid-arguments
    /// are left out: they never ran and their arguments are not valid.
    fn partial(&self) -> Option<AssistantMessage> {
        if self.done.is_empty() {
            return None;
        }
        Some(AssistantMessage {
            content: self.done.clone(),
            stop: StopReason::Aborted,
            usage: Default::default(),
        })
    }
}

async fn execute_calls(
    ctx: &AgentContext,
    calls: Vec<(String, String, Value)>,
    lock: &Arc<RwLock<()>>,
    events: &Events,
    cancel: &CancellationToken,
) -> Vec<Message> {
    // `join_all` polls in order, so locks are requested in call order; the lock is fair, so a
    // write queued behind earlier reads waits for them and later reads wait for it.
    let runs = calls.into_iter().map(|(call_id, name, arguments)| {
        let tool = ctx.tools.get(&name);
        let lock = lock.clone();
        let cancel = cancel.clone();
        let cwd = ctx.cwd.clone();
        let events = events.clone();
        async move {
            let (content, is_error) = match tool {
                None => (format!("Unknown tool: {name}"), true),
                Some(tool) => {
                    let tool_ctx = ToolCtx { cancel: cancel.clone(), cwd };
                    let args = arguments.clone();
                    let run = async {
                        // Held across the call; dropped when it finishes or is stopped.
                        let _guard = if tool.mutates() {
                            Guard::Write(lock.write_owned().await)
                        } else {
                            Guard::Read(lock.read_owned().await)
                        };
                        tool.call(tool_ctx, args).await
                    };
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => ("Stopped by the user before it finished.".to_string(), true),
                        out = run => (out.content, out.is_error),
                    }
                }
            };
            emit(&events, AgentEvent::ToolResult { call_id: call_id.clone(), name: name.clone(), arguments, output: content.clone(), is_error });
            Message::ToolResult { call_id, name, content, is_error }
        }
    });
    join_all(runs).await
}

#[allow(dead_code)] // held only for its Drop
enum Guard {
    Read(tokio::sync::OwnedRwLockReadGuard<()>),
    Write(tokio::sync::OwnedRwLockWriteGuard<()>),
}
