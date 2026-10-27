use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};

/// How much of the context window is left, so the model can plan around it instead of being
/// surprised by an automatic compaction.
pub struct GetContextRemainingTool;

impl Tool for GetContextRemainingTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "get_context_remaining".into(),
            description:
                "Reports how many tokens of the context window are used and how many remain.".into(),
            schema: json!({"type": "object", "properties": {}, "additionalProperties": false}),
        }
    }

    fn call(&self, ctx: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            match ctx.context {
                Some((used, window)) if window > 0 => {
                    let left = window.saturating_sub(used);
                    ToolOutput::ok(format!(
                        "Context window: {used} of {window} tokens used ({}%), {left} remaining.",
                        used * 100 / window
                    ))
                }
                _ => ToolOutput::err("The context window size is not known for this model."),
            }
        })
    }
}

#[derive(Deserialize)]
struct NewWindowArgs {
    summary: String,
}

/// Start over with a fresh context window carrying only a summary the model wrote. Cheaper than
/// an automatic compaction when the model already knows what matters.
pub struct NewContextWindowTool;

impl Tool for NewContextWindowTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: fv_agent::NEW_CONTEXT_WINDOW_TOOL.into(),
            description: "Start a new context window. Everything said and done so far is dropped from what you see; only your user's messages and the `summary` you write here carry over. Write the summary so you can continue without anything else: the goal, what is done, what is left, file paths and decisions. Use it when the window is nearly full and you know what matters.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "A self-contained handoff for your next context window."}
                },
                "required": ["summary"],
                "additionalProperties": false
            }),
        }
    }

    fn mutates(&self) -> bool {
        true
    }

    fn call(&self, _: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            match serde_json::from_value::<NewWindowArgs>(arguments) {
                Ok(a) if !a.summary.trim().is_empty() => {
                    ToolOutput::ok("A new context window starts now; continue from your summary.")
                }
                Ok(_) => ToolOutput::err("summary must not be empty"),
                Err(e) => ToolOutput::err(format!("failed to parse function arguments: {e}")),
            }
        })
    }
}
