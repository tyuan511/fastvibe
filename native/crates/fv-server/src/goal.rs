//! A conversation's long-running goal: the model keeps working round after round, by itself,
//! until it says the goal is done (`goal_complete`), the user pauses or stops it, a round fails,
//! or the unattended-round cap is reached.
//!
//! The goal is stored per thread in the settings table (`goal:<thread id>`) and is deleted with
//! the thread. A restart finds a running goal and leaves it **paused**: a goal spends tokens
//! without anyone watching, so nothing may resume behind the user's back after a relaunch.

use fv_core::{ContentBlock, Message};
use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::{Goal, GoalStatus, TurnStatus};
use serde::{Deserialize, Serialize};

use crate::log::LogEvent;
use crate::runtime::ThreadRuntime;
use crate::state::ServerState;

/// Rounds one unattended stretch may run before the goal pauses itself. Setting a goal or
/// resuming it starts the count again, so 继续 always buys a full stretch.
const ROUND_CAP: u32 = 100;

#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    objective: String,
    status: GoalStatus,
    round: u32,
    /// Rounds run since the user last set or resumed the goal.
    #[serde(default)]
    autonomous: u32,
}

impl Stored {
    fn goal(&self) -> Goal {
        Goal {
            objective: self.objective.clone(),
            status: self.status,
            round: self.round,
        }
    }
}

fn key(thread_id: &str) -> String {
    format!("goal:{thread_id}")
}

fn load(state: &ServerState, thread_id: &str) -> Option<Stored> {
    state
        .store
        .db
        .get_setting(&key(thread_id))
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn save(state: &ServerState, thread_id: &str, stored: Option<&Stored>) {
    let text = stored.and_then(|s| serde_json::to_string(s).ok());
    if let Err(e) = state.store.db.set_setting(&key(thread_id), text.as_deref()) {
        eprintln!("cannot save the goal of {thread_id}: {e}");
    }
}

/// The goal as clients should draw it.
pub fn read(state: &ServerState, thread_id: &str) -> Option<Goal> {
    load(state, thread_id).map(|s| s.goal())
}

/// Mark every goal that was running when the server last stopped as paused.
pub fn pause_all_on_start(state: &ServerState) {
    let Ok(threads) = state.threads(true) else {
        return;
    };
    for thread in threads {
        if let Some(mut stored) = load(state, &thread.id)
            && stored.status == GoalStatus::Running
        {
            stored.status = GoalStatus::Paused;
            save(state, &thread.id, Some(&stored));
        }
    }
}

async fn publish(state: &ServerState, rt: &ThreadRuntime, stored: Option<&Stored>) {
    rt.publish(state, LogEvent::GoalChanged(stored.map(Stored::goal)))
        .await;
}

/// What the model is told every turn while the goal runs.
pub fn instructions(goal: &Goal) -> String {
    format!(
        "Long-term goal: {}\nThis is round {}. First compare the work so far with the goal, list what this round must accomplish, then do it. When the goal is fully achieved, call the `goal_complete` tool; otherwise the next round starts automatically.",
        goal.objective, goal.round
    )
}

const CONTINUE: &str = "Continue working towards the goal. Compare current progress with it, list and finish the next batch of tasks, and call `goal_complete` when it is fully achieved.";

/// Start pursuing `objective`. The first round begins now, or right after the reply in flight.
pub async fn set(
    state: &std::sync::Arc<ServerState>,
    rt: &std::sync::Arc<ThreadRuntime>,
    thread_id: &str,
    objective: &str,
) -> Result<(), ErrorObject> {
    let objective = objective.trim();
    if objective.is_empty() {
        return Err(ErrorObject::new(
            code::INVALID_PARAMS,
            "a goal needs an objective",
        ));
    }
    let stored = Stored {
        objective: objective.into(),
        status: GoalStatus::Running,
        round: 1,
        autonomous: 0,
    };
    save(state, thread_id, Some(&stored));
    publish(state, rt, Some(&stored)).await;
    start_round(
        state,
        rt,
        thread_id,
        format!("Start working towards the goal: {objective}"),
    )
    .await;
    Ok(())
}

pub async fn pause(state: &ServerState, rt: &ThreadRuntime, thread_id: &str) {
    if let Some(mut stored) = load(state, thread_id)
        && stored.status == GoalStatus::Running
    {
        stored.status = GoalStatus::Paused;
        save(state, thread_id, Some(&stored));
        publish(state, rt, Some(&stored)).await;
    }
}

pub async fn resume(
    state: &std::sync::Arc<ServerState>,
    rt: &std::sync::Arc<ThreadRuntime>,
    thread_id: &str,
) {
    let Some(mut stored) = load(state, thread_id) else {
        return;
    };
    if stored.status != GoalStatus::Paused {
        return;
    }
    stored.status = GoalStatus::Running;
    stored.autonomous = 0;
    save(state, thread_id, Some(&stored));
    publish(state, rt, Some(&stored)).await;
    start_round(state, rt, thread_id, CONTINUE.into()).await;
}

pub async fn clear(state: &ServerState, rt: &ThreadRuntime, thread_id: &str) {
    if load(state, thread_id).is_some() {
        save(state, thread_id, None);
        publish(state, rt, None).await;
    }
}

/// Send a round's prompt: now on an idle thread, behind the reply in flight otherwise.
async fn start_round(
    state: &std::sync::Arc<ServerState>,
    rt: &std::sync::Arc<ThreadRuntime>,
    thread_id: &str,
    text: String,
) {
    if rt.is_running() {
        if crate::queue::enqueue(state, rt, thread_id, text).is_ok() {
            crate::queue::publish(state, rt, thread_id).await;
        }
        return;
    }
    crate::turn::start_text(state.clone(), rt.clone(), thread_id, text).await;
}

/// Whether the turn that just ended (everything after the last user message) called
/// `goal_complete`.
fn declared_done(history: &[Message]) -> bool {
    let from = history
        .iter()
        .rposition(|m| matches!(m, Message::User { .. }))
        .map_or(0, |i| i + 1);
    history[from..].iter().any(|m| {
        match m {
        Message::Assistant(a) => a.content.iter().any(|b| {
            matches!(b, ContentBlock::ToolCall { name, .. } if name == fv_tools::GOAL_COMPLETE_TOOL)
        }),
        _ => false,
    }
    })
}

/// A turn ended: settle the goal's state and, when another round should run, say what to send.
///
/// A stop or a failed turn pauses the goal (a stop the user made to send something else —
/// 「立即」 — does not). Declaring it done ends it. Otherwise the next round follows, unless the
/// unattended cap has been reached.
pub async fn after_turn(
    state: &ServerState,
    rt: &ThreadRuntime,
    thread_id: &str,
    status: TurnStatus,
    sending_now: bool,
) -> Option<String> {
    let mut stored = load(state, thread_id)?;
    if stored.status != GoalStatus::Running {
        return None;
    }
    let verdict = match status {
        TurnStatus::Failed => Some(GoalStatus::Paused),
        TurnStatus::Interrupted if sending_now => return None,
        TurnStatus::Interrupted => Some(GoalStatus::Paused),
        _ if declared_done(&rt.history()) => Some(GoalStatus::Complete),
        _ if stored.autonomous >= ROUND_CAP => Some(GoalStatus::Paused),
        _ => None,
    };
    if let Some(next) = verdict {
        stored.status = next;
        save(state, thread_id, Some(&stored));
        publish(state, rt, Some(&stored)).await;
        return None;
    }
    stored.round += 1;
    stored.autonomous += 1;
    save(state, thread_id, Some(&stored));
    publish(state, rt, Some(&stored)).await;
    Some(CONTINUE.into())
}
