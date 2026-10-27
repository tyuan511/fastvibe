//! Plan mode and reviews: turns where the agent may look but not change anything.
//!
//! Both restrict the turn to the read-only tools and a read-only sandbox without asking, the way
//! a read-only subagent role does; they differ in how long it lasts. Plan mode is a standing
//! property of the conversation (`mode:<thread id>` in the settings table) until the user leaves
//! it; a review restricts the one turn it starts.

use std::sync::Arc;

use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::{ReviewTarget, ThreadMode};

use crate::runtime::ThreadRuntime;
use crate::state::ServerState;

fn key(thread_id: &str) -> String {
    format!("mode:{thread_id}")
}

pub fn read(state: &ServerState, thread_id: &str) -> ThreadMode {
    match state
        .store
        .db
        .get_setting(&key(thread_id))
        .ok()
        .flatten()
        .as_deref()
    {
        Some("plan") => ThreadMode::Plan,
        _ => ThreadMode::Default,
    }
}

pub fn set(state: &ServerState, thread_id: &str, mode: ThreadMode) {
    let value = (mode == ThreadMode::Plan).then_some("plan");
    if let Err(e) = state.store.db.set_setting(&key(thread_id), value) {
        eprintln!("cannot save the mode of {thread_id}: {e}");
    }
}

/// What a plan-mode turn is told on top of its restrictions.
pub const PLAN_INSTRUCTIONS: &str = "Plan mode: investigate with the read-only tools you have and write a plan. Do not change files or run commands that change anything; those tools are not available. Keep the plan in `update_plan`, and finish with a short summary of the approach, the files involved and the risks. The user will take it from there.";

const REVIEW_FORMAT: &str = "Report findings as a list ordered by priority. Each finding has: a priority (P0 blocks release, P1 should be fixed soon, P2 worth fixing, P3 nit), `path:line`, what is wrong, and why it matters, with a concrete suggestion. Only report problems you can point to in the code; do not pad the list, and say plainly if you found none. You are reviewing, not fixing: do not modify anything.";

fn review_prompt(target: &ReviewTarget) -> String {
    let what = match target {
        ReviewTarget::Uncommitted => "Review the uncommitted changes in the working tree (staged, unstaged and untracked). Use `git status` and `git diff` / `git diff --staged` to read them.".to_string(),
        ReviewTarget::Base { base } => format!(
            "Review the changes on the current branch since it diverged from `{base}`. Use `git diff $(git merge-base HEAD {base})..HEAD` and `git log` to read them."
        ),
        ReviewTarget::Commit { sha } => {
            format!("Review commit `{sha}`. Use `git show {sha}` to read it.")
        }
        ReviewTarget::Custom { instructions } => instructions.clone(),
    };
    format!("{what}\n\n{REVIEW_FORMAT}")
}

/// Start a review as the thread's next turn (queued behind the reply in flight).
pub async fn start_review(
    state: &Arc<ServerState>,
    rt: &Arc<ThreadRuntime>,
    thread_id: &str,
    target: &ReviewTarget,
) -> Result<(), ErrorObject> {
    if let ReviewTarget::Custom { instructions } = target
        && instructions.trim().is_empty()
    {
        return Err(ErrorObject::new(
            code::INVALID_PARAMS,
            "a review needs instructions",
        ));
    }
    if rt.is_running() {
        return Err(ErrorObject::new(
            code::THREAD_BUSY,
            "wait for the reply in flight before starting a review",
        ));
    }
    rt.set_review_pending();
    crate::turn::start_text(state.clone(), rt.clone(), thread_id, review_prompt(target)).await;
    Ok(())
}
