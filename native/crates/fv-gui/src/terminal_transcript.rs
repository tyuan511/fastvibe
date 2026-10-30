//! A render-only projection: terminal interactions update the command that owns the session.
//! The engine transcript stays intact, including every tool call and its original result.

use std::collections::HashMap;

use fv_protocol::types::{Item, Turn};
use serde_json::{Value, json};

use crate::presentation;

const META: &str = "_fastvibe_terminal";

#[derive(Clone, Copy)]
enum State {
    Running,
    Waiting,
    Sending,
    Interrupting,
    Exited(i32),
    Finished,
    Failed,
    Stopped,
    TimedOut,
}

impl State {
    fn key(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Sending => "sending",
            Self::Interrupting => "interrupting",
            Self::Exited(_) | Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
            Self::TimedOut => "timed_out",
        }
    }

    fn active(self) -> bool {
        matches!(
            self,
            Self::Running | Self::Waiting | Self::Sending | Self::Interrupting
        )
    }
}

struct Report<'a> {
    session: Option<u64>,
    state: State,
    body: &'a str,
}

/// Read only the native tool's envelope, never status-looking lines in stdout.
fn report(output: &str) -> Option<Report<'_>> {
    let (header, body) = output.split_once("\nOutput:\n")?;
    let mut lines = header.lines();
    lines
        .next()?
        .strip_prefix("Wall time: ")?
        .strip_suffix(" seconds")?
        .parse::<f64>()
        .ok()?;
    let status = lines.next()?;
    let (session, state) = if let Some(id) = status.strip_prefix("Process running with session ID ")
    {
        let session = id.parse().ok()?;
        lines
            .next()?
            .strip_prefix("Process ID: ")?
            .parse::<u32>()
            .ok()?;
        (Some(session), State::Running)
    } else if let Some(code) = status.strip_prefix("Process exited with code ") {
        (None, State::Exited(code.parse().ok()?))
    } else {
        (
            None,
            match status {
                "Command timed out and was killed" => State::TimedOut,
                "Command was stopped and killed" => State::Stopped,
                s if s.starts_with("Command failed: ") => State::Failed,
                _ => return None,
            },
        )
    };
    if lines.next().is_some() {
        return None;
    }
    Some(Report {
        session,
        state,
        body: if matches!(state, State::Failed) && body.is_empty() {
            status
        } else {
            body
        },
    })
}

struct Command {
    item: Item,
    output: String,
    state: State,
    failed: bool,
    continued: bool,
}

impl Command {
    fn collect(&mut self, output: Option<&str>, failed: bool, input: &str) -> Option<u64> {
        let Some(output) = output else {
            self.state = match input {
                "" => State::Waiting,
                "\u{3}" => State::Interrupting,
                _ => State::Sending,
            };
            return None;
        };
        self.failed |= failed;
        let (session, state, body) = match report(output) {
            Some(r) => (r.session, r.state, r.body),
            None => (
                None,
                if failed {
                    State::Failed
                } else {
                    State::Finished
                },
                output,
            ),
        };
        self.state = if failed && state.active() {
            State::Failed
        } else {
            state
        };
        // Results contain only newly collected bytes. Do not insert a newline between chunks:
        // a process can return the beginning of a line in one call and its tail in the next.
        self.output.push_str(body);
        session
    }

    fn finish(mut self) -> Item {
        if let Item::ToolCall {
            arguments,
            output,
            is_error,
            ..
        } = &mut self.item
        {
            if !arguments.is_object() {
                *arguments = json!({"cmd": arguments.as_str().unwrap_or_default()});
            }
            arguments[META] = json!({
                "state": self.state.key(),
                "active": self.state.active(),
                "exit_code": match self.state { State::Exited(code) => Some(code), _ => None },
            });
            // A continuation must expose the newest output even when the combined session
            // exceeds the panel's text budget. The original tool results remain untouched.
            *output = Some(if self.continued {
                recent_output(&self.output)
            } else {
                self.output
            });
            *is_error = self.failed;
        }
        self.item
    }
}

/// Built once per conversation/frame, so session ids never associate across conversations.
/// Walking in transcript order also handles a reused id after a server restart.
pub(crate) fn project(turns: &[Turn], english: bool) -> HashMap<String, Item> {
    let mut commands: Vec<Command> = Vec::new();
    let mut sessions: HashMap<u64, usize> = HashMap::new();
    let mut projected = HashMap::new();
    for item in turns.iter().flat_map(|turn| &turn.items) {
        let Item::ToolCall {
            id,
            name,
            arguments,
            output,
            is_error,
        } = item
        else {
            continue;
        };
        if name == "write_stdin" {
            let session = arguments.get("session_id").and_then(Value::as_u64);
            let index = session
                .and_then(|id| sessions.get(&id).copied())
                .unwrap_or_else(|| {
                    // An older command can be absent from a partial/imported history. Keep its
                    // output in one session card rather than silently hiding it.
                    let index = commands.len();
                    let command = match session {
                        Some(session) => {
                            tr!(english, "transcript.terminal_session", session = session)
                        }
                        None => trs!(english, "transcript.terminal_interaction").to_string(),
                    };
                    commands.push(Command {
                        item: Item::ToolCall {
                            id: id.clone(),
                            name: "exec_command".into(),
                            arguments: json!({"cmd": command}),
                            output: None,
                            is_error: false,
                        },
                        output: String::new(),
                        state: State::Running,
                        failed: false,
                        continued: true,
                    });
                    if let Some(session) = session {
                        sessions.insert(session, index);
                    }
                    index
                });
            let input = arguments
                .get("chars")
                .and_then(Value::as_str)
                .unwrap_or_default();
            commands[index].continued = true;
            let _ = commands[index].collect(output.as_deref(), *is_error, input);
            if let Item::ToolCall { id: owner, .. } = &commands[index].item {
                if owner != id {
                    let mut hidden = item.clone();
                    if let Item::ToolCall { arguments, .. } = &mut hidden {
                        arguments[META] = json!({"hidden": true});
                    }
                    projected.insert(id.clone(), hidden);
                }
            }
        } else if presentation::family_of(name) == presentation::Family::Terminal {
            let index = commands.len();
            let mut command = Command {
                item: item.clone(),
                output: String::new(),
                state: State::Running,
                failed: false,
                continued: false,
            };
            if output.is_some() {
                if let Some(session) = command.collect(output.as_deref(), *is_error, "") {
                    sessions.insert(session, index);
                }
            }
            commands.push(command);
        }
    }
    for command in commands {
        let item = command.finish();
        if let Item::ToolCall { id, .. } = &item {
            projected.insert(id.clone(), item);
        }
    }
    projected
}

fn recent_output(output: &str) -> String {
    if output.encode_utf16().count() <= 4000 {
        return output.to_string();
    }
    let mut units = 0;
    let mut start = output.len();
    for (index, ch) in output.char_indices().rev() {
        units += ch.len_utf16();
        if units > 3998 {
            break;
        }
        start = index;
    }
    format!("…\n{}", &output[start..])
}

pub(crate) fn hidden(item: &Item) -> bool {
    matches!(item, Item::ToolCall { arguments, .. } if arguments[META]["hidden"].as_bool() == Some(true))
}

pub(crate) fn running(arguments: &Value, output: Option<&str>) -> bool {
    arguments[META]["active"]
        .as_bool()
        .unwrap_or(output.is_none())
}

pub(crate) fn active(item: &Item) -> bool {
    matches!(item, Item::ToolCall { arguments, .. } if arguments[META]["active"].as_bool() == Some(true))
}

pub(crate) fn status(arguments: &Value, english: bool) -> Option<String> {
    let meta = &arguments[META];
    let key = match meta["state"].as_str()? {
        "running" => "transcript.terminal_running",
        "waiting" => "transcript.waiting_for_output",
        "sending" => "transcript.terminal_sending",
        "interrupting" => "transcript.terminal_interrupting",
        "finished" => {
            return Some(match meta["exit_code"].as_i64() {
                Some(code) => tr!(english, "transcript.terminal_exited", code = code),
                None => trs!(english, "transcript.completed").to_string(),
            });
        }
        "failed" => "transcript.execution_failed",
        "stopped" => "transcript.interrupted",
        "timed_out" => "transcript.terminal_timed_out",
        _ => return None,
    };
    Some(crate::workspace::static_text(english, key).to_string())
}
