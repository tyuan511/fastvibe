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

#[derive(Clone)]
pub struct AgentContext {
    pub model: Arc<dyn Model>,
    pub tools: Arc<ToolRegistry>,
    pub system: String,
    pub cwd: Option<PathBuf>,
    /// Where a tool's questions go; absent when no client can answer.
    pub ui: Option<Arc<dyn crate::UserInput>>,
    /// The deferred tools this conversation has loaded (see `tool_search`).
    pub loaded: crate::LoadedTools,
    /// The sandbox and approval rules of this turn; absent means no limits.
    pub permissions: Option<Arc<crate::Permissions>>,
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

/// Add a message to the history and announce it.
fn commit(history: &mut Vec<Message>, events: &Events, message: Message) {
    emit(events, AgentEvent::Committed(message.clone()));
    history.push(message);
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
    commit(history, events, Message::User { text: user_text });
    // Reads run side by side; a write waits for them and then runs alone. One lock for the
    // whole turn, shared by every batch, as in codex's `tools/parallel.rs`.
    let lock = Arc::new(RwLock::new(()));
    // A request that was refused for being too large is answered by one summary; if that does
    // not help, asking again would only repeat it.
    let mut summarized_for_overflow = false;

    loop {
        if cancel.is_cancelled() {
            return TurnOutcome::Interrupted;
        }
        // Make room before the window is full, not after the provider has refused the request.
        if crate::compact::needs_compaction(ctx, history) {
            match crate::compact::compact(ctx, history, events, cancel).await {
                Ok(()) => {}
                Err(crate::compact::CompactError::Interrupted) => return TurnOutcome::Interrupted,
                Err(crate::compact::CompactError::Failed(e)) => {
                    return TurnOutcome::Failed(format!(
                        "The conversation is full and could not be summarized: {e}"
                    ));
                }
            }
            if crate::compact::needs_compaction(ctx, history) {
                return TurnOutcome::Failed(
                    "The conversation is too large to continue, even after summarizing it.".into(),
                );
            }
        }
        let request = ModelRequest {
            system: ctx.system.clone(),
            messages: normalize(history),
            tools: ctx.tools.specs_for(&ctx.loaded),
        };
        match sample(ctx, request, events, cancel).await {
            Sampled::Done(message) => {
                let stop = message.stop.clone();
                let calls: Vec<_> = message
                    .tool_calls()
                    .map(|c| (c.id.to_string(), c.name.to_string(), c.arguments.clone()))
                    .collect();
                commit(history, events, Message::Assistant(message));
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
                // Results first, in call order; then any pictures they returned, as providers
                // want them (a tool message must not be separated from its call).
                let mut pictures = Vec::new();
                for (result, images) in results {
                    if let Message::ToolResult { call_id, name, .. } = &result
                        && !images.is_empty()
                    {
                        pictures.push(Message::ToolImages {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            images,
                        });
                    }
                    commit(history, events, result);
                }
                for message in pictures {
                    commit(history, events, message);
                }
            }
            Sampled::Aborted(partial) => {
                if let Some(m) = partial {
                    commit(history, events, Message::Assistant(m));
                }
                return TurnOutcome::Interrupted;
            }
            Sampled::Failed {
                partial: None,
                overflow: true,
                ..
            } if !summarized_for_overflow => {
                summarized_for_overflow = true;
                match crate::compact::compact(ctx, history, events, cancel).await {
                    Ok(()) => continue,
                    Err(crate::compact::CompactError::Interrupted) => {
                        return TurnOutcome::Interrupted;
                    }
                    Err(crate::compact::CompactError::Failed(e)) => {
                        return TurnOutcome::Failed(format!(
                            "The conversation is too large for the model and could not be summarized: {e}"
                        ));
                    }
                }
            }
            Sampled::Failed { partial, error, .. } => {
                if let Some(m) = partial {
                    commit(history, events, Message::Assistant(m));
                }
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
        /// The request was larger than the model's window.
        overflow: bool,
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
                    overflow: false,
                };
            }
            Some(Err(e)) => {
                blocks.close();
                return Sampled::Failed {
                    partial: blocks.partial(),
                    error: e.message,
                    overflow: e.overflow,
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
                Open::Thinking => ContentBlock::Thinking {
                    text,
                    signature: None,
                },
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
            model: None,
        })
    }
}

async fn execute_calls(
    ctx: &AgentContext,
    calls: Vec<(String, String, Value)>,
    lock: &Arc<RwLock<()>>,
    events: &Events,
    cancel: &CancellationToken,
) -> Vec<(Message, Vec<fv_core::ImagePart>)> {
    // `join_all` polls in order, so locks are requested in call order; the lock is fair, so a
    // write queued behind earlier reads waits for them and later reads wait for it.
    let runs = calls.into_iter().map(|(call_id, name, arguments)| {
        // A deferred tool the model has not found yet is not there to be called.
        let tool = ctx.tools.get(&name).filter(|t| !t.deferred() || ctx.loaded.contains(&name));
        let lock = lock.clone();
        let cancel = cancel.clone();
        let cwd = ctx.cwd.clone();
        let ui = ctx.ui.clone();
        let permissions = ctx.permissions.clone();
        let vision = ctx.model.supports_images();
        let registry = ctx.tools.clone();
        let loaded = ctx.loaded.clone();
        let events = events.clone();
        async move {
            let (content, is_error, images) = match tool {
                None => (unknown_tool(&name, &registry), true, Vec::new()),
                Some(tool) => {
                    let tool_ctx = ToolCtx {
                        cancel: cancel.clone(),
                        cwd,
                        call_id: call_id.clone(),
                        ui,
                        permissions,
                        vision,
                        registry,
                        loaded,
                    };
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
                        _ = cancel.cancelled() => ("Stopped by the user before it finished.".to_string(), true, Vec::new()),
                        out = run => (out.content, out.is_error, out.images),
                    }
                }
            };
            emit(&events, AgentEvent::ToolResult { call_id: call_id.clone(), name: name.clone(), arguments, output: content.clone(), is_error });
            (Message::ToolResult { call_id, name, content, is_error }, images)
        }
    });
    join_all(runs).await
}

#[allow(dead_code)] // held only for its Drop
enum Guard {
    Read(tokio::sync::OwnedRwLockReadGuard<()>),
    Write(tokio::sync::OwnedRwLockWriteGuard<()>),
}

fn unknown_tool(name: &str, registry: &ToolRegistry) -> String {
    if registry.deferred_specs().iter().any(|t| t.name == name) {
        format!("Tool `{name}` is not loaded yet. Find it with tool_search first.")
    } else {
        format!("Unknown tool: {name}")
    }
}
