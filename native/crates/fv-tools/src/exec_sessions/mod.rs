//! A conversation's command sessions. The pool, not a tool future or GUI window, owns them.
//! A yielded process survives normal turn completion, and is killed on cancellation of the
//! turn currently interacting with it, pool shutdown, or loss of its owning conversation.

mod io;
mod output;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use fv_agent::{
    ApprovalKind, ApprovalPolicy, ApprovalRequest, Decision, Policy, SandboxMode, ToolCtx,
    ToolOutput, ToolRegistry,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio_util::sync::CancellationToken;

use output::Collected;

const MAX_SESSIONS: usize = 64;
static NEXT_ID: LazyLock<AtomicU64> =
    LazyLock::new(|| AtomicU64::new((uuid::Uuid::new_v4().as_u128() & ((1u128 << 52) - 1)) as u64));

#[derive(Default)]
pub struct ExecSessions {
    runtime_dir: Option<PathBuf>,
    sessions: Mutex<BTreeMap<u64, Arc<Session>>>,
    permits: Permits,
    closed: AtomicBool,
}

struct Permits(Arc<Semaphore>);
impl Default for Permits {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(MAX_SESSIONS)))
    }
}

pub(crate) struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub tty: bool,
    pub timeout: Option<Duration>,
    pub requested_policy: Option<Policy>,
    pub effective_policy: Option<Policy>,
}

#[derive(Clone)]
pub(crate) enum End {
    Exited(i32),
    Failed(String),
    TimedOut,
    Canceled,
}

struct State {
    output: Collected,
    end: Option<End>,
}

pub(crate) struct Session {
    id: u64,
    pid: u32,
    state: Mutex<State>,
    input: Mutex<Option<io::Input>>,
    changed: watch::Sender<u64>,
    current_turn: watch::Sender<CancellationToken>,
    stop: CancellationToken,
    killer: Arc<io::KillSwitch>,
    interaction: tokio::sync::Mutex<()>,
    requested_policy: Option<Policy>,
    effective_policy: Option<Policy>,
    cwd: Option<PathBuf>,
    _permit: Mutex<Option<OwnedSemaphorePermit>>,
}

pub(crate) struct Report {
    pub output: ToolOutput,
    pub code: Option<i32>,
    pub text: String,
    pub running: bool,
}

impl Report {
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            output: ToolOutput::err(message),
            code: None,
            text: String::new(),
            running: false,
        }
    }
}

struct StopOnDrop {
    session: Arc<Session>,
    armed: bool,
}
impl Drop for StopOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.session.abort();
        }
    }
}

impl ExecSessions {
    pub fn for_runtime(data_dir: PathBuf) -> Self {
        Self {
            runtime_dir: Some(data_dir),
            sessions: Mutex::new(BTreeMap::new()),
            permits: Permits::default(),
            closed: AtomicBool::new(false),
        }
    }

    pub fn has_running(&self) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .any(|session| session.state.lock().unwrap().end.is_none())
    }

    pub fn register(self: &Arc<Self>, registry: &mut ToolRegistry) {
        registry
            .register(crate::ExecCommandTool::new(self.clone()))
            .register(crate::WriteStdinTool::new(self.clone()))
            .register(crate::ManageSessionsTool::new(self.clone()));
    }

    /// Stop this conversation's commands without retiring the pool; a resumed child may
    /// launch fresh commands only once these have settled.
    pub fn terminate_all(&self) {
        for session in self.sessions.lock().unwrap().values() {
            session.abort();
        }
    }

    /// This conversation's sessions: id, process id, working directory, and whether still running.
    pub fn list(&self) -> Vec<(u64, u32, Option<PathBuf>, bool)> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| {
                (
                    s.id,
                    s.pid,
                    s.cwd.clone(),
                    s.state.lock().unwrap().end.is_none(),
                )
            })
            .collect()
    }

    /// Stop one session. `false` when there is no such session.
    pub fn kill(&self, id: u64) -> bool {
        match self.sessions.lock().unwrap().get(&id) {
            Some(session) => {
                session.abort();
                true
            }
            None => false,
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        for session in sessions.values() {
            session.abort();
        }
    }

    fn permit(&self) -> Result<OwnedSemaphorePermit, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("Command sessions have been closed.".into());
        }
        let mut sessions = self.sessions.lock().unwrap();
        // Finished, unread sessions may be evicted at capacity. Live commands are never evicted.
        if sessions.len() >= MAX_SESSIONS || self.permits.0.available_permits() == 0 {
            sessions.retain(|_, session| session.state.lock().unwrap().end.is_none());
        }
        self.permits.0.clone().try_acquire_owned().map_err(|_| "Too many running command sessions (64). Stop or collect existing sessions before starting another.".into())
    }

    pub(crate) async fn launch(
        self: &Arc<Self>,
        launch: Launch,
        cancel: CancellationToken,
        wait: Duration,
        budget: usize,
    ) -> Report {
        let started = Instant::now();
        let permit = match self.permit() {
            Ok(permit) => permit,
            Err(e) => return Report::failed(e),
        };
        let requested_policy = launch.requested_policy.clone();
        let effective_policy = launch.effective_policy.clone();
        let cwd = launch.cwd.clone();
        let timeout = launch.timeout;
        let environment = self
            .runtime_dir
            .as_deref()
            .map(fv_env::snapshot_for)
            .unwrap_or_else(fv_env::snapshot);
        let spawned = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Report::failed("Command was stopped before starting."),
            result = tokio::task::spawn_blocking(move || io::spawn(launch, environment)) => match result {
                Ok(Ok(spawned)) => spawned,
                Ok(Err(e)) => return Report::failed(e),
                Err(e) => return Report::failed(format!("failed to start command: {e}")),
            },
        };
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (changed, _) = watch::channel(0);
        let (current_turn, _) = watch::channel(cancel.clone());
        let session = Arc::new(Session {
            id,
            pid: spawned.pid,
            state: Mutex::new(State {
                output: Collected::default(),
                end: None,
            }),
            input: Mutex::new(Some(spawned.input.clone())),
            changed,
            current_turn,
            stop: CancellationToken::new(),
            killer: spawned.guard.0.clone(),
            interaction: tokio::sync::Mutex::new(()),
            requested_policy,
            effective_policy,
            cwd,
            _permit: Mutex::new(Some(permit)),
        });
        {
            let mut sessions = self.sessions.lock().unwrap();
            if self.closed.load(Ordering::Acquire) {
                session.abort();
                return Report::failed("Command sessions have been closed.");
            }
            sessions.insert(id, session.clone());
        }
        tokio::spawn(io::monitor(spawned, session.clone(), timeout));
        let mut guard = StopOnDrop {
            session: session.clone(),
            armed: true,
        };
        let waited = session.wait(wait, &cancel).await;
        if !waited {
            session.abort();
        }
        let mut report = self.take_with_budget(&session, started.elapsed(), budget);
        if !waited {
            report.output.is_error = true;
            report.output.content.push_str("\nCommand was stopped.");
        }
        guard.armed = false;
        report
    }

    pub(crate) async fn interact(
        &self,
        ctx: ToolCtx,
        id: u64,
        chars: String,
        wait: Duration,
        budget: usize,
    ) -> ToolOutput {
        let session = match self.sessions.lock().unwrap().get(&id).cloned() {
            Some(session) => session,
            None => {
                return ToolOutput::err(format!(
                    "Unknown command session {id}: it belongs to another conversation, has already been collected, or was evicted after exit."
                ));
            }
        };
        let started = Instant::now();
        let _interaction = tokio::select! { biased;
            _ = ctx.cancel.cancelled() => return ToolOutput::err("Command interaction was stopped."),
            lock = session.interaction.lock() => lock,
        };
        // A poll is always allowed. Inputs retain the launch approval, but cannot use a session
        // with broader permissions after the conversation's policy has been restricted.
        if !chars.is_empty()
            && chars != "\u{3}"
            && chars != "\u{4}"
            && let Err(error) = session.authorize_input(&ctx, &chars).await
        {
            return ToolOutput::err(error);
        }
        session.current_turn.send_replace(ctx.cancel.clone());
        let mut guard = StopOnDrop {
            session: session.clone(),
            armed: true,
        };
        if !chars.is_empty()
            && let Err(error) = session.write(&chars, &ctx.cancel).await
        {
            guard.armed = false;
            return ToolOutput::err(error);
        }
        let waited = session.wait(wait, &ctx.cancel).await;
        if !waited {
            session.abort();
        }
        let mut report = self.take_with_budget(&session, started.elapsed(), budget);
        if !waited && report.running {
            report.output.is_error = true;
            report
                .output
                .content
                .push_str("\nCommand interaction was stopped.");
        }
        guard.armed = false;
        report.output
    }

    fn take_with_budget(&self, session: &Session, elapsed: Duration, budget: usize) -> Report {
        let (text, end) = {
            let mut state = session.state.lock().unwrap();
            (state.output.take(), state.end.clone())
        };
        let (status, failed, code, running) = match end {
            None => (
                format!(
                    "Process running with session ID {}\nProcess ID: {}",
                    session.id, session.pid
                ),
                false,
                None,
                true,
            ),
            Some(End::Exited(code)) => (
                format!("Process exited with code {code}"),
                code != 0,
                Some(code),
                false,
            ),
            Some(End::TimedOut) => ("Command timed out and was killed".into(), true, None, false),
            Some(End::Canceled) => ("Command was stopped and killed".into(), true, None, false),
            Some(End::Failed(error)) => (format!("Command failed: {error}"), true, None, false),
        };
        if !running {
            self.sessions.lock().unwrap().remove(&session.id);
        }
        let (body, _) = crate::truncate_middle(&text, budget);
        Report {
            output: ToolOutput {
                content: format!(
                    "Wall time: {:.1} seconds\n{status}\nOutput:\n{body}",
                    elapsed.as_secs_f32()
                ),
                is_error: failed,
                images: vec![],
                audio: vec![],
            },
            code,
            text,
            running,
        }
    }
}

impl Drop for ExecSessions {
    fn drop(&mut self) {
        self.close();
    }
}

impl Session {
    fn abort(&self) {
        self.stop.cancel();
        self.killer.kill();
    }

    fn push(&self, text: &str) {
        self.state.lock().unwrap().output.push(text);
        self.changed.send_modify(|value| *value += 1);
    }

    fn finish(&self, end: End) {
        self.input.lock().unwrap().take();
        {
            let mut state = self.state.lock().unwrap();
            state.end = Some(end);
            self._permit.lock().unwrap().take();
        }
        self.changed.send_modify(|value| *value += 1);
    }

    async fn wait(&self, budget: Duration, cancel: &CancellationToken) -> bool {
        let mut changes = self.changed.subscribe();
        let end = tokio::time::Instant::now() + budget;
        loop {
            if self.state.lock().unwrap().end.is_some() {
                return true;
            }
            tokio::select! { biased;
                _ = cancel.cancelled() => return false,
                _ = tokio::time::sleep_until(end) => return true,
                _ = changes.changed() => (),
            }
        }
    }

    async fn canceled(&self) {
        let mut turns = self.current_turn.subscribe();
        loop {
            let cancel = turns.borrow_and_update().clone();
            tokio::select! { biased;
                _ = self.stop.cancelled() => return,
                changed = turns.changed() => if changed.is_err() { return; },
                _ = cancel.cancelled() => return,
            }
        }
    }

    async fn authorize_input(&self, ctx: &ToolCtx, chars: &str) -> Result<(), String> {
        let Some(permissions) = &ctx.permissions else {
            return Ok(());
        };
        if self.requested_policy.as_ref() != Some(&permissions.policy)
            && !policy_allows(self.effective_policy.as_ref(), &permissions.policy)
        {
            return Err("This command session has broader permissions than the current conversation. Start a new command under the current policy.".into());
        }
        if permissions.approval == ApprovalPolicy::Untrusted {
            let decision = permissions
                .ask(ApprovalRequest {
                    call_id: ctx.call_id.clone(),
                    kind: ApprovalKind::Command {
                        command: format!("stdin to session {}: {chars}", self.id),
                        cwd: self.cwd.as_ref().map(|path| path.display().to_string()),
                    },
                    reason: Some("Send input to an existing command session.".into()),
                })
                .await;
            if decision == Decision::Denied {
                return Err("The user did not allow input to this command session.".into());
            }
        }
        Ok(())
    }

    async fn write(&self, chars: &str, cancel: &CancellationToken) -> Result<(), String> {
        if self.state.lock().unwrap().end.is_some() {
            return Err(
                "This command has already exited; poll without input to collect its final output."
                    .into(),
            );
        }
        let input = self
            .input
            .lock()
            .unwrap()
            .clone()
            .ok_or("Command stdin is closed.")?;
        if chars == "\u{3}" && !input.is_tty() {
            self.killer.interrupt();
            return Ok(());
        }
        if chars == "\u{4}" && !input.is_tty() {
            self.input.lock().unwrap().take();
            return Ok(());
        }
        io::write(input, chars.as_bytes(), cancel).await
    }
}

fn policy_allows(original: Option<&Policy>, current: &Policy) -> bool {
    if current.mode == SandboxMode::DangerFullAccess {
        return true;
    }
    let Some(original) = original else {
        return false;
    };
    if original.network && !current.network {
        return false;
    }
    match original.mode {
        SandboxMode::DangerFullAccess => false,
        SandboxMode::ReadOnly => true,
        SandboxMode::WorkspaceWrite => {
            current.mode == SandboxMode::WorkspaceWrite
                && original
                    .writable_roots
                    .iter()
                    .all(|root| current.can_write(root))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn capacity_is_reserved_before_spawn_and_does_not_leave_a_rejected_child() {
        let pool = Arc::new(ExecSessions {
            runtime_dir: None,
            permits: Permits(Arc::new(Semaphore::new(2))),
            sessions: Mutex::default(),
            closed: AtomicBool::new(false),
        });
        let mut tools = ToolRegistry::new();
        pool.register(&mut tools);
        for _ in 0..2 {
            let out = tools
                .get("exec_command")
                .unwrap()
                .call(
                    ToolCtx::new(CancellationToken::new(), None),
                    json!({"cmd":"sleep 60","shell":"/bin/sh","login":false,"yield_time_ms":250}),
                )
                .await;
            assert!(!out.is_error, "{}", out.content);
        }
        let dir = tempfile::tempdir().unwrap();
        let out = tools
            .get("exec_command")
            .unwrap()
            .call(
                ToolCtx::new(CancellationToken::new(), Some(dir.path().into())),
                json!({"cmd":"touch forbidden","login":false}),
            )
            .await;
        assert!(out.is_error && out.content.contains("Too many"));
        assert!(!dir.path().join("forbidden").exists());
        pool.close();
    }
}
