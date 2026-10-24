//! Keeping a `fastvibe-server` running for the app to talk to.
//!
//! The server is a process of its own so that a window closing, crashing or updating does not
//! stop a turn in flight. This crate is the app's half of that: reach the server that is
//! already there, or start one, and hand back a connected client.
//!
//! Files in the data directory: `server.sock` (the server's own), `server.lock` (held while
//! one app starts it, so two apps opening together start one server), `server.pid` and
//! `server.log` (what the server printed).

use std::fs::OpenOptions;
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use fv_client::Client;
use fv_protocol::methods::Initialize;
use fv_protocol::types::{ClientCapabilities, ClientInfo, InitializeParams};
use fv_protocol::{PROTOCOL_VERSION, ServerNotification, ServerRequest};
use tokio::net::UnixStream;
use tokio::sync::mpsc::UnboundedReceiver;

const START_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub enum DaemonError {
    /// The server executable could not be found.
    NoServerBinary(String),
    Io(std::io::Error),
    /// The server was started and did not come up; `log` is the end of what it printed.
    DidNotStart {
        log: String,
    },
    /// The previous process was signalled but did not release its socket in time.
    DidNotStop,
    Rpc(String),
}

impl std::fmt::Display for DaemonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DaemonError::NoServerBinary(s) => write!(f, "cannot find the FastVibe server: {s}"),
            DaemonError::Io(e) => write!(f, "{e}"),
            DaemonError::DidNotStart { log } => {
                write!(
                    f,
                    "the FastVibe server did not start{}",
                    if log.is_empty() {
                        String::new()
                    } else {
                        format!(": {log}")
                    }
                )
            }
            DaemonError::DidNotStop => {
                write!(f, "the previous FastVibe server did not stop in time")
            }
            DaemonError::Rpc(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for DaemonError {}

impl From<std::io::Error> for DaemonError {
    fn from(e: std::io::Error) -> Self {
        DaemonError::Io(e)
    }
}

pub struct Daemon {
    data_dir: PathBuf,
    server_bin: PathBuf,
}

/// A connected, initialized client, and what is worth knowing about the server behind it.
pub struct Connection {
    pub client: Client,
    pub notifications: UnboundedReceiver<ServerNotification>,
    pub requests: UnboundedReceiver<ServerRequest>,
    pub server_version: String,
    /// The server is from a different build than this app; it should be restarted when idle.
    pub version_mismatch: bool,
    /// Digest of the running executable, absent on servers built before this handshake field.
    pub build_fingerprint: Option<String>,
    /// `None` means the running server is too old to report activity; restart conservatively.
    pub has_running_turns: Option<bool>,
}

/// Where the app keeps its data unless told otherwise.
pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FASTVIBE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Library/Application Support/FastVibeNative")
}

/// The server executable: named by the environment, else next to this one, else on `PATH`.
pub fn find_server_binary() -> Result<PathBuf, DaemonError> {
    if let Ok(p) = std::env::var("FASTVIBE_SERVER_BIN") {
        let p = PathBuf::from(p);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(DaemonError::NoServerBinary(format!(
                "FASTVIBE_SERVER_BIN={} does not exist",
                p.display()
            )))
        };
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join("fastvibe-server");
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("fastvibe-server");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(DaemonError::NoServerBinary(
        "no `fastvibe-server` next to the app or on PATH".into(),
    ))
}

impl Daemon {
    pub fn new(data_dir: PathBuf, server_bin: PathBuf) -> Self {
        Self {
            data_dir,
            server_bin,
        }
    }

    pub fn socket(&self) -> PathBuf {
        self.data_dir.join("server.sock")
    }

    fn pid_file(&self) -> PathBuf {
        self.data_dir.join("server.pid")
    }

    fn log_file(&self) -> PathBuf {
        self.data_dir.join("server.log")
    }

    async fn reachable(&self) -> bool {
        UnixStream::connect(self.socket()).await.is_ok()
    }

    /// The server's socket, once something is answering on it: the one already running, or one
    /// started now.
    pub async fn ensure_running(&self) -> Result<PathBuf, DaemonError> {
        if self.reachable().await {
            return Ok(self.socket());
        }
        std::fs::create_dir_all(&self.data_dir)?;
        // Two apps opening together must not both start a server: whoever holds the lock does,
        // and the other finds it running once the lock is its.
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.data_dir.join("server.lock"))?;
        let fd = lock.as_raw_fd();
        let locked =
            tokio::task::spawn_blocking(move || unsafe { libc::flock(fd, libc::LOCK_EX) }).await;
        if !matches!(locked, Ok(0)) {
            return Err(DaemonError::Io(std::io::Error::last_os_error()));
        }
        // `fd` stays valid because `lock` outlives the call above and the code below.
        if self.reachable().await {
            return Ok(self.socket());
        }
        self.start().await?;
        drop(lock);
        Ok(self.socket())
    }

    async fn start(&self) -> Result<(), DaemonError> {
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_file())?;
        let mut command = Command::new(&self.server_bin);
        command
            .arg("--data-dir")
            .arg(&self.data_dir)
            .arg("--listen")
            .arg("unix")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            // Its own process group: the app quitting, or its terminal closing, must not take
            // the server (and a turn running in it) along.
            .process_group(0);
        let mut child = command.spawn().map_err(|e| {
            DaemonError::NoServerBinary(format!("{}: {e}", self.server_bin.display()))
        })?;
        std::fs::write(self.pid_file(), child.id().to_string())?;

        let started = Instant::now();
        loop {
            if self.reachable().await {
                // It keeps running on its own. Something has to collect it when it exits, or it
                // lingers as a zombie for as long as this app lives.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            if let Ok(Some(_)) = child.try_wait() {
                return Err(DaemonError::DidNotStart {
                    log: self.log_tail(),
                });
            }
            if started.elapsed() > START_TIMEOUT {
                let _ = child.kill();
                return Err(DaemonError::DidNotStart {
                    log: self.log_tail(),
                });
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn log_tail(&self) -> String {
        let text = std::fs::read_to_string(self.log_file()).unwrap_or_default();
        let lines: Vec<&str> = text.lines().rev().take(3).collect();
        lines.into_iter().rev().collect::<Vec<_>>().join(" | ")
    }

    /// Reach the server (starting it if need be) and say hello.
    pub async fn connect(
        &self,
        client_name: &str,
        client_version: &str,
    ) -> Result<Connection, DaemonError> {
        let socket = self.ensure_running().await?;
        connect_to(&socket, client_name, client_version).await
    }

    /// Stop the current server and wait for its socket to close before returning. Development
    /// builds use this before starting the GUI, so newly built protocol methods cannot be
    /// answered by an older resident process.
    pub fn stop_and_wait(&self) -> Result<bool, DaemonError> {
        if !self.stop()? {
            return Ok(false);
        }
        let started = Instant::now();
        while self.reachable_blocking() {
            if started.elapsed() > START_TIMEOUT {
                return Err(DaemonError::DidNotStop);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(true)
    }

    fn reachable_blocking(&self) -> bool {
        std::os::unix::net::UnixStream::connect(self.socket()).is_ok()
    }

    /// Ask the server to stop, if it is running.
    pub fn stop(&self) -> Result<bool, DaemonError> {
        let Ok(text) = std::fs::read_to_string(self.pid_file()) else {
            return Ok(false);
        };
        let Ok(pid) = text.trim().parse::<i32>() else {
            return Ok(false);
        };
        let stopped = unsafe { libc::kill(pid, libc::SIGTERM) } == 0;
        let _ = std::fs::remove_file(self.pid_file());
        Ok(stopped)
    }
}

/// Connect to a server socket and complete the handshake.
pub async fn connect_to(
    socket: &Path,
    client_name: &str,
    client_version: &str,
) -> Result<Connection, DaemonError> {
    let (client, notifications) = Client::connect_unix(socket).await?;
    let requests = client
        .take_requests()
        .expect("a fresh client has its requests");
    let hello = client
        .call::<Initialize>(InitializeParams {
            client_info: ClientInfo {
                name: client_name.into(),
                version: client_version.into(),
            },
            protocol_version: PROTOCOL_VERSION,
            capabilities: ClientCapabilities::default(),
        })
        .await
        .map_err(|e| DaemonError::Rpc(e.to_string()))?;
    let version_mismatch = hello.server_version != client_version;
    Ok(Connection {
        client,
        notifications,
        requests,
        server_version: hello.server_version,
        version_mismatch,
        build_fingerprint: hello.build_fingerprint,
        has_running_turns: hello.has_running_turns,
    })
}
