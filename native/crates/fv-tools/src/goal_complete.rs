use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use serde_json::{Value, json};

/// How the model says the conversation's goal is done. The tool only acknowledges: the server
/// sees the call in the transcript and stops starting further rounds. It is offered to the model
/// only while the thread has a running goal.
pub struct GoalCompleteTool;

pub const NAME: &str = "goal_complete";

impl Tool for GoalCompleteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: NAME.into(),
            description: "Declare that the conversation's long-term goal is fully achieved. Call it only after checking the work against the goal; no further rounds are started afterwards. Do not call it while any part of the goal remains.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "What was achieved, in a sentence or two."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn call(&self, _: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async { ToolOutput::ok("Goal marked complete.") })
    }
}
