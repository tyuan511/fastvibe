//! Prompts queued behind the reply in flight, and "send this one now".
//!
//! The queue lives in the database, one row per prompt, so it survives a restart the way the
//! Electron app's `queue_items` does — and so a crash cannot rewrite a neighbour's entry. Two
//! rules shape everything here:
//!
//! - **A queue that stopped on its own stays stopped.** A failed turn, or a restart that found
//!   a prompt marked as being sent, pauses the queue instead of draining it; the user resumes it.
//!   Otherwise a single bad turn eats every prompt they had lined up.
//! - **`立即` sends one prompt now, and the row leaves the queue only once it has.** The run in
//!   flight is interrupted and the thread is told to start that prompt next, even though the two
//!   turns are not adjacent in time (the old run still has to settle).
//!
//! The thread runtime holds the same list in memory while the server runs; the database is the
//! recovery copy, written whenever the list changes.

use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::{QueueItem, QueuePauseReason, QueueState};
use fv_store::QueuedPrompt;

use crate::log::LogEvent;
use crate::runtime::ThreadRuntime;
use crate::state::{ServerState, now_ms};

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

pub fn queue_item(row: &QueuedPrompt) -> QueueItem {
    QueueItem {
        id: row.id.clone(),
        text: row.text.clone(),
        at: row.at,
    }
}

/// The stored reason, as the protocol names it. An unknown one (a file written by a newer
/// build) reads as a failure: the safe answer is "do not send anything".
fn pause_of(raw: Option<String>) -> Option<QueuePauseReason> {
    raw.map(|raw| match raw.as_str() {
        "stopped" => QueuePauseReason::Stopped,
        _ => QueuePauseReason::Failed,
    })
}

fn pause_name(reason: QueuePauseReason) -> &'static str {
    match reason {
        QueuePauseReason::Stopped => "stopped",
        QueuePauseReason::Failed => "failed",
    }
}

/// Whether the queue may drain: no stored pause, and nothing in memory said otherwise.
pub fn is_paused(state: &ServerState, thread_id: &str) -> bool {
    state
        .store
        .db
        .queue_pause(thread_id)
        .unwrap_or(None)
        .is_some()
}

/// The queue as the client should draw it.
pub fn state_for(state: &ServerState, rt: &ThreadRuntime, thread_id: &str) -> QueueState {
    QueueState {
        items: rt.queue().iter().map(queue_item).collect(),
        pause: pause_of(state.store.db.queue_pause(thread_id).unwrap_or(None)),
    }
}

/// Announce the queue's whole current state to everyone watching the thread.
pub async fn publish(state: &ServerState, rt: &ThreadRuntime, thread_id: &str) {
    let queue = state_for(state, rt, thread_id);
    rt.publish(state, LogEvent::QueueChanged(queue)).await;
}

/// Load a thread's queue from the database into its runtime. Called when the runtime is built:
/// a restart resumes what was queued but never sent, which is safe. A queue that was paused
/// before the restart stays paused — the flag is stored, not inferred from the last run.
pub fn restore(state: &ServerState, rt: &ThreadRuntime, thread_id: &str) {
    match state.store.db.queue(thread_id) {
        Ok(rows) if !rows.is_empty() => rt.set_queue(rows),
        Ok(_) => {}
        Err(e) => eprintln!("cannot read the queue of {thread_id}: {e}"),
    }
}

/// Queue a prompt for after the reply in flight.
pub fn enqueue(
    state: &ServerState,
    rt: &ThreadRuntime,
    thread_id: &str,
    text: String,
) -> Result<QueuedPrompt, ErrorObject> {
    let row = QueuedPrompt {
        id: uuid::Uuid::new_v4().to_string(),
        text,
        at: now_ms(),
    };
    state
        .store
        .db
        .push_queued(thread_id, &row)
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
    rt.push_queue(row.clone());
    Ok(row)
}

/// Take one prompt off the queue. `None` when it is no longer there (another client, a send).
pub fn take(
    state: &ServerState,
    rt: &ThreadRuntime,
    thread_id: &str,
    id: &str,
) -> Option<QueuedPrompt> {
    let taken = rt.take_queue(id)?;
    if let Err(e) = state.store.db.remove_queued(thread_id, id) {
        eprintln!("cannot remove a queued prompt of {thread_id}: {e}");
    }
    Some(taken)
}

/// The head of the queue, if anything may be sent from it right now.
///
/// A paused queue sends nothing; that is the whole point of the flag.
pub fn next_sendable(
    state: &ServerState,
    rt: &ThreadRuntime,
    thread_id: &str,
) -> Option<QueuedPrompt> {
    if is_paused(state, thread_id) {
        return None;
    }
    rt.queue().into_iter().next()
}

/// Put a prompt back at the front, for a turn that could not start it after all.
pub fn requeue_front(state: &ServerState, rt: &ThreadRuntime, thread_id: &str, row: &QueuedPrompt) {
    rt.push_front_queue(row.clone());
    if let Err(e) = state.store.db.requeue_front(thread_id, row) {
        eprintln!("cannot requeue a prompt of {thread_id}: {e}");
    }
}

/// Pause the queue, so nothing drains until the user resumes it. The reason is what the client
/// prints beside the prompts, so it has to be the real one: a stop and a failure mean different
/// things to the person reading it.
pub fn pause(state: &ServerState, _rt: &ThreadRuntime, thread_id: &str, reason: QueuePauseReason) {
    if let Err(e) = state
        .store
        .db
        .set_queue_pause(thread_id, Some(pause_name(reason)))
    {
        eprintln!("cannot pause the queue of {thread_id}: {e}");
    }
}

/// Let the queue drain again.
pub fn resume(state: &ServerState, _rt: &ThreadRuntime, thread_id: &str) {
    if let Err(e) = state.store.db.set_queue_pause(thread_id, None) {
        eprintln!("cannot resume the queue of {thread_id}: {e}");
    }
}

/// The thread's next prompt, if one is waiting and sending is allowed.
pub fn take_next(state: &ServerState, rt: &ThreadRuntime, thread_id: &str) -> Option<QueuedPrompt> {
    let head = next_sendable(state, rt, thread_id)?;
    take(state, rt, thread_id, &head.id)
}

/// `立即`: send this prompt as the thread's next turn, interrupting whatever is running.
///
/// The interrupted run still has to settle before the prompt can start, so the prompt is left
/// in the queue and recorded as the one to send next (`send` marks it); the settle path picks it
/// up. That keeps one copy of the prompt — a client that reconnects meanwhile sees it in the
/// queue, exactly where the server would look.
pub fn send_now(
    state: &ServerState,
    rt: &ThreadRuntime,
    thread_id: &str,
    id: &str,
) -> Result<QueuedPrompt, ErrorObject> {
    let Some(row) = rt.queue().into_iter().find(|item| item.id == id) else {
        return Err(invalid("that prompt is no longer queued"));
    };
    // Sending one prompt by hand is the user saying "go": a paused queue is resumed by the act,
    // otherwise the item they asked for would sit there behind the pause they did not mention.
    resume(state, rt, thread_id);
    rt.set_preferred(id);
    rt.interrupt();
    Ok(row)
}
