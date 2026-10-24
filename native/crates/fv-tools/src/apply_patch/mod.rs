//! `apply_patch`: codex's patch format and parser, so a model that has been taught the format
//! writes it correctly, with one difference in how a patch is applied: every file is worked
//! out in memory first and nothing is written unless the whole patch applies. A patch that
//! fails half-way in codex leaves half of it on disk.

mod parser;
mod plan;
mod seek_sequence;

use futures_util::future::BoxFuture;
use fv_agent::{
    ApprovalKind, ApprovalPolicy, ApprovalRequest, Decision, Tool, ToolCtx, ToolOutput, ToolSpec,
};
use serde_json::{Value, json};

pub(crate) use parser::Hunk;

/// The raw patch text and the hunks parsed from it.
#[derive(Debug, PartialEq)]
pub(crate) struct ApplyPatchArgs {
    pub patch: String,
    pub hunks: Vec<Hunk>,
    pub workdir: Option<String>,
}

const INSTRUCTIONS: &str = include_str!("instructions.md");

fn description() -> String {
    // Codex teaches this format for a shell command; here it is a tool with one argument.
    INSTRUCTIONS
        .replace("Use the `apply_patch` shell command to edit files.", "Use the `apply_patch` tool to edit files.")
        .replace(
            "You can invoke apply_patch like:\n\n```\nshell {\"command\":[\"apply_patch\",\"*** Begin Patch\\n*** Add File: hello.txt\\n+Hello, world!\\n*** End Patch\\n\"]}\n```\n",
            "You invoke apply_patch with the whole patch as `input`:\n\n```\napply_patch {\"input\":\"*** Begin Patch\\n*** Add File: hello.txt\\n+Hello, world!\\n*** End Patch\\n\"}\n```\n\nThe patch is applied all together: if any part of it cannot be applied, nothing is changed. To replace a whole file, delete it and add it again in the same patch. Paths may also be absolute.\n",
        )
}

pub struct ApplyPatchTool;

impl Tool for ApplyPatchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "apply_patch".into(),
            description: description(),
            schema: json!({
                "type": "object",
                "properties": {
                    "input": {"type": "string", "description": "The entire contents of the apply_patch command, from `*** Begin Patch` to `*** End Patch`."}
                },
                "required": ["input"],
                "additionalProperties": false
            }),
        }
    }

    fn mutates(&self) -> bool {
        true
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            // Some models send the patch itself instead of wrapping it.
            let patch = match &arguments {
                Value::String(s) => s.clone(),
                other => match other.get("input").and_then(Value::as_str) {
                    Some(s) => s.to_string(),
                    None => {
                        return ToolOutput::err(
                            "apply_patch needs an `input` string holding the patch",
                        );
                    }
                },
            };
            let args = match parser::parse_patch(&patch) {
                Ok(a) => a,
                Err(e) => return ToolOutput::err(format!("apply_patch verification failed: {e}")),
            };
            // File work is blocking and a patch can touch many files.
            let cwd = ctx.cwd.clone();
            let permissions = ctx.permissions.clone();
            let call_id = ctx.call_id.clone();
            let applied =
                tokio::task::spawn_blocking(move || plan::plan(&args.hunks, cwd.as_deref())).await;
            let planned = match applied {
                Ok(Ok(planned)) => planned,
                Ok(Err(e)) => return ToolOutput::err(e),
                Err(e) => return ToolOutput::err(format!("apply_patch failed: {e}")),
            };
            // A patch writes files itself, outside any sandbox, so the sandbox's rule is
            // checked here: what a command could not write, a patch may not either, unless the
            // user says so.
            if let Some(perms) = permissions {
                let paths = planned.paths();
                let blocked: Vec<String> = paths
                    .iter()
                    .filter(|p| !perms.policy.can_write(p))
                    .map(|p| p.display().to_string())
                    .collect();
                let ask_for = if perms.approval == ApprovalPolicy::Untrusted {
                    paths.iter().map(|p| p.display().to_string()).collect()
                } else {
                    blocked.clone()
                };
                if !ask_for.is_empty() {
                    if perms.approval == ApprovalPolicy::Never {
                        return ToolOutput::err(format!(
                            "The sandbox does not allow writing {}. Nothing was changed.",
                            blocked.join(", ")
                        ));
                    }
                    let reason = if blocked.is_empty() {
                        None
                    } else {
                        Some("The patch writes outside the folders the sandbox allows.".to_string())
                    };
                    let asked = perms
                        .ask(ApprovalRequest {
                            call_id,
                            kind: ApprovalKind::Patch { files: ask_for },
                            reason,
                        })
                        .await;
                    if asked == Decision::Denied {
                        return ToolOutput::err(
                            "The user did not allow this patch. Nothing was changed.",
                        );
                    }
                }
            }
            let applied = tokio::task::spawn_blocking(move || planned.apply()).await;
            match applied {
                Ok(Ok(summary)) => ToolOutput::ok(summary),
                Ok(Err(e)) => ToolOutput::err(e),
                Err(e) => ToolOutput::err(format!("apply_patch failed: {e}")),
            }
        })
    }
}
