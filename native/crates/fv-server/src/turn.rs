use futures_util::FutureExt;
use std::sync::Arc;

use fv_agent::{AgentContext, AgentEvent, TurnOutcome, base_instructions, run_turn};

use crate::prompt::{ThreadUserInput, announce_resolved};
use fv_protocol::types::{Item, QueuePauseReason, TurnStatus};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::log::LogEvent;
use crate::mapping::EventMapper;
use crate::runtime::ThreadRuntime;
use crate::state::ServerState;

/// Run a turn in the background. The caller has already claimed the thread (`begin`).
pub fn spawn_turn(
    state: Arc<ServerState>,
    rt: Arc<ThreadRuntime>,
    thread_id: String,
    turn_id: String,
    text: String,
    cancel: CancellationToken,
) {
    spawn_turn_inner(state, rt, thread_id, turn_id, text, cancel, false);
}

fn spawn_turn_inner(
    state: Arc<ServerState>,
    rt: Arc<ThreadRuntime>,
    thread_id: String,
    turn_id: String,
    text: String,
    cancel: CancellationToken,
    wait_for_mcp: bool,
) {
    // The workspace as it is *before* this turn touches it, so a retry can run against the code
    // the user asked about rather than the half-applied result of the attempt it retries.
    capture_checkpoint(&state, &thread_id);
    // A guess about a conversation that has moved on is worse than none: the user's own prompt
    // already answered it. Publishing is a task of its own — the turn must start now.
    if rt.forget_suggestion() {
        let state = state.clone();
        let rt = rt.clone();
        tokio::spawn(async move {
            rt.publish(&state, LogEvent::SuggestionChanged(None)).await;
        });
    }
    let worker = tokio::spawn(drive(
        state.clone(),
        rt.clone(),
        thread_id.clone(),
        turn_id.clone(),
        text,
        cancel,
        wait_for_mcp,
    ));
    // A panic in the turn must not leave the thread claimed forever, nor keep a chained run
    // (the next queued prompt) from being abandoned with it.
    tokio::spawn(async move {
        if worker.await.is_err() {
            recover_panic(&state, &rt, &thread_id, &turn_id).await;
        }
    });
}

async fn drive(
    state: Arc<ServerState>,
    rt: Arc<ThreadRuntime>,
    thread_id: String,
    turn_id: String,
    text: String,
    cancel: CancellationToken,
    wait_for_mcp: bool,
) -> bool {
    record_start(&state, &thread_id, &turn_id);
    rt.publish(
        &state,
        LogEvent::TurnStarted {
            turn_id: turn_id.clone(),
        },
    )
    .await;
    let user = Item::UserMessage {
        id: uuid::Uuid::new_v4().to_string(),
        text: text.clone(),
    };
    rt.publish(
        &state,
        LogEvent::ItemCompleted {
            turn_id: turn_id.clone(),
            item: user,
        },
    )
    .await;

    let (withdrawn_tx, mut withdrawn_rx) = mpsc::unbounded_channel();
    if wait_for_mcp {
        state.mcp.start();
        tokio::select! {
            biased;
            _ = cancel.cancelled() => (),
            _ = state.mcp.wait_ready(std::time::Duration::from_secs(11)) => (),
        }
    }
    let ctx = build_context(
        &state,
        &rt,
        &thread_id,
        &turn_id,
        withdrawn_tx,
        Some(text.clone()),
        &cancel,
    )
    .await;
    let first_prompt = text.clone();
    let mut history = rt.history();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut mapper = EventMapper::new(turn_id.clone(), fv_agent::effective_context_window(&ctx));
    let outcome = {
        let run = std::panic::AssertUnwindSafe(run_turn(&ctx, &mut history, text, &tx, &cancel))
            .catch_unwind();
        tokio::pin!(run);
        loop {
            tokio::select! {
                biased;
                Some(event) = rx.recv() => {
                    persist(&state, &thread_id, &event);
                    for e in mapper.map(event) {
                        rt.publish(&state, e).await;
                    }
                }
                Some(id) = withdrawn_rx.recv() => {
                    announce_resolved(&state, &thread_id, id).await;
                }
                outcome = &mut run => break outcome.unwrap_or_else(|_| TurnOutcome::Failed("Internal error.".into())),
            }
        }
    };
    // The agent normally settles its tools; retain this guard for a panicking provider/tool.
    rt.code_mode.settle().await;
    // Events sent in the last instant before the loop returned.
    while let Ok(event) = rx.try_recv() {
        persist(&state, &thread_id, &event);
        for e in mapper.map(event) {
            rt.publish(&state, e).await;
        }
    }
    while let Ok(id) = withdrawn_rx.try_recv() {
        announce_resolved(&state, &thread_id, id).await;
    }
    rt.set_history(history.clone());
    // The bill is part of the stats a client draws, and the catalog prices by the label each
    // reply recorded: recompute it once the turn's messages are all in.
    if rt.reprice(&state.catalog.snapshot(), &history).is_some() {
        rt.publish(&state, LogEvent::StatsSnapshot).await;
    }

    let (status, error) = match outcome {
        TurnOutcome::Completed => (TurnStatus::Completed, None),
        TurnOutcome::Interrupted => (TurnStatus::Interrupted, None),
        TurnOutcome::Failed(message) => (TurnStatus::Failed, Some(message)),
    };
    finish_turn(&state, &rt, &thread_id, &turn_id, status, error.clone()).await;
    state.touch_thread(&thread_id, Some(&first_prompt));
    // Whatever was queued behind this turn goes next — unless this turn failed, in which case
    // the queue stops where it is rather than being fed to a run that is already broken.
    //
    // The hand-off happens *before* the thread is reported idle: two prompts the user queued
    // back to back are one stretch of work, and a client that saw an idle moment between them
    // would drop the running mark and the 「来消息了」 state it drives. The caller then keeps the
    // thread claimed for the next turn instead of ending it here.
    if drain_queue(&state, &rt, &thread_id, status, &turn_id).await {
        return true;
    }
    crate::queue::publish(&state, &rt, &thread_id).await;
    // "Running" ends only now, after the completion event: a client that sees the thread idle
    // has already seen everything the turn did.
    rt.end(&state).await;
    crate::subagents::settled(&state, &thread_id, status, error, &rt.turns());
    // The guess at the user's next message is not part of the turn: it is started once the thread
    // is idle, so it can never hold up the run that produced what it is guessing from.
    //
    // Never after a failure or a stop: the user's next message is about the problem, and guessing
    // it from a half-written reply is exactly the wrong material.
    if status == TurnStatus::Completed {
        spawn_suggestion(state, rt, thread_id.to_string());
    } else if rt.forget_suggestion() {
        rt.publish(&state, LogEvent::SuggestionChanged(None)).await;
    }
    false
}

/// Ask the conversation's own model what the user is likely to say next, and publish it as the
/// composer's placeholder.
///
/// Three things make this safe to fire after every turn: it runs on a task of its own (nothing
/// waits for it), every failure is swallowed (the placeholder simply stays as it was), and the
/// answer is withdrawn when it stops being true — a new turn, or a reply that is not prose.
fn spawn_suggestion(state: Arc<ServerState>, rt: Arc<ThreadRuntime>, thread_id: String) {
    if crate::subagents::is_child(&state, &thread_id) || state.schedules.owns(&thread_id) {
        return;
    }
    // A setting, not a hidden default: the side request costs a round trip and some people would
    // rather not spend it. Read at the moment the turn ends, so turning it off takes effect now.
    let on = crate::settings::read(&state)
        .map(|s| s.reply_suggestions)
        .unwrap_or(true);
    if !on {
        return;
    }
    tokio::spawn(async move {
        // Read from what the transcript already holds, so the same turn yields the same guess
        // whether this runs now or the client reconnects later.
        let turns = rt.turns();
        let Some(thread) = state.thread(&thread_id).ok().flatten() else {
            return;
        };
        let model = state.suggestion_model(&thread);
        let answer = crate::suggestion::suggest(model, &turns).await;
        let still_idle = !rt.is_running();
        // A run that started while the model was thinking has made the guess stale: publish
        // nothing rather than a placeholder about a turn that is over.
        if !still_idle {
            return;
        }
        rt.publish(&state, LogEvent::SuggestionChanged(answer))
            .await;
    });
}

/// Start the next queued prompt, if the thread is idle and the queue may drain.
///
/// Returns whether a turn was started. A failed turn pauses the queue instead: the user sees
/// 「已暂停」 beside the prompts and decides whether to send them, which is what the Electron app
/// does and the only thing that keeps one broken run from eating everything lined up behind it.
pub(crate) async fn drain_queue(
    state: &Arc<ServerState>,
    rt: &Arc<ThreadRuntime>,
    thread_id: &str,
    status: TurnStatus,
    previous_turn: &str,
) -> bool {
    // A failure and a stop both stop the queue, and they say different things: the prompts were
    // not the problem in either case, but a stop was the user's own decision, and they may well
    // have stopped *because* of what is queued. Both wait for 继续.
    //
    // 「立即」 is the one stop that is *about* the queue: it interrupted the run in order to send
    // the prompt the user picked, so that prompt goes next instead of the queue stopping.
    let sending_now = rt.preferred().is_some();
    // A running goal settles first: it may pause on this outcome, finish, or want another round.
    let goal_round = crate::goal::after_turn(state, rt, thread_id, status, sending_now).await;
    match status {
        TurnStatus::Failed => {
            crate::queue::pause(state, rt, thread_id, QueuePauseReason::Failed);
            return false;
        }
        TurnStatus::Interrupted if !sending_now => {
            crate::queue::pause(state, rt, thread_id, QueuePauseReason::Stopped);
            return false;
        }
        _ => {}
    }
    // 「立即」 picks a specific prompt; otherwise the head of the queue goes.
    let taken = match rt.take_preferred() {
        Some(row) => {
            if let Err(e) = state.store.db.remove_queued(thread_id, &row.id) {
                eprintln!("cannot remove a sent prompt of {thread_id}: {e}");
            }
            Some(row)
        }
        None => crate::queue::take_next(state, rt, thread_id),
    };
    let taken = taken.or_else(|| {
        // Nothing the user lined up: the goal's next round goes, if it has one.
        goal_round.map(|text| fv_store::QueuedPrompt {
            id: uuid::Uuid::new_v4().to_string(),
            text,
            at: crate::state::now_ms(),
        })
    });
    let Some(row) = taken else {
        return false;
    };
    // The queue is announced as the prompt leaves it, before the next turn begins: a client
    // that redraws on the new turn's first event must not still see the prompt it is running.
    crate::queue::publish(state, rt, thread_id).await;
    start_queued(
        state.clone(),
        rt.clone(),
        thread_id.to_string(),
        row,
        previous_turn,
    )
    .await
}

/// Start a queued prompt on a thread that has no run to chain onto (nothing was running when the
/// client queued it, or 「立即」 was pressed on an idle chat).
pub(crate) async fn start_next(state: Arc<ServerState>, rt: Arc<ThreadRuntime>, thread_id: &str) {
    let taken = match rt.take_preferred() {
        Some(row) => {
            if let Err(e) = state.store.db.remove_queued(thread_id, &row.id) {
                eprintln!("cannot remove a sent prompt of {thread_id}: {e}");
            }
            Some(row)
        }
        None => crate::queue::take_next(&state, &rt, thread_id),
    };
    let Some(row) = taken else {
        crate::queue::publish(&state, &rt, thread_id).await;
        return;
    };
    let turn_id = uuid::Uuid::new_v4().to_string();
    let Some(cancel) = rt.begin(&state, &turn_id).await else {
        crate::queue::requeue_front(&state, &rt, thread_id, &row);
        crate::queue::publish(&state, &rt, thread_id).await;
        return;
    };
    spawn_turn_inner(
        state,
        rt,
        thread_id.to_string(),
        turn_id,
        row.text,
        cancel,
        true,
    );
}

/// Start a turn with `text` on an idle thread; the prompt is put in the queue if the thread
/// was claimed in the meantime.
pub(crate) async fn start_text(
    state: Arc<ServerState>,
    rt: Arc<ThreadRuntime>,
    thread_id: &str,
    text: String,
) {
    let turn_id = uuid::Uuid::new_v4().to_string();
    let Some(cancel) = rt.begin(&state, &turn_id).await else {
        if crate::queue::enqueue(&state, &rt, thread_id, text).is_ok() {
            crate::queue::publish(&state, &rt, thread_id).await;
        }
        return;
    };
    spawn_turn_inner(
        state,
        rt,
        thread_id.to_string(),
        turn_id,
        text,
        cancel,
        true,
    );
}

/// Run one queued prompt as the thread's next turn, exactly as `turn/start` would.
async fn start_queued(
    state: Arc<ServerState>,
    rt: Arc<ThreadRuntime>,
    thread_id: String,
    row: fv_store::QueuedPrompt,
    previous_turn: &str,
) -> bool {
    let turn_id = uuid::Uuid::new_v4().to_string();
    let Some(cancel) = rt.chain(&state, previous_turn, &turn_id) else {
        // Someone started a turn in the gap; the prompt goes back to the front of the queue
        // rather than being lost. It is the only copy.
        if state.thread(&thread_id).is_ok_and(|t| t.is_some()) {
            crate::queue::requeue_front(&state, &rt, &thread_id, &row);
            crate::queue::publish(&state, &rt, &thread_id).await;
        }
        return false;
    };
    spawn_turn_inner(state, rt, thread_id, turn_id, row.text, cancel, true);
    true
}

/// Snapshot the conversation's workspace for this turn.
///
/// Deliberately best-effort: a workspace that is not a git repository, or a `git` that is not
/// installed, must not stop a turn. It is *cleared* by a capture that finds nothing, so a stale
/// snapshot from an earlier turn can never be offered as this turn's undo.
fn capture_checkpoint(state: &ServerState, thread_id: &str) {
    let Some(cwd) = state
        .thread(thread_id)
        .ok()
        .flatten()
        .and_then(|t| t.cwd)
        .map(std::path::PathBuf::from)
    else {
        return;
    };
    let captured = match fv_store::capture(&cwd, thread_id) {
        Ok(captured) => captured,
        Err(e) => {
            eprintln!("cannot snapshot the workspace of {thread_id}: {e}");
            None
        }
    };
    let mut checkpoints = state.checkpoints.lock().unwrap();
    match captured {
        Some(checkpoint) => {
            checkpoints.insert(thread_id.into(), checkpoint);
        }
        // No snapshot means nothing to undo, so an older turn's must not be offered as this
        // turn's.
        None => {
            checkpoints.remove(thread_id);
        }
    }
}

/// Throw away the reply to `turn_id` (and everything after it), then run that turn again.
///
/// This is the retry and the edit in one call: a retry passes no words and the turn's own stay,
/// an edit passes the corrected ones. The history is cut at the *user* message of that turn, so
/// what is re-sent is what the model would have seen had the user written those words the first
/// time. The transcript is not shortened — `rewind` appends a marker — so nothing a user wrote is
/// destroyed by a mistake here.
pub async fn rewind(
    state: Arc<ServerState>,
    rt: Arc<ThreadRuntime>,
    thread_id: String,
    turn_id: String,
    text: Option<String>,
    rewind_files: bool,
) -> Result<fv_protocol::types::TurnRewindResponse, fv_protocol::ErrorObject> {
    use fv_protocol::ErrorObject;
    use fv_protocol::jsonrpc::code;
    let new_turn_id = uuid::Uuid::new_v4().to_string();
    let Some(cancel) = rt.begin(&state, &new_turn_id).await else {
        return Err(ErrorObject::new(
            code::THREAD_BUSY,
            "stop the reply in flight before rewinding",
        ));
    };
    // Claim before touching files/history, across *all* clients. A second start or retry
    // cannot slip into the notification await between the rewind and its replacement run.
    let result = rewind_claimed(&state, &rt, &thread_id, &turn_id, text, rewind_files);
    let (words, files) = match result {
        Ok(result) => result,
        Err(error) => {
            rt.end(&state).await;
            crate::subagents::settled(
                &state,
                &thread_id,
                TurnStatus::Failed,
                Some(error.message.clone()),
                &rt.turns(),
            );
            return Err(error);
        }
    };
    rt.publish(&state, LogEvent::Rewound { turn_id }).await;
    spawn_turn(state, rt, thread_id, new_turn_id.clone(), words, cancel);
    Ok(fv_protocol::types::TurnRewindResponse {
        turn_id: new_turn_id,
        files,
    })
}

fn rewind_claimed(
    state: &ServerState,
    rt: &ThreadRuntime,
    thread_id: &str,
    turn_id: &str,
    text: Option<String>,
    rewind_files: bool,
) -> Result<(String, fv_protocol::types::FilesRewound), fv_protocol::ErrorObject> {
    use fv_protocol::ErrorObject;
    use fv_protocol::jsonrpc::code;
    // Use absolute transcript positions. The model's history starts at the last compaction;
    // counting its user messages cannot locate an older turn or a turn containing a steer.
    let loaded = state.store.transcripts.read(thread_id).map_err(|e| {
        ErrorObject::new(
            code::INTERNAL_ERROR,
            format!("cannot read the transcript: {e}"),
        )
    })?;
    if loaded.skipped > 0 {
        return Err(ErrorObject::new(
            code::INTERNAL_ERROR,
            "Cannot rewind a damaged transcript",
        ));
    }
    let cut = loaded.turn_start(turn_id);
    let Some(cut) = cut else {
        return Err(ErrorObject::new(
            code::INVALID_PARAMS,
            "that turn is not in this conversation's history",
        ));
    };
    let kept = &loaded.messages[..cut];
    // The words to run: the replacement, or the ones that turn already has.
    let original = loaded
        .turns()
        .into_iter()
        .find(|t| t.id == turn_id)
        .and_then(|t| {
            t.items.into_iter().find_map(|item| match item {
                Item::UserMessage { text, .. } => Some(text),
                _ => None,
            })
        });
    let Some(original) = original else {
        return Err(ErrorObject::new(
            code::INVALID_PARAMS,
            "that turn has no user prompt to retry",
        ));
    };
    let words = text.unwrap_or(original);
    if words.trim().is_empty() {
        return Err(ErrorObject::new(
            code::INVALID_PARAMS,
            "a prompt cannot be empty",
        ));
    }
    // History *before* the message is what the turn appends to, so the rewind keeps exactly the
    // messages a fresh run would have started from.
    let mut restored = fv_core::effective_history(kept);
    // A failed file restore leaves the conversation intact. The runtime is already claimed,
    // so no other client can start against the files while this is in progress.
    let files = if rewind_files {
        restore_checkpoint(state, thread_id)?
    } else {
        Default::default()
    };
    if let Err(e) = state
        .store
        .transcripts
        .rewind_before(thread_id, cut, Some(turn_id))
    {
        return Err(ErrorObject::new(
            code::INTERNAL_ERROR,
            format!("cannot rewind the transcript: {e}"),
        ));
    }
    rt.set_history(std::mem::take(&mut restored));
    Ok((words, files))
}

/// Put the conversation's workspace back to its checkpoint, if it has one.
fn restore_checkpoint(
    state: &ServerState,
    thread_id: &str,
) -> Result<fv_protocol::types::FilesRewound, fv_protocol::ErrorObject> {
    use fv_protocol::jsonrpc::code;
    use fv_protocol::{ErrorObject, types::SkippedPath};
    let checkpoint = state.checkpoints.lock().unwrap().remove(thread_id);
    let Some(checkpoint) = checkpoint else {
        return Ok(Default::default());
    };
    let result = fv_store::restore(&checkpoint).map_err(|e| {
        ErrorObject::new(
            code::INTERNAL_ERROR,
            format!("cannot put the workspace back: {e}"),
        )
    })?;
    fv_store::clear(thread_id, &checkpoint.root);
    Ok(fv_protocol::types::FilesRewound {
        restored: result.restored,
        removed: result.removed,
        skipped: result
            .skipped
            .into_iter()
            .map(|(path, reason)| SkippedPath { path, reason })
            .collect(),
        had_checkpoint: true,
    })
}

/// Messages reach the transcript as the agent adds them to its history, not when the turn ends:
/// a crash then loses the message being written and nothing before it.
fn persist(state: &ServerState, thread_id: &str, event: &AgentEvent) {
    let nested = match event {
        AgentEvent::NestedToolStarted {
            parent_id,
            call_id,
            name,
            arguments,
        } => Some((
            parent_id,
            Item::ToolCall {
                id: call_id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
                output: None,
                is_error: false,
            },
        )),
        AgentEvent::NestedToolFinished {
            parent_id,
            call_id,
            name,
            arguments,
            output,
            is_error,
        } => Some((
            parent_id,
            Item::ToolCall {
                id: call_id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
                output: Some(output.clone()),
                is_error: *is_error,
            },
        )),
        _ => None,
    };
    if let Some((parent, item)) = nested
        && let Some(turn) = state
            .loaded_runtime(thread_id)
            .and_then(|rt| rt.running_turn())
        && let Err(e) = state
            .store
            .transcripts
            .tool_activity(thread_id, &turn, parent, item)
    {
        eprintln!("cannot record nested tool activity: {e}");
    }
    if let AgentEvent::Committed(message) = event {
        state.persist(thread_id, message);
        if let Some(rt) = state.loaded_runtime(thread_id) {
            rt.commits.send_modify(|n| *n = n.wrapping_add(1));
        }
        if let fv_core::Message::Assistant(reply) = message {
            state.memory.note_reply(state, &reply.text());
        }
    }
}

fn record_start(state: &ServerState, thread_id: &str, turn_id: &str) {
    if let Err(e) = state.store.transcripts.start_turn(thread_id, turn_id) {
        eprintln!("cannot record the start of {thread_id}/{turn_id}: {e}");
    }
}

/// Store the terminal result before announcing it. It is UI metadata, never an authored
/// message, so an upstream error cannot become a user instruction in the next request.
async fn finish_turn(
    state: &ServerState,
    rt: &ThreadRuntime,
    thread_id: &str,
    turn_id: &str,
    status: TurnStatus,
    error: Option<String>,
) {
    let recorded_error = error
        .as_ref()
        .filter(|_| status == TurnStatus::Failed)
        .map(|message| fv_store::RecordedError {
            id: uuid::Uuid::new_v4().to_string(),
            message: message.clone(),
        });
    if let Err(e) =
        state
            .store
            .transcripts
            .finish_turn(thread_id, turn_id, status, recorded_error.clone())
    {
        eprintln!("cannot record the result of {thread_id}/{turn_id}: {e}");
    }
    if let Some(error) = recorded_error {
        rt.publish(
            state,
            LogEvent::ItemCompleted {
                turn_id: turn_id.into(),
                item: Item::Error {
                    id: error.id,
                    message: error.message,
                },
            },
        )
        .await;
    }
    rt.publish(
        state,
        LogEvent::TurnCompleted {
            turn_id: turn_id.into(),
            status,
            error,
        },
    )
    .await;
}

async fn recover_panic(
    state: &Arc<ServerState>,
    rt: &Arc<ThreadRuntime>,
    thread_id: &str,
    turn_id: &str,
) {
    rt.code_mode.settle().await;
    // Committed events may already have reached disk before the worker panicked. Keeping an
    // older runtime history would send a different conversation until the next restart.
    if let Ok(loaded) = state.store.transcripts.read(thread_id) {
        rt.set_history(fv_core::effective_history(&loaded.messages));
    }
    finish_turn(
        state,
        rt,
        thread_id,
        turn_id,
        TurnStatus::Failed,
        Some("Internal error.".into()),
    )
    .await;
    crate::queue::pause(state, rt, thread_id, QueuePauseReason::Failed);
    crate::queue::publish(state, rt, thread_id).await;
    state.touch_thread(thread_id, None);
    rt.end(state).await;
    crate::subagents::settled(
        state,
        thread_id,
        TurnStatus::Failed,
        Some("Internal error.".into()),
        &rt.turns(),
    );
}

/// What a turn of this thread runs with: its own model (or the default), the working directory
/// it tells the model about, the deferred tools it has found, and a way to ask the user.
/// What the model is told about its sandbox, so it plans within it and knows how to ask.
fn permissions_prompt(p: &fv_agent::Permissions) -> String {
    use fv_agent::{ApprovalPolicy, SandboxMode};
    let mut out = String::from("Filesystem sandboxing and approvals:\n");
    if p.policy.mode != SandboxMode::DangerFullAccess && !fv_sandbox::available() {
        out.push_str("This system has no command sandbox, so commands cannot run in the restricted mode the user chose: they are refused until the user switches to full access. Do not plan around a sandbox or ask for `require_escalated`; tell the user that commands need full access here.\n");
        return out;
    }
    match p.policy.mode {
        SandboxMode::ReadOnly => out.push_str(
            "Commands run in a read-only sandbox: they can read files anywhere but cannot write any. apply_patch is blocked the same way.\n",
        ),
        SandboxMode::WorkspaceWrite => {
            out.push_str("Commands run in a sandbox that lets them read files anywhere but write only inside these folders (and `.git` and `.fastvibe` inside them stay read-only):\n");
            for root in &p.policy.writable_roots {
                out.push_str(&format!("- {}\n", root.display()));
            }
            out.push_str(if p.policy.network {
                "Network access from commands is enabled.\n"
            } else {
                "Network access from commands is blocked.\n"
            });
        }
        SandboxMode::DangerFullAccess => out.push_str(
            "Commands run with full access to the machine: there is no sandbox.\n",
        ),
    }
    if p.policy.mode != SandboxMode::DangerFullAccess {
        out.push_str(match p.approval {
            ApprovalPolicy::OnRequest => "Approval policy is on-request. A command that has to leave the sandbox (to write elsewhere or use the network) needs `sandbox_permissions: \"require_escalated\"` with a short `justification`; the user is then asked. Do not ask for it unless the command needs it.\n",
            ApprovalPolicy::OnFailure => "Approval policy is on-failure. Commands run in the sandbox; if one is blocked by it, the user is asked whether to run it again outside.\n",
            ApprovalPolicy::Untrusted => "Approval policy is untrusted. Commands that are not plain reads (ls, cat, git status…) ask the user first, and so does every patch.\n",
            ApprovalPolicy::Never => "Approval policy is never. You cannot ask to leave the sandbox: work within it, and tell the user when something needs more.\n",
        });
    }
    out
}

/// The sandbox and approval rules for a turn: the user's settings, applied to the folders the
/// conversation works in (its own, and its project's) and the temporary directories.
fn permissions_for(
    state: &Arc<ServerState>,
    rt: &Arc<ThreadRuntime>,
    thread: Option<&fv_protocol::types::Thread>,
    thread_id: &str,
    turn_id: &str,
    withdrawn: &mpsc::UnboundedSender<fv_protocol::RequestId>,
) -> Arc<fv_agent::Permissions> {
    use fv_protocol::types as wire;
    let settings = crate::settings::read(state).unwrap_or_default();
    let mut folders: Vec<std::path::PathBuf> = Vec::new();
    if let Some(t) = thread {
        folders.extend(t.cwd.iter().map(std::path::PathBuf::from));
        if let Some(project) = t
            .project
            .as_deref()
            .and_then(|p| crate::projects::of_thread(state, p))
        {
            folders.push(project.path.into());
            folders.extend(project.folders.into_iter().map(std::path::PathBuf::from));
        }
    }
    let mode = match settings.sandbox_mode {
        wire::SandboxMode::ReadOnly => fv_agent::SandboxMode::ReadOnly,
        wire::SandboxMode::WorkspaceWrite => fv_agent::SandboxMode::WorkspaceWrite,
        wire::SandboxMode::DangerFullAccess => fv_agent::SandboxMode::DangerFullAccess,
    };
    let approval = match settings.approval_policy {
        wire::ApprovalPolicy::Untrusted => fv_agent::ApprovalPolicy::Untrusted,
        wire::ApprovalPolicy::OnFailure => fv_agent::ApprovalPolicy::OnFailure,
        wire::ApprovalPolicy::OnRequest => fv_agent::ApprovalPolicy::OnRequest,
        wire::ApprovalPolicy::Never => fv_agent::ApprovalPolicy::Never,
    };
    let read_only_role =
        crate::subagents::roles::of_thread(state, thread_id).is_some_and(|r| r.read_only);
    let mode = if read_only_role {
        fv_agent::SandboxMode::ReadOnly
    } else {
        mode
    };
    let approval = if read_only_role {
        fv_agent::ApprovalPolicy::Never
    } else {
        approval
    };
    Arc::new(fv_agent::Permissions {
        policy: fv_agent::Policy {
            mode,
            writable_roots: fv_sandbox::default_writable_roots(&folders),
            network: settings.sandbox_network,
        },
        approval,
        approver: Some(Arc::new(crate::prompt::ThreadApprover {
            state: state.clone(),
            rt: rt.clone(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            withdrawn: withdrawn.clone(),
        })),
    })
}

async fn build_context(
    state: &Arc<ServerState>,
    rt: &Arc<ThreadRuntime>,
    thread_id: &str,
    turn_id: &str,
    withdrawn: mpsc::UnboundedSender<fv_protocol::RequestId>,
    user_text: Option<String>,
    cancel: &CancellationToken,
) -> AgentContext {
    let thread = state.thread(thread_id).ok().flatten();
    // Each conversation works in its own directory, and tells the model so.
    let cwd = thread
        .as_ref()
        .and_then(|t| t.cwd.clone())
        .map(std::path::PathBuf::from);
    // The conversation's own model, or the default one; a model that cannot be used fails
    // the turn with the reason, rather than the turn not starting at all.
    let model = match &thread {
        Some(thread) => crate::providers::model_for(state, thread),
        None => state.agent.model.clone(),
    };
    rt.sampling_model(model.as_ref());
    // A project with several folders says which they are; the model may use absolute paths in
    // all of them (there is no sandbox to extend, as there is none to begin with).
    let folders = thread
        .as_ref()
        .and_then(|t| t.project.as_deref())
        .and_then(|project| crate::projects::of_thread(state, project))
        .and_then(|project| {
            let cwd = cwd.as_ref()?.display().to_string();
            crate::projects::folders_prompt(&project, &cwd)
        })
        .map(|text| format!("\n\n{text}"))
        .unwrap_or_default();
    let permissions = permissions_for(state, rt, thread.as_ref(), thread_id, turn_id, &withdrawn);
    let context_state = state.clone();
    let context_cwd = cwd.clone();
    let other_folders = thread
        .as_ref()
        .and_then(|t| t.project.as_deref())
        .and_then(|project| crate::projects::of_thread(state, project))
        .map(|project| {
            let mut folders = project.folders;
            // The worktree replaces the primary folder for this conversation. Loading the
            // original tree as well would reintroduce its uncommitted instructions.
            if !thread.as_ref().is_some_and(|t| t.worktree.is_some()) {
                folders.insert(0, project.path);
            }
            folders
        })
        .unwrap_or_default();
    let discovery = tokio::task::spawn_blocking(move || {
        context_state.context.prompt_for_folders(
            context_cwd.as_deref(),
            &other_folders,
            user_text.as_deref(),
        )
    });
    // A file on an unavailable mount must not hold a stopped turn open.
    tokio::select! {
        biased;
        _ = cancel.cancelled() => (),
        _ = tokio::time::timeout(std::time::Duration::from_secs(3), state.memory.refresh_snapshot()) => (),
    }
    let discovered = tokio::select! {
        biased;
        _ = cancel.cancelled() => String::new(),
        result = discovery => result.unwrap_or_else(|e| format!("\nContext discovery failed: {e}")),
    };
    state.mcp.start();
    tokio::select! {
        biased;
        _ = cancel.cancelled() => (),
        _ = state.mcp.wait_ready(std::time::Duration::from_secs(3)) => (),
    }
    let mut mcp = state.mcp.snapshot(&state.agent.tools);
    if state.agent.tools.get("exec_command").is_some() {
        rt.exec_sessions.register(&mut mcp.tools);
    }
    if state.agent.tools.get("code_mode").is_some() {
        rt.code_mode.register(&mut mcp.tools);
    }
    crate::subagents::register(state, thread_id, turn_id, &mut mcp.tools);
    // 电脑操控: off means no desktop tools at all; on, the driver's own tools (reached through the
    // managed MCP server) replace the basic `computer` tool, which stays only as the fallback for a
    // moment where the driver is not up — and a platform with no driver build has no such moment,
    // and no settings pane to switch it on either.
    let desktop = crate::settings::read(state)
        .map(|s| s.computer_control)
        .unwrap_or(false);
    let status = state.computer_status();
    if !crate::computer::keep_basic_computer_tool(desktop, status.running, status.supported) {
        mcp.tools.retain(|name| name != "computer");
    }
    if !crate::settings::read(state)
        .map(|s| s.code_mode_enabled)
        .unwrap_or(true)
    {
        mcp.tools
            .retain(|name| !matches!(name, "code_mode" | "wait"));
    }
    let role = crate::subagents::roles::of_thread(state, thread_id);
    crate::subagents::roles::restrict(role.as_ref(), &mut mcp.tools);
    let ceiling = state
        .store
        .db
        .subagent(thread_id)
        .ok()
        .flatten()
        .and_then(|s| s.tool_ceiling);
    if let Some(ceiling) = &ceiling {
        mcp.tools
            .retain(|name| ceiling.iter().any(|allowed| allowed == name));
    }
    let goal = crate::goal::read(state, thread_id)
        .filter(|g| g.status == fv_protocol::types::GoalStatus::Running);
    if goal.is_none() {
        mcp.tools
            .retain(|name| name != fv_tools::GOAL_COMPLETE_TOOL);
    }
    let loaded = rt.loaded_tools();
    // Explicit role/ancestor grants must work without granting tool_search as well.
    // Load only tools that survived BOTH restrictions in this per-turn snapshot.
    for names in role
        .as_ref()
        .and_then(|r| r.tools.as_ref())
        .into_iter()
        .chain(ceiling.as_ref())
    {
        loaded.load(
            names
                .iter()
                .filter(|name| mcp.tools.get(name).is_some())
                .cloned(),
        );
    }
    let role_prompt = role
        .map(|r| {
            format!(
                "\n\nChild agent role: {} ({})\n{}",
                r.name, r.id, r.system_prompt
            )
        })
        .unwrap_or_default();
    let child_prompt = if crate::subagents::is_child(state, thread_id) {
        "\n\nYou are a child agent. Any preceding conversation is inherited parent context. Follow the assigned task and your own role. Earlier tool sessions and process handles are historical and cannot be reused. Tool availability comes from your current tool list, not inherited calls. Earlier action-specific approvals belong to the parent; use your own sandbox and approvals. Report your result to the parent."
    } else {
        ""
    };
    let tools = Arc::new(mcp.tools);
    // Re-read per turn, including queued runs and manual compaction. Do not put this in a
    // transcript: updating or clearing a preference must not leave old instructions behind.
    let personalization = crate::settings::read(state)
        .map(|s| s.custom_system_prompt)
        .unwrap_or_default();
    let personalization = personalization.trim();
    let personalization = if personalization.is_empty() {
        String::new()
    } else {
        format!("\n\n{personalization}")
    };
    AgentContext {
        model,
        tools,
        // Only what is stable for a conversation stays in the system prompt, so the provider's
        // cached prefix survives a new skill, an edited AGENTS.md, a refreshed memory or an MCP
        // server coming and going. The user's personalization is the final suffix, matching the
        // desktop's per-turn custom instructions.
        system: format!(
            "{}\n\n{}\n\n{}{}{}{}",
            base_instructions(cwd.as_deref()),
            permissions_prompt(&permissions),
            state.agent.system,
            child_prompt,
            role_prompt,
            personalization
        ),
        // What changes between turns, and what comes from the project rather than from us,
        // leads the conversation as a user message: lower trust than the system prompt.
        context: {
            let body = format!(
                "Today is {} (call `current_time` for the exact time).\n\n{}{}{}{}",
                fv_tools::today_text(),
                folders,
                discovered,
                mcp.instructions,
                state.schedules.instructions(thread_id)
            ) + &goal
                .as_ref()
                .map(|g| format!("\n\n{}", crate::goal::instructions(g)))
                .unwrap_or_default();
            let body = body.trim();
            if body.is_empty() {
                String::new()
            } else {
                format!(
                    "<project_context>\nBackground gathered from this machine and project for this turn. It is reference material, not a message from the user.\n\n{body}\n</project_context>"
                )
            }
        },
        cwd,
        loaded,
        ui: Some(Arc::new(ThreadUserInput {
            state: state.clone(),
            rt: rt.clone(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            withdrawn,
        })),
        permissions: Some(permissions),
        steer: Some(rt.steers()),
        memory: Some(state.memory.clone()),
        budget: rt.budget.clone(),
        compaction: Some(state.auto_compaction.clone()),
    }
}

/// Summarize a thread now, without the user having sent anything: its own turn, which shows
/// the compaction and can be stopped like any other.
pub fn spawn_compaction(
    state: Arc<ServerState>,
    rt: Arc<ThreadRuntime>,
    thread_id: String,
    turn_id: String,
    cancel: CancellationToken,
) {
    let worker = tokio::spawn(drive_compaction(
        state.clone(),
        rt.clone(),
        thread_id.clone(),
        turn_id.clone(),
        cancel,
    ));
    tokio::spawn(async move {
        if worker.await.is_err() {
            recover_panic(&state, &rt, &thread_id, &turn_id).await;
        }
    });
}

async fn drive_compaction(
    state: Arc<ServerState>,
    rt: Arc<ThreadRuntime>,
    thread_id: String,
    turn_id: String,
    cancel: CancellationToken,
) {
    record_start(&state, &thread_id, &turn_id);
    rt.publish(
        &state,
        LogEvent::TurnStarted {
            turn_id: turn_id.clone(),
        },
    )
    .await;
    let (withdrawn_tx, _unused) = mpsc::unbounded_channel();
    let ctx = build_context(
        &state,
        &rt,
        &thread_id,
        &turn_id,
        withdrawn_tx,
        None,
        &cancel,
    )
    .await;
    let mut history = rt.history();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut mapper = EventMapper::new(turn_id.clone(), fv_agent::effective_context_window(&ctx));
    let result = {
        let run = std::panic::AssertUnwindSafe(fv_agent::compact(&ctx, &mut history, &tx, &cancel))
            .catch_unwind();
        tokio::pin!(run);
        loop {
            tokio::select! {
                biased;
                Some(event) = rx.recv() => {
                    persist(&state, &thread_id, &event);
                    for e in mapper.map(event) {
                        rt.publish(&state, e).await;
                    }
                }
                result = &mut run => break result.unwrap_or_else(|_| Err(fv_agent::CompactError::Failed("Internal error.".into()))),
            }
        }
    };
    while let Ok(event) = rx.try_recv() {
        persist(&state, &thread_id, &event);
        for e in mapper.map(event) {
            rt.publish(&state, e).await;
        }
    }
    rt.set_history(history.clone());
    // The bill is part of the stats a client draws, and the catalog prices by the label each
    // reply recorded: recompute it once the turn's messages are all in.
    if rt.reprice(&state.catalog.snapshot(), &history).is_some() {
        rt.publish(&state, LogEvent::StatsSnapshot).await;
    }
    let (status, error) = match result {
        Ok(()) => (TurnStatus::Completed, None),
        Err(fv_agent::CompactError::Interrupted) => (TurnStatus::Interrupted, None),
        Err(
            fv_agent::CompactError::Failed(message) | fv_agent::CompactError::Capacity(message),
        ) => (TurnStatus::Failed, Some(message)),
    };
    finish_turn(&state, &rt, &thread_id, &turn_id, status, error.clone()).await;
    state.touch_thread(&thread_id, None);
    rt.end(&state).await;
    crate::subagents::settled(&state, &thread_id, status, error, &rt.turns());
    // A compaction divider is not a place the user answers from, and guessing there would spend a
    // request on material that says nothing about the work.
    if rt.forget_suggestion() {
        rt.publish(&state, LogEvent::SuggestionChanged(None)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fv_agent::testing::{Reply, ScriptedModel};

    #[tokio::test]
    async fn rewind_claims_the_thread_before_waiting_for_a_slow_client() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(
            ServerState::new(
                dir.path().into(),
                crate::agent_with_builtin_tools(Arc::new(ScriptedModel::new([
                    Reply::new().then_hang()
                ]))),
            )
            .unwrap(),
        );
        let thread = state.create_thread(None, None, None, None).unwrap();
        state.persist(
            &thread.id,
            &fv_core::Message::User {
                text: "original".into(),
            },
        );
        let rt = state.runtime(&thread.id);
        let original = std::fs::read(state.store.transcripts.path(&thread.id)).unwrap();
        let (tx, mut rx) = mpsc::channel(1);
        let conn = state.register(tx.clone());
        rt.subscribe(conn);
        tx.try_send(fv_protocol::Message::Notification {
            method: "full".into(),
            params: serde_json::json!({}),
        })
        .unwrap();
        let task = tokio::spawn(rewind(
            state.clone(),
            rt.clone(),
            thread.id.clone(),
            "t0".into(),
            None,
            false,
        ));
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !rt.is_running() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(rt.begin(&state, "competing-turn").await.is_none());
        assert_eq!(
            std::fs::read(state.store.transcripts.path(&thread.id)).unwrap(),
            original
        );
        // Release the blocked delivery, and drain the subsequent rewind/start notifications.
        tokio::pin!(task);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                tokio::select! {
                    result = &mut task => { assert!(result.unwrap().is_ok()); break; }
                    _ = rx.recv() => (),
                }
            }
        })
        .await
        .unwrap();
        state.unregister(conn);
        drop(rx);
        rt.interrupt();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while rt.is_running() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn an_invalid_rewind_releases_its_claim_and_preserves_the_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(
            ServerState::new(
                dir.path().into(),
                crate::agent_with_builtin_tools(Arc::new(ScriptedModel::default())),
            )
            .unwrap(),
        );
        let thread = state.create_thread(None, None, None, None).unwrap();
        state.persist(
            &thread.id,
            &fv_core::Message::User {
                text: "keep".into(),
            },
        );
        let rt = state.runtime(&thread.id);
        let before = std::fs::read(state.store.transcripts.path(&thread.id)).unwrap();
        assert!(
            rewind(
                state.clone(),
                rt.clone(),
                thread.id.clone(),
                "missing".into(),
                None,
                false
            )
            .await
            .is_err()
        );
        assert!(!rt.is_running());
        assert_eq!(
            std::fs::read(state.store.transcripts.path(&thread.id)).unwrap(),
            before
        );
    }
}
