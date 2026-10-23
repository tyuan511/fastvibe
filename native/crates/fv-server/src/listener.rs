use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fv_protocol::types::ClientOrigin;
use tokio::net::{UnixListener, UnixStream};

use crate::connection::serve_connection;
use crate::state::ServerState;

#[derive(Debug)]
pub enum ListenError {
    /// Another server already answers on this socket.
    AlreadyRunning(PathBuf),
    Io(std::io::Error),
}

impl std::fmt::Display for ListenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ListenError::AlreadyRunning(p) => {
                write!(f, "a server is already listening on {}", p.display())
            }
            ListenError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ListenError {}

impl From<std::io::Error> for ListenError {
    fn from(e: std::io::Error) -> Self {
        ListenError::Io(e)
    }
}

/// The local listener: a unix socket only its owner can open. Whoever can reach it is the
/// user themself, so connections are accepted as [`ClientOrigin::Local`] with no password.
pub struct UnixServer {
    listener: UnixListener,
    path: PathBuf,
    state: Arc<ServerState>,
}

impl UnixServer {
    pub async fn bind(state: Arc<ServerState>, path: &Path) -> Result<Self, ListenError> {
        // The directory is what keeps other users out while the socket is being created;
        // the socket's own mode is tightened right after.
        if let Some(parent) = path.parent() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        if path.exists() {
            // A live server answers; a stale file from a crash does not and is replaced.
            if UnixStream::connect(path).await.is_ok() {
                return Err(ListenError::AlreadyRunning(path.to_path_buf()));
            }
            std::fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(Self {
            listener,
            path: path.to_path_buf(),
            state,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Accept connections until the future is dropped.
    pub async fn run(self) -> std::io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let state = self.state.clone();
            tokio::spawn(async move {
                let (r, w) = stream.into_split();
                serve_connection(state, ClientOrigin::Local, r, w).await;
            });
        }
    }
}

impl Drop for UnixServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
