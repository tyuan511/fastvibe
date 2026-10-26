use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};

pub struct WriteStdinTool {
    sessions: Arc<crate::ExecSessions>,
}
impl WriteStdinTool {
    pub fn new(sessions: Arc<crate::ExecSessions>) -> Self {
        Self { sessions }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    session_id: u64,
    #[serde(default)]
    chars: String,
    #[serde(default)]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    max_output_tokens: Option<usize>,
}

impl Tool for WriteStdinTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec { name: "write_stdin".into(), description: "Send input to an existing exec_command session, or poll with empty chars. Returns only new output. Ctrl+C (\\u0003) interrupts and Ctrl+D (\\u0004) sends EOF, including pipe sessions. Session ids belong to this conversation.".into(),
            schema: json!({"type":"object","properties":{
                "session_id":{"type":"integer","description":"Session id returned by exec_command."},
                "chars":{"type":"string","description":"Input to send; omit or use an empty string to poll."},
                "yield_time_ms":{"type":"number","description":"Wait before yielding. Input waits default to 250ms (250–30000); empty polls wait 5000–300000ms, or until exit."},
                "max_output_tokens":{"type":"number","description":"Output token budget; defaults to 10000."}
            },"required":["session_id"],"additionalProperties":false}) }
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        let sessions = self.sessions.clone();
        Box::pin(async move {
            let args: Args = match serde_json::from_value(arguments) {
                Ok(args) => args,
                Err(error) => {
                    return ToolOutput::err(format!("failed to parse arguments: {error}"));
                }
            };
            let wait = if args.chars.is_empty() {
                args.yield_time_ms.unwrap_or(5_000).clamp(5_000, 300_000)
            } else {
                args.yield_time_ms.unwrap_or(250).clamp(250, 30_000)
            };
            sessions
                .interact(
                    ctx,
                    args.session_id,
                    args.chars,
                    Duration::from_millis(wait),
                    args.max_output_tokens.unwrap_or(10_000).clamp(1, 50_000) * 4,
                )
                .await
        })
    }
}
