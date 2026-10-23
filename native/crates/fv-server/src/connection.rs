use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use fv_protocol::jsonrpc::code;
use fv_protocol::methods::CLIENT_METHODS;
use fv_protocol::types::*;
use fv_protocol::{ClientRequest, ErrorObject, Message, PROTOCOL_VERSION, RequestId};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

use crate::policy::allows;
use crate::state::{ConnId, OUTBOUND_CAPACITY, ServerState};

const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// Serve one client until it hangs up. The byte stream can be a unix socket, an `ssh` child's
/// stdio or (in tests) an in-memory pipe; only `origin` says how far to trust it.
pub async fn serve_connection<R, W>(
    state: Arc<ServerState>,
    origin: ClientOrigin,
    reader: R,
    writer: W,
) where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::channel::<Message>(OUTBOUND_CAPACITY);
    let conn = state.register(tx.clone());

    let writer_task = tokio::spawn(async move {
        let mut sink = FramedWrite::new(writer, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
        while let Some(frame) = rx.recv().await {
            let line = serde_json::to_string(&frame).expect("frames serialize");
            if sink.send(line).await.is_err() {
                break;
            }
        }
    });

    let mut lines = FramedRead::new(reader, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
    let mut initialized = false;
    while let Some(line) = lines.next().await {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        // Messages that must follow the reply (a resumed thread's unanswered questions).
        let mut followups = Vec::new();
        let reply = handle_frame(
            &state,
            origin,
            conn,
            &mut initialized,
            &line,
            &mut followups,
        )
        .await;
        // Answers wait for room rather than being dropped: the client is owed one per request.
        let mut closed = false;
        for frame in reply.into_iter().chain(followups) {
            if tx.send(frame).await.is_err() {
                closed = true;
                break;
            }
        }
        if closed {
            break;
        }
    }

    state.unregister(conn);
    drop(tx);
    let _ = writer_task.await;
}

fn error(id: RequestId, code: i64, message: impl Into<String>) -> Message {
    Message::Error {
        id,
        error: ErrorObject::new(code, message),
    }
}

/// One incoming line → the answer to send back, if it calls for one.
async fn handle_frame(
    state: &Arc<ServerState>,
    origin: ClientOrigin,
    conn: ConnId,
    initialized: &mut bool,
    line: &str,
    followups: &mut Vec<Message>,
) -> Option<Message> {
    let frame: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        // No id to answer to; JSON-RPC answers a parse error with a null id.
        Err(_) => {
            return Some(error(
                RequestId::String(String::new()),
                code::PARSE_ERROR,
                "invalid JSON",
            ));
        }
    };
    let id = frame
        .get("id")
        .and_then(|v| serde_json::from_value::<RequestId>(v.clone()).ok());
    let method = frame
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned);

    // An answer to a request of ours (a question put to the user).
    if method.is_none()
        && let Some(id) = &id
        && (frame.get("result").is_some() || frame.get("error").is_some())
    {
        crate::prompt::resolve(state, id.clone(), &frame).await;
        return None;
    }

    let (Some(id), Some(method)) = (id, method.clone()) else {
        // A notification (or a stray response, which nothing waits for yet).
        if method.as_deref() == Some("initialized") {
            *initialized = true;
        }
        return None;
    };

    if !CLIENT_METHODS.contains(&method.as_str()) {
        return Some(error(
            id,
            code::METHOD_NOT_FOUND,
            format!("unknown method {method}"),
        ));
    }
    let request: ClientRequest = match serde_json::from_value(frame) {
        Ok(r) => r,
        Err(e) => return Some(error(id, code::INVALID_PARAMS, e.to_string())),
    };

    let is_initialize = matches!(request, ClientRequest::Initialize { .. });
    if is_initialize && *initialized {
        return Some(error(
            id,
            code::ALREADY_INITIALIZED,
            "initialize was already called",
        ));
    }
    if !is_initialize && !*initialized {
        return Some(error(id, code::NOT_INITIALIZED, "call initialize first"));
    }
    if !allows(origin, &request) {
        return Some(error(
            id,
            code::FORBIDDEN,
            format!("{method} is not available to this connection"),
        ));
    }

    match dispatch(state, conn, request, followups).await {
        Ok(result) => {
            if is_initialize {
                *initialized = true;
            }
            Some(Message::Response { id, result })
        }
        Err(e) => Some(Message::Error { id, error: e }),
    }
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, ErrorObject> {
    serde_json::to_value(v).map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))
}

async fn dispatch(
    state: &Arc<ServerState>,
    conn: ConnId,
    request: ClientRequest,
    followups: &mut Vec<Message>,
) -> Result<Value, ErrorObject> {
    match request {
        ClientRequest::Initialize { params, .. } => {
            if params.protocol_version != PROTOCOL_VERSION {
                return Err(ErrorObject::new(
                    code::INVALID_PARAMS,
                    format!(
                        "protocol version {} is not supported (server speaks {PROTOCOL_VERSION})",
                        params.protocol_version
                    ),
                ));
            }
            to_value(InitializeResponse {
                server_version: crate::SERVER_VERSION.to_string(),
                protocol_version: PROTOCOL_VERSION,
                data_dir: state.data_dir.display().to_string(),
            })
        }
        ClientRequest::ThreadList { params, .. } => to_value(ThreadListResponse {
            threads: state.threads(params.include_archived)?,
        }),
        ClientRequest::ThreadStart { params, .. } => {
            if let Some(label) = &params.model {
                crate::providers::resolve(state, label, None)
                    .map_err(|m| ErrorObject::new(code::INVALID_PARAMS, m))?;
            }
            let thread =
                state.create_thread(params.cwd, params.project, params.model, params.thinking)?;
            // Whoever starts a thread is watching it.
            state.runtime(&thread.id).subscribe(conn);
            to_value(ThreadStartResponse { thread })
        }
        ClientRequest::ThreadResume { params, .. } => {
            let thread = state
                .thread(&params.thread_id)?
                .ok_or_else(|| ErrorObject::new(code::INVALID_PARAMS, "thread not found"))?;
            // Subscribing and reading the snapshot are one step: nothing can happen to the
            // thread in between that the client would then see twice or not at all.
            let (turns, seq, running) = state.runtime(&params.thread_id).resume(conn);
            // Questions still waiting for an answer are put to this client too, after the reply.
            for request in state.pending_prompts(&params.thread_id) {
                followups.push(crate::prompt::request_frame(&request));
            }
            let token_usage = crate::providers::token_usage(state, &thread, &params.thread_id);
            to_value(ThreadResumeResponse {
                token_usage,
                thread,
                turns,
                seq,
                running,
            })
        }
        ClientRequest::ThreadUnsubscribe { params, .. } => {
            state.runtime(&params.thread_id).unsubscribe(conn);
            to_value(Empty {})
        }
        ClientRequest::TurnStart { params, .. } => {
            state
                .thread(&params.thread_id)?
                .ok_or_else(|| ErrorObject::new(code::INVALID_PARAMS, "thread not found"))?;
            let rt = state.runtime(&params.thread_id);
            // The caller sees its own turn without having to resume first.
            rt.subscribe(conn);
            let turn_id = uuid::Uuid::new_v4().to_string();
            let cancel = rt.begin(state, &turn_id).await.ok_or_else(|| {
                ErrorObject::new(
                    code::THREAD_BUSY,
                    "a turn is already running in this thread",
                )
            })?;
            crate::turn::spawn_turn(
                state.clone(),
                rt,
                params.thread_id,
                turn_id.clone(),
                params.text,
                cancel,
            );
            to_value(TurnStartResponse { turn_id })
        }
        ClientRequest::ThreadCompactStart { params, .. } => {
            state
                .thread(&params.thread_id)?
                .ok_or_else(|| ErrorObject::new(code::INVALID_PARAMS, "thread not found"))?;
            let rt = state.runtime(&params.thread_id);
            // Busy is the more useful answer: a first turn in flight has no history yet.
            if rt.is_running() {
                return Err(ErrorObject::new(
                    code::THREAD_BUSY,
                    "a turn is already running in this thread",
                ));
            }
            if rt.history().is_empty() {
                return Err(ErrorObject::new(
                    code::INVALID_PARAMS,
                    "there is nothing to summarize yet",
                ));
            }
            rt.subscribe(conn);
            let turn_id = uuid::Uuid::new_v4().to_string();
            let cancel = rt.begin(state, &turn_id).await.ok_or_else(|| {
                ErrorObject::new(
                    code::THREAD_BUSY,
                    "a turn is already running in this thread",
                )
            })?;
            crate::turn::spawn_compaction(state.clone(), rt, params.thread_id, turn_id, cancel);
            to_value(Empty {})
        }
        ClientRequest::ThreadModelSet { params, .. } => to_value(ThreadStartResponse {
            thread: crate::providers::set_thread_model(state, params)?,
        }),
        ClientRequest::ProviderList { .. } => to_value(crate::providers::list(state)?),
        ClientRequest::ProviderUpsert { params, .. } => {
            to_value(crate::providers::upsert(state, params)?)
        }
        ClientRequest::ProviderDelete { params, .. } => {
            crate::providers::delete(state, &params.provider_id)?;
            to_value(Empty {})
        }
        ClientRequest::ProviderReorder { params, .. } => {
            to_value(crate::providers::reorder(state, &params.ids)?)
        }
        ClientRequest::ProviderFetchModels { params, .. } => {
            to_value(crate::providers::fetch_models(state, params).await?)
        }
        ClientRequest::ModelList { .. } => to_value(crate::providers::model_list(state)?),
        ClientRequest::ModelDefaultsGet { .. } => to_value(crate::providers::read_defaults(state)?),
        ClientRequest::ModelDefaultsSet { params, .. } => {
            to_value(crate::providers::set_defaults(state, params)?)
        }
        ClientRequest::TurnInterrupt { params, .. } => {
            // Stopping a thread that is not running is not an error: the user's intent is met.
            state.runtime(&params.thread_id).interrupt();
            to_value(Empty {})
        }
    }
}
