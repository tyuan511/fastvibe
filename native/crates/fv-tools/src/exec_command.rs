// Adapted from OpenAI Codex (codex-rs/core/src/tools/handlers/shell_spec.rs `exec_command`
// and core/src/exec.rs), Apache-2.0. See NOTICE.md.
//
// Argument names follow codex's `exec_command`. The difference that matters: a command here
// runs to completion (or its timeout). Codex returns a session id for a command still
// running after `yield_time_ms` and lets the model poll it with `write_stdin`; that needs
// the pty work and comes with the terminal.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::paths::resolve;
use crate::truncate::truncate_middle;

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
/// Tokens are counted at four bytes each, as codex does.
const DEFAULT_OUTPUT_TOKENS: usize = 10_000;
const MAX_OUTPUT_TOKENS: usize = 50_000;
/// What is kept in memory however much the command prints.
const KEEP_HEAD_BYTES: usize = 2 * 1024 * 1024;
const KEEP_TAIL_BYTES: usize = 2 * 1024 * 1024;
/// How long output is still collected after the command has exited: a background process it
/// started may hold the pipes open for ever.
const DRAIN_GRACE: Duration = Duration::from_millis(300);

#[derive(Deserialize)]
struct Args {
    cmd: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default = "default_login")]
    login: bool,
    #[serde(default)]
    max_output_tokens: Option<usize>,
}

fn default_login() -> bool {
    true
}

pub struct ExecCommandTool;

impl Tool for ExecCommandTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "exec_command".into(),
            description: "Runs a shell command in the working directory and returns its output once it finishes. A command that runs past `timeout_ms` is killed.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "cmd": {"type": "string", "description": "Shell command to execute."},
                    "workdir": {"type": "string", "description": "Working directory for the command. Defaults to the conversation's working directory."},
                    "timeout_ms": {"type": "number", "description": "Kill the command after this many milliseconds. Defaults to 120000; at most 600000."},
                    "shell": {"type": "string", "description": "Shell binary to launch. Defaults to the user's default shell."},
                    "login": {"type": "boolean", "description": "True runs the shell as a login shell (-l); false does not. Defaults to true."},
                    "max_output_tokens": {"type": "number", "description": "Output token budget. Defaults to 10000 tokens."}
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
            let timeout = Duration::from_millis(
                args.timeout_ms
                    .unwrap_or(DEFAULT_TIMEOUT_MS)
                    .clamp(1, MAX_TIMEOUT_MS),
            );
            let budget = args
                .max_output_tokens
                .unwrap_or(DEFAULT_OUTPUT_TOKENS)
                .clamp(1, MAX_OUTPUT_TOKENS)
                * 4;
            let shell = args
                .shell
                .or_else(|| std::env::var("SHELL").ok())
                .unwrap_or_else(|| "/bin/sh".into());
            run(&shell, args.login, &args.cmd, workdir, timeout, budget).await
        })
    }
}

enum Ended {
    Exited(std::process::ExitStatus),
    TimedOut,
}

/// Kills the command's whole process group when dropped, unless it finished: a tool call that
/// is stopped is dropped mid-await, and the shell would otherwise leave its children running.
struct GroupGuard(Option<i32>);

impl GroupGuard {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            kill_group(pid);
        }
    }
}

fn kill_group(pid: i32) {
    // Negative pid: the group the shell led (it was started as its own group leader).
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

async fn run(
    shell: &str,
    login: bool,
    cmd: &str,
    workdir: Option<PathBuf>,
    timeout: Duration,
    budget: usize,
) -> ToolOutput {
    let mut command = Command::new(shell);
    command
        .arg(if login { "-lc" } else { "-c" })
        .arg(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Nothing here has a terminal to page into.
        .env("TERM", "dumb")
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .env("NO_COLOR", "1")
        .process_group(0);
    if let Some(dir) = &workdir {
        command.current_dir(dir);
    }
    let started = Instant::now();
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return ToolOutput::err(format!("failed to start `{shell}`: {e}")),
    };
    let mut guard = GroupGuard(child.id().map(|p| p as i32));

    // Both streams into one ordered buffer, in the order the bytes arrive.
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    for stream in [
        child.stdout.take().map(Pipe::Out),
        child.stderr.take().map(Pipe::Err),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 16 * 1024];
            let mut reader = stream;
            while let Ok(n) = reader.read(&mut buf).await {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let mut collected = Collected::default();
    let ended = {
        let wait = tokio::time::timeout(timeout, child.wait());
        tokio::pin!(wait);
        loop {
            tokio::select! {
                chunk = rx.recv() => match chunk {
                    Some(c) => collected.push(&c),
                    // Both pipes closed; the exit status is next.
                    None => break match (&mut wait).await {
                        Ok(Ok(status)) => Ended::Exited(status),
                        Ok(Err(_)) => Ended::TimedOut,
                        Err(_) => Ended::TimedOut,
                    },
                },
                result = &mut wait => break match result {
                    Ok(Ok(status)) => Ended::Exited(status),
                    _ => Ended::TimedOut,
                },
            }
        }
    };
    if matches!(ended, Ended::TimedOut) {
        if let Some(pid) = guard.0 {
            kill_group(pid);
        }
        let _ = child.wait().await;
    }
    guard.disarm();
    // Whatever was already in flight.
    let drain = async {
        while let Some(c) = rx.recv().await {
            collected.push(&c);
        }
    };
    let _ = tokio::time::timeout(DRAIN_GRACE, drain).await;

    let wall = started.elapsed().as_secs_f32();
    let text = collected.text();
    let (body, _) = truncate_middle(&text, budget);
    let (status, failed) = match ended {
        Ended::TimedOut => (
            format!(
                "Command timed out after {:.0} seconds and was killed",
                timeout.as_secs_f32()
            ),
            true,
        ),
        Ended::Exited(s) => match s.code() {
            Some(code) => (format!("Process exited with code {code}"), code != 0),
            None => (
                format!("Process was terminated by a signal ({})", signal_of(&s)),
                true,
            ),
        },
    };
    let content = format!("Wall time: {wall:.1} seconds\n{status}\nOutput:\n{body}");
    if failed {
        ToolOutput::err(content)
    } else {
        ToolOutput::ok(content)
    }
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status.signal().unwrap_or(0)
}

enum Pipe {
    Out(tokio::process::ChildStdout),
    Err(tokio::process::ChildStderr),
}

impl Pipe {
    async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Pipe::Out(p) => p.read(buf).await,
            Pipe::Err(p) => p.read(buf).await,
        }
    }
}

/// The start and the end of what a command printed; a flood in between is dropped so memory
/// stays bounded (the model sees an even smaller share of it after `truncate_middle`).
#[derive(Default)]
struct Collected {
    head: Vec<u8>,
    tail: std::collections::VecDeque<u8>,
    dropped: usize,
}

impl Collected {
    fn push(&mut self, mut chunk: &[u8]) {
        if self.head.len() < KEEP_HEAD_BYTES {
            let take = (KEEP_HEAD_BYTES - self.head.len()).min(chunk.len());
            self.head.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
        }
        self.tail.extend(chunk);
        while self.tail.len() > KEEP_TAIL_BYTES {
            self.tail.pop_front();
            self.dropped += 1;
        }
    }

    fn text(&self) -> String {
        let mut bytes = self.head.clone();
        if self.dropped > 0 {
            bytes.extend_from_slice(format!("\n[… {} bytes dropped …]\n", self.dropped).as_bytes());
        }
        bytes.extend(self.tail.iter());
        String::from_utf8_lossy(&bytes).into_owned()
    }
}
