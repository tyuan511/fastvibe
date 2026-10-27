use std::sync::Arc;

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::exec_sessions::ExecSessions;

#[derive(Deserialize)]
struct Args {
    action: String,
    #[serde(default)]
    session_id: Option<u64>,
}

/// Lists this conversation's command sessions and stops one, so a server or watcher the model
/// started earlier is never out of reach once its session id has scrolled out of attention.
pub struct ManageSessionsTool {
    sessions: Arc<ExecSessions>,
}

impl ManageSessionsTool {
    pub fn new(sessions: Arc<ExecSessions>) -> Self {
        Self { sessions }
    }
}

impl Tool for ManageSessionsTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "manage_exec_sessions".into(),
            description: "List the command sessions started with exec_command in this conversation (`action: \"list\"`), or stop one (`action: \"kill\"` with its `session_id`).".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "kill"]},
                    "session_id": {"type": "integer", "description": "The session to stop; required for kill."}
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    fn mutates(&self) -> bool {
        true
    }

    fn call(&self, _: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        let sessions = self.sessions.clone();
        Box::pin(async move {
            let args: Args = match serde_json::from_value(arguments) {
                Ok(args) => args,
                Err(e) => {
                    return ToolOutput::err(format!("failed to parse function arguments: {e}"));
                }
            };
            match args.action.as_str() {
                "list" => {
                    let rows = sessions.list();
                    if rows.is_empty() {
                        return ToolOutput::ok("No command sessions.");
                    }
                    let lines: Vec<String> = rows
                        .into_iter()
                        .map(|(id, pid, cwd, running)| {
                            format!(
                                "session {id}: pid {pid}, {}{}",
                                if running { "running" } else { "finished" },
                                cwd.map(|c| format!(", cwd {}", c.display()))
                                    .unwrap_or_default()
                            )
                        })
                        .collect();
                    ToolOutput::ok(lines.join("\n"))
                }
                "kill" => match args.session_id {
                    Some(id) if sessions.kill(id) => {
                        ToolOutput::ok(format!("Stopped session {id}."))
                    }
                    Some(id) => ToolOutput::err(format!("No session {id}.")),
                    None => ToolOutput::err("kill needs a session_id."),
                },
                other => ToolOutput::err(format!("unknown action `{other}`")),
            }
        })
    }
}
