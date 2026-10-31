//! The app's link to the server: a tokio runtime on its own thread that finds (or starts) the
//! server, and a retained handle whose current connection is replaced after a disconnect.
//!
//! GPUI has its own executor, and the client's futures need tokio's reactor, so the calls are
//! spawned on the runtime and only their results cross over. A call belongs to the connection
//! it started on; reconnecting never retries an application operation.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures_channel::mpsc;
use futures_util::StreamExt as _;
use fv_client::{Client, ClientError};
use fv_protocol::{RequestId, Rpc, ServerNotification, ServerRequest};
use serde_json::Value;
use tokio::sync::{oneshot, watch};

#[path = "mcp_oauth.rs"]
mod mcp_oauth;
#[path = "remote_backend.rs"]
mod remote_backend;
pub(crate) use mcp_oauth::OAuthCancellation;

/// What the server told us, or that we lost it.
#[derive(Debug)]
pub enum BackendEvent {
    /// A new initialized connection is current. The UI refreshes snapshots and resumes its
    /// selected conversation in response; old requests and stream events are never replayed.
    Connected {
        version_mismatch: bool,
    },
    Notification(ServerNotification),
    Request(ServerRequest),
    /// Could not reach the server, or lost it. Connection attempts continue until the UI drops.
    Failed(String),
}

#[derive(Clone)]
pub struct Backend {
    state: Arc<BackendState>,
    runtime: tokio::runtime::Handle,
}

struct BackendState {
    current: Mutex<Option<Arc<LiveConnection>>>,
    // Only GUI handles own this state. The runner holds a Weak, so even an idle connection
    // stops when the last handle disappears rather than retaining its own runtime forever.
    shutdown: Option<oneshot::Sender<()>>,
}

impl Drop for BackendState {
    fn drop(&mut self) {
        if let Some(current) = self.current.get_mut().unwrap().take() {
            current.disconnect();
        }
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

/// One connection generation, also used by local operations such as the OAuth callback.
/// Holding this does not keep the GUI backend alive, and it never follows a reconnect.
pub(crate) struct LiveConnection {
    pub(crate) client: Arc<Client>,
    disconnected: watch::Sender<bool>,
}

impl LiveConnection {
    fn new(client: Client) -> Self {
        Self {
            client: Arc::new(client),
            disconnected: watch::channel(false).0,
        }
    }

    fn disconnect(&self) {
        self.disconnected.send_replace(true);
    }

    pub(crate) async fn until_disconnected<T>(
        &self,
        operation: impl Future<Output = Result<T, ClientError>>,
    ) -> Result<T, ClientError> {
        tokio::select! {
            biased;
            _ = self.closed() => Err(ClientError::Closed),
            result = operation => result,
        }
    }

    pub(crate) async fn closed(&self) {
        let mut disconnected = self.disconnected.subscribe();
        if !*disconnected.borrow_and_update() {
            let _ = disconnected.changed().await;
        }
    }
}

#[derive(Clone, Copy)]
struct RetryPolicy {
    attempt_timeout: Duration,
    initial_delay: Duration,
    max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempt_timeout: Duration::from_secs(30),
            initial_delay: Duration::from_millis(250),
            max_delay: Duration::from_secs(5),
        }
    }
}

impl Backend {
    /// Run a local application operation on the same Tokio reactor as network calls.
    pub fn task<F>(&self, future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.runtime.spawn(future)
    }

    /// Create the retained GUI handle, then connect to the server for `data_dir`, starting it
    /// if needed. Initial failures and later disconnects retry with bounded attempts/backoff.
    /// Every successful handshake emits one `Connected` before its notifications or requests.
    pub fn start(
        data_dir: PathBuf,
        server_bin: Option<PathBuf>,
    ) -> (
        impl std::future::Future<Output = Option<Backend>>,
        mpsc::UnboundedReceiver<BackendEvent>,
    ) {
        Self::start_with_connector(
            move || {
                let data_dir = data_dir.clone();
                let server_bin = server_bin.clone();
                async move {
                    fv_env::initialize().await;
                    let bin = server_bin
                        .map(Ok)
                        .unwrap_or_else(fv_daemon::find_server_binary)
                        .map_err(|e| e.to_string())?;
                    fv_daemon::Daemon::new(data_dir, bin)
                        .connect_current(
                            "fastvibe-gui",
                            env!("CARGO_PKG_VERSION"),
                            fv_protocol::DESKTOP_REQUIRED_FEATURES,
                        )
                        .await
                        .map_err(|e| e.to_string())
                }
            },
            RetryPolicy::default(),
        )
    }

    fn start_with_connector<F, C>(
        connect: F,
        policy: RetryPolicy,
    ) -> (
        impl Future<Output = Option<Backend>>,
        mpsc::UnboundedReceiver<BackendEvent>,
    )
    where
        F: FnMut() -> C + Send + 'static,
        C: Future<Output = Result<fv_daemon::Connection, String>> + Send,
    {
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
                let (shutdown_tx, shutdown_rx) = oneshot::channel();
                let backend = Backend {
                    state: Arc::new(BackendState {
                        current: Mutex::new(None),
                        shutdown: Some(shutdown_tx),
                    }),
                    runtime: runtime.handle().clone(),
                };
                let state = Arc::downgrade(&backend.state);
                if ready_tx.send(Some(backend)).is_ok() {
                    runtime.block_on(async {
                        tokio::select! {
                            biased;
                            _ = shutdown_rx => {},
                            _ = async {
                                // futures-channel has no awaitable sender-closed notification.
                                // Check even when the server is silent or a connect is parked.
                                loop {
                                    if events_tx.is_closed() { break; }
                                    tokio::time::sleep(Duration::from_millis(100)).await;
                                }
                            } => {},
                            _ = reconnect(&state, &events_tx, connect, policy) => {},
                        }
                        clear_current(&state);
                    });
                }
                // Abort asynchronous local/client tasks too. A blocking helper cannot make
                // dropping the GUI wait forever for the runtime's default blocking shutdown.
                runtime.shutdown_timeout(Duration::from_millis(100));
            })
            .expect("spawn backend thread");
        (async move { ready_rx.await.ok().flatten() }, events_rx)
    }

    pub(crate) fn connection(&self) -> Option<Arc<LiveConnection>> {
        self.state.current.lock().unwrap().clone()
    }

    /// Make a call on the connection current now; the future may use any executor. Capturing
    /// before spawning is deliberate: a queued call must not move onto a replacement client.
    pub fn call<M: Rpc + 'static>(
        &self,
        params: M::Params,
    ) -> impl std::future::Future<Output = Result<M::Response, ClientError>> + use<M>
    where
        M::Params: Send + 'static,
        M::Response: Send + 'static,
    {
        let connection = self.connection();
        let task = self.runtime.spawn(async move {
            let connection = connection.ok_or(ClientError::Closed)?;
            connection
                .until_disconnected(connection.client.call::<M>(params))
                .await
        });
        async move {
            match task.await {
                Ok(r) => r,
                Err(_) => Err(ClientError::Closed),
            }
        }
    }

    pub fn respond(&self, id: RequestId, result: Value) {
        if let Some(connection) = self.connection() {
            self.runtime.spawn(async move {
                let _ = connection
                    .until_disconnected(connection.client.respond(id, result))
                    .await;
            });
        }
    }

    pub fn decline(&self, id: RequestId, message: &'static str) {
        if let Some(connection) = self.connection() {
            self.runtime.spawn(async move {
                let _ = connection
                    .until_disconnected(connection.client.decline(id, message))
                    .await;
            });
        }
    }
}

fn clear_current(state: &Weak<BackendState>) {
    if let Some(state) = state.upgrade()
        && let Some(connection) = state.current.lock().unwrap().take()
    {
        connection.disconnect();
    }
}

async fn reconnect<F, C>(
    state: &Weak<BackendState>,
    events: &mpsc::UnboundedSender<BackendEvent>,
    mut connect: F,
    policy: RetryPolicy,
) where
    F: FnMut() -> C,
    C: Future<Output = Result<fv_daemon::Connection, String>>,
{
    let mut delay = policy.initial_delay;
    loop {
        let connection = tokio::time::timeout(policy.attempt_timeout, connect()).await;
        let failure = match connection {
            Ok(Ok(connection)) => {
                let fv_daemon::Connection {
                    client,
                    mut notifications,
                    mut requests,
                    version_mismatch,
                    ..
                } = connection;
                let Some(owner) = state.upgrade() else {
                    return;
                };
                *owner.current.lock().unwrap() = Some(Arc::new(LiveConnection::new(client)));
                drop(owner);
                if events
                    .unbounded_send(BackendEvent::Connected { version_mismatch })
                    .is_err()
                {
                    return;
                }
                delay = policy.initial_delay;
                loop {
                    let event = tokio::select! {
                        n = notifications.recv() => match n {
                            Some(n) => BackendEvent::Notification(n),
                            None => break,
                        },
                        r = requests.recv() => match r {
                            Some(r) => BackendEvent::Request(r),
                            None => break,
                        },
                    };
                    if events.unbounded_send(event).is_err() {
                        return;
                    }
                }
                clear_current(state);
                "the connection to the server closed; reconnecting".to_string()
            }
            Ok(Err(error)) => error,
            Err(_) => "connecting to the server timed out; retrying".to_string(),
        };
        if events
            .unbounded_send(BackendEvent::Failed(failure))
            .is_err()
        {
            return;
        }
        tokio::time::sleep(delay).await;
        delay = delay.saturating_mul(2).min(policy.max_delay);
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

#[cfg(test)]
#[path = "backend_tests.rs"]
mod tests;
