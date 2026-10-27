//! Hooks configured in `hooks.json`: commands the server runs at points in a turn.
//!
//! Two files are read, the user's (`<data dir>/hooks.json`) then the project's
//! (`<cwd>/.fastvibe/hooks.json`), in the shape Claude Code uses:
//!
//! ```json
//! { "hooks": { "PreToolUse": [ { "matcher": "exec_command|apply_patch",
//!     "hooks": [ { "type": "command", "command": "./check.sh", "timeout": 10 } ] } ] } }
//! ```
//!
//! Events: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. A command receives one JSON
//! object on stdin and answers with its exit code and, optionally, JSON on stdout:
//!
//! - exit 2 blocks (stderr is the reason); any other failure is ignored — a broken hook must not
//!   stop the work;
//! - `{"decision":"block","reason":"…"}` blocks the same way;
//! - `{"updatedInput": {…}}` (`PreToolUse`) replaces the tool's arguments;
//! - `{"additionalContext":"…"}` adds text for the model.
//!
//! A `matcher` is `*` (or empty) for everything, or tool names separated by `|`; a name ending
//! in `*` matches by prefix.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::future::BoxFuture;
use fv_agent::{HookToolCall, Hooks, PreToolHook, PromptHook};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

const DEFAULT_TIMEOUT_SECS: u64 = 30;

#[derive(Default, Deserialize)]
struct File {
    #[serde(default)]
    hooks: std::collections::BTreeMap<String, Vec<Rule>>,
}

#[derive(Clone, Deserialize)]
struct Rule {
    #[serde(default)]
    matcher: String,
    #[serde(default)]
    hooks: Vec<Command>,
}

#[derive(Clone, Deserialize)]
struct Command {
    #[serde(default)]
    command: String,
    #[serde(default)]
    timeout: Option<u64>,
}

struct Selected {
    command: Command,
}

pub struct ConfigHooks {
    rules: std::collections::BTreeMap<String, Vec<Rule>>,
    session_id: String,
    cwd: Option<PathBuf>,
}

impl ConfigHooks {
    /// `None` when no file configures anything.
    pub fn load(data_dir: &Path, cwd: Option<&Path>, session_id: &str) -> Option<Self> {
        let mut rules: std::collections::BTreeMap<String, Vec<Rule>> = Default::default();
        let mut paths = vec![data_dir.join("hooks.json")];
        if let Some(cwd) = cwd {
            paths.push(cwd.join(".fastvibe").join("hooks.json"));
        }
        for path in paths {
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            match serde_json::from_str::<File>(&text) {
                Ok(file) => {
                    for (event, mut list) in file.hooks {
                        rules.entry(event).or_default().append(&mut list);
                    }
                }
                Err(e) => eprintln!("ignoring {}: {e}", path.display()),
            }
        }
        rules.retain(|_, list| {
            list.iter()
                .any(|r| r.hooks.iter().any(|c| !c.command.is_empty()))
        });
        (!rules.is_empty()).then(|| Self {
            rules,
            session_id: session_id.into(),
            cwd: cwd.map(Path::to_path_buf),
        })
    }

    fn selected(&self, event: &str, tool: Option<&str>) -> Vec<Selected> {
        self.rules
            .get(event)
            .into_iter()
            .flatten()
            .filter(|rule| tool.is_none_or(|name| matches(&rule.matcher, name)))
            .flat_map(|rule| rule.hooks.iter())
            .filter(|c| !c.command.is_empty())
            .map(|c| Selected { command: c.clone() })
            .collect()
    }

    fn input(&self, event: &str, extra: Value) -> Value {
        let mut base = json!({
            "hook_event_name": event,
            "session_id": self.session_id,
            "cwd": self.cwd.as_ref().map(|p| p.display().to_string()),
        });
        if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        base
    }
}

fn matches(matcher: &str, name: &str) -> bool {
    let matcher = matcher.trim();
    if matcher.is_empty() || matcher == "*" {
        return true;
    }
    matcher
        .split('|')
        .map(str::trim)
        .any(|m| match m.strip_suffix('*') {
            Some(prefix) => name.starts_with(prefix),
            None => m == name,
        })
}

/// What one command said.
#[derive(Default)]
struct Verdict {
    block: Option<String>,
    updated_input: Option<Value>,
    context: Option<String>,
}

async fn run(command: &Command, cwd: Option<&Path>, input: &Value) -> Verdict {
    let mut child = tokio::process::Command::new("sh");
    child
        .arg("-c")
        .arg(&command.command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        child.current_dir(cwd).env("FASTVIBE_PROJECT_DIR", cwd);
    }
    let Ok(mut child) = child.spawn() else {
        return Verdict::default();
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.to_string().as_bytes()).await;
    }
    let wait = Duration::from_secs(command.timeout.unwrap_or(DEFAULT_TIMEOUT_SECS));
    let Ok(Ok(output)) = tokio::time::timeout(wait, child.wait_with_output()).await else {
        return Verdict::default();
    };
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.code() == Some(2) {
        return Verdict {
            block: Some(if stderr.is_empty() {
                "blocked by a hook".into()
            } else {
                stderr
            }),
            ..Default::default()
        };
    }
    if !output.status.success() {
        return Verdict::default();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let Ok(Value::Object(out)) = serde_json::from_str::<Value>(text.trim()) else {
        return Verdict::default();
    };
    let string = |key: &str| out.get(key).and_then(Value::as_str).map(str::to_string);
    Verdict {
        block: (out.get("decision").and_then(Value::as_str) == Some("block"))
            .then(|| string("reason").unwrap_or_else(|| "blocked by a hook".into())),
        updated_input: out.get("updatedInput").filter(|v| v.is_object()).cloned(),
        context: string("additionalContext"),
    }
}

impl Hooks for ConfigHooks {
    fn user_prompt_submit(&self, prompt: &str) -> BoxFuture<'static, PromptHook> {
        let commands = self.selected("UserPromptSubmit", None);
        let input = self.input("UserPromptSubmit", json!({ "prompt": prompt }));
        let cwd = self.cwd.clone();
        Box::pin(async move {
            let mut context = Vec::new();
            for selected in commands {
                let verdict = run(&selected.command, cwd.as_deref(), &input).await;
                if let Some(reason) = verdict.block {
                    return PromptHook::Block(reason);
                }
                context.extend(verdict.context);
            }
            PromptHook::Allow((!context.is_empty()).then(|| context.join("\n")))
        })
    }

    fn pre_tool_use(&self, call: &HookToolCall) -> BoxFuture<'static, PreToolHook> {
        let commands = self.selected("PreToolUse", Some(&call.name));
        let input = self.input(
            "PreToolUse",
            json!({
                "tool_name": call.name,
                "tool_input": call.arguments,
                "tool_use_id": call.call_id,
            }),
        );
        let cwd = self.cwd.clone();
        Box::pin(async move {
            let mut rewritten = None;
            let mut input = input;
            for selected in commands {
                let verdict = run(&selected.command, cwd.as_deref(), &input).await;
                if let Some(reason) = verdict.block {
                    return PreToolHook::Block(reason);
                }
                if let Some(updated) = verdict.updated_input {
                    // The next hook sees the arguments the previous one produced.
                    input["tool_input"] = updated.clone();
                    rewritten = Some(updated);
                }
            }
            rewritten.map_or(PreToolHook::Proceed, PreToolHook::Rewrite)
        })
    }

    fn post_tool_use(
        &self,
        call: &HookToolCall,
        output: &str,
        is_error: bool,
    ) -> BoxFuture<'static, Option<String>> {
        let commands = self.selected("PostToolUse", Some(&call.name));
        let input = self.input(
            "PostToolUse",
            json!({
                "tool_name": call.name,
                "tool_input": call.arguments,
                "tool_response": { "output": output, "is_error": is_error },
                "tool_use_id": call.call_id,
            }),
        );
        let cwd = self.cwd.clone();
        Box::pin(async move {
            let mut notes = Vec::new();
            for selected in commands {
                let verdict = run(&selected.command, cwd.as_deref(), &input).await;
                notes.extend(verdict.block.or(verdict.context));
            }
            (!notes.is_empty()).then(|| notes.join("\n"))
        })
    }

    fn stop(&self) -> BoxFuture<'static, Option<String>> {
        let commands = self.selected("Stop", None);
        let input = self.input("Stop", json!({}));
        let cwd = self.cwd.clone();
        Box::pin(async move {
            for selected in commands {
                if let Some(reason) = run(&selected.command, cwd.as_deref(), &input).await.block {
                    return Some(reason);
                }
            }
            None
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matchers_select_by_name_alternative_and_prefix() {
        assert!(matches("", "exec_command"));
        assert!(matches("*", "anything"));
        assert!(matches("exec_command|apply_patch", "apply_patch"));
        assert!(!matches("exec_command|apply_patch", "view_image"));
        assert!(matches("mcp_*", "mcp_github_search"));
        assert!(!matches("mcp_*", "exec_command"));
    }
}
