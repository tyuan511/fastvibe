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
pub(crate) mod agent_path;
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
pub fn is_child(state: &ServerState, id: &str) -> bool {
    state.store.db.subagent(id).ok().flatten().is_some()
}
fn room(state: &ServerState, root: &str, config: &SubagentConfig) -> Result<(), ErrorObject> {
    if !config.enabled {
        return Err(invalid("Subagents are disabled in settings."));
    }
    // Codex v2 counts *resident* children — runtimes that are loaded — and frees capacity by
    // evicting a settled resident: its row, transcript and queue survive, the runtime is
    // rebuilt on demand. Agents are durable; only residency is bounded.
    let rows = state.store.db.subagents(Some(root)).map_err(internal)?;
    let resident = |rows: &[Subagent]| {
        rows.iter()
            .filter(|a| state.loaded_runtime(&a.agent_id).is_some())
            .count()
    };
    while resident(&rows) >= config.max_agents as usize {
        // The oldest settled resident goes first: no running work, nothing parked on a person.
        let mut candidates: Vec<&Subagent> = rows
            .iter()
            .filter(|a| {
                a.status != SubagentStatus::Running
                    && state.loaded_runtime(&a.agent_id).is_some()
                    && state.pending_prompts(&a.agent_id).is_empty()
                    && !state
                        .loaded_runtime(&a.agent_id)
                        .is_some_and(|rt| rt.exec_sessions.has_running())
            })
            .collect();
        candidates.sort_by_key(|a| a.updated_at);
        let evicted = candidates
            .first()
            .is_some_and(|a| state.evict_runtime(&a.agent_id));
        if !evicted {
            return Err(invalid(
                "Agent limit reached. Wait for running agents to finish, or interrupt them.",
            ));
        }
    }
    Ok(())
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnArgs {
    message: String,
    task_name: String,
    #[serde(default)]
    fork_turns: Option<String>,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(skip)]
    history: Option<fv_store::Loaded>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    reasoning_effort: Option<fv_protocol::types::ThinkingLevel>,
}

impl SpawnArgs {
    /// codex v2 spelling: `fork_turns` is `"none"` (fresh context) or `"all"` (inherit the
    /// parent's retained conversation), with `"all"` as the default — as in codex, where an
    /// unqualified spawn passes all surrounding context to the child.
    fn fork_context(&self) -> Result<bool, ErrorObject> {
        match self.fork_turns.as_deref().map(str::trim) {
            None | Some("") | Some("all") => Ok(true),
            Some("none") => Ok(false),
            Some(_) => Err(invalid("fork_turns must be `none` or `all`.")),
        }
    }
}

async fn spawn(
    state: &Arc<ServerState>,
    parent_id: &str,
    args: SpawnArgs,
    parent_cancel: &CancellationToken,
) -> Result<Subagent, ErrorObject> {
    validate_message(&args.message)?;
    let fork_context = args.fork_context()?;
    if fork_context && args.history.is_none() {
        return Err(invalid("The parent history snapshot is missing."));
    }
    let role = roles::for_spawn(state, args.agent_type.as_deref())?;
    agent_path::valid_name(&args.task_name).map_err(invalid)?;
    let id = uuid::Uuid::new_v4().to_string();
    let (agent, task_name) = {
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
        // Durable task names are unique per tree: a path names exactly one agent.
        let task_name = agent_path::join(
            &agent_path::caller_path(source.as_ref().and_then(|s| s.task_name.as_deref())),
            &args.task_name,
        )
        .map_err(invalid)?;
        let tree = state.store.db.subagents(Some(&root)).map_err(internal)?;
        if tree
            .iter()
            .any(|a| a.task_name.as_deref() == Some(task_name.as_str()))
        {
            return Err(invalid(format!(
                "task_name `{}` is already in use in this tree",
                args.task_name
            )));
        }
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
            fork_context,
            task_name: Some(task_name.clone()),
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
        (agent, task_name)
    };
    // The child is told its own canonical task name along with the message, as codex does:
    // it needs the name to introduce itself on the board and to name its own children.
    let message = format!("You are the agent \"{task_name}\".\n\n{}", args.message);
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
    crate::turn::spawn_turn(state.clone(), rt, id.clone(), turn_id, message, cancel);
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
    state: &Arc<ServerState>,
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
        // Deliver the final answer to the parent as its own message, after codex's
        // `notify_parent_of_terminal_turn`. Computed after the row below takes its terminal
        // status; interrupted turns say nothing, and the answer text rides the normal
        // queue/steer path so it reaches the parent outside this tool-time lock.
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
            agent.error = error.clone();
        }
        agent.updated_at = now_ms();
        if let Err(e) = state.store.db.update_subagent(&agent) {
            eprintln!("cannot settle agent {id}: {e}");
        }
        let notify = match status {
            TurnStatus::Completed | TurnStatus::Failed => {
                final_answer_notification(&agent, error.as_deref())
            }
            TurnStatus::Interrupted => None,
        };
        if let Some((parent, text)) = notify {
            let delivered_at = agent.updated_at;
            let state = Arc::clone(state);
            let id = id.to_string();
            tokio::spawn(async move {
                deliver_final_answer(&state, &parent, &id, text, delivered_at).await;
            });
        }
        changed(state);
    }
}

/// A `FINAL_ANSWER` message in codex's wire format, or None for turns that say nothing.
fn final_answer_notification(agent: &Subagent, error: Option<&str>) -> Option<(String, String)> {
    let name = agent
        .task_name
        .clone()
        .unwrap_or_else(|| agent.agent_id.clone());
    let payload = match agent.status {
        SubagentStatus::Completed => agent.result.clone(),
        SubagentStatus::Failed => format!(
            "Agent errored: {}",
            error.unwrap_or("the run failed without an error message")
        ),
        _ => return None,
    };
    Some((
        agent.parent_thread_id.clone(),
        format!(
            "Message Type: FINAL_ANSWER\nTask name: {name}\nSender: {name}\nPayload:\n{payload}"
        ),
    ))
}

/// Best effort: the message rides the steer queue of the parent's running turn, or its
/// prompt queue otherwise. A closed or deleted parent simply drops the notification.
async fn deliver_final_answer(
    state: &Arc<ServerState>,
    parent: &str,
    id: &str,
    text: String,
    delivered_at: i64,
) {
    let rt = state.runtime(parent);
    if let Some(turn_id) = rt.running_turn()
        && rt.steer(&turn_id, text.clone()).is_ok()
    {
        state
            .subagent_delivered
            .lock()
            .unwrap()
            .insert(id.to_string(), delivered_at);
        return;
    }
    // Idle parent: the mail waits for the next input boundary. Unlike the prompt queue it
    // never wakes the thread on its own — codex's WakeOnAgentMessages is off by default.
    state
        .agent_mailbox
        .lock()
        .unwrap()
        .entry(parent.to_string())
        .or_default()
        .push(text);
    state
        .subagent_delivered
        .lock()
        .unwrap()
        .insert(id.to_string(), delivered_at);
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

/// Resolve a tool target to an agent row: an agent id, or a path — relative to the caller's
/// own path, or absolute — within the caller's tree, after codex's `resolve_agent_target`.
fn resolve(state: &ServerState, caller: &str, target: &str) -> Result<Subagent, ErrorObject> {
    let root = root_id(state, caller)?;
    if let Ok(Some(agent)) = state.store.db.subagent(target) {
        if agent.root_thread_id == root {
            return Ok(agent);
        }
        return Err(invalid(format!(
            "Agent `{target}` belongs to another conversation's tree."
        )));
    }
    let caller_row = state.store.db.subagent(caller).map_err(internal)?;
    let path = agent_path::resolve(
        &agent_path::caller_path(caller_row.as_ref().and_then(|s| s.task_name.as_deref())),
        target,
    )
    .map_err(invalid)?;
    if path == agent_path::ROOT {
        return Err(invalid("The root thread is not an agent."));
    }
    state
        .store
        .db
        .subagents(Some(&root))
        .map_err(internal)?
        .into_iter()
        .find(|a| a.task_name.as_deref() == Some(path.as_str()))
        .ok_or_else(|| invalid(format!("live agent path `{path}` not found")))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetedMessage {
    target: String,
    message: String,
}

fn closed_by_tray() -> ErrorObject {
    invalid("This agent was closed from the task tray. Reopen it there before sending more work.")
}

/// Deliver work to a target: steer it into the running turn at the next model request, or
/// start another turn when the agent is idle.
async fn start_or_steer(
    state: &Arc<ServerState>,
    caller: &str,
    target_id: &str,
    message: String,
    cancel: &CancellationToken,
) -> Result<Value, ErrorObject> {
    let rt = {
        let _gate = state.subagents_lock.lock().unwrap();
        // Recheck under the lock: another tool or the tray may have closed it meanwhile.
        resolve(state, caller, target_id)?;
        state.runtime(target_id)
    };
    if let Some(turn_id) = rt.running_turn() {
        rt.steer(&turn_id, message)
            .map_err(|_| invalid("The agent just finished; send the input again."))?;
        return Ok(json!({"submission_id": turn_id}));
    }
    let source = resolve(state, caller, target_id)?;
    let turn_id = uuid::Uuid::new_v4().to_string();
    if !state
        .schedules
        .adopt(&source.root_thread_id, target_id, &turn_id, rt.clone())
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
        target_id.to_string(),
        turn_id.clone(),
        message,
        token,
    );
    Ok(json!({"submission_id": turn_id}))
}

/// `followup_task`: send a follow-up task and trigger a turn if the target is idle; a running
/// target receives it at its next message boundary.
async fn followup(
    state: &Arc<ServerState>,
    caller: &str,
    args: TargetedMessage,
    cancel: &CancellationToken,
) -> Result<Value, ErrorObject> {
    validate_message(&args.message)?;
    let target = resolve(state, caller, &args.target)?;
    if target.status == SubagentStatus::Closed {
        return Err(closed_by_tray());
    }
    start_or_steer(state, caller, &target.agent_id, args.message, cancel).await
}

/// `send_message`: queue-only. Delivered promptly at a message boundary while sampling; on an
/// idle agent it waits in the mailbox and is read at the next input boundary — it never
/// starts a turn.
async fn message(
    state: &Arc<ServerState>,
    caller: &str,
    args: TargetedMessage,
) -> Result<Value, ErrorObject> {
    validate_message(&args.message)?;
    let target = resolve(state, caller, &args.target)?;
    if target.status == SubagentStatus::Closed {
        return Err(closed_by_tray());
    }
    let rt = state.runtime(&target.agent_id);
    if let Some(turn_id) = rt.running_turn()
        && rt.steer(&turn_id, args.message.clone()).is_ok()
    {
        return Ok(Value::String(String::new()));
    }
    // NOTE: creating the runtime above makes the agent resident; a just-messaged idle agent
    // counts toward the spawn limit until it is evicted, exactly as codex counts every
    // agent a communication touched.
    state
        .agent_mailbox
        .lock()
        .unwrap()
        .entry(target.agent_id.clone())
        .or_default()
        .push(args.message);
    Ok(Value::String(String::new()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    target: String,
}

/// `interrupt_agent`: stop the target's current turn, if any, and report its previous
/// status. The agent remains available for messages and follow-up tasks. The call waits,
/// bounded, for the interrupted turn to settle so an immediate follow-up starts a new turn
/// instead of steering one that is on its way out.
async fn interrupt(
    state: &Arc<ServerState>,
    caller: &str,
    args: Target,
    cancel: &CancellationToken,
) -> Result<Value, ErrorObject> {
    let target = resolve(state, caller, &args.target)?;
    let previous = target.status;
    let Some(rt) = state.loaded_runtime(&target.agent_id) else {
        return Ok(json!({"previous_status": previous}));
    };
    if rt.is_running() || rt.exec_sessions.has_running() {
        rt.interrupt();
        rt.exec_sessions.terminate_all();
        interrupt_tree(state, &target.agent_id);
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
            result = tokio::time::timeout(Duration::from_secs(15), settled) => {
                result.map_err(|_| invalid("The agent is still stopping. Try again in a moment."))??;
            }
        }
    }
    Ok(json!({"previous_status": previous}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArgs {
    timeout_ms: Option<u64>,
}

/// One agent as `wait_agent` reports it: its path (or id for legacy rows) and what happened.
fn wait_entry(state: &ServerState, agent: &Subagent) -> Value {
    let waiting = !state.pending_prompts(&agent.agent_id).is_empty();
    json!({
        "agent_name": agent.task_name.clone().unwrap_or_else(|| agent.agent_id.clone()),
        "status": agent.status,
        "waiting_for_input": waiting,
    })
}

/// `wait_agent` (codex v2): wait until any agent in the caller's tree updates — a terminal
/// turn, an undelivered final answer, or a question parked on a person. Does not return the
/// content: the final answer is delivered to the caller as a message of its own.
async fn wait(
    state: &ServerState,
    caller: &str,
    args: WaitArgs,
    cancel: &CancellationToken,
) -> Result<Value, ErrorObject> {
    let ids = descendants(state, caller)?;
    let started = now_ms();
    let deadline = tokio::time::Instant::now()
        + Duration::from_millis(args.timeout_ms.unwrap_or(30_000).min(300_000));
    let mut changes = state.subagent_changes.subscribe();
    loop {
        let mut agents = Vec::new();
        for id in &ids {
            let Ok(Some(agent)) = state.store.db.subagent(id) else {
                continue;
            };
            let waiting = !state.pending_prompts(id).is_empty();
            let delivered = state
                .subagent_delivered
                .lock()
                .unwrap()
                .get(id)
                .copied()
                .unwrap_or(0);
            let undelivered = agent.updated_at > delivered;
            let changed_since = agent.updated_at > started;
            if waiting
                || ((undelivered || changed_since)
                    && agent.status != SubagentStatus::Running
                    && agent.status != SubagentStatus::Idle)
            {
                agents.push(wait_entry(state, &agent));
            }
        }
        if !agents.is_empty() {
            return Ok(json!({"agents":agents,"timed_out":false}));
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(invalid("Stopped waiting for agents.")),
            _ = tokio::time::sleep_until(deadline) => return Ok(json!({"agents":Vec::<Value>::new(),"timed_out":true})),
            result = changes.changed() => { result.map_err(internal)?; }
        }
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Spawn,
    Followup,
    SendMessage,
    Interrupt,
    Wait,
    List,
}
pub fn register(state: &Arc<ServerState>, parent: &str, turn: &str, registry: &mut ToolRegistry) {
    for kind in [
        Kind::Spawn,
        Kind::Followup,
        Kind::SendMessage,
        Kind::Interrupt,
        Kind::Wait,
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
                "Spawn an agent to work on the specified task. If your current task is `/root/task1` and you spawn_agent with task_name \"task_3\" the agent will have canonical task name `/root/task1/task_3`. You are then able to refer to this agent as `task_3` or `/root/task1/task_3` interchangeably. However an agent `/root/task2/task_3` would only be able to communicate with this agent via its canonical name `/root/task1/task_3`. The spawned agent has the same tools as you and the ability to spawn its own subagents; children share files, so assign non-overlapping writes. It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes. The new agent's canonical task name will be provided to it along with the message. Agents are durable: they stay available for follow-up tasks after finishing, across turns and restarts; settled ones can be evicted from residency to free the agent limit. Passing fork_turns=\"none\" will not pass any surrounding context to the spawned agent, which may cause it to lack the context it needs to complete its task, whereas fork_turns=\"all\" (the default) will provide the agent with all surrounding context.",
                json!({"message":{"type":"string"},"task_name":{"type":"string","description":"Task name for the new agent. Use lowercase letters, digits, and underscores."},"fork_turns":{"type":"string","enum":["none","all"],"description":"`none` starts the child with no surrounding context; `all` (the default) passes the parent's retained conversation."},"model":{"type":"string","description":"Optional provider/model label; otherwise inherit."},"reasoning_effort":{"type":"string","enum":["minimal","low","medium","high","xhigh","max"]}}),
                vec!["message", "task_name"],
            ),
            Kind::Followup => (
                "followup_task",
                "Send a follow-up task to an existing agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes. The target keeps its full history, so prefer reusing a finished agent whose earlier task built the context you need over spawning a fresh one.",
                json!({"target":{"type":"string","description":"Agent id or canonical task name to send a follow-up task to (from spawn_agent)."},"message":{"type":"string"}}),
                vec!["target", "message"],
            ),
            Kind::SendMessage => (
                "send_message",
                "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn: use followup_task for that.",
                json!({"target":{"type":"string","description":"Relative or canonical task name to message (from spawn_agent)."},"message":{"type":"string"}}),
                vec!["target", "message"],
            ),
            Kind::Interrupt => (
                "interrupt_agent",
                "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
                json!({"target":{"type":"string","description":"Agent id or canonical task name to interrupt (from spawn_agent)."}}),
                vec!["target"],
            ),
            Kind::Wait => (
                "wait_agent",
                "Wait for an update from any agent in your tree: a finished or failed turn, a final answer not yet delivered, or an agent waiting for a person to answer its question. Returns which agents have updates, not their content — the final answer is delivered to you as a message when the agent finishes. Also ends early (timeout) if nothing arrives; the default is 30000ms and the maximum 300000ms. A timeout does not stop the agents.",
                json!({"timeout_ms":{"type":"integer","minimum":0,"maximum":300000}}),
                vec![],
            ),
            Kind::List => (
                "list_agents",
                "List the agents in the current root thread tree with their current status. Optionally filter by task-path prefix. Agents that the user closed from the task tray are not listed.",
                json!({"path_prefix":{"type":"string","description":"Task-path prefix filter without a trailing slash. Omit to list all agents."}}),
                vec![],
            ),
        };
        let mut description = description.to_string();
        let mut properties = properties;
        if matches!(self.kind, Kind::Spawn)
            && let Some(state) = self.state.upgrade()
        {
            let roles = roles::merged(&state).unwrap_or_default();
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
                        if args.fork_context()? { args.history = Some(fork_history(&state, &parent, &turn, &ctx).await?); }
                        let agent = spawn(&state, &parent, args, &ctx.cancel).await?;
                        Ok(json!({"task_name":agent.task_name}))
                    },
                    Kind::Followup => followup(&state, &parent, serde_json::from_value(arguments).map_err(invalid)?, &ctx.cancel).await,
                    Kind::SendMessage => message(&state, &parent, serde_json::from_value(arguments).map_err(invalid)?).await,
                    Kind::Interrupt => interrupt(&state, &parent, serde_json::from_value(arguments).map_err(invalid)?, &ctx.cancel).await,
                    Kind::Wait => wait(&state, &parent, serde_json::from_value(arguments).map_err(invalid)?, &ctx.cancel).await,
                    Kind::List => {
                        #[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListArgs { #[serde(default)] path_prefix: Option<String> }
                        let args: ListArgs = serde_json::from_value(arguments).map_err(invalid)?;
                        let root = root_id(&state, &parent)?;
                        let agents = state.store.db.subagents(Some(&root)).map_err(internal)?
                            .into_iter()
                            .filter(|a| a.status != SubagentStatus::Closed)
                            .filter(|a| args.path_prefix.as_deref().is_none_or(|prefix| {
                                a.task_name.as_deref().is_some_and(|name| name.starts_with(prefix))
                            }))
                            .map(|a| json!({"agent_name": a.task_name.clone().unwrap_or_else(|| a.agent_id.clone()), "agent_status": a.status}))
                            .collect::<Vec<_>>();
                        Ok(json!({"agents": agents}))
                    }
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
