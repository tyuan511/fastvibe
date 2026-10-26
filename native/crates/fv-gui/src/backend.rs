//! The app's link to the server: a tokio runtime on its own thread that finds (or starts) the
//! server, and a handle the UI uses to make calls without caring which executor it runs on.
//!
//! GPUI has its own executor, and the client's futures need tokio's reactor, so the calls are
//! spawned on the runtime and only their results cross over (a `JoinHandle` can be awaited
//! from anywhere).

use std::path::PathBuf;
use std::sync::Arc;

use futures_channel::mpsc;
use futures_util::StreamExt as _;
use fv_client::{Client, ClientError};
use fv_protocol::{RequestId, Rpc, ServerNotification, ServerRequest};
use serde_json::Value;

#[path = "mcp_oauth.rs"]
mod mcp_oauth;
pub(crate) use mcp_oauth::OAuthCancellation;

/// What the server told us, or that we lost it.
#[derive(Debug)]
pub enum BackendEvent {
    Connected {
        version_mismatch: bool,
    },
    Notification(ServerNotification),
    Request(ServerRequest),
    /// Could not reach the server, or lost it.
    Failed(String),
}

#[derive(Clone)]
pub struct Backend {
    client: Arc<Client>,
    runtime: tokio::runtime::Handle,
}

impl Backend {
    /// Connect to the server for `data_dir`, starting it if needed. Events arrive on the
    /// returned channel; `Connected` comes first.
    pub fn start(
        data_dir: PathBuf,
        server_bin: Option<PathBuf>,
    ) -> (
        impl std::future::Future<Output = Option<Backend>>,
        mpsc::UnboundedReceiver<BackendEvent>,
    ) {
        let (events_tx, events_rx) = mpsc::unbounded();
        let (ready_tx, ready_rx) = futures_channel::oneshot::channel();
        std::thread::Builder::new()
            .name("fv-backend".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = events_tx.unbounded_send(BackendEvent::Failed(e.to_string()));
                        let _ = ready_tx.send(None);
                        return;
                    }
                };
                let handle = runtime.handle().clone();
                runtime.block_on(async move {
                    fv_env::initialize().await;
                    let bin = match server_bin.map(Ok).unwrap_or_else(fv_daemon::find_server_binary)
                    {
                        Ok(b) => b,
                        Err(e) => {
                            let _ = events_tx.unbounded_send(BackendEvent::Failed(e.to_string()));
                            let _ = ready_tx.send(None);
                            return;
                        }
                    };
                    let daemon = fv_daemon::Daemon::new(data_dir, bin);
                    let conn = match daemon.connect_current("fastvibe-gui", env!("CARGO_PKG_VERSION"), &["sidebarSettings", "skills", "mcp", "mcpConfigEdit", "mcpOAuth", "execSessions", "workspaceEntries", "terminalInteraction", "memory", "autoCompaction"]).await
                    {
                        Ok(c) => c,
                        Err(e) => {
                            let _ = events_tx.unbounded_send(BackendEvent::Failed(e.to_string()));
                            let _ = ready_tx.send(None);
                            return;
                        }
                    };
                    let fv_daemon::Connection {
                        client,
                        mut notifications,
                        mut requests,
                        version_mismatch,
                        ..
                    } = conn;
                    let backend = Backend {
                        client: Arc::new(client),
                        runtime: handle,
                    };
                    let _ = events_tx.unbounded_send(BackendEvent::Connected { version_mismatch });
                    let _ = ready_tx.send(Some(backend));
                    loop {
                        tokio::select! {
                            n = notifications.recv() => match n {
                                Some(n) => {
                                    if events_tx.unbounded_send(BackendEvent::Notification(n)).is_err() {
                                        return;
                                    }
                                }
                                None => {
                                    let _ = events_tx.unbounded_send(BackendEvent::Failed(
                                        "the connection to the server closed".into(),
                                    ));
                                    return;
                                }
                            },
                            r = requests.recv() => match r {
                                Some(r) => {
                                    if events_tx.unbounded_send(BackendEvent::Request(r)).is_err() {
                                        return;
                                    }
                                }
                                None => return,
                            },
                        }
                    }
                });
                // The UI is gone (or the connection is): nothing left to run.
                drop(runtime);
            })
            .expect("spawn backend thread");
        (async move { ready_rx.await.ok().flatten() }, events_rx)
    }

    /// Make a call; the future may be awaited on any executor.
    pub fn call<M: Rpc + 'static>(
        &self,
        params: M::Params,
    ) -> impl std::future::Future<Output = Result<M::Response, ClientError>> + use<M>
    where
        M::Params: Send + 'static,
        M::Response: Send + 'static,
    {
        let client = self.client.clone();
        let task = self
            .runtime
            .spawn(async move { client.call::<M>(params).await });
        async move {
            match task.await {
                Ok(r) => r,
                Err(_) => Err(ClientError::Closed),
            }
        }
    }

    pub fn respond(&self, id: RequestId, result: Value) {
        let client = self.client.clone();
        self.runtime.spawn(async move {
            let _ = client.respond(id, result).await;
        });
    }

    pub fn decline(&self, id: RequestId, message: &'static str) {
        let client = self.client.clone();
        self.runtime.spawn(async move {
            let _ = client.decline(id, message).await;
        });
    }
}

/// Drain a channel into a closure; used by the app to turn events into view updates.
pub async fn for_each<T>(mut rx: mpsc::UnboundedReceiver<T>, mut f: impl FnMut(T) -> bool) {
    while let Some(item) = rx.next().await {
        if !f(item) {
            break;
        }
    }
}
