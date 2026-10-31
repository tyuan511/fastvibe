//! A client of `fastvibe-server`: typed calls and a stream of notifications.
//!
//! The desktop GUI, the CLI and the tests all use this; it knows nothing about what is on the
//! other end of the byte stream, so a unix socket, an `ssh` child's stdio or an in-memory pipe
//! are all the same to it ([`Client::from_io`]).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use fv_protocol::jsonrpc::code;
use fv_protocol::methods::ClientNotification;
use fv_protocol::types::CancelRequestParams;
use fv_protocol::{ErrorObject, RequestId, Rpc, ServerNotification, ServerRequest};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

/// Largest single frame either side accepts.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub enum ClientError {
    /// The server answered with an error.
    Rpc(ErrorObject),
    /// The connection ended before the answer arrived.
    Closed,
    /// The answer did not have the shape the method promises.
    Decode(serde_json::Error),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Rpc(e) => write!(f, "server error {}: {}", e.code, e.message),
            ClientError::Closed => write!(f, "connection closed"),
            ClientError::Decode(e) => write!(f, "unexpected response: {e}"),
        }
    }
}

impl std::error::Error for ClientError {}

type Pending = Arc<Mutex<HashMap<RequestId, oneshot::Sender<Result<Value, ErrorObject>>>>>;

struct PendingCall {
    pending: Pending,
    outgoing: mpsc::Sender<Value>,
    id: RequestId,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        if self.pending.lock().unwrap().remove(&self.id).is_some() {
            let notification = ClientNotification::RequestCancel(CancelRequestParams {
                request_id: self.id.clone(),
            });
            if let Ok(frame) = serde_json::to_value(notification) {
                let _ = self.outgoing.try_send(frame);
            }
        }
    }
}

pub struct Client {
    outgoing: mpsc::Sender<Value>,
    pending: Pending,
    next_id: AtomicI64,
    requests: Mutex<Option<mpsc::UnboundedReceiver<ServerRequest>>>,
    tasks: Vec<tokio::task::AbortHandle>,
}

impl Drop for Client {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        self.pending.lock().unwrap().clear();
    }
}

impl Client {
    /// Connect to a server listening on a unix socket. Returns the client and the stream of
    /// notifications it pushes; dropping the receiver just discards them.
    pub async fn connect_unix(
        path: impl AsRef<Path>,
    ) -> std::io::Result<(Self, mpsc::UnboundedReceiver<ServerNotification>)> {
        let stream = UnixStream::connect(path).await?;
        let (r, w) = stream.into_split();
        Ok(Self::from_io(r, w))
    }

    /// HTTP password exchange; token storage belongs to the caller's private credential store.
    pub async fn login(origin: &str, password: &str, label: &str) -> Result<String, String> {
        let response = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?
            .post(format!("{}/api/login", origin.trim_end_matches('/')))
            .json(&json!({"password": password, "label": label}))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("login refused ({})", response.status()));
        }
        let value: Value = response.json().await.map_err(|error| error.to_string())?;
        value
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "login returned no token".into())
    }

    /// Connect with a bearer token before the server registers a protocol connection.
    /// Websocket payloads are the same JSON frames as Unix/SSH, with no legacy envelope.
    pub async fn connect_websocket(
        url: &str,
        token: &str,
    ) -> Result<(Self, mpsc::UnboundedReceiver<ServerNotification>), String> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio_tungstenite::tungstenite::{Message as WsMessage, client::IntoClientRequest};
        let mut request = url
            .into_client_request()
            .map_err(|error| error.to_string())?;
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {token}")
                .parse()
                .map_err(|_| "invalid token")?,
        );
        let (socket, _) = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .map_err(|_| "connection timed out")?
        .map_err(|error| error.to_string())?;
        let (client_io, adapter) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (adapter_read, mut adapter_write) = tokio::io::split(adapter);
        let mut lines = BufReader::new(adapter_read).lines();
        let (mut sink, mut stream) = socket.split();
        let adapter_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    line = lines.next_line() => match line {
                        Ok(Some(text)) => { if sink.send(WsMessage::Text(text.into())).await.is_err() { break; } }
                        _ => break,
                    },
                    frame = stream.next() => match frame {
                        Some(Ok(WsMessage::Text(text))) => {
                            if text.contains('\n') || text.contains('\r') { break; }
                            if adapter_write.write_all(text.as_bytes()).await.is_err() || adapter_write.write_all(b"\n").await.is_err() { break; }
                        }
                        Some(Ok(WsMessage::Ping(bytes))) => { if sink.send(WsMessage::Pong(bytes)).await.is_err() { break; } }
                        Some(Ok(WsMessage::Pong(_))) => {},
                        _ => break,
                    }
                }
            }
            let _ = sink.close().await;
        });
        let (mut client, notes) = Self::from_io(client_read, client_write);
        client.tasks.push(adapter_task.abort_handle());
        Ok((client, notes))
    }

    pub fn from_io<R, W>(
        reader: R,
        writer: W,
    ) -> (Self, mpsc::UnboundedReceiver<ServerNotification>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out_tx, mut out_rx) = mpsc::channel::<Value>(256);
        let (note_tx, note_rx) = mpsc::unbounded_channel();
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let pending: Pending = Arc::default();

        let writer_task = tokio::spawn(async move {
            let mut sink =
                FramedWrite::new(writer, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
            while let Some(frame) = out_rx.recv().await {
                if sink.send(frame.to_string()).await.is_err() {
                    break;
                }
            }
        });

        let reader_pending = pending.clone();
        let reader_task = tokio::spawn(async move {
            let mut lines =
                FramedRead::new(reader, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
            while let Some(Ok(line)) = lines.next().await {
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                route(&reader_pending, &note_tx, &request_tx, frame);
            }
            // The connection is gone: wake everyone still waiting.
            let waiting: Vec<_> = reader_pending.lock().unwrap().drain().collect();
            for (_, tx) in waiting {
                let _ = tx.send(Err(ErrorObject::new(
                    code::INTERNAL_ERROR,
                    "connection closed",
                )));
            }
        });

        (
            Self {
                outgoing: out_tx,
                pending,
                next_id: AtomicI64::new(1),
                requests: Mutex::new(Some(request_rx)),
                tasks: vec![writer_task.abort_handle(), reader_task.abort_handle()],
            },
            note_rx,
        )
    }

    /// Call a method and wait for its answer.
    pub async fn call<M: Rpc>(&self, params: M::Params) -> Result<M::Response, ClientError> {
        let params = serde_json::to_value(params).map_err(ClientError::Decode)?;
        let id = RequestId::Number(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let _pending = PendingCall {
            pending: self.pending.clone(),
            outgoing: self.outgoing.clone(),
            id: id.clone(),
        };
        let frame = json!({ "id": id, "method": M::METHOD, "params": params });
        if self.outgoing.send(frame).await.is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(ClientError::Closed);
        }
        match rx.await {
            Ok(Ok(value)) => serde_json::from_value(value).map_err(ClientError::Decode),
            Ok(Err(e)) if e.message == "connection closed" && e.code == code::INTERNAL_ERROR => {
                Err(ClientError::Closed)
            }
            Ok(Err(e)) => Err(ClientError::Rpc(e)),
            Err(_) => Err(ClientError::Closed),
        }
    }

    /// The server's requests to this client (questions for the user). Take it once; a client
    /// that never takes it leaves them unanswered, and the agent waits.
    pub fn take_requests(&self) -> Option<mpsc::UnboundedReceiver<ServerRequest>> {
        self.requests.lock().unwrap().take()
    }

    /// Answer a request of the server's with its result.
    pub async fn respond(&self, id: RequestId, result: Value) -> Result<(), ClientError> {
        self.outgoing
            .send(json!({ "id": id, "result": result }))
            .await
            .map_err(|_| ClientError::Closed)
    }

    /// Decline a request of the server's.
    pub async fn decline(&self, id: RequestId, message: &str) -> Result<(), ClientError> {
        let error = ErrorObject::new(code::INTERNAL_ERROR, message);
        self.outgoing
            .send(json!({ "id": id, "error": error }))
            .await
            .map_err(|_| ClientError::Closed)
    }

    /// Send a notification (no answer expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), ClientError> {
        self.outgoing
            .send(json!({ "method": method, "params": params }))
            .await
            .map_err(|_| ClientError::Closed)
    }
}

fn route(
    pending: &Pending,
    notes: &mpsc::UnboundedSender<ServerNotification>,
    requests: &mpsc::UnboundedSender<ServerRequest>,
    frame: Value,
) {
    let id = frame
        .get("id")
        .and_then(|v| serde_json::from_value::<RequestId>(v.clone()).ok());
    match (id, frame.get("method").is_some()) {
        (Some(id), false) => {
            let answer = match frame.get("error") {
                Some(e) => Err(serde_json::from_value(e.clone())
                    .unwrap_or_else(|_| ErrorObject::new(code::INTERNAL_ERROR, "malformed error"))),
                None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
            };
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let _ = tx.send(answer);
            }
        }
        (None, true) => {
            // A method this build does not know is ignored: a newer server may send more.
            if let Ok(note) = serde_json::from_value::<ServerNotification>(frame) {
                let _ = notes.send(note);
            }
        }
        // A request from the server; one this build does not know is ignored.
        (Some(_), true) => {
            if let Ok(request) = serde_json::from_value::<ServerRequest>(frame) {
                let _ = requests.send(request);
            }
        }
        _ => {}
    }
}
