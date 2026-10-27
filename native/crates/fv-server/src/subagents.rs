//! In-process child sessions. Tool names and lifecycle follow Codex's multi_agents handler;
//! execution, persistence and client transport use FastVibe's ordinary thread engine.
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
use fv_protocol::subagents::*;
use fv_protocol::types::{Empty, Item, Thread, TurnStatus};
use fv_protocol::{ErrorObject, ServerNotification, jsonrpc::code};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::state::{ServerState, now_ms};
pub(crate) mod roles;

const CONFIG: &str = "subagent_config_v1";
const PREVIEW_CHARS: usize = 8_000;
const MAX_TASK_CHARS: usize = 32_000;

fn invalid(message: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message.to_string())
}
fn internal(error: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, error.to_string())
}
pub(crate) fn changed(state: &ServerState) {
    state
        .subagent_changes
        .send_modify(|n| *n = n.wrapping_add(1));
    state.broadcast(ServerNotification::SubagentsChanged(Empty {}));
}
pub fn config(state: &ServerState) -> Result<SubagentConfig, ErrorObject> {
    state
        .store
        .db
        .get_setting(CONFIG)
        .map_err(internal)?
        .map(|s| serde_json::from_str(&s).map_err(internal))
        .transpose()
        .map(|c| c.unwrap_or_default())
}
pub fn configure(
    state: &ServerState,
    value: SubagentConfig,
) -> Result<SubagentConfig, ErrorObject> {
    if !(1..=16).contains(&value.max_agents) || !(1..=3).contains(&value.max_depth) {
        return Err(invalid("Use 1–16 agents and a maximum depth of 1–3."));
    }
    let _gate = state.subagents_lock.lock().unwrap();
    state
        .store
        .db
        .set_setting(
            CONFIG,
            Some(&serde_json::to_string(&value).map_err(internal)?),
        )
        .map_err(internal)?;
    changed(state);
    Ok(value)
}
pub fn list(
    state: &ServerState,
    thread: Option<&str>,
) -> Result<SubagentListResponse, ErrorObject> {
    let root = thread.map(|id| root_id(state, id)).transpose()?;
    let mut agents = match root {
        Some(root) => state.store.db.subagents(Some(&root)),
        None => state.store.db.recent_subagents(),
    }
    .map_err(internal)?;
    for a in &mut agents {
        a.waiting_for_input = !state.pending_prompts(&a.agent_id).is_empty();
    }
    Ok(SubagentListResponse { agents })
}
pub(crate) fn root_id(state: &ServerState, id: &str) -> Result<String, ErrorObject> {
    if state.thread(id)?.is_none() {
        return Err(invalid("thread not found"));
    }
    Ok(state
        .store
        .db
        .subagent(id)
        .map_err(internal)?
        .map(|a| a.root_thread_id)
        .unwrap_or_else(|| id.into()))
}
fn get(state: &ServerState, id: &str) -> Result<Subagent, ErrorObject> {
    state
        .store
        .db
        .subagent(id)
        .map_err(internal)?
        .ok_or_else(|| invalid("agent not found"))
}
fn owned(state: &ServerState, parent: &str, id: &str) -> Result<Subagent, ErrorObject> {
    let agent = get(state, id)?;
    if agent.parent_thread_id != parent {
        return Err(invalid(
            "Only direct children can be controlled by this agent.",
        ));
    }
    Ok(agent)
}
pub fn is_child(state: &ServerState, id: &str) -> bool {
    state.store.db.subagent(id).ok().flatten().is_some()
}
fn room(state: &ServerState, root: &str, config: &SubagentConfig) -> Result<(), ErrorObject> {
    if !config.enabled {
        return Err(invalid("Subagents are disabled in settings."));
    }
    let count = state
        .store
        .db
        .subagents(Some(root))
        .map_err(internal)?
        .into_iter()
        .filter(|a| {
            a.status != SubagentStatus::Closed
                || state
                    .loaded_runtime(&a.agent_id)
                    .is_some_and(|rt| rt.is_running() || rt.exec_sessions.has_running())
        })
        .count();
    if count >= config.max_agents as usize {
        return Err(invalid(
            "Agent limit reached. Close an agent before creating or resuming another.",
        ));
    }
    Ok(())
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnArgs {
    message: String,
    #[serde(default)]
    fork_context: bool,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(skip)]
    history: Option<fv_store::Loaded>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    reasoning_effort: Option<fv_protocol::types::ThinkingLevel>,
}

async fn spawn(
    state: &Arc<ServerState>,
    parent_id: &str,
    args: SpawnArgs,
    parent_cancel: &CancellationToken,
) -> Result<Subagent, ErrorObject> {
    validate_message(&args.message)?;
    if args.fork_context && args.history.is_none() {
        return Err(invalid("The parent history snapshot is missing."));
    }
    let role = roles::for_spawn(state, args.agent_type.as_deref())?;
    let id = uuid::Uuid::new_v4().to_string();
    let agent = {
        let _gate = state.subagents_lock.lock().unwrap();
        if parent_cancel.is_cancelled() {
            return Err(invalid("The parent turn was stopped."));
        }
        let parent = state
            .thread(parent_id)?
            .ok_or_else(|| invalid("parent thread not found"))?;
        let config = config(state)?;
        let source = state.store.db.subagent(parent_id).map_err(internal)?;
        if source
            .as_ref()
            .is_some_and(|s| s.status == SubagentStatus::Closed)
        {
            return Err(invalid("The parent agent is closed."));
        }
        let mut tool_ceiling = source.as_ref().and_then(|s| s.tool_ceiling.clone());
        if let Some(parent_role) = source.as_ref().and_then(|s| s.role.as_ref()) {
            if parent_role.read_only {
                return Err(invalid("A read-only agent cannot delegate work."));
            }
            if let Some(grant) = &parent_role.tools {
                tool_ceiling = Some(match tool_ceiling {
                    Some(ceiling) => ceiling
                        .into_iter()
                        .filter(|name| grant.contains(name))
                        .collect(),
                    None => grant.clone(),
                });
            }
        }
        if tool_ceiling
            .as_ref()
            .is_some_and(|tools| !tools.iter().any(|t| t == "spawn_agent"))
        {
            return Err(invalid("The parent role does not grant delegation."));
        }
        let root = source
            .as_ref()
            .map(|s| s.root_thread_id.clone())
            .unwrap_or_else(|| parent_id.into());
        let depth = source.as_ref().map(|s| s.depth).unwrap_or(0) + 1;
        if depth > config.max_depth {
            return Err(invalid(
                "Agent depth limit reached. Complete the task yourself.",
            ));
        }
        room(state, &root, &config)?;
        // Prevent an unbounded retained history even if agents are repeatedly opened/closed.
        if state
            .store
            .db
            .subagents(Some(&root))
            .map_err(internal)?
            .len()
            >= 100
        {
            return Err(invalid(
                "This conversation has reached its 100 retained child sessions.",
            ));
        }
        let defaults = crate::providers::read_defaults(state)?;
        let model = args
            .model
            .or_else(|| role.as_ref().and_then(|r| r.model.clone()))
            .or(parent.model)
            .or(defaults.model);
        let thinking = args
            .reasoning_effort
            .or_else(|| role.as_ref().and_then(|r| r.thinking))
            .or(parent.thinking)
            .or(defaults.thinking);
        if let Some(label) = &model {
            crate::providers::resolve(state, label, thinking).map_err(invalid)?;
        }
        let now = now_ms();
        let thread = Thread {
            id: id.clone(),
            title: crate::state::title_from(&args.message),
            cwd: parent.cwd,
            project: parent.project,
            source: None,
            created_at: now,
            updated_at: now,
            archived: false,
            unread: false,
            model,
            thinking,
            pinned: false,
            worktree: parent.worktree,
        };
        let agent = Subagent {
            agent_id: id.clone(),
            parent_thread_id: parent_id.into(),
            root_thread_id: root,
            depth,
            role,
            fork_context: args.fork_context,
            tool_ceiling,
            task: args.message.clone(),
            waiting_for_input: false,
            status: SubagentStatus::Idle,
            result: String::new(),
            error: None,
            updated_at: now,
        };
        let created = (|| {
            if let Some(history) = &args.history {
                let messages = history
                    .messages
                    .iter()
                    .map(|m| state.store.images.copy_message(&id, m))
                    .collect::<Result<Vec<_>, _>>()?;
                state
                    .store
                    .transcripts
                    .copy_loaded(&id, history, &messages)?;
            }
            state.store.db.create_subagent(&thread, &agent)
        })();
        if let Err(error) = created {
            let _ = state.store.transcripts.delete(&id);
            let _ = state.store.images.delete(&id);
            return Err(internal(error));
        }
        agent
    };
    // Claim with a token linked to the spawning turn. A simultaneous parent Stop therefore
    // cannot miss a newly allocated child between the ownership insert and its first poll.
    let rt = {
        let _gate = state.subagents_lock.lock().unwrap();
        get(state, &id)?;
        state.runtime(&id)
    };
    let turn_id = uuid::Uuid::new_v4().to_string();
    if !state
        .schedules
        .adopt(&agent.root_thread_id, &id, &turn_id, rt.clone())
    {
        close(state, &id)?;
        return Err(invalid("The scheduled run is stopping."));
    }
    let Some(cancel) = rt
        .begin_linked(state, &turn_id, parent_cancel.child_token())
        .await
    else {
        close(state, &id)?;
        return Err(invalid("The child session could not be started."));
    };
    crate::turn::spawn_turn(state.clone(), rt, id.clone(), turn_id, args.message, cancel);
    Ok(get(state, &id).unwrap_or(agent))
}
async fn fork_history(
    state: &ServerState,
    parent: &str,
    turn: &str,
    ctx: &ToolCtx,
) -> Result<fv_store::Loaded, ErrorObject> {
    let rt = state
        .loaded_runtime(parent)
        .ok_or_else(|| invalid("The parent session is not running."))?;
    let mut commits = rt.commits.subscribe();
    let read = async {
        loop {
            let loaded = state.store.transcripts.read(parent).map_err(internal)?;
            if loaded.skipped > 0 {
                return Err(invalid("Cannot inherit a damaged parent transcript."));
            }
            if let Some(snapshot) = loaded.before_tool_call(
                turn,
                if ctx.history_call_id.is_empty() {
                    &ctx.call_id
                } else {
                    &ctx.history_call_id
                },
                ctx.history_len,
            ) {
                return Ok(snapshot);
            }
            commits.changed().await.map_err(internal)?;
        }
    };
    tokio::select! {
        biased;
        _ = ctx.cancel.cancelled() => Err(invalid("The parent turn was stopped.")),
        result = tokio::time::timeout(Duration::from_secs(5), read) => result.map_err(|_| invalid("The parent history was not durably recorded; cannot fork this context."))?,
    }
}

fn validate_message(message: &str) -> Result<(), ErrorObject> {
    if message.trim().is_empty() || message.chars().count() > MAX_TASK_CHARS {
        return Err(invalid("The task must contain 1–32000 characters."));
    }
    Ok(())
}

/// Called by begin/end for *all* entry points, including user input in a child transcript.
/// Closed sessions cannot bypass the lifecycle/limit via ordinary turn/start.
pub fn can_begin(state: &ServerState, id: &str) -> bool {
    state
        .store
        .db
        .subagent(id)
        .map(|a| a.is_none_or(|a| a.status != SubagentStatus::Closed))
        .unwrap_or(false)
}
// Caller holds subagents_lock while claiming the runtime.
pub fn started(state: &ServerState, id: &str) {
    if let Ok(Some(mut agent)) = state.store.db.subagent(id) {
        if agent.status == SubagentStatus::Closed {
            return;
        }
        agent.status = SubagentStatus::Running;
        agent.result.clear();
        agent.error = None;
        agent.updated_at = now_ms();
        if let Err(e) = state.store.db.update_subagent(&agent) {
            eprintln!("cannot start agent {id}: {e}");
        }
        changed(state);
    }
}
pub fn settled(
    state: &ServerState,
    id: &str,
    status: TurnStatus,
    error: Option<String>,
    turns: &[fv_protocol::types::Turn],
) {
    let _gate = state.subagents_lock.lock().unwrap();
    if state.loaded_runtime(id).is_some_and(|rt| rt.is_running()) {
        return;
    }
    if let Ok(Some(mut agent)) = state.store.db.subagent(id) {
        if let Some(turn) = turns.last() {
            if agent.status != SubagentStatus::Closed {
                agent.status = match status {
                    TurnStatus::Completed => SubagentStatus::Completed,
                    TurnStatus::Interrupted => SubagentStatus::Interrupted,
                    TurnStatus::Failed => SubagentStatus::Failed,
                };
            }
            agent.result = turn
                .items
                .iter()
                .filter_map(|item| match item {
                    Item::AgentMessage { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .enumerate()
                .flat_map(|(i, text)| {
                    (if i == 0 { "" } else { "\n\n" })
                        .chars()
                        .chain(text.chars())
                })
                .take(PREVIEW_CHARS)
                .collect();
            agent.error = error;
        }
        agent.updated_at = now_ms();
        if let Err(e) = state.store.db.update_subagent(&agent) {
            eprintln!("cannot settle agent {id}: {e}");
        }
        changed(state);
    }
}

/// Close is immediate as a lifecycle decision. The worker still owns cleanup, and resume is
/// refused until it has actually settled, so its tools cannot overlap a new run.
pub fn close(state: &ServerState, id: &str) -> Result<Subagent, ErrorObject> {
    let _gate = state.subagents_lock.lock().unwrap();
    let mut agent = get(state, id)?;
    let mut ids = descendants(state, id)?;
    ids.push(id.into());
    for id in ids {
        if let Some(rt) = state.loaded_runtime(&id) {
            rt.interrupt();
            rt.exec_sessions.terminate_all();
        }
        let mut row = get(state, &id)?;
        row.status = SubagentStatus::Closed;
        row.updated_at = now_ms();
        state.store.db.update_subagent(&row).map_err(internal)?;
        if row.agent_id == agent.agent_id {
            agent = row;
        }
    }
    changed(state);
    Ok(agent)
}
pub fn resume(state: &ServerState, id: &str) -> Result<Subagent, ErrorObject> {
    let _gate = state.subagents_lock.lock().unwrap();
    let mut agent = get(state, id)?;
    if state
        .loaded_runtime(id)
        .is_some_and(|rt| rt.is_running() || rt.exec_sessions.has_running())
    {
        return Err(invalid(
            "The agent is still stopping. Wait for it to settle.",
        ));
    }
    if agent.status != SubagentStatus::Closed {
        return Ok(agent);
    }
    let config = config(state)?;
    room(state, &agent.root_thread_id, &config)?;
    if agent.depth > config.max_depth {
        return Err(invalid("Agent depth limit reached."));
    }
    // A closed ancestor cannot leave an orphaned live subtree.
    if state
        .store
        .db
        .subagent(&agent.parent_thread_id)
        .map_err(internal)?
        .is_some_and(|a| a.status == SubagentStatus::Closed)
    {
        return Err(invalid("Resume the parent agent first."));
    }
    agent.status = SubagentStatus::Idle;
    agent.updated_at = now_ms();
    state.store.db.update_subagent(&agent).map_err(internal)?;
    changed(state);
    Ok(agent)
}
pub fn descendants(state: &ServerState, parent: &str) -> Result<Vec<String>, ErrorObject> {
    let root = root_id(state, parent)?;
    let rows = state.store.db.subagents(Some(&root)).map_err(internal)?;
    let mut found = HashSet::from([parent.to_string()]);
    let mut ids = Vec::new();
    loop {
        let mut added = false;
        for a in &rows {
            if found.contains(&a.parent_thread_id) && found.insert(a.agent_id.clone()) {
                ids.push(a.agent_id.clone());
                added = true;
            }
        }
        if !added {
            break;
        }
    }
    Ok(ids)
}
pub fn interrupt_tree(state: &ServerState, parent: &str) {
    // No runtime/catalog creation for Stop. Linked cancellation handles children being born.
    if let Ok(ids) = descendants(state, parent) {
        for id in ids {
            if let Some(rt) = state.loaded_runtime(&id) {
                rt.interrupt();
                rt.exec_sessions.terminate_all();
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendArgs {
    target: String,
    message: String,
    #[serde(default)]
    interrupt: bool,
}
async fn send(
    state: &Arc<ServerState>,
    parent: &str,
    args: SendArgs,
    cancel: &CancellationToken,
) -> Result<Value, ErrorObject> {
    validate_message(&args.message)?;
    if owned(state, parent, &args.target)?.status == SubagentStatus::Closed {
        return Err(invalid("Resume this agent before sending input."));
    }
    let rt = {
        let _gate = state.subagents_lock.lock().unwrap();
        owned(state, parent, &args.target)?;
        state.runtime(&args.target)
    };
    if let Some(turn_id) = rt.running_turn() {
        if !args.interrupt {
            rt.steer(&turn_id, args.message)
                .map_err(|_| invalid("The agent just finished; send the input again."))?;
            return Ok(json!({"submission_id": turn_id}));
        }
        rt.interrupt();
        rt.exec_sessions.terminate_all();
        interrupt_tree(state, &args.target);
        let mut changes = state.subagent_changes.subscribe();
        let settled = async {
            let mut tick = tokio::time::interval(Duration::from_millis(25));
            while rt.is_running() || rt.exec_sessions.has_running() {
                tokio::select! {
                    result = changes.changed() => { result.map_err(internal)?; },
                    _ = tick.tick() => (),
                }
            }
            Ok::<_, ErrorObject>(())
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(invalid("Stopped while waiting for the agent.")),
            result = tokio::time::timeout(Duration::from_secs(15), settled) => result.map_err(|_| invalid("The agent is still stopping. Send the input again once it settles."))??,
        }
    }
    // Recheck after awaiting: another tool/UI may have closed it.
    owned(state, parent, &args.target)?;
    let turn_id = uuid::Uuid::new_v4().to_string();
    let source = owned(state, parent, &args.target)?;
    if !state
        .schedules
        .adopt(&source.root_thread_id, &args.target, &turn_id, rt.clone())
    {
        return Err(invalid("The scheduled run is stopping."));
    }
    let token = rt
        .begin_linked(state, &turn_id, cancel.child_token())
        .await
        .ok_or_else(|| invalid("The agent is busy or closed."))?;
    crate::turn::spawn_turn(
        state.clone(),
        rt,
        args.target,
        turn_id.clone(),
        args.message,
        token,
    );
    Ok(json!({"submission_id": turn_id}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArgs {
    targets: Vec<String>,
    timeout_ms: Option<u64>,
}
async fn wait(
    state: &ServerState,
    parent: &str,
    args: WaitArgs,
    cancel: &CancellationToken,
) -> Result<Value, ErrorObject> {
    if args.targets.is_empty() || args.targets.len() > 16 {
        return Err(invalid("Wait for 1–16 agents."));
    }
    let mut changes = state.subagent_changes.subscribe();
    // Register before reading states so a completion between the check and wait isn't lost.
    let deadline = tokio::time::Instant::now()
        + Duration::from_millis(args.timeout_ms.unwrap_or(30_000).min(300_000));
    loop {
        let mut status = BTreeMap::new();
        for id in &args.targets {
            let agent = owned(state, parent, id)?;
            let waiting = !state.pending_prompts(id).is_empty();
            if agent.status != SubagentStatus::Running || waiting {
                status.insert(id, json!({"status": agent.status, "result": agent.result, "error": agent.error, "waiting_for_input": waiting}));
            }
        }
        if !status.is_empty() {
            return Ok(json!({"status":status,"timed_out":false}));
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(invalid("Stopped waiting for agents.")),
            _ = tokio::time::sleep_until(deadline) => return Ok(json!({"status":{},"timed_out":true})),
            result = changes.changed() => { result.map_err(internal)?; }
        }
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Spawn,
    Send,
    Wait,
    Close,
    Resume,
    List,
}
pub fn register(state: &Arc<ServerState>, parent: &str, turn: &str, registry: &mut ToolRegistry) {
    for kind in [
        Kind::Spawn,
        Kind::Send,
        Kind::Wait,
        Kind::Close,
        Kind::Resume,
        Kind::List,
    ] {
        registry.register(AgentTool {
            state: Arc::downgrade(state),
            parent: parent.into(),
            turn: turn.into(),
            kind,
        });
    }
}
struct AgentTool {
    state: Weak<ServerState>,
    parent: String,
    turn: String,
    kind: Kind,
}
impl Tool for AgentTool {
    fn spec(&self) -> ToolSpec {
        let (name, description, properties, required) = match self.kind {
            Kind::Spawn => (
                "spawn_agent",
                "Delegate a self-contained task to an independent child session. The child inherits the working directory, project instructions, skills, MCP tools, sandbox and selected custom model. By default it starts without this chat's history: include the context it needs in message. Set fork_context to inherit the retained conversation through this decision; earlier tool handles and action-specific approvals are historical, not live permissions. Use only when delegation is authorized. Children share files; assign non-overlapping writes. Close finished children to release slots.",
                json!({"message":{"type":"string"},"fork_context":{"type":"boolean","description":"Inherit the parent's retained conversation and explanation before this call. Defaults to false."},"model":{"type":"string","description":"Optional provider/model label; otherwise inherit."},"reasoning_effort":{"type":"string","enum":["minimal","low","medium","high","xhigh","max"]}}),
                vec!["message"],
            ),
            Kind::Send => (
                "send_input",
                "Send input to your direct child. A running child receives it before its next model request; a finished child starts another turn. interrupt stops the current turn before starting the new input. A closed child must first be resumed.",
                json!({"target":{"type":"string"},"message":{"type":"string"},"interrupt":{"type":"boolean"}}),
                vec!["target", "message"],
            ),
            Kind::Wait => (
                "wait_agent",
                "Wait until any named direct child stops running, or the timeout (default 30000ms, maximum 300000ms). Returns bounded result previews; the complete child transcript is retained. A timeout does not stop the children.",
                json!({"targets":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":16},"timeout_ms":{"type":"integer","minimum":0,"maximum":300000}}),
                vec!["targets"],
            ),
            Kind::Close => (
                "close_agent",
                "Close your direct child and its descendants. Running turns and command sessions are stopped. History remains available for inspection and explicit resume.",
                json!({"target":{"type":"string"}}),
                vec!["target"],
            ),
            Kind::Resume => (
                "resume_agent",
                "Reopen your closed direct child with its existing history. Does not start work: use send_input next. Refused while the previous turn is still stopping.",
                json!({"target":{"type":"string"}}),
                vec!["target"],
            ),
            Kind::List => (
                "list_agents",
                "List your direct children, their current status and bounded result previews.",
                json!({}),
                vec![],
            ),
        };
        let mut description = description.to_string();
        let mut properties = properties;
        if matches!(self.kind, Kind::Spawn)
            && let Some(state) = self.state.upgrade()
        {
            let roles = roles::read(&state).unwrap_or_default();
            properties["agent_type"] = json!({"type":"string","enum":std::iter::once("default").chain(roles.iter().map(|r|r.id.as_str())).collect::<Vec<_>>(),"description":"Optional saved role; otherwise use a general child with inherited tools."});
            for role in roles {
                description.push_str(&format!("\nRole {}: {}", role.id, role.description));
            }
        }
        ToolSpec {
            name: name.into(),
            description,
            schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        }
    }
    fn enabled(&self, _registry: &ToolRegistry) -> bool {
        if !matches!(self.kind, Kind::Spawn) {
            return true;
        }
        let Some(state) = self.state.upgrade() else {
            return false;
        };
        let Ok(config) = config(&state) else {
            return false;
        };
        let depth = state
            .store
            .db
            .subagent(&self.parent)
            .ok()
            .flatten()
            .map(|a| a.depth)
            .unwrap_or(0);
        config.enabled && depth < config.max_depth
    }
    fn mutates(&self) -> bool {
        !matches!(self.kind, Kind::Wait | Kind::List)
    }
    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        let state = self.state.upgrade();
        let parent = self.parent.clone();
        let turn = self.turn.clone();
        let kind = self.kind;
        Box::pin(async move {
            let Some(state) = state else {
                return ToolOutput::err("Server closed.");
            };
            if ctx.cancel.is_cancelled() {
                return ToolOutput::err("The parent turn was stopped.");
            }
            let result = async {
                match kind {
                    Kind::Spawn => {
                        let mut args: SpawnArgs = serde_json::from_value(arguments).map_err(invalid)?;
                        if args.fork_context { args.history = Some(fork_history(&state, &parent, &turn, &ctx).await?); }
                        let agent = spawn(&state, &parent, args, &ctx.cancel).await?;
                        Ok(json!({"agent_id":agent.agent_id}))
                    },
                    Kind::Send => send(&state, &parent, serde_json::from_value(arguments).map_err(invalid)?, &ctx.cancel).await,
                    Kind::Wait => wait(&state, &parent, serde_json::from_value(arguments).map_err(invalid)?, &ctx.cancel).await,
                    Kind::Close | Kind::Resume => {
                        #[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Target { target: String }
                        let args: Target = serde_json::from_value(arguments).map_err(invalid)?;
                        owned(&state, &parent, &args.target)?;
                        serde_json::to_value(if matches!(kind, Kind::Close) { close(&state, &args.target)? } else { resume(&state, &args.target)? }).map_err(internal)
                    }
                    Kind::List => Ok(json!({"agents":list(&state, Some(&parent))?.agents.into_iter().filter(|a| a.parent_thread_id == parent).collect::<Vec<_>>()})),
                }
            }.await;
            match result {
                Ok(value) => ToolOutput::ok(value.to_string()),
                Err(error) => ToolOutput::err(error.message),
            }
        })
    }
}

/// Questions retain their child thread id, but also reach a client watching only the root.
pub async fn relay_prompt(state: &ServerState, thread: &str, frame: fv_protocol::Message) {
    if let Ok(Some(agent)) = state.store.db.subagent(thread)
        && let Some(root) = state.loaded_runtime(&agent.root_thread_id)
    {
        root.send_frame(state, frame).await;
    }
}

#[cfg(test)]
mod tests;
