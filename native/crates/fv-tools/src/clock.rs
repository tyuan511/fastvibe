use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};

/// The local date, time and zone as one line, for the model's context and `current_time`.
pub fn now_text() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S %:z (%A)")
        .to_string()
}

/// Today's local date and zone, without the time of day: it leads every request, and a value that
/// moved by the second would end the provider's cached prefix at the first message.
pub fn today_text() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d (%A) UTC%:z")
        .to_string()
}

/// The current local date and time. A model has no clock of its own.
pub struct CurrentTimeTool;

impl Tool for CurrentTimeTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "current_time".into(),
            description: "Returns the user's current local date, time and UTC offset.".into(),
            schema: json!({"type": "object", "properties": {}, "additionalProperties": false}),
        }
    }

    fn call(&self, _: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async { ToolOutput::ok(now_text()) })
    }
}

const MAX_SLEEP_SECONDS: f64 = 300.0;

#[derive(Deserialize)]
struct SleepArgs {
    seconds: f64,
}

/// Waits without holding a command session open; ends early if the user stops the turn.
pub struct SleepTool;

impl Tool for SleepTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "sleep".into(),
            description: "Wait for a number of seconds (at most 300) before continuing, for example to let a build or a deployment settle.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "seconds": {"type": "number", "description": "How long to wait, up to 300."}
                },
                "required": ["seconds"],
                "additionalProperties": false
            }),
        }
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            let seconds = match serde_json::from_value::<SleepArgs>(arguments) {
                Ok(a) if a.seconds.is_finite() && a.seconds >= 0.0 => {
                    a.seconds.min(MAX_SLEEP_SECONDS)
                }
                Ok(_) => return ToolOutput::err("seconds must be a non-negative number"),
                Err(e) => {
                    return ToolOutput::err(format!("failed to parse function arguments: {e}"));
                }
            };
            tokio::select! {
                _ = ctx.cancel.cancelled() => ToolOutput::ok("Interrupted."),
                _ = tokio::time::sleep(std::time::Duration::from_secs_f64(seconds)) => {
                    ToolOutput::ok(format!("Waited {seconds} seconds."))
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn sleep_ends_early_when_the_turn_is_stopped() {
        let cancel = CancellationToken::new();
        let ctx = ToolCtx::new(cancel.clone(), None);
        cancel.cancel();
        let started = std::time::Instant::now();
        let out = SleepTool.call(ctx, json!({"seconds": 60})).await;
        assert!(started.elapsed().as_secs() < 5);
        assert!(!out.is_error);
    }

    #[tokio::test]
    async fn sleep_rejects_a_negative_wait() {
        let ctx = ToolCtx::new(CancellationToken::new(), None);
        assert!(SleepTool.call(ctx, json!({"seconds": -1})).await.is_error);
    }
}
