// Adapted from OpenAI Codex (codex-rs/core/src/tools/handlers/shell_spec.rs `exec_command`
// and core/src/exec.rs), Apache-2.0. See NOTICE.md.
//
// `exec_command` / `write_stdin` share a conversation-owned session pool. See
// exec_sessions for PTY, bounded output, turn cancellation and process-group cleanup.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use fv_agent::{
    ApprovalKind, ApprovalPolicy, ApprovalRequest, Decision, Permissions, Policy, Tool, ToolCtx,
    ToolOutput, ToolSpec,
};
use fv_sandbox::{is_known_safe, looks_denied};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::paths::resolve;

const MAX_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_OUTPUT_TOKENS: usize = 10_000;
const MAX_OUTPUT_TOKENS: usize = 50_000;

type Ran = crate::exec_sessions::Report;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    cmd: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    tty: bool,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default = "default_login")]
    login: bool,
    #[serde(default)]
    max_output_tokens: Option<usize>,
    /// `require_escalated` asks to run outside the sandbox; the user is asked first.
    #[serde(default)]
    sandbox_permissions: Option<String>,
    /// Why it has to run outside the sandbox: what the user is shown when asked.
    #[serde(default)]
    justification: Option<String>,
}

fn default_login() -> bool {
    true
}

pub struct ExecCommandTool {
    sessions: Arc<crate::ExecSessions>,
}

impl Default for ExecCommandTool {
    fn default() -> Self {
        Self::new(Arc::new(crate::ExecSessions::default()))
    }
}
impl ExecCommandTool {
    pub fn new(sessions: Arc<crate::ExecSessions>) -> Self {
        Self { sessions }
    }
}

impl Tool for ExecCommandTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "exec_command".into(),
            description: "Runs a shell command. Commands still running after yield_time_ms return a session_id for write_stdin; keep the command in the foreground rather than using shell &. Set tty for a real terminal. An explicit timeout_ms waits for completion and kills the command at that deadline.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "cmd": {"type": "string", "description": "Shell command to execute."},
                    "workdir": {"type": "string", "description": "Working directory for the command. Defaults to the conversation's working directory."},
                    "timeout_ms": {"type": "number", "description": "Completion-only call: wait until the command finishes, or kill it after this many milliseconds (at most 600000). Omit to allow a background session."},
                    "yield_time_ms": {"type":"number", "description":"Wait before yielding a running session. Defaults to 10000; clamped to 250–30000 milliseconds."},
                    "tty": {"type":"boolean", "description":"Allocate a real PTY for interactive programs and terminal control. Defaults to false (pipes)."},
                    "shell": {"type": "string", "description": "Shell binary to launch. Defaults to the user's default shell."},
                    "login": {"type": "boolean", "description": "True runs the shell as a login shell (-l); false does not. Defaults to true."},
                    "max_output_tokens": {"type": "number", "description": "Output token budget. Defaults to 10000 tokens."},
                    "sandbox_permissions": {"type": "string", "enum": ["use_default", "require_escalated"], "description": "Commands run in a sandbox that stops them writing outside the working folders and using the network. Use `require_escalated` to run this one without it; the user is asked first. Only use it for a command that failed because of the sandbox, or that surely needs to leave it."},
                    "justification": {"type": "string", "description": "With `require_escalated`: a short question for the user explaining why the command has to run outside the sandbox."}
                },
                "required": ["cmd"],
                "additionalProperties": false
            }),
        }
    }

    // A command can do anything, so it never runs beside another tool.
    fn mutates(&self) -> bool {
        true
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        let sessions = self.sessions.clone();
        Box::pin(async move {
            let args: Args = match serde_json::from_value(arguments) {
                Ok(a) => a,
                Err(e) => return ToolOutput::err(format!("failed to parse arguments: {e}")),
            };
            if args.cmd.trim().is_empty() {
                return ToolOutput::err("cmd must not be empty");
            }
            let workdir = match args.workdir.as_deref() {
                Some(w) => match resolve(ctx.cwd.as_deref(), w) {
                    Ok(p) => Some(p),
                    Err(e) => return ToolOutput::err(e),
                },
                None => ctx.cwd.clone(),
            };
            if args
                .sandbox_permissions
                .as_deref()
                .is_some_and(|value| !matches!(value, "use_default" | "require_escalated"))
            {
                return ToolOutput::err("invalid sandbox_permissions");
            }
            let timeout = args
                .timeout_ms
                .map(|ms| Duration::from_millis(ms.clamp(1, MAX_TIMEOUT_MS)));
            let budget = args
                .max_output_tokens
                .unwrap_or(DEFAULT_OUTPUT_TOKENS)
                .clamp(1, MAX_OUTPUT_TOKENS)
                * 4;
            let shell = args
                .shell
                .unwrap_or_else(|| fv_env::user_shell().to_string_lossy().into_owned());
            let request = Request {
                call_id: ctx.call_id.clone(),
                shell,
                login: args.login,
                cmd: args.cmd,
                workdir,
                timeout,
                yield_time: Duration::from_millis(
                    args.yield_time_ms.unwrap_or(10_000).clamp(250, 30_000),
                ),
                tty: args.tty,
                requested_policy: ctx
                    .permissions
                    .as_ref()
                    .map(|permissions| permissions.policy.clone()),
                budget,
                escalate: args.sandbox_permissions.as_deref() == Some("require_escalated"),
                justification: args.justification,
            };
            execute(ctx.permissions.clone(), request, sessions, ctx.cancel).await
        })
    }
}

struct Request {
    call_id: String,
    shell: String,
    login: bool,
    cmd: String,
    workdir: Option<PathBuf>,
    timeout: Option<Duration>,
    yield_time: Duration,
    tty: bool,
    requested_policy: Option<Policy>,
    budget: usize,
    escalate: bool,
    justification: Option<String>,
}

/// Run a command under the turn's permissions: in the sandbox, asking the user when the policy
/// says to, and again outside the sandbox when it was in the way and the policy allows asking.
async fn execute(
    permissions: Option<Arc<Permissions>>,
    request: Request,
    sessions: Arc<crate::ExecSessions>,
    cancel: tokio_util::sync::CancellationToken,
) -> ToolOutput {
    let Some(perms) = permissions else {
        return run(&request, None, &sessions, cancel.clone()).await.output;
    };
    let sandboxed = perms.policy.sandboxed();
    let mut outside = !sandboxed;
    let ask = |reason: String| {
        perms.ask(ApprovalRequest {
            call_id: request.call_id.clone(),
            kind: ApprovalKind::Command {
                command: request.cmd.clone(),
                cwd: request.workdir.as_ref().map(|d| d.display().to_string()),
            },
            reason: Some(reason),
        })
    };

    if request.escalate && sandboxed {
        if perms.approval == ApprovalPolicy::Never {
            return ToolOutput::err(
                "This command cannot leave the sandbox: approvals are switched off (approval policy `never`).",
            );
        }
        let reason = request
            .justification
            .clone()
            .unwrap_or_else(|| "The command asks to run outside the sandbox.".into());
        if ask(reason).await == Decision::Denied {
            return ToolOutput::err(
                "The user did not allow this command to run outside the sandbox.",
            );
        }
        outside = true;
    } else if perms.approval == ApprovalPolicy::Untrusted
        && !is_known_safe(&request.cmd)
        && ask("This command is not known to be read-only.".into()).await == Decision::Denied
    {
        return ToolOutput::err("The user did not allow this command to run.");
    }

    let first = run(
        &request,
        (!outside).then_some(&perms.policy),
        &sessions,
        cancel.clone(),
    )
    .await;
    if first.running || outside || !looks_denied(first.code, &first.text) {
        return first.output;
    }
    // The sandbox was in the way.
    match perms.approval {
        ApprovalPolicy::OnFailure => {
            let reason =
                "The command failed in the sandbox. Run it again without the sandbox?".to_string();
            if ask(reason).await == Decision::Denied {
                return first.output;
            }
            run(&request, None, &sessions, cancel.clone()).await.output
        }
        ApprovalPolicy::OnRequest => note(
            first.output,
            "The sandbox may have blocked this command. If it has to run outside it, call exec_command again with sandbox_permissions=\"require_escalated\" and a justification; the user will be asked.",
        ),
        ApprovalPolicy::Untrusted | ApprovalPolicy::Never => note(
            first.output,
            "The sandbox may have blocked this command, and asking is not available under the current approval policy.",
        ),
    }
}

fn note(mut out: ToolOutput, text: &str) -> ToolOutput {
    out.content.push_str("\n\n");
    out.content.push_str(text);
    out
}

async fn run(
    request: &Request,
    policy: Option<&Policy>,
    sessions: &Arc<crate::ExecSessions>,
    cancel: tokio_util::sync::CancellationToken,
) -> Ran {
    let shell_args = vec![
        if request.login { "-lc" } else { "-c" }.to_string(),
        request.cmd.clone(),
    ];
    let (program, args) = match policy {
        Some(policy) => match fv_sandbox::wrap(policy, &request.shell, &shell_args) {
            Ok(Some(wrapped)) => (wrapped.program, wrapped.args),
            Ok(None) => (request.shell.clone(), shell_args),
            Err(error) => return Ran::failed(error),
        },
        None => (request.shell.clone(), shell_args),
    };
    // An explicit timeout is a completion-only call, matching unified-exec. Otherwise the
    // process is returned to the conversation after its yield interval and has no hard deadline.
    let wait = request
        .timeout
        .map(|timeout| timeout + Duration::from_secs(4))
        .unwrap_or(request.yield_time);
    sessions
        .launch(
            crate::exec_sessions::Launch {
                program,
                args,
                cwd: request.workdir.clone(),
                tty: request.tty,
                timeout: request.timeout,
                requested_policy: request.requested_policy.clone(),
                effective_policy: policy.cloned(),
            },
            cancel,
            wait,
            request.budget,
        )
        .await
}
