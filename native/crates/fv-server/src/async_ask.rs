//! Tools that talk to the user without stopping the turn.
//!
//! `request_user_input` parks the whole turn on a person. These two do not: the agent asks (or
//! just says something) and carries on. An answer, when it comes, reaches the agent as a message
//! of its own: it starts a turn on an idle thread and queues behind the reply in flight otherwise.

use std::sync::{Arc, Weak};

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
use fv_core::{Question, QuestionOption};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::log::LogEvent;
use crate::state::ServerState;

pub const ASK: &str = "request_user_input_async";
pub const TELL: &str = "send_message_to_user_async";

#[derive(Clone, Copy)]
enum Kind {
    Ask,
    Tell,
}

struct AsyncTool {
    state: Weak<ServerState>,
    thread: String,
    kind: Kind,
}

pub fn register(state: &Arc<ServerState>, thread: &str, registry: &mut ToolRegistry) {
    for kind in [Kind::Ask, Kind::Tell] {
        registry.register(AsyncTool {
            state: Arc::downgrade(state),
            thread: thread.into(),
            kind,
        });
    }
}

#[derive(Deserialize)]
struct AskArgs {
    questions: Vec<RawQuestion>,
}

#[derive(Deserialize)]
struct RawQuestion {
    id: String,
    header: String,
    question: String,
    #[serde(default)]
    options: Vec<QuestionOption>,
}

#[derive(Deserialize)]
struct TellArgs {
    message: String,
}

/// What the agent is told when the user has answered.
pub fn answer_message(answers: &fv_core::Answers) -> String {
    let json = serde_json::to_string(answers).unwrap_or_default();
    format!("The user answered the questions you asked earlier without waiting:\n{json}")
}

impl Tool for AsyncTool {
    fn spec(&self) -> ToolSpec {
        match self.kind {
            Kind::Ask => {
                let mut spec = fv_tools::RequestUserInputTool.spec();
                spec.name = ASK.into();
                spec.description = "Ask the user one to three short questions and keep working. The questions appear for the user to answer whenever they look; their answers arrive later as a message from them. Use it for a decision that does not block the rest of your work.".into();
                spec
            }
            Kind::Tell => ToolSpec {
                name: TELL.into(),
                description: "Tell the user something without waiting for a reply, for example that a long step finished or that you need them later. It does not interrupt your work.".into(),
                schema: json!({
                    "type": "object",
                    "properties": {"message": {"type": "string"}},
                    "required": ["message"],
                    "additionalProperties": false
                }),
            },
        }
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        let state = self.state.upgrade();
        let thread = self.thread.clone();
        let kind = self.kind;
        Box::pin(async move {
            let Some(state) = state else {
                return ToolOutput::err("Server closed.");
            };
            let rt = state.runtime(&thread);
            match kind {
                Kind::Tell => {
                    let args: TellArgs = match serde_json::from_value(arguments) {
                        Ok(a) => a,
                        Err(e) => {
                            return ToolOutput::err(format!(
                                "failed to parse function arguments: {e}"
                            ));
                        }
                    };
                    let text = args.message.trim();
                    if text.is_empty() {
                        return ToolOutput::err("message must not be empty");
                    }
                    rt.publish(&state, LogEvent::Notice(text.to_string())).await;
                    ToolOutput::ok("The user was told.")
                }
                Kind::Ask => {
                    let args: AskArgs = match serde_json::from_value(arguments) {
                        Ok(a) => a,
                        Err(e) => {
                            return ToolOutput::err(format!(
                                "failed to parse function arguments: {e}"
                            ));
                        }
                    };
                    if args.questions.is_empty()
                        || args.questions.iter().any(|q| q.options.is_empty())
                    {
                        return ToolOutput::err("every question needs options");
                    }
                    let Some(ui) = ctx.ui.clone() else {
                        return ToolOutput::err("no client is connected that can answer");
                    };
                    let questions = args
                        .questions
                        .into_iter()
                        .map(|q| Question {
                            id: q.id,
                            header: q.header,
                            question: q.question,
                            options: q.options,
                            is_other: true,
                        })
                        .collect();
                    let call_id = ctx.call_id.clone();
                    tokio::spawn(async move {
                        if let Some(answers) = ui.ask(call_id, questions).await {
                            deliver(state, rt, &thread, answer_message(&answers)).await;
                        }
                    });
                    ToolOutput::ok(
                        "The questions were put to the user. Carry on; their answers will arrive later as a message.",
                    )
                }
            }
        })
    }
}

/// Hand the agent a message of its own: now if the thread is idle, behind the reply otherwise.
async fn deliver(
    state: Arc<ServerState>,
    rt: Arc<crate::runtime::ThreadRuntime>,
    thread: &str,
    text: String,
) {
    if rt.is_running() {
        if crate::queue::enqueue(&state, &rt, thread, text).is_ok() {
            crate::queue::publish(&state, &rt, thread).await;
        }
        return;
    }
    crate::turn::start_text(state, rt, thread, text).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_reaches_the_agent_as_json_it_can_read() {
        let mut answers = fv_core::Answers::default();
        answers.answers.insert(
            "branch".into(),
            fv_core::AnswerList {
                answers: vec!["main".into()],
            },
        );
        let text = answer_message(&answers);
        assert!(
            text.contains("asked earlier") && text.contains(r#""branch""#) && text.contains("main")
        );
    }
}
