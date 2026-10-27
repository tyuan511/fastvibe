use base64::Engine;
use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use fv_core::{ImagePart, ImageSource, Question, QuestionOption};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Args {
    Screenshot,
    Click { x: i32, y: i32 },
    Type { text: String },
    Key { key: String },
}

pub struct ComputerTool;

impl Tool for ComputerTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "computer".into(),
            description: "Inspect or control the user's macOS desktop. Screenshot is read-only; click, type and key require explicit approval and Accessibility permission.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type":"string", "enum":["screenshot","click","type","key"]},
                    "x": {"type":"integer", "minimum":0, "maximum":20000},
                    "y": {"type":"integer", "minimum":0, "maximum":20000},
                    "text": {"type":"string", "maxLength":4096},
                    "key": {"type":"string", "enum":["return","escape","tab","delete","up","down","left","right"]}
                },
                "required":["action"],
                "additionalProperties":false
            }),
        }
    }

    fn mutates(&self) -> bool {
        true
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            let args: Args = match serde_json::from_value(arguments) {
                Ok(args) => args,
                Err(error) => {
                    return ToolOutput::err(format!("failed to parse computer action: {error}"));
                }
            };
            match args {
                Args::Screenshot => screenshot(ctx).await,
                action => {
                    if !approved(&ctx, &action).await {
                        return ToolOutput::err("computer action was not approved");
                    }
                    perform(action).await
                }
            }
        })
    }
}

async fn approved(ctx: &ToolCtx, action: &Args) -> bool {
    let Some(ui) = ctx.ui.clone() else {
        return false;
    };
    let description = match action {
        Args::Click { x, y } => format!("点击屏幕坐标 ({x}, {y})"),
        Args::Type { text } => format!("输入 {} 个字符", text.chars().count()),
        Args::Key { key } => format!("按键 {key}"),
        Args::Screenshot => return true,
    };
    let questions = vec![Question {
        id: "computer_action".into(),
        header: "电脑操控".into(),
        question: format!("允许电脑操控执行：{description}？"),
        options: vec![
            QuestionOption {
                label: "允许一次".into(),
                description: "只执行这一个动作。".into(),
            },
            QuestionOption {
                label: "拒绝".into(),
                description: "不执行该动作。".into(),
            },
        ],
        is_other: false,
    }];
    ui.ask(ctx.call_id.clone(), questions)
        .await
        .and_then(|answers| answers.answers.get("computer_action").cloned())
        .is_some_and(|answers| {
            answers
                .answers
                .first()
                .is_some_and(|answer| answer == "允许一次")
        })
}

async fn screenshot(ctx: ToolCtx) -> ToolOutput {
    if !ctx.vision {
        return ToolOutput::err("computer screenshot requires image input support");
    }
    #[cfg(not(target_os = "macos"))]
    {
        return ToolOutput::err("computer control is currently supported on macOS only");
    }
    #[cfg(target_os = "macos")]
    {
        let output = tokio::process::Command::new("screencapture")
            .args(["-x", "-t", "png", "-"])
            .output()
            .await;
        match output {
            Ok(output) if output.status.success() && !output.stdout.is_empty() => {
                let data = base64::engine::general_purpose::STANDARD.encode(output.stdout);
                ToolOutput::ok("Desktop screenshot captured.").with_images(vec![ImagePart {
                    mime: "image/png".into(),
                    source: ImageSource::Base64 { data },
                }])
            }
            Ok(output) => ToolOutput::err(format!(
                "unable to capture the desktop: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(error) => ToolOutput::err(format!("unable to start screencapture: {error}")),
        }
    }
}

async fn perform(action: Args) -> ToolOutput {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = action;
        return ToolOutput::err("computer control is currently supported on macOS only");
    }
    #[cfg(target_os = "macos")]
    {
        let script = match action {
            Args::Click { x, y } => {
                format!("tell application \"System Events\" to click at {{{x}, {y}}}")
            }
            Args::Type { text } => format!(
                "tell application \"System Events\" to keystroke {}",
                apple_string(&text)
            ),
            Args::Key { key } => {
                let code = match key.as_str() {
                    "return" => 36,
                    "escape" => 53,
                    "tab" => 48,
                    "delete" => 51,
                    "up" => 126,
                    "down" => 125,
                    "left" => 123,
                    "right" => 124,
                    _ => return ToolOutput::err("unsupported macOS key"),
                };
                format!("tell application \"System Events\" to key code {code}")
            }
            Args::Screenshot => return ToolOutput::err("screenshot is read-only"),
        };
        match tokio::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .await
        {
            Ok(output) if output.status.success() => ToolOutput::ok("Computer action completed."),
            Ok(output) => ToolOutput::err(format!(
                "computer action failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(error) => ToolOutput::err(format!("unable to start osascript: {error}")),
        }
    }
}

#[cfg(target_os = "macos")]
fn apple_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_explicit_about_actions_and_bounds() {
        let value = ComputerTool.spec().schema;
        assert_eq!(value["properties"]["action"]["enum"][0], "screenshot");
        assert_eq!(value["properties"]["text"]["maxLength"], 4096);
    }
}
