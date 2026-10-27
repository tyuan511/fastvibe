//! Automatic review of approval prompts. With `auto_review_approvals` on, the conversation's own
//! model reads a command or patch that is about to ask the user and answers it when the answer is
//! clear. Anything unclear, any failure and any timeout falls through to asking the user: the
//! reviewer can spare an interruption, but it is never the reason something unsafe runs without
//! the user having had the chance to say no — a doubtful call is the user's.

use std::sync::Arc;

use futures_util::StreamExt as _;
use fv_agent::{ApprovalKind, ApprovalRequest};

use crate::runtime::ThreadRuntime;
use crate::state::ServerState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Approve,
    Deny,
    Ask,
}

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

const SYSTEM: &str = "You review one action an AI coding agent wants to take on the user's computer, and decide whether to let it run without asking the user. \
Answer APPROVE only when the action is clearly what the user asked for, is narrow in scope, stays inside the project or temporary files, and cannot lose data that is not easily recovered. \
Answer DENY when it is clearly harmful or unrelated to the request: deleting or overwriting data outside the project, reading or sending credentials or private keys, force-pushing or rewriting shared history, disabling security tools, installing software system-wide, or sending data to a host the user did not mention. \
Answer ASK for everything else, and whenever you are unsure. \
Reply with one word on the first line (APPROVE, DENY or ASK), then at most one short sentence of reasoning.";

pub fn enabled(state: &ServerState) -> bool {
    crate::settings::read(state)
        .map(|s| s.auto_review_approvals)
        .unwrap_or(false)
}

/// What a reviewer's answer means; anything but a clear first word is `Ask`.
pub fn verdict_of(answer: &str) -> Verdict {
    let first = answer
        .trim_start()
        .split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    match first.as_str() {
        "APPROVE" => Verdict::Approve,
        "DENY" => Verdict::Deny,
        _ => Verdict::Ask,
    }
}

fn prompt(request: &ApprovalRequest, user_said: &str) -> String {
    let action = match &request.kind {
        ApprovalKind::Command { command, cwd } => format!(
            "Run a command{}:\n{command}",
            cwd.as_ref()
                .map(|c| format!(" in {}", c))
                .unwrap_or_default()
        ),
        ApprovalKind::Patch { files } => format!("Apply a patch to: {}", files.join(", ")),
    };
    let why = request
        .reason
        .as_deref()
        .map(|r| format!("\nWhy it is asking: {r}"))
        .unwrap_or_default();
    format!("The user's latest request:\n{user_said}\n\nThe action:\n{action}{why}")
}

/// The last thing the user said in this conversation.
fn last_user_words(rt: &ThreadRuntime) -> String {
    use fv_protocol::types::Item;
    rt.turns()
        .iter()
        .rev()
        .flat_map(|t| t.items.iter().rev())
        .find_map(|item| match item {
            Item::UserMessage { text, .. } => Some(text.chars().take(1500).collect::<String>()),
            _ => None,
        })
        .unwrap_or_default()
}

pub async fn review(
    state: &Arc<ServerState>,
    rt: &Arc<ThreadRuntime>,
    thread_id: &str,
    request: &ApprovalRequest,
) -> Verdict {
    let Some(thread) = state.thread(thread_id).ok().flatten() else {
        return Verdict::Ask;
    };
    let model = state.suggestion_model(&thread);
    let ask = fv_agent::ModelRequest {
        system: SYSTEM.into(),
        messages: vec![fv_core::Message::User {
            text: prompt(request, &last_user_words(rt)),
        }],
        tools: Vec::new(),
        max_output_tokens: None,
    };
    let read = async {
        let mut stream = model.stream(ask);
        let mut text = String::new();
        while let Some(event) = stream.next().await {
            match event {
                Ok(fv_agent::ModelEvent::Text(delta)) => text.push_str(&delta),
                Ok(fv_agent::ModelEvent::Done(message)) => {
                    let full = message.text();
                    return if full.is_empty() { text } else { full };
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        text
    };
    match tokio::time::timeout(TIMEOUT, read).await {
        Ok(answer) => verdict_of(&answer),
        Err(_) => Verdict::Ask,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_clear_first_word_settles_it() {
        assert_eq!(verdict_of("APPROVE\nIt only reads."), Verdict::Approve);
        assert_eq!(verdict_of("  deny - deletes ~/.ssh"), Verdict::Deny);
        assert_eq!(verdict_of("ASK"), Verdict::Ask);
        assert_eq!(verdict_of("I think this is probably fine"), Verdict::Ask);
        assert_eq!(verdict_of(""), Verdict::Ask);
        assert_eq!(verdict_of("Approved, because"), Verdict::Ask);
    }
}
