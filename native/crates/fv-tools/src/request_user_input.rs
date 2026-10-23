// The tool's name, arguments, description and result follow OpenAI Codex (codex-rs/core/src/
// tools/handlers/request_user_input.rs and request_user_input_spec.rs), Apache-2.0. See NOTICE.md.

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use fv_core::{Question, QuestionOption};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Args {
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

/// Stops the turn to ask the user one to three short questions, and returns what they answered.
pub struct RequestUserInputTool;

impl Tool for RequestUserInputTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "request_user_input".into(),
            description:
                "Request user input for one to three short questions and wait for the response."
                    .into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "description": "Questions to show the user. Prefer 1 and do not exceed 3",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "Stable identifier for mapping answers (snake_case)."},
                                "header": {"type": "string", "description": "Short header label shown in the UI (12 or fewer chars)."},
                                "question": {"type": "string", "description": "Single-sentence prompt shown to the user."},
                                "options": {
                                    "type": "array",
                                    "description": "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with \"(Recommended)\". Do not include an \"Other\" option in this list; the client will add a free-form \"Other\" option automatically.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": {"type": "string", "description": "User-facing label (1-5 words)."},
                                            "description": {"type": "string", "description": "One short sentence explaining impact/tradeoff if selected."}
                                        },
                                        "required": ["label", "description"],
                                        "additionalProperties": false
                                    }
                                }
                            },
                            "required": ["id", "header", "question", "options"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["questions"],
                "additionalProperties": false
            }),
        }
    }

    // The turn waits on a person; nothing else should run in the meantime.
    fn mutates(&self) -> bool {
        true
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            let args: Args = match serde_json::from_value(arguments) {
                Ok(a) => a,
                Err(e) => {
                    return ToolOutput::err(format!("failed to parse function arguments: {e}"));
                }
            };
            if args.questions.is_empty() {
                return ToolOutput::err("request_user_input needs at least one question");
            }
            if args.questions.iter().any(|q| q.options.is_empty()) {
                return ToolOutput::err(
                    "request_user_input requires non-empty options for every question",
                );
            }
            let Some(ui) = ctx.ui.clone() else {
                return ToolOutput::err(
                    "request_user_input is unavailable here: no client is connected that can answer",
                );
            };
            // The client adds a free-form "Other" itself, whatever the model listed.
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
            match ui.ask(ctx.call_id, questions).await {
                Some(answers) => match serde_json::to_string(&answers) {
                    Ok(json) => ToolOutput::ok(json),
                    Err(e) => ToolOutput::err(format!("failed to serialize the response: {e}")),
                },
                None => {
                    ToolOutput::err("request_user_input was cancelled before receiving a response")
                }
            }
        })
    }
}
