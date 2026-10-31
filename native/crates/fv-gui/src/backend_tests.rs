use super::*;
use serde_json::json;
use tokio::io::{
    AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf,
};

struct Echo;
impl Rpc for Echo {
    const METHOD: &'static str = "test/echo";
    type Params = Value;
    type Response = Value;
}

struct Peer {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    notifications: tokio::sync::mpsc::UnboundedSender<ServerNotification>,
    requests: tokio::sync::mpsc::UnboundedSender<ServerRequest>,
}

fn connection() -> (fv_daemon::Connection, Peer) {
    let (local, remote) = tokio::io::duplex(64 * 1024);
    let (read, write) = tokio::io::split(local);
    let (client, _) = Client::from_io(read, write);
    let (notifications, notes) = tokio::sync::mpsc::unbounded_channel();
    let (requests, asks) = tokio::sync::mpsc::unbounded_channel();
    let (read, write) = tokio::io::split(remote);
    (
        fv_daemon::Connection {
            client,
            notifications: notes,
            requests: asks,
            server_version: "test".into(),
            features: Vec::new(),
            version_mismatch: true,
            has_running_turns: Some(false),
        },
        Peer {
            reader: BufReader::new(read),
            writer: write,
            notifications,
            requests,
        },
    )
}

fn policy() -> RetryPolicy {
    RetryPolicy {
        attempt_timeout: Duration::from_millis(100),
        initial_delay: Duration::from_millis(20),
        max_delay: Duration::from_millis(40),
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(3), future)
        .await
        .expect("backend must make progress")
}

async fn next(events: &mut mpsc::UnboundedReceiver<BackendEvent>) -> BackendEvent {
    bounded(events.next())
        .await
        .expect("backend event stream open")
}

async fn frame(peer: &mut Peer) -> Value {
    let mut line = String::new();
    assert_ne!(bounded(peer.reader.read_line(&mut line)).await.unwrap(), 0);
    serde_json::from_str(&line).unwrap()
}

async fn answer(peer: &mut Peer, request: Value) {
    peer.writer
        .write_all(
            format!(
                "{}\n",
                json!({"id": request["id"], "result": request["params"]})
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn retained_handle_reconnects_without_replaying_calls_or_old_replies() {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let receiver = Arc::new(tokio::sync::Mutex::new(receiver));
    let (ready, mut events) = Backend::start_with_connector(
        move || {
            let receiver = receiver.clone();
            async move { receiver.lock().await.recv().await.unwrap() }
        },
        policy(),
    );
    let backend = bounded(ready).await.unwrap();
    assert!(matches!(
        bounded(backend.call::<Echo>(json!("offline"))).await,
        Err(ClientError::Closed)
    ));
    let (_cancel, url, oauth) = backend.start_mcp_oauth("server".into(), None, None, Vec::new());
    assert_eq!(bounded(oauth).await.unwrap_err(), "connection closed");
    assert!(bounded(url).await.is_err());
    let retained = backend.clone();
    let (first, mut peer) = connection();
    assert!(sender.send(Ok(first)).is_ok());
    assert!(matches!(
        next(&mut events).await,
        BackendEvent::Connected {
            version_mismatch: true
        }
    ));

    // A request already received by the server must fail, never execute again after reconnect.
    let pending = backend.call::<Echo>(json!("do-once"));
    assert_eq!(frame(&mut peer).await["params"], "do-once");
    let old = backend.connection().unwrap();
    drop(peer.requests);
    assert!(matches!(next(&mut events).await, BackendEvent::Failed(_)));
    assert!(matches!(bounded(pending).await, Err(ClientError::Closed)));
    assert!(matches!(
        bounded(backend.call::<Echo>(json!("also-offline"))).await,
        Err(ClientError::Closed)
    ));
    // These do not queue a stale response for the next server's potentially reused id.
    backend.respond(RequestId::Number(1), json!("stale"));
    backend.decline(RequestId::Number(2), "stale");

    let (second, mut peer) = connection();
    let question = ServerRequest::UserInput {
        id: RequestId::Number(1),
        params: fv_protocol::types::UserInputRequest {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            call_id: "call".into(),
            questions: Vec::new(),
        },
    };
    // Already queued traffic cannot overtake Connected, which invalidates old GUI prompts.
    peer.requests.send(question.clone()).unwrap();
    assert!(sender.send(Ok(second)).is_ok());
    assert!(matches!(
        next(&mut events).await,
        BackendEvent::Connected { .. }
    ));
    assert!(
        matches!(next(&mut events).await, BackendEvent::Request(request) if request == question)
    );
    assert!(!Arc::ptr_eq(&old, &backend.connection().unwrap()));
    assert!(matches!(
        old.until_disconnected(old.client.call::<Echo>(Value::Null))
            .await,
        Err(ClientError::Closed)
    ));
    let call = retained.call::<Echo>(json!("new"));
    let request = frame(&mut peer).await;
    assert_eq!(
        request["params"], "new",
        "no earlier RPC or response is replayed"
    );
    answer(&mut peer, request).await;
    assert_eq!(bounded(call).await.unwrap(), "new");

    // The first event in a generation is Connected, followed by each event only once.
    peer.notifications
        .send(ServerNotification::SettingsChanged(Default::default()))
        .unwrap();
    assert!(matches!(
        next(&mut events).await,
        BackendEvent::Notification(_)
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), events.next())
            .await
            .is_err()
    );
    drop(backend);
    assert_eq!(bounded(retained.task(async { 42 })).await.unwrap(), 42);
    drop(retained);
    assert!(bounded(events.next()).await.is_none());
}

#[tokio::test]
async fn notification_stream_closure_also_retries_and_cancels_parked_local_work() {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let receiver = Arc::new(tokio::sync::Mutex::new(receiver));
    let (ready, mut events) = Backend::start_with_connector(
        move || {
            let receiver = receiver.clone();
            async move { receiver.lock().await.recv().await.unwrap() }
        },
        policy(),
    );
    let backend = bounded(ready).await.unwrap();
    let (first, peer) = connection();
    assert!(sender.send(Ok(first)).is_ok());
    assert!(matches!(
        next(&mut events).await,
        BackendEvent::Connected { .. }
    ));
    let (_cancel, url, oauth) = backend.start_mcp_oauth("server".into(), None, None, Vec::new());
    let mut peer = peer;
    assert_eq!(frame(&mut peer).await["method"], "mcp/auth/begin");
    let connection = backend.connection().unwrap();
    let local = backend.task(async move {
        connection
            .until_disconnected(std::future::pending::<Result<(), ClientError>>())
            .await
    });
    drop(peer.notifications);
    assert!(matches!(next(&mut events).await, BackendEvent::Failed(_)));
    assert!(matches!(
        bounded(local).await.unwrap(),
        Err(ClientError::Closed)
    ));
    assert!(backend.connection().is_none());
    assert_eq!(bounded(oauth).await.unwrap_err(), "connection closed");
    assert!(bounded(url).await.is_err());
}

#[tokio::test]
async fn failed_and_stalled_attempts_retry_with_capped_delay_until_dropped() {
    let (attempts, mut attempts_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut count = 0;
    let (ready, mut events) = Backend::start_with_connector(
        move || {
            count += 1;
            attempts.send((count, std::time::Instant::now())).unwrap();
            async move {
                if count == 1 {
                    std::future::pending::<()>().await;
                }
                Err("temporarily unavailable".into())
            }
        },
        policy(),
    );
    let backend = bounded(ready).await.unwrap();
    let (_, first) = bounded(attempts_rx.recv()).await.unwrap();
    assert!(
        matches!(next(&mut events).await, BackendEvent::Failed(text) if text.contains("timed out"))
    );
    let (_, second) = bounded(attempts_rx.recv()).await.unwrap();
    assert!(second.duration_since(first) >= Duration::from_millis(115));
    for _ in 0..3 {
        assert!(matches!(next(&mut events).await, BackendEvent::Failed(_)));
    }
    let (_, third) = bounded(attempts_rx.recv()).await.unwrap();
    let (_, fourth) = bounded(attempts_rx.recv()).await.unwrap();
    assert!(third.duration_since(second) >= Duration::from_millis(35));
    assert!(fourth.duration_since(third) >= Duration::from_millis(35));
    assert!(
        fourth.duration_since(third) < Duration::from_secs(1),
        "backoff stays bounded"
    );
    drop(backend);
    while bounded(events.next()).await.is_some() {}
}

struct Dropped(Option<std::sync::mpsc::Sender<()>>);
impl Drop for Dropped {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(());
    }
}

#[tokio::test]
async fn dropping_gui_cancels_idle_connection_attempt_backoff_and_runtime_tasks() {
    for mode in 0..4 {
        let (stopped, stop_rx) = std::sync::mpsc::channel();
        let probe = Dropped(Some(stopped));
        let mut held_peer = None;
        let mut connection = None;
        if mode == 0 || mode == 3 {
            let (conn, peer) = self::connection();
            connection = Some(conn);
            held_peer = Some(peer);
        }
        let (ready, mut events) = Backend::start_with_connector(
            move || {
                let _ = &probe;
                let connection = connection.take();
                async move {
                    if let Some(connection) = connection {
                        return Ok(connection);
                    }
                    if mode == 1 {
                        std::future::pending::<()>().await;
                    }
                    Err("retry".into())
                }
            },
            RetryPolicy {
                attempt_timeout: Duration::from_secs(60),
                initial_delay: Duration::from_secs(60),
                max_delay: Duration::from_secs(60),
            },
        );
        let backend = bounded(ready).await.unwrap();
        if mode != 1 {
            let _ = next(&mut events).await;
        }
        let (task_stopped, task_stop_rx) = tokio::sync::oneshot::channel();
        let (started, task_started) = tokio::sync::oneshot::channel();
        backend.task(async move {
            struct Guard(Option<oneshot::Sender<()>>);
            impl Drop for Guard {
                fn drop(&mut self) {
                    let _ = self.0.take().unwrap().send(());
                }
            }
            let _guard = Guard(Some(task_stopped));
            let _ = started.send(());
            std::future::pending::<()>().await;
        });
        bounded(task_started).await.unwrap();
        if mode == 3 {
            drop(events); // A dropped event consumer also owns the GUI lifetime.
        } else {
            drop(backend.clone()); // One clone dropping must not terminate the backend.
            assert!(stop_rx.try_recv().is_err());
            drop(backend);
        }
        bounded(task_stop_rx).await.unwrap();
        stop_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("runner dropped its connector");
        if let Some(mut peer) = held_peer {
            let mut bytes = Vec::new();
            bounded(peer.reader.read_to_end(&mut bytes)).await.unwrap();
        }
    }
}

#[tokio::test]
async fn dropping_unawaited_ready_does_not_leave_a_runner() {
    let (stopped, stop_rx) = std::sync::mpsc::channel();
    let probe = Dropped(Some(stopped));
    let (ready, _events) = Backend::start_with_connector(
        move || {
            let _ = &probe;
            std::future::pending::<Result<fv_daemon::Connection, String>>()
        },
        policy(),
    );
    drop(ready);
    // Keep events alive: cancellation must be driven by the undelivered handle as well.
    stop_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("startup runner exits");
}
