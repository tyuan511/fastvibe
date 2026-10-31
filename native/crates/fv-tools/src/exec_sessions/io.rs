use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::output::Decoder;
use super::{End, Launch, Session};

#[derive(Clone)]
pub(super) enum Input {
    Pipe(Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>),
    #[cfg(unix)]
    Pty(Arc<tokio::io::unix::AsyncFd<std::fs::File>>),
}

impl Input {
    pub fn is_tty(&self) -> bool {
        match self {
            Self::Pipe(_) => false,
            #[cfg(unix)]
            Self::Pty(_) => true,
        }
    }
}

enum Reader {
    Out(tokio::process::ChildStdout),
    Err(tokio::process::ChildStderr),
    #[cfg(unix)]
    Pty(Arc<tokio::io::unix::AsyncFd<std::fs::File>>),
}

pub(super) struct KillSwitch {
    pid: u32,
    live: AtomicBool,
    #[cfg(not(unix))]
    error: std::sync::Mutex<Option<String>>,
    #[cfg(unix)]
    tty: std::sync::Mutex<Option<Arc<tokio::io::unix::AsyncFd<std::fs::File>>>>,
}

impl KillSwitch {
    fn new(pid: u32) -> Self {
        Self {
            pid,
            live: AtomicBool::new(true),
            #[cfg(not(unix))]
            error: std::sync::Mutex::new(None),
            #[cfg(unix)]
            tty: std::sync::Mutex::new(None),
        }
    }
    #[cfg(unix)]
    fn signal(&self, signal: i32) {
        use std::os::fd::AsRawFd;
        if let Some(fd) = self.tty.lock().unwrap().as_ref() {
            let foreground = unsafe { libc::tcgetpgrp(fd.get_ref().as_raw_fd()) };
            if foreground > 0 && foreground != self.pid as i32 {
                unsafe {
                    libc::kill(-foreground, signal);
                }
            }
        }
        unsafe {
            libc::kill(-(self.pid as i32), signal);
        }
    }
    #[cfg(windows)]
    fn terminate_tree(&self) -> Result<(), String> {
        let mut child = std::process::Command::new("taskkill.exe")
            .args(["/PID", &self.pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not terminate command process tree: {error}"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(format!(
                            "taskkill failed to terminate command process tree ({status})"
                        ))
                    };
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error.to_string());
                }
                Ok(None) if std::time::Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Timed out terminating command process tree".into());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }

    pub fn kill(&self) {
        if self.live.swap(false, Ordering::AcqRel) {
            #[cfg(unix)]
            {
                self.signal(libc::SIGKILL);
                self.tty.lock().unwrap().take();
            }
            #[cfg(windows)]
            if let Err(error) = self.terminate_tree() {
                *self.error.lock().unwrap() = Some(error);
            }
            #[cfg(not(any(unix, windows)))]
            {
                *self.error.lock().unwrap() =
                    Some("Process-tree termination is unsupported on this platform".into());
            }
        }
    }
    pub fn interrupt(&self) {
        if self.live.load(Ordering::Acquire) {
            #[cfg(unix)]
            self.signal(libc::SIGINT);
            // A pipe child has no shared Windows console to deliver Ctrl-C into. Terminate
            // its tree explicitly instead of pretending the interrupt was delivered.
            #[cfg(not(unix))]
            self.kill();
        }
    }
}

pub(super) struct Guard(pub Arc<KillSwitch>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.kill();
    }
}

enum Child {
    Pipe(tokio::process::Child),
    Pty(tokio::task::JoinHandle<std::io::Result<portable_pty::ExitStatus>>),
}

pub(super) struct Spawned {
    pub pid: u32,
    pub input: Input,
    pub guard: Guard,
    child: Child,
    readers: Vec<Reader>,
}

pub(super) fn spawn(
    launch: Launch,
    environment: std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
) -> Result<Spawned, String> {
    if launch.tty {
        return spawn_pty(launch, environment);
    }
    let mut command = tokio::process::Command::new(&launch.program);
    command
        .args(&launch.args)
        .envs(environment)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("TERM", "dumb")
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .env("NO_COLOR", "1")
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    if let Some(cwd) = &launch.cwd {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to start `{}`: {e}", launch.program))?;
    let pid = child.id().ok_or("command has no process id")?;
    let guard = Guard(Arc::new(KillSwitch::new(pid)));
    let stdin = child.stdin.take().ok_or("command has no stdin")?;
    let readers = vec![
        Reader::Out(child.stdout.take().ok_or("command has no stdout")?),
        Reader::Err(child.stderr.take().ok_or("command has no stderr")?),
    ];
    Ok(Spawned {
        pid,
        input: Input::Pipe(Arc::new(tokio::sync::Mutex::new(stdin))),
        child: Child::Pipe(child),
        readers,
        guard,
    })
}

#[cfg(unix)]
fn spawn_pty(
    launch: Launch,
    environment: std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
) -> Result<Spawned, String> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use std::os::fd::FromRawFd;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("cannot allocate PTY: {e}"))?;
    let mut command = CommandBuilder::new(&launch.program);
    command.args(&launch.args);
    for (name, value) in environment {
        command.env(name, value);
    }
    if let Some(cwd) = &launch.cwd {
        command.cwd(cwd);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("failed to start `{}` in PTY: {e}", launch.program))?;
    let pid = child.process_id().ok_or("PTY command has no process id")?;
    let guard = Guard(Arc::new(KillSwitch::new(pid)));
    drop(pair.slave);
    let fd = pair
        .master
        .as_raw_fd()
        .ok_or("PTY does not expose a file descriptor")?;
    let owned = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if owned < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let file = unsafe { std::fs::File::from_raw_fd(owned) };
    let flags = unsafe { libc::fcntl(owned, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(owned, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // SAFETY: `file` owns the duplicated fd. It is never replaced or closed while AsyncFd
    // owns it; shared readers/writers borrow that same file description through Arc.
    let fd =
        Arc::new(unsafe { tokio::io::unix::AsyncFd::register(file) }.map_err(|e| e.to_string())?);
    *guard.0.tty.lock().unwrap() = Some(fd.clone());
    drop(pair.master);
    // Only waitpid blocks. PTY reads and writes use readiness, so a stopped process or a full
    // input queue cannot leave a blocking I/O thread behind.
    let wait = tokio::task::spawn_blocking(move || child.wait());
    Ok(Spawned {
        pid,
        input: Input::Pty(fd.clone()),
        child: Child::Pty(wait),
        readers: vec![Reader::Pty(fd)],
        guard,
    })
}

#[cfg(not(unix))]
fn spawn_pty(
    _launch: Launch,
    _environment: std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
) -> Result<Spawned, String> {
    Err("PTY command sessions are not available on this platform yet.".into())
}

async fn wait(child: &mut Child) -> Result<End, String> {
    match child {
        Child::Pipe(child) => child
            .wait()
            .await
            .map(|status| {
                status
                    .code()
                    .map(End::Exited)
                    .unwrap_or_else(|| End::Failed(format!("terminated by signal ({status})")))
            })
            .map_err(|e| e.to_string()),
        Child::Pty(wait) => {
            let status = wait
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            Ok(match status.signal() {
                Some(signal) => End::Failed(format!("terminated by signal ({signal})")),
                None => End::Exited(status.exit_code() as i32),
            })
        }
    }
}

pub(super) async fn monitor(
    mut spawned: Spawned,
    session: Arc<Session>,
    deadline: Option<Duration>,
) {
    // The session owns stdin. Keeping the launcher's clone here would prevent pipe EOF
    // when write_stdin closes it, and keep a child waiting for input forever.
    drop(spawned.input);
    let readers_cancel = CancellationToken::new();
    let mut readers = Vec::new();
    for reader in spawned.readers.drain(..) {
        let session = session.clone();
        let cancel = readers_cancel.clone();
        readers.push(tokio::spawn(read(reader, session, cancel)));
    }
    let elapsed = async {
        match deadline {
            Some(deadline) => tokio::time::sleep(deadline).await,
            None => std::future::pending::<()>().await,
        }
    };
    let end = tokio::select! { biased;
        _ = session.canceled() => End::Canceled,
        _ = elapsed => End::TimedOut,
        result = wait(&mut spawned.child) => result.unwrap_or_else(End::Failed),
    };
    // Kill any remaining members as soon as the leader exits, before draining. A shell's `&`
    // must not leave untracked children holding output pipes after the session has finished.
    spawned.guard.0.kill();
    if matches!(end, End::Canceled | End::TimedOut) {
        if let Child::Pipe(child) = &mut spawned.child {
            let _ = child.start_kill();
        }
        let _ = tokio::time::timeout(Duration::from_secs(3), wait(&mut spawned.child)).await;
    }
    let drain = async {
        for task in &mut readers {
            let _ = task.await;
        }
    };
    tokio::pin!(drain);
    if tokio::time::timeout(Duration::from_millis(300), &mut drain)
        .await
        .is_err()
    {
        readers_cancel.cancel();
        drain.await;
    }
    #[cfg(not(unix))]
    if let Some(error) = spawned.guard.0.error.lock().unwrap().take() {
        session.push(&format!("\n[process cleanup failed: {error}]\n"));
    }
    session.finish(end);
}

async fn read(mut reader: Reader, session: Arc<Session>, cancel: CancellationToken) {
    let mut decoder = Decoder::default();
    let mut buffer = [0; 8192];
    loop {
        let result = tokio::select! { biased; _ = cancel.cancelled() => break, result = reader.read(&mut buffer) => result };
        match result {
            Ok(0) => break,
            Ok(n) => {
                let text = decoder.push(&buffer[..n]);
                if !text.is_empty() {
                    session.push(&text);
                }
            }
            Err(error) => {
                // Linux reports EIO after the slave side closes; it is PTY EOF, not a lost log.
                #[cfg(unix)]
                if matches!(reader, Reader::Pty(_)) && error.raw_os_error() == Some(libc::EIO) {
                    break;
                }
                session.push(&format!("\n[output read failed: {error}]\n"));
                break;
            }
        }
    }
    let last = decoder.finish();
    if !last.is_empty() {
        session.push(&last);
    }
}

impl Reader {
    async fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Reader::Out(reader) => reader.read(buffer).await,
            Reader::Err(reader) => reader.read(buffer).await,
            #[cfg(unix)]
            Reader::Pty(fd) => loop {
                let mut ready = fd.readable().await?;
                match ready.try_io(|fd| (&mut fd.get_ref()).read(buffer)) {
                    Ok(result) => return result,
                    Err(_) => continue,
                }
            },
        }
    }
}

pub(super) async fn write(
    input: Input,
    bytes: &[u8],
    cancel: &CancellationToken,
) -> Result<(), String> {
    let mut written = 0;
    let send = async {
        match input {
            Input::Pipe(stdin) => {
                let mut stdin = stdin.lock().await;
                while written < bytes.len() {
                    let n = stdin.write(&bytes[written..]).await?;
                    if n == 0 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::WriteZero,
                            "stdin closed",
                        ));
                    }
                    written += n;
                }
                stdin.flush().await
            }
            #[cfg(unix)]
            Input::Pty(fd) => {
                while written < bytes.len() {
                    let mut ready = fd.writable().await?;
                    match ready.try_io(|fd| (&mut fd.get_ref()).write(&bytes[written..])) {
                        Ok(Ok(0)) => {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::WriteZero,
                                "PTY closed",
                            ));
                        }
                        Ok(Ok(n)) => written += n,
                        Ok(Err(e)) => return Err(e),
                        Err(_) => (),
                    }
                }
                Ok(())
            }
        }
    };
    let result = tokio::select! { biased;
        _ = cancel.cancelled() => Err("input was stopped".to_string()),
        result = tokio::time::timeout(Duration::from_secs(10), send) => match result { Ok(result) => result.map_err(|e| e.to_string()), Err(_) => Err("stdin did not accept input before its deadline".into()) },
    };
    result.map_err(|e| format!("Failed to write stdin after {written} of {} bytes: {e}. Do not resend already-written bytes.", bytes.len()))
}
