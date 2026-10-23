//! Questions the agent puts to the user: a request to the client, and the agent waiting on its
//! answer. The wait survives a client leaving: the request is kept, and replayed to whoever
//! opens the thread next.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use fv_agent::UserInput;
use fv_core::{Answers, Question};
use fv_protocol::types::{self, ThreadId, TurnId};
use fv_protocol::{Message, RequestId, ServerRequest};
use tokio::sync::mpsc::UnboundedSender;

use crate::log::LogEvent;
use crate::runtime::ThreadRuntime;
use crate::state::ServerState;

/// `UserInput` for one turn of one thread.
pub struct ThreadUserInput {
    pub state: Arc<ServerState>,
    pub rt: Arc<ThreadRuntime>,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    /// Where the turn is told that a question it asked was abandoned, so that it can announce
    /// that in order, before it reports itself finished.
    pub withdrawn: UnboundedSender<RequestId>,
}

pub fn request_frame(request: &ServerRequest) -> Message {
    let v = serde_json::to_value(request).expect("requests serialize");
    Message::Request {
        id: request.id().clone(),
        method: request.method().to_string(),
        params: v.get("params").cloned().unwrap_or(serde_json::Value::Null),
    }
}

fn to_protocol(q: Question) -> types::Question {
    types::Question {
        id: q.id,
        header: q.header,
        question: q.question,
        options: q
            .options
            .into_iter()
            .map(|o| types::QuestionOption {
                label: o.label,
                description: o.description,
            })
            .collect(),
        is_other: q.is_other,
    }
}

impl UserInput for ThreadUserInput {
    fn ask(
        &self,
        call_id: String,
        questions: Vec<Question>,
    ) -> BoxFuture<'static, Option<Answers>> {
        let (state, rt) = (self.state.clone(), self.rt.clone());
        let (thread_id, turn_id) = (self.thread_id.clone(), self.turn_id.clone());
        let withdrawn = self.withdrawn.clone();
        Box::pin(async move {
            let id = RequestId::String(uuid::Uuid::new_v4().to_string());
            let request = ServerRequest::UserInput {
                id: id.clone(),
                params: types::UserInputRequest {
                    thread_id: thread_id.clone(),
                    turn_id,
                    call_id,
                    questions: questions.into_iter().map(to_protocol).collect(),
                },
            };
            let answer = state.park_prompt(id.clone(), &thread_id, request.clone());
            // If this future is dropped (the turn was stopped) the guard withdraws the prompt.
            let guard = Withdraw {
                state: state.clone(),
                withdrawn,
                id,
            };
            rt.send_frame(&state, request_frame(&request)).await;
            let answers = answer.await.ok().flatten();
            drop(guard);
            answers
        })
    }
}

/// Takes the prompt down when the question is abandoned. If an answer got there first the
/// prompt is already gone and this does nothing. It runs in a destructor, so nothing is awaited
/// here: the turn is told through a channel and announces it.
struct Withdraw {
    state: Arc<ServerState>,
    withdrawn: UnboundedSender<RequestId>,
    id: RequestId,
}

impl Drop for Withdraw {
    fn drop(&mut self) {
        if self.state.take_prompt(&self.id).is_some() {
            let _ = self.withdrawn.send(self.id.clone());
        }
    }
}

/// Tell watchers a request is no longer waiting.
pub async fn announce_resolved(state: &ServerState, thread_id: &str, id: RequestId) {
    state
        .runtime(thread_id)
        .publish(state, LogEvent::RequestResolved { request_id: id })
        .await;
}

/// A client answered (`result`) or declined (`error`) a request of ours.
pub async fn resolve(state: &ServerState, id: RequestId, frame: &serde_json::Value) {
    let Some(pending) = state.take_prompt(&id) else {
        return;
    };
    let answers = match frame.get("result") {
        Some(result) => serde_json::from_value::<types::UserInputResponse>(result.clone())
            .ok()
            .map(|r| Answers {
                answers: r
                    .answers
                    .into_iter()
                    .map(|(q, a)| (q, fv_core::AnswerList { answers: a.answers }))
                    .collect(),
            }),
        // An error reply, or nothing usable: the user did not answer.
        None => None,
    };
    let _ = pending.answer.send(answers);
    announce_resolved(state, &pending.thread_id, id).await;
}
