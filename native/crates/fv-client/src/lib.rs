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
use fv_protocol::{ErrorObject, RequestId, Rpc, ServerNotification};
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

pub struct Client {
    outgoing: mpsc::Sender<Value>,
    pending: Pending,
    next_id: AtomicI64,
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
        let pending: Pending = Arc::default();

        tokio::spawn(async move {
            let mut sink =
                FramedWrite::new(writer, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
            while let Some(frame) = out_rx.recv().await {
                if sink.send(frame.to_string()).await.is_err() {
                    break;
                }
            }
        });

        let reader_pending = pending.clone();
        tokio::spawn(async move {
            let mut lines =
                FramedRead::new(reader, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
            while let Some(Ok(line)) = lines.next().await {
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                route(&reader_pending, &note_tx, frame);
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
            },
            note_rx,
        )
    }

    /// Call a method and wait for its answer.
    pub async fn call<M: Rpc>(&self, params: M::Params) -> Result<M::Response, ClientError> {
        let id = RequestId::Number(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let frame = json!({ "id": id, "method": M::METHOD, "params": serde_json::to_value(params).map_err(ClientError::Decode)? });
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

    /// Send a notification (no answer expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), ClientError> {
        self.outgoing
            .send(json!({ "method": method, "params": params }))
            .await
            .map_err(|_| ClientError::Closed)
    }
}

fn route(pending: &Pending, notes: &mpsc::UnboundedSender<ServerNotification>, frame: Value) {
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
        // A server → client request: none are defined yet.
        _ => {}
    }
}
