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
    state.start_services();
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
    let mut resource_reads = tokio::task::JoinSet::new();
    let mut entry_predecessor: Option<tokio::sync::oneshot::Receiver<()>> = None;
    while let Some(line) = lines.next().await {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        // Resource reads and OAuth discovery/exchange may take a minute. Keep control messages
        // flowing meanwhile. OAuth results check their captured config again before committing;
        // ordinary configuration mutations still retain their arrival order. Tree mutations
        // also leave Stop/question replies flowing; their own predecessor chain retains order.
        let resource = serde_json::from_str::<Value>(&line).ok().filter(|frame| {
            initialized
                && matches!(
                    frame.get("method").and_then(Value::as_str),
                    Some(
                        "mcp/resources"
                            | "mcp/resourceTemplates"
                            | "mcp/readResource"
                            | "mcp/auth/begin"
                            | "mcp/auth/complete"
                            | "workspace/createEntry"
                            | "workspace/renameEntry"
                            | "workspace/deleteEntry"
                            | "workspace/writeFile"
                            | "terminal/copy"
                            | "memory/read"
                            | "memory/configure"
                            | "memory/run"
                            | "memory/clear"
                    )
                )
        });
        if let Some(frame) = resource {
            while resource_reads.try_join_next().is_some() {}
            if resource_reads.len() >= 16 {
                if let Some(id) = frame
                    .get("id")
                    .and_then(|id| serde_json::from_value(id.clone()).ok())
                {
                    let _ = tx
                        .send(error(id, code::OVERLOADED, "too many background requests"))
                        .await;
                }
                continue;
            }
            let state = state.clone();
            let tx = tx.clone();
            let ordered = matches!(
                frame.get("method").and_then(Value::as_str),
                Some(
                    "workspace/createEntry"
                        | "workspace/renameEntry"
                        | "workspace/deleteEntry"
                        | "workspace/writeFile"
                        | "memory/read"
                        | "memory/configure"
                        | "memory/run"
                        | "memory/clear"
                )
            );
            let (predecessor, completed) = if ordered {
                let (completed, next) = tokio::sync::oneshot::channel();
                (entry_predecessor.replace(next), Some(completed))
            } else {
                (None, None)
            };
            resource_reads.spawn(async move {
                if let Some(predecessor) = predecessor {
                    let _ = predecessor.await;
                }
                let _completed = completed;
                let mut ready = true;
                let mut followups = Vec::new();
                if let Some(reply) =
                    handle_frame(&state, origin, conn, &mut ready, &line, &mut followups).await
                {
                    let _ = tx.send(reply).await;
                }
            });
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

    resource_reads.abort_all();
    while resource_reads.join_next().await.is_some() {}
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
        // Only a successful initialize response opens the gate. A notification on its own
        // (including after a refused version) cannot authenticate a protocol handshake.
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
                features: vec![
                    "sidebarSettings".into(),
                    "skills".into(),
                    "mcp".into(),
                    "mcpConfigEdit".into(),
                    "mcpOAuth".into(),
                    "execSessions".into(),
                    "workspaceEntries".into(),
                    "terminalInteraction".into(),
                    "memory".into(),
                ],
                data_dir: state.data_dir.display().to_string(),
                build_fingerprint: crate::build_fingerprint(),
                has_running_turns: Some(state.has_running_turns()),
            })
        }
        ClientRequest::ThreadList { params, .. } => to_value(ThreadListResponse {
            threads: state.threads(params.include_archived)?,
        }),
        ClientRequest::ThreadSearch { params, .. } => {
            // Disk scans never occupy the executor that drives agent streams.
            let state = state.clone();
            let result = tokio::task::spawn_blocking(move || crate::search::search(&state, params))
                .await
                .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))??;
            to_value(result)
        }
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
            let mut thread = state
                .thread(&params.thread_id)?
                .ok_or_else(|| ErrorObject::new(code::INVALID_PARAMS, "thread not found"))?;
            if thread.unread {
                thread.unread = false;
                state
                    .store
                    .db
                    .put_thread(&thread)
                    .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
                state.broadcast(fv_protocol::ServerNotification::CatalogChanged(
                    CatalogChanged {},
                ));
            }
            // Subscribing and reading the snapshot are one step: nothing can happen to the
            // thread in between that the client would then see twice or not at all.
            let model = crate::providers::model_for(state, &thread);
            let (turns, seq, running, stats, token_usage) = state
                .runtime(&params.thread_id)
                .resume(conn, model.as_ref());
            // Questions still waiting for an answer are put to this client too, after the reply.
            for request in state.pending_prompts(&params.thread_id) {
                followups.push(crate::prompt::request_frame(&request));
            }
            let rt = state.runtime(&params.thread_id);
            let queue = crate::queue::state_for(state, &rt, &params.thread_id);
            let suggestion = rt.suggestion();
            to_value(ThreadResumeResponse {
                stats,
                token_usage,
                thread,
                turns,
                seq,
                running,
                queue,
                suggestion,
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
        ClientRequest::ThreadUpdate { params, .. } => to_value(ThreadStartResponse {
            thread: state.update_thread(params)?,
        }),
        ClientRequest::ThreadFork { params, .. } => {
            let thread = state.fork_thread(&params.thread_id)?;
            state.runtime(&thread.id).subscribe(conn);
            to_value(ThreadStartResponse { thread })
        }
        ClientRequest::ThreadWorktreeCreate { params, .. } => {
            let thread_id = params.thread_id.clone();
            let thread = crate::worktree::create(state, &thread_id, params)?;
            to_value(ThreadStartResponse { thread })
        }
        ClientRequest::ThreadWorktreeBind { params, .. } => {
            let thread = crate::worktree::bind_existing(state, &params.thread_id, &params.path)?;
            to_value(ThreadStartResponse { thread })
        }
        ClientRequest::ThreadWorktreeUnbind { params, .. } => {
            let thread = crate::worktree::unbind(state, &params.thread_id, params.remove)?;
            to_value(ThreadStartResponse { thread })
        }
        ClientRequest::ThreadWorktreeList { params, .. } => {
            let cwd = state
                .thread(&params.thread_id)?
                .and_then(|t| t.cwd)
                .unwrap_or_default();
            to_value(ThreadWorktreeListResponse {
                worktrees: if cwd.is_empty() {
                    Vec::new()
                } else {
                    crate::worktree::list(&cwd)
                },
            })
        }
        ClientRequest::ThreadDelete { params, .. } => {
            state.delete_thread(&params.thread_id)?;
            to_value(Empty {})
        }
        ClientRequest::ProjectList { .. } => to_value(crate::projects::list(state)?),
        ClientRequest::ProjectCreate { params, .. } => {
            to_value(crate::projects::create(state, params)?)
        }
        ClientRequest::ProjectUpdate { params, .. } => {
            to_value(crate::projects::update(state, params)?)
        }
        ClientRequest::ProjectRemove { params, .. } => {
            to_value(crate::projects::remove(state, &params.path)?)
        }
        ClientRequest::WorkspaceReadDir { params, .. } => {
            let path = crate::workspace::resolve(params.cwd.as_deref(), &params.path);
            to_value(crate::workspace::read_dir(&path.display().to_string())?)
        }
        ClientRequest::WorkspacePreview { params, .. } => {
            let path = crate::workspace::resolve(params.cwd.as_deref(), &params.path);
            to_value(crate::workspace::preview(&path.display().to_string()))
        }
        ClientRequest::WorkspaceWriteFile { params, .. } => {
            crate::workspace_entries::apply(
                state.clone(),
                crate::workspace_entries::Operation::Write(params),
            )
            .await
        }
        ClientRequest::WorkspaceCreateEntry { params, .. } => {
            crate::workspace_entries::apply(
                state.clone(),
                crate::workspace_entries::Operation::Create(params),
            )
            .await
        }
        ClientRequest::WorkspaceRenameEntry { params, .. } => {
            crate::workspace_entries::apply(
                state.clone(),
                crate::workspace_entries::Operation::Rename(params),
            )
            .await
        }
        ClientRequest::WorkspaceDeleteEntry { params, .. } => {
            crate::workspace_entries::apply(
                state.clone(),
                crate::workspace_entries::Operation::Delete(params),
            )
            .await
        }
        ClientRequest::WorkspaceSearchFiles { params, .. } => {
            // A walk of a large tree is blocking work; it must not occupy the executor that
            // drives agent streams.
            let state = state.clone();
            let hits = tokio::task::spawn_blocking(move || {
                let hits = crate::project_files::search(
                    params.cwd.as_deref(),
                    params.query.as_deref(),
                    &params.other_folders,
                );
                hits.into_iter()
                    .map(|hit| FileHit {
                        relative: hit.relative,
                        path: hit.path,
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
            let _ = state;
            to_value(SearchFilesResponse { hits })
        }
        ClientRequest::WorkspaceGitStatus { params, .. } => {
            to_value(crate::git::status(&params.cwd)?)
        }
        ClientRequest::WorkspaceGitDiff { params, .. } => to_value(crate::git::diff(params)?),
        ClientRequest::WorkspaceGitComparison { params, .. } => to_value(
            crate::git::comparison_files(&params.cwd, params.revision.as_deref())?,
        ),
        ClientRequest::WorkspaceGitHistory { params, .. } => to_value(crate::git::history(params)?),
        ClientRequest::WorkspaceGitStage { params, .. } => {
            to_value(crate::git::stage(&params.cwd, &params.paths, params.all)?)
        }
        ClientRequest::WorkspaceGitUnstage { params, .. } => {
            to_value(crate::git::unstage(&params.cwd, &params.paths)?)
        }
        ClientRequest::WorkspaceGitDiscard { params, .. } => {
            to_value(crate::git::discard(&params.cwd, &params.paths)?)
        }
        ClientRequest::WorkspaceGitDeleteUntracked { params, .. } => {
            to_value(crate::git::delete_untracked(&params.cwd, &params.paths)?)
        }
        ClientRequest::WorkspaceGitCommit { params, .. } => to_value(crate::git::commit(
            &params.cwd,
            &params.message,
            params.amend,
        )?),
        ClientRequest::TerminalStart { params, .. } => to_value(state.terminals.start(
            &params.cwd,
            params.cols,
            params.rows,
        )?),
        ClientRequest::TerminalWrite { params, .. } => {
            state.terminals.write(&params.id, &params.data)?;
            to_value(Empty {})
        }
        ClientRequest::TerminalResize { params, .. } => {
            state
                .terminals
                .resize(&params.id, params.cols, params.rows)?;
            to_value(Empty {})
        }
        ClientRequest::TerminalRead { params, .. } => to_value(state.terminals.read_view(&params)?),
        ClientRequest::TerminalCopy { params, .. } => {
            let state = state.clone();
            let text = tokio::task::spawn_blocking(move || state.terminals.copy(&params))
                .await
                .map_err(|error| ErrorObject::new(code::INTERNAL_ERROR, error.to_string()))??;
            to_value(TerminalCopyResponse { text })
        }
        ClientRequest::TerminalKill { params, .. } => {
            state.terminals.kill(&params.id);
            to_value(Empty {})
        }
        ClientRequest::SettingsGet { .. } => to_value(crate::settings::read(state)?),
        ClientRequest::McpList { .. } => to_value(state.mcp.list()),
        ClientRequest::McpAuthBegin { params, .. } => to_value(
            state
                .mcp
                .auth_begin(conn, params)
                .await
                .map_err(|e| ErrorObject::new(code::INVALID_PARAMS, e))?,
        ),
        ClientRequest::McpAuthComplete { params, .. } => to_value(
            state
                .mcp
                .auth_complete(conn, params)
                .await
                .map_err(|e| ErrorObject::new(code::INVALID_PARAMS, e))?,
        ),
        ClientRequest::McpAuthCancel { params, .. } => {
            state
                .mcp
                .auth_cancel(conn, &params.flow_id)
                .map_err(|e| ErrorObject::new(code::INVALID_PARAMS, e))?;
            to_value(Empty {})
        }
        ClientRequest::McpAuthForget { params, .. } => to_value(
            state
                .mcp
                .auth_forget(&params.server_id)
                .await
                .map_err(|e| ErrorObject::new(code::INVALID_PARAMS, e))?,
        ),
        ClientRequest::McpUpdate { params, .. } => to_value(
            state
                .mcp
                .update(params)
                .await
                .map_err(|e| ErrorObject::new(code::INVALID_PARAMS, e))?,
        ),
        ClientRequest::McpSet { params, .. } => to_value(
            state
                .mcp
                .set(params.servers)
                .await
                .map_err(|e| ErrorObject::new(code::INVALID_PARAMS, e))?,
        ),
        ClientRequest::McpImport { params, .. } => to_value(
            state
                .mcp
                .import(&params.json)
                .await
                .map_err(|e| ErrorObject::new(code::INVALID_PARAMS, e))?,
        ),
        ClientRequest::McpReconnect { params, .. } => {
            state
                .mcp
                .begin_reconnect(&params.server_id)
                .map_err(|e| ErrorObject::new(code::INVALID_PARAMS, e))?;
            to_value(state.mcp.list())
        }
        ClientRequest::McpResources { params, .. } => to_value(McpResourceResponse {
            data: state
                .mcp
                .resources(params.server_id.as_deref(), false, params.cursor)
                .await
                .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e))?,
        }),
        ClientRequest::McpResourceTemplates { params, .. } => to_value(McpResourceResponse {
            data: state
                .mcp
                .resources(params.server_id.as_deref(), true, params.cursor)
                .await
                .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e))?,
        }),
        ClientRequest::McpReadResource { params, .. } => to_value(McpResourceResponse {
            data: state
                .mcp
                .read_resource(&params.server_id, &params.uri)
                .await
                .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e))?,
        }),
        ClientRequest::SettingsSet { params, .. } => to_value(crate::settings::set(state, params)?),
        ClientRequest::MemoryRead { .. } => {
            state.memory.refresh_snapshot().await;
            to_value(state.memory.state())
        }
        ClientRequest::MemoryConfigure { params, .. } => {
            to_value(state.memory.configure(state, params).await?)
        }
        ClientRequest::MemoryRun { .. } => to_value(state.memory.run(state)),
        ClientRequest::MemoryClear { .. } => to_value(state.memory.clear(state).await?),
        ClientRequest::SkillList { params, .. } => {
            let state = state.clone();
            to_value(
                tokio::task::spawn_blocking(move || {
                    state.context.list_for_folders(
                        params.cwd.as_deref().map(std::path::Path::new),
                        &params.other_folders,
                    )
                })
                .await
                .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?,
            )
        }
        ClientRequest::SkillRead { params, .. } => {
            let state = state.clone();
            to_value(
                tokio::task::spawn_blocking(move || {
                    state.context.read_for_folders(
                        params.cwd.as_deref().map(std::path::Path::new),
                        &params.other_folders,
                        &params.name,
                    )
                })
                .await
                .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))??,
            )
        }
        ClientRequest::SkillCreate { params, .. } => {
            let state = state.clone();
            let changed = state.clone();
            tokio::task::spawn_blocking(move || state.context.create(params))
                .await
                .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))??;
            changed.broadcast(fv_protocol::ServerNotification::SkillsChanged(Empty {}));
            to_value(Empty {})
        }
        ClientRequest::SkillRemove { params, .. } => {
            let state = state.clone();
            let changed = state.clone();
            tokio::task::spawn_blocking(move || {
                state.context.remove_for_folders(
                    params.cwd.as_deref().map(std::path::Path::new),
                    &params.other_folders,
                    &params.name,
                )
            })
            .await
            .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))??;
            changed.broadcast(fv_protocol::ServerNotification::SkillsChanged(Empty {}));
            to_value(Empty {})
        }
        ClientRequest::SkillImport { params, .. } => {
            let state = state.clone();
            let changed = state.clone();
            tokio::task::spawn_blocking(move || {
                state.context.import(std::path::Path::new(&params.path))
            })
            .await
            .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))??;
            changed.broadcast(fv_protocol::ServerNotification::SkillsChanged(Empty {}));
            to_value(Empty {})
        }
        ClientRequest::TurnSteer { params, .. } => {
            state
                .thread(&params.thread_id)?
                .ok_or_else(|| ErrorObject::new(code::INVALID_PARAMS, "thread not found"))?;
            let rt = state.runtime(&params.thread_id);
            rt.subscribe(conn);
            match rt.steer(&params.expected_turn_id, params.text.clone()) {
                Ok(()) => to_value(TurnSteerResponse {
                    turn_id: params.expected_turn_id,
                }),
                // A different run is live: codex's client retries once with the turn id the
                // server reports, so the server does that retry itself and answers with the id
                // it actually used. One round trip, same outcome.
                Err(crate::runtime::SteerRefused::OtherTurn(turn_id)) => {
                    rt.steer(&turn_id, params.text.clone()).map_err(|_| {
                        ErrorObject::new(code::NO_ACTIVE_TURN, "the run ended before the steer")
                    })?;
                    to_value(TurnSteerResponse { turn_id })
                }
                // Nothing is running, so there is nothing to steer into. That is not a failure
                // of the request but a different question — codex's client then queues the
                // words as its next prompt, and this is the error it acts on.
                Err(crate::runtime::SteerRefused::NotRunning) => Err(ErrorObject::new(
                    code::NO_ACTIVE_TURN,
                    "nothing is running in this thread",
                )),
            }
        }
        ClientRequest::TurnInterrupt { params, .. } => {
            // Stopping a thread that is not running is not an error: the user's intent is met.
            state.runtime(&params.thread_id).interrupt();
            to_value(Empty {})
        }
        ClientRequest::TurnRewind { params, .. } => {
            state
                .thread(&params.thread_id)?
                .ok_or_else(|| ErrorObject::new(code::INVALID_PARAMS, "thread not found"))?;
            let rt = state.runtime(&params.thread_id);
            rt.subscribe(conn);
            let out = crate::turn::rewind(
                state.clone(),
                rt,
                params.thread_id,
                params.turn_id,
                params.text,
                params.rewind_files,
            )
            .await?;
            to_value(out)
        }
        ClientRequest::TurnEnqueue { params, .. } => {
            state
                .thread(&params.thread_id)?
                .ok_or_else(|| ErrorObject::new(code::INVALID_PARAMS, "thread not found"))?;
            let rt = state.runtime(&params.thread_id);
            rt.subscribe(conn);
            let row = crate::queue::enqueue(state, &rt, &params.thread_id, params.text)?;
            crate::queue::publish(state, &rt, &params.thread_id).await;
            // Queued onto an idle thread there is nothing to wait for: it goes now, rather than
            // sitting there until something else starts a turn.
            if !rt.is_running() {
                crate::turn::start_next(state.clone(), rt.clone(), &params.thread_id).await;
            }
            to_value(crate::queue::queue_item(&row))
        }
        ClientRequest::TurnQueueRemove { params, .. } => {
            let rt = state.runtime(&params.thread_id);
            crate::queue::take(state, &rt, &params.thread_id, &params.item_id);
            crate::queue::publish(state, &rt, &params.thread_id).await;
            to_value(Empty {})
        }
        ClientRequest::TurnQueueSendNow { params, .. } => {
            let rt = state.runtime(&params.thread_id);
            crate::queue::send_now(state, &rt, &params.thread_id, &params.item_id)?;
            crate::queue::publish(state, &rt, &params.thread_id).await;
            // Nothing was running to interrupt, so nothing will settle and pick it up: start it.
            if !rt.is_running() {
                crate::turn::start_next(state.clone(), rt.clone(), &params.thread_id).await;
            }
            to_value(Empty {})
        }
        ClientRequest::TurnQueueResume { params, .. } => {
            let rt = state.runtime(&params.thread_id);
            crate::queue::resume(state, &rt, &params.thread_id);
            crate::queue::publish(state, &rt, &params.thread_id).await;
            // Resuming an idle thread is what lets its held prompts go; one that is still
            // working picks them up when it settles.
            if !rt.is_running() {
                crate::turn::start_next(state.clone(), rt.clone(), &params.thread_id).await;
            }
            to_value(Empty {})
        }
    }
}
