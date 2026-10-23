// The tool's name, arguments and description follow OpenAI Codex (codex-rs/core/src/tools/
// handlers/plan.rs and plan_spec.rs), Apache-2.0. See NOTICE.md.

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[allow(dead_code)] // parsed to validate the call; the plan itself goes to clients from the call's arguments
struct Args {
    #[serde(default)]
    explanation: Option<String>,
    plan: Vec<Step>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct Step {
    step: String,
    status: Status,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Pending,
    InProgress,
    Completed,
}

/// A checklist the model keeps up to date. The tool only checks the shape and acknowledges;
/// what it is for is the arguments, which the server turns into a `turn/plan/updated`
/// notification and which stay in the transcript.
pub struct UpdatePlanTool;

impl Tool for UpdatePlanTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "update_plan".into(),
            description: "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "explanation": {"type": "string", "description": "Optional explanation for this plan update."},
                    "plan": {
                        "type": "array",
                        "description": "The list of steps",
                        "items": {
                            "type": "object",
                            "properties": {
                                "step": {"type": "string", "description": "Task step text."},
                                "status": {"type": "string", "enum": ["pending", "in_progress", "completed"], "description": "Step status."}
                            },
                            "required": ["step", "status"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["plan"],
                "additionalProperties": false
            }),
        }
    }

    // Each update replaces the one before, so updates must not run side by side.
    fn mutates(&self) -> bool {
        true
    }

    fn call(&self, _: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            match serde_json::from_value::<Args>(arguments) {
                Ok(_) => ToolOutput::ok("Plan updated"),
                Err(e) => ToolOutput::err(format!("failed to parse function arguments: {e}")),
            }
        })
    }
}
