use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::future::join_all;
use futures_util::{FutureExt, StreamExt};
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
    /// Project and environment context that changes between turns (instructions found on disk,
    /// skills, MCP notes). It leads the request as a user message instead of living in `system`,
    /// so a change to it does not invalidate the cached prefix and it is not given the trust of
    /// the system prompt. Never persisted in the transcript.
    pub context: String,
    pub cwd: Option<PathBuf>,
    /// Where a tool's questions go; absent when no client can answer.
    pub ui: Option<Arc<dyn crate::UserInput>>,
    /// The deferred tools this conversation has loaded (see `tool_search`).
    pub loaded: crate::LoadedTools,
    /// The sandbox and approval rules of this turn; absent means no limits.
    pub permissions: Option<Arc<crate::Permissions>>,
    /// Words the user said while this run was working, added before the next model request.
    pub steer: Option<Arc<crate::Steers>>,
    pub memory: Option<Arc<dyn MemorySource>>,
    pub budget: Arc<crate::ContextBudget>,
    /// Read before each request boundary so changing the setting also affects a live run.
    /// Absent means automatic compaction is enabled.
    pub compaction: Option<Arc<dyn CompactionPolicy>>,
}

pub trait CompactionPolicy: Send + Sync {
    fn automatic_enabled(&self) -> bool;
}

impl CompactionPolicy for std::sync::atomic::AtomicBool {
    fn automatic_enabled(&self) -> bool {
        self.load(std::sync::atomic::Ordering::Acquire)
    }
}

fn auto_compaction(ctx: &AgentContext) -> bool {
    ctx.compaction
        .as_ref()
        .is_none_or(|policy| policy.automatic_enabled())
}

const AUTO_COMPACTION_DISABLED: &str = "The context needs compaction, but automatic compaction is disabled. Compact this conversation manually or choose a model with a larger context window.";

/// A changing memory map. The agent persists a new snapshot only when needed; the source
/// can withdraw all snapshots immediately without changing the append-only transcript.
pub trait MemorySource: Send + Sync {
    fn snapshot(&self) -> Option<String>;
    fn instructions(&self) -> String;
}

fn refresh_memory(ctx: &AgentContext, history: &mut Vec<Message>, events: &Events) {
    let Some(summary) = ctx.memory.as_ref().and_then(|m| m.snapshot()) else {
        return;
    };
    let previous = history.iter().rev().find_map(|m| match m {
        Message::MemoryContext { summary } => Some(summary),
        _ => None,
    });
    if previous != Some(&summary) {
        commit(history, events, Message::MemoryContext { summary });
    }
}

pub(crate) fn request_messages(ctx: &AgentContext, history: &[Message]) -> Vec<Message> {
    let enabled = ctx.memory.as_ref().and_then(|m| m.snapshot()).is_some();
    let projected: Vec<_> = history
        .iter()
        .filter(|m| enabled || !matches!(m, Message::MemoryContext { .. }))
        .map(|m| {
            if let Message::Compaction {
                user_messages,
                summary,
                ..
            } = m
            {
                let window = ctx.budget.window(ctx.model.as_ref());
                let instructions = ctx
                    .memory
                    .as_ref()
                    .map(|m| m.instructions())
                    .unwrap_or_default();
                let overhead = crate::budget::prefix_tokens(
                    &format!("{instructions}{}{}", ctx.system, ctx.context),
                    &ctx.tools.specs_for(&ctx.loaded),
                );
                let room = window
                    .saturating_sub(overhead)
                    .saturating_sub(crate::budget::reply_reserve(ctx.model.as_ref(), window))
                    .saturating_sub(crate::budget::margin(window))
                    .saturating_sub(summary.len() as u64 / 3)
                    .saturating_sub(256);
                Message::User {
                    text: Message::compaction_text_with_budget(
                        user_messages,
                        summary,
                        room.saturating_mul(3)
                            .saturating_div(2)
                            .min(usize::MAX as u64) as usize,
                    ),
                }
            } else {
                m.clone()
            }
        })
        .collect();
    normalize(&projected)
}

pub(crate) fn model_request(ctx: &AgentContext, history: &[Message]) -> ModelRequest {
    let memory_instructions = ctx
        .memory
        .as_ref()
        .map(|m| m.instructions())
        .unwrap_or_default();
    ModelRequest {
        system: format!("{memory_instructions}{}", ctx.system),
        messages: {
            let mut messages = request_messages(ctx, history);
            if !ctx.context.trim().is_empty() {
                messages.insert(
                    0,
                    Message::User {
                        text: ctx.context.clone(),
                    },
                );
            }
            messages
        },
        tools: ctx
            .tools
            .specs_for(&ctx.loaded)
            .into_iter()
            .filter(|s| {
                !ctx.tools.get(&s.name).is_some_and(|t| t.hosted())
                    || ctx.model.supports_web_search()
            })
            .collect(),
        max_output_tokens: None,
    }
}

pub(crate) fn learn_capacity(ctx: &AgentContext, request: &ModelRequest, events: &Events) -> bool {
    let used = crate::budget::request_tokens(request);
    let output = request.max_output_tokens.map(u64::from).unwrap_or_else(|| {
        crate::budget::reply_reserve(ctx.model.as_ref(), ctx.budget.window(ctx.model.as_ref()))
    });
    let changed = ctx.budget.reject(ctx.model.as_ref(), used, output);
    if changed {
        emit(
            events,
            AgentEvent::ContextBudgetChanged {
                used,
                window: ctx.budget.window(ctx.model.as_ref()),
            },
        );
    }
    changed
}

const CAPACITY_PAUSED: &str = "The conversation cannot fit the model's actual context capacity. Edit or retry an earlier turn, change the model, or compact manually to probe its capacity again.";

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
    let result = run_turn_inner(ctx, history, user_text, events, cancel).await;
    ctx.tools.finish_turn().await;
    result
}

async fn run_turn_inner(
    ctx: &AgentContext,
    history: &mut Vec<Message>,
    user_text: String,
    events: &Events,
    cancel: &CancellationToken,
) -> TurnOutcome {
    refresh_memory(ctx, history, events);
    commit(history, events, Message::User { text: user_text });
    if cancel.is_cancelled() {
        return TurnOutcome::Interrupted;
    }
    if ctx.budget.blocked(ctx.model.as_ref(), history) {
        return TurnOutcome::Failed(CAPACITY_PAUSED.into());
    }
    ctx.budget.recovered(ctx.model.as_ref());
    // Reads run side by side; a write waits for them and then runs alone. One lock for the
    // whole turn, shared by every batch, as in codex's `tools/parallel.rs`.
    let lock = Arc::new(RwLock::new(()));
    let mut capacity_recovery = false;

    loop {
        if cancel.is_cancelled() {
            return TurnOutcome::Interrupted;
        }
        // What the user said while the previous step was running, added *here* — at the top of
        // the loop, where the history ends with a completed tool batch. Never mid-batch: a
        // provider rejects a user message wedged between a call and its result, and the model
        // would be deciding with half of its own work missing.
        drain_steers(ctx, history, events);
        refresh_memory(ctx, history, events);
        // Make room before the window is full, not after the provider has refused the request.
        if capacity_recovery || crate::compact::needs_compaction(ctx, history) {
            if !auto_compaction(ctx) {
                return TurnOutcome::Failed(AUTO_COMPACTION_DISABLED.into());
            }
            capacity_recovery = false;
            match crate::compact::compact_auto(ctx, history, events, cancel).await {
                Ok(()) => {}
                Err(crate::compact::CompactError::Interrupted) => return TurnOutcome::Interrupted,
                Err(crate::compact::CompactError::Capacity(e)) => {
                    ctx.budget.block(ctx.model.as_ref(), history);
                    return TurnOutcome::Failed(format!("{e} {CAPACITY_PAUSED}"));
                }
                Err(crate::compact::CompactError::Failed(e)) => {
                    return TurnOutcome::Failed(format!(
                        "The conversation is full and could not be summarized: {e}"
                    ));
                }
            }
            if crate::compact::needs_compaction(ctx, history) {
                ctx.budget.block(ctx.model.as_ref(), history);
                return TurnOutcome::Failed(
                    "The conversation is too large to continue, even after summarizing it.".into(),
                );
            }
        }
        refresh_memory(ctx, history, events);
        let mut request = model_request(ctx, history);
        let used = crate::budget::request_tokens(&request);
        let window = ctx.budget.window(ctx.model.as_ref());
        if ctx.budget.learned(ctx.model.as_ref()) {
            let room = window
                .saturating_sub(used)
                .saturating_sub(crate::budget::margin(window));
            if room < crate::budget::reply_reserve(ctx.model.as_ref(), window).min(1024) {
                if !auto_compaction(ctx) {
                    return TurnOutcome::Failed(AUTO_COMPACTION_DISABLED.into());
                }
                capacity_recovery = true;
                continue;
            }
            request.max_output_tokens = Some(
                room.min(ctx.model.max_output_tokens().map(u64::from).unwrap_or(4096))
                    .min(u32::MAX as u64) as u32,
            );
        }
        let capacity_request = request.clone();
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
                    StopReason::Length => {
                        // A parsed JSON call can still belong to a truncated reply. Close
                        // it without dispatching, so both live UI and persisted history
                        // have a terminal result rather than an eternally pending tool.
                        for (call_id, name, arguments) in calls {
                            let output = "Tool call was not executed because the reply reached its output limit.".to_string();
                            emit(
                                events,
                                AgentEvent::ToolResult {
                                    call_id: call_id.clone(),
                                    name: name.clone(),
                                    arguments,
                                    output: output.clone(),
                                    is_error: true,
                                },
                            );
                            commit(
                                history,
                                events,
                                Message::ToolResult {
                                    call_id,
                                    name,
                                    content: output,
                                    is_error: true,
                                },
                            );
                        }
                        return TurnOutcome::Failed(
                            "The reply was cut off at the output limit.".into(),
                        );
                    }
                    _ => {}
                }
                ctx.budget.recovered(ctx.model.as_ref());
                if calls.is_empty() {
                    // A steer that arrived after this request was built still has to be run: it
                    // is the user's latest words and the answer above may not have seen them.
                    if ctx.steer.as_ref().is_some_and(|s| !s.is_empty()) {
                        continue;
                    }
                    return TurnOutcome::Completed;
                }
                let results = execute_calls(ctx, calls, history.len(), &lock, events, cancel).await;
                // Results first, in call order; then any pictures they returned, as providers
                // want them (a tool message must not be separated from its call).
                let mut pictures = Vec::new();
                let mut audio = Vec::new();
                for (result, images, clips) in results {
                    if let Message::ToolResult { call_id, name, .. } = &result
                        && !images.is_empty()
                    {
                        pictures.push(Message::ToolImages {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            images,
                        });
                    }
                    if let Message::ToolResult { call_id, name, .. } = &result
                        && !clips.is_empty()
                    {
                        audio.push(Message::ToolAudio {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            audio: clips,
                        });
                    }
                    commit(history, events, result);
                }
                for message in pictures {
                    commit(history, events, message);
                }
                for message in audio {
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
            } => {
                if !learn_capacity(ctx, &capacity_request, events) {
                    ctx.budget.block(ctx.model.as_ref(), history);
                    return TurnOutcome::Failed(CAPACITY_PAUSED.into());
                }
                if !auto_compaction(ctx) {
                    return TurnOutcome::Failed(AUTO_COMPACTION_DISABLED.into());
                }
                capacity_recovery = true;
                continue;
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

/// Move waiting steers into the history as user messages.
///
/// Each one is committed on its own, so the transcript shows it as what the user said, in the
/// order they said it, and a crash mid-drain keeps the ones already in.
fn drain_steers(ctx: &AgentContext, history: &mut Vec<Message>, events: &Events) {
    let Some(steer) = &ctx.steer else {
        return;
    };
    for text in steer.take() {
        commit(history, events, Message::User { text });
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
    let started = std::time::Instant::now();
    let mut stream = ctx.model.stream(request);
    let mut blocks = Blocks::new(events);
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                return Sampled::Aborted(blocks.aborted());
            }
            next = stream.next() => next,
        };
        match next {
            None => {
                return Sampled::Failed {
                    partial: blocks.aborted(),
                    error: "The model's response ended before it was complete.".into(),
                    overflow: false,
                };
            }
            Some(Err(e)) => {
                return Sampled::Failed {
                    partial: blocks.aborted(),
                    error: e.message,
                    overflow: e.overflow,
                };
            }
            Some(Ok(ModelEvent::HostedSearch(call))) => blocks.hosted(call),
            Some(Ok(ModelEvent::Citations(citations))) => {
                for c in citations {
                    if !blocks.citations.contains(&c) {
                        blocks.citations.push(c);
                    }
                }
            }
            Some(Ok(ModelEvent::Text(d))) => blocks.delta(Open::Text, d),
            Some(Ok(ModelEvent::Thinking(d))) => blocks.delta(Open::Thinking, d),
            Some(Ok(ModelEvent::ToolCallStart { id, name })) => blocks.tool_start(id, name),
            Some(Ok(ModelEvent::ToolCallArgs { id, delta })) => blocks.tool_args(id, delta),
            Some(Ok(ModelEvent::Done(mut message))) => {
                message.duration_ms = Some(started.elapsed().as_millis() as u64);
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
    rendered: Vec<(String, ContentBlock)>,
    hosted: std::collections::BTreeMap<String, fv_core::WebSearchCall>,
    citations: Vec<fv_core::UrlCitation>,
    text_since_hosted: bool,
}

impl<'a> Blocks<'a> {
    fn new(events: &'a Events) -> Self {
        Self {
            events,
            open: None,
            calls: HashMap::new(),
            done: Vec::new(),
            rendered: Vec::new(),
            hosted: Default::default(),
            citations: Vec::new(),
            text_since_hosted: false,
        }
    }

    fn delta(&mut self, kind: Open, delta: String) {
        if kind == Open::Text {
            self.text_since_hosted = true;
        }
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
            self.rendered.push((id.clone(), block.clone()));
            emit(self.events, AgentEvent::BlockDone { id, block });
        }
    }

    fn hosted(&mut self, call: fv_core::WebSearchCall) {
        if self.hosted.get(&call.id) == Some(&call) {
            return;
        }
        if !self.hosted.contains_key(&call.id) {
            self.close();
            self.text_since_hosted = false;
        }
        if let Some(block) = self
            .done
            .iter_mut()
            .find(|b| matches!(b, ContentBlock::HostedSearch(old) if old.id == call.id))
        {
            *block = ContentBlock::HostedSearch(call.clone());
        } else {
            self.done.push(ContentBlock::HostedSearch(call.clone()));
        }
        self.hosted.insert(call.id.clone(), call.clone());
        emit(self.events, AgentEvent::HostedSearch(call));
    }
    fn aborted(&mut self) -> Option<AssistantMessage> {
        self.close();
        let partial = self.partial();
        if let Some(reply) = &partial {
            self.finish(reply);
        }
        partial
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
        for block in &message.content {
            if let ContentBlock::HostedSearch(call) = block {
                self.hosted(call.clone());
            }
        }
        // Complete provider content is authoritative, including citation-rendered text
        // and Responses endpoints which send final text but omit deltas.
        for thinking in [false, true] {
            let select = |b: &ContentBlock| {
                matches!(b, ContentBlock::Thinking { .. }) == thinking
                    && matches!(b, ContentBlock::Text { .. } | ContentBlock::Thinking { .. })
            };
            let final_blocks = message
                .content
                .iter()
                .filter(|b| select(b))
                .cloned()
                .collect::<Vec<_>>();
            let existing = self
                .rendered
                .iter()
                .filter(|(_, b)| select(b))
                .cloned()
                .collect::<Vec<_>>();
            let reuse = if !thinking && !self.hosted.is_empty() && !self.text_since_hosted {
                existing.len()
            } else {
                existing.len().saturating_sub(final_blocks.len())
            };
            for (index, block) in final_blocks.iter().enumerate() {
                let id = existing
                    .get(index + reuse)
                    .map(|(id, _)| id.clone())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                if existing.get(index + reuse).is_none() {
                    emit(
                        self.events,
                        AgentEvent::BlockStarted {
                            id: id.clone(),
                            kind: if thinking {
                                BlockKind::Thinking
                            } else {
                                BlockKind::Text
                            },
                        },
                    );
                }
                if existing
                    .get(index + reuse)
                    .is_none_or(|(_, old)| old != block)
                {
                    emit(
                        self.events,
                        AgentEvent::BlockDone {
                            id,
                            block: block.clone(),
                        },
                    );
                }
            }
            for (id, _) in existing.into_iter().take(reuse) {
                emit(
                    self.events,
                    AgentEvent::BlockDone {
                        id,
                        block: if thinking {
                            ContentBlock::Thinking {
                                text: String::new(),
                                signature: None,
                            }
                        } else {
                            ContentBlock::Text {
                                text: String::new(),
                            }
                        },
                    },
                );
            }
        }
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
        if self.done.is_empty() && self.hosted.is_empty() {
            return None;
        }
        let mut content = self.done.clone();
        if !self.citations.is_empty() {
            let joined = content
                .iter()
                .filter_map(|b| {
                    if let ContentBlock::Text { text } = b {
                        Some(text.as_str())
                    } else {
                        None
                    }
                })
                .collect::<String>();
            let rendered = fv_core::citation_markdown(&joined, &self.citations);
            let mut last = true;
            for b in content.iter_mut().rev() {
                if let ContentBlock::Text { text } = b {
                    *text = if last {
                        last = false;
                        rendered.clone()
                    } else {
                        String::new()
                    };
                }
            }
            content.push(ContentBlock::Citations {
                citations: self.citations.clone(),
            });
        }
        for block in &mut content {
            if let ContentBlock::HostedSearch(call) = block
                && !call.status.terminal()
            {
                call.status = fv_core::SearchStatus::Interrupted;
            }
        }
        Some(AssistantMessage {
            duration_ms: None,
            content,
            stop: StopReason::Aborted,
            usage: Default::default(),
            model: None,
        })
    }
}

async fn execute_calls(
    ctx: &AgentContext,
    calls: Vec<(String, String, Value)>,
    history_len: usize,
    lock: &Arc<RwLock<()>>,
    events: &Events,
    cancel: &CancellationToken,
) -> Vec<(Message, Vec<fv_core::ImagePart>, Vec<fv_core::AudioPart>)> {
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
            let (content, is_error, images, audio) = match tool {
                None => (unknown_tool(&name, &registry), true, Vec::new(), Vec::new()),
                Some(tool) => {
                    let tool_ctx = ToolCtx {
                        cancel: cancel.clone(),
                        cwd,
                        call_id: call_id.clone(),
                        history_len,
                        history_call_id: call_id.clone(),
                        nested: Some(Arc::new(NestedDispatcher { lock: lock.clone(), events: events.clone() })),
                        ui,
                        permissions,
                        vision,
                        registry,
                        loaded,
                    };
                    let args = arguments.clone();
                    let run = async {
                        // Held across the call; dropped when it finishes or is stopped.
                        let _guard = if tool.orchestrates() { None } else if tool.mutates() {
                            Some(Guard::Write(lock.write_owned().await))
                        } else {
                            Some(Guard::Read(lock.read_owned().await))
                        };
                        tool.call(tool_ctx, args).await
                    };
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => ("Stopped by the user before it finished.".to_string(), true, Vec::new(), Vec::new()),
                        out = run => (out.content, out.is_error, out.images, out.audio),
                    }
                }
            };
            emit(&events, AgentEvent::ToolResult { call_id: call_id.clone(), name: name.clone(), arguments, output: content.clone(), is_error });
            (Message::ToolResult { call_id, name, content, is_error }, images, audio)
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

struct NestedDispatcher {
    lock: Arc<RwLock<()>>,
    events: Events,
}
impl crate::NestedTools for NestedDispatcher {
    fn call(
        &self,
        ctx: ToolCtx,
        name: String,
        arguments: Value,
    ) -> futures_util::future::BoxFuture<'static, crate::ToolOutput> {
        let lock = self.lock.clone();
        let events = self.events.clone();
        Box::pin(async move {
            let parent_id = ctx.history_call_id.clone();
            let call_id = ctx.call_id.clone();
            emit(
                &events,
                AgentEvent::NestedToolStarted {
                    parent_id: parent_id.clone(),
                    call_id: call_id.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                },
            );
            let tool = ctx
                .registry
                .get(&name)
                .filter(|t| t.enabled(&ctx.registry) && !t.orchestrates() && !t.hosted());
            let cancel = ctx.cancel.clone();
            let run = async {
                match tool {
                    None => crate::ToolOutput::err(format!(
                        "Tool `{name}` is unavailable or cannot be nested."
                    )),
                    Some(tool) => {
                        let _guard = if tool.mutates() {
                            Guard::Write(lock.write_owned().await)
                        } else {
                            Guard::Read(lock.read_owned().await)
                        };
                        tool.call(ctx, arguments.clone()).await
                    }
                }
            };
            let out = tokio::select! {biased;_ = cancel.cancelled()=>crate::ToolOutput::err("Stopped before the nested call finished."),out=std::panic::AssertUnwindSafe(run).catch_unwind()=>out.unwrap_or_else(|_|crate::ToolOutput::err("Nested tool failed internally."))};
            emit(
                &events,
                AgentEvent::NestedToolFinished {
                    parent_id,
                    call_id,
                    name,
                    arguments,
                    output: out.content.clone(),
                    is_error: out.is_error,
                },
            );
            out
        })
    }
}
