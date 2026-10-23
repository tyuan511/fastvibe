use std::sync::Arc;

use fv_agent::{AgentContext, AgentEvent, TurnOutcome, base_instructions, run_turn};

use crate::prompt::{ThreadUserInput, announce_resolved};
use fv_protocol::types::{Item, TurnStatus};
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
    let worker = tokio::spawn(drive(
        state.clone(),
        rt.clone(),
        thread_id,
        turn_id.clone(),
        text,
        cancel,
    ));
    // A panic in the turn must not leave the thread claimed forever.
    tokio::spawn(async move {
        if worker.await.is_err() {
            rt.publish(
                &state,
                LogEvent::TurnCompleted {
                    turn_id,
                    status: TurnStatus::Failed,
                    error: Some("Internal error.".into()),
                },
            )
            .await;
            rt.end(&state).await;
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
) {
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

    // Each conversation works in its own directory, and tells the model so.
    let cwd = state
        .thread(&thread_id)
        .ok()
        .flatten()
        .and_then(|t| t.cwd)
        .map(std::path::PathBuf::from);
    let (withdrawn_tx, mut withdrawn_rx) = mpsc::unbounded_channel();
    let ctx = AgentContext {
        // The base instructions, then whatever the server was configured to add.
        system: format!(
            "{}{}",
            base_instructions(cwd.as_deref()),
            state.agent.system
        ),
        cwd,
        // Deferred tools found earlier in this thread are still on offer.
        loaded: rt.loaded_tools(),
        // Questions the agent asks go to whoever is watching this thread.
        ui: Some(std::sync::Arc::new(ThreadUserInput {
            state: state.clone(),
            rt: rt.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            withdrawn: withdrawn_tx,
        })),
        ..state.agent.clone()
    };
    let first_prompt = text.clone();
    let mut history = rt.history();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut mapper = EventMapper::new(turn_id.clone());
    let outcome = {
        let run = run_turn(&ctx, &mut history, text, &tx, &cancel);
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
                outcome = &mut run => break outcome,
            }
        }
    };
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
    rt.set_history(history);

    let (status, error) = match outcome {
        TurnOutcome::Completed => (TurnStatus::Completed, None),
        TurnOutcome::Interrupted => (TurnStatus::Interrupted, None),
        TurnOutcome::Failed(message) => {
            let item = Item::Error {
                id: uuid::Uuid::new_v4().to_string(),
                message: message.clone(),
            };
            rt.publish(
                &state,
                LogEvent::ItemCompleted {
                    turn_id: turn_id.clone(),
                    item,
                },
            )
            .await;
            (TurnStatus::Failed, Some(message))
        }
    };
    rt.publish(
        &state,
        LogEvent::TurnCompleted {
            turn_id,
            status,
            error,
        },
    )
    .await;
    state.touch_thread(&thread_id, Some(&first_prompt));
    // "Running" ends only now, after the completion event: a client that sees the thread idle
    // has already seen everything the turn did.
    rt.end(&state).await;
}

/// Messages reach the transcript as the agent adds them to its history, not when the turn ends:
/// a crash then loses the message being written and nothing before it.
fn persist(state: &ServerState, thread_id: &str, event: &AgentEvent) {
    if let AgentEvent::Committed(message) = event {
        state.persist(thread_id, message);
    }
}
