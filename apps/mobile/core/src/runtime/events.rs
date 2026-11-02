use super::*;
use crate::transcript::trim_values;

#[cfg(feature = "iroh-transport")]
pub(super) async fn handle_server_message(
    shared: &Arc<SharedCore>,
    generation: u64,
    message: AppServerMessage,
    writer: &mut crate::iroh_transport::IrohWriter,
) {
    if lock(&shared.connection).generation != generation {
        return;
    }
    if !matches!(message, AppServerMessage::Welcome { .. }) && lock(&shared.welcome).is_none() {
        return;
    }
    match message {
        AppServerMessage::Welcome {
            session_id,
            capabilities,
            epoch,
            features,
            handshake,
        } => {
            let compatible = handshake
                .get("protocol")
                .and_then(serde_json::Value::as_str)
                .map(|value| value == APP_PROTOCOL)
                .unwrap_or(false)
                && handshake
                    .get("protocolVersion")
                    .and_then(serde_json::Value::as_u64)
                    .map(|value| value == APP_PROTOCOL_VERSION as u64)
                    .unwrap_or(false);
            if !compatible {
                let message = "incompatible App Protocol welcome";
                let mut connection = lock(&shared.connection);
                connection.status = "error".into();
                connection.error = Some(message.into());
                if let Some(sender) = connection.outbound.take() {
                    let _ = sender.send(TransportCommand::Close);
                }
                shared.push_event(serde_json::json!({
                    "type":"connection_error",
                    "code":"protocol.incompatible",
                    "message":message
                }));
                return;
            }
            *lock(&shared.welcome) = Some(WelcomeState {
                session_id: session_id.clone(),
                epoch,
                capabilities: capabilities.clone(),
                features: features.clone().unwrap_or(serde_json::Value::Null),
            });
            lock(&shared.wire_cursors).clear();
            lock(&shared.connection).status = "ready".into();
            shared.push_event(serde_json::json!({
                "type":"welcome",
                "sessionId":session_id,
                "capabilities":capabilities,
                "features":features
            }));
        }
        AppServerMessage::Result {
            request_id,
            ok,
            result,
            error,
        } => apply_rpc_result(shared, request_id, ok, result, error),
        AppServerMessage::Event(event) => apply_server_event(shared, event),
        AppServerMessage::Events { events } => {
            for event in events {
                let AppEventEnvelope::Event(event) = event;
                apply_server_event(shared, event);
            }
        }
        AppServerMessage::Subscribed {
            request_id,
            cursors,
        } => {
            for (scope, cursor) in &cursors {
                lock(&shared.wire_cursors).insert(scope.clone(), cursor.clone());
            }
            if let Some(request_id) = request_id {
                apply_rpc_result(
                    shared,
                    request_id,
                    true,
                    Some(serde_json::json!({"cursors":cursors})),
                    None,
                );
            } else {
                shared.push_event(serde_json::json!({"kind":"subscribed","cursors":cursors}));
            }
        }
        AppServerMessage::Resync {
            scope,
            reason,
            epoch,
            seq,
        } => {
            lock(&shared.wire_cursors).remove(&scope);
            shared.push_event(serde_json::json!({
                "kind":"resync",
                "scope":scope,
                "reason":reason,
                "epoch":epoch,
                "seq":seq
            }));
        }
        AppServerMessage::Pong => shared.push_event(serde_json::json!({"kind":"pong"})),
    }
    let _ = writer;
}

#[cfg(feature = "iroh-transport")]
pub(super) fn apply_rpc_result(
    shared: &Arc<SharedCore>,
    request_id: u64,
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
) {
    let pending = shared.take_rpc(request_id);
    let (action, method, kind) = pending
        .map(|pending| (pending.action, pending.method, pending.kind))
        .unwrap_or_else(|| ("unknown".into(), "unknown".into(), RpcKind::Generic));
    let decode_error = if ok {
        match (&kind, result.as_ref()) {
            (RpcKind::Snapshot { conversation_id }, Some(value)) => {
                match serde_json::from_value::<ConversationSnapshot>(value.clone()) {
                    Ok(snapshot) if snapshot.conversation_id.as_deref() == Some(conversation_id) => None,
                    Ok(_) => Some("snapshot conversation does not match the request".to_owned()),
                    Err(error) => Some(format!("invalid conversation snapshot: {error}")),
                }
            }
            (RpcKind::Snapshot { .. }, None) => Some("missing conversation snapshot".to_owned()),
            _ => None,
        }
    } else {
        None
    };
    let ok = ok && decode_error.is_none();
    let error = decode_error
        .map(|message| serde_json::json!({"code":"mobile.invalid_snapshot","message":message}))
        .or(error);
    if ok {
        if let Some(result_value) = result.as_ref() {
            hydrate_rpc_result(shared, &kind, result_value);
        }
    }
    if matches!(kind, RpcKind::HistoryPage { .. }) {
        *lock(&shared.loading_history) = false;
    }
    let mut event = serde_json::Map::new();
    event.insert("kind".into(), serde_json::json!("rpcResult"));
    event.insert("requestId".into(), serde_json::json!(request_id));
    event.insert("action".into(), serde_json::json!(action));
    event.insert("method".into(), serde_json::json!(method));
    event.insert("ok".into(), serde_json::json!(ok));
    if let Some(result) = result {
        event.insert("result".into(), result);
    }
    if let Some(error) = error {
        event.insert("error".into(), error);
    }
    shared.push_event(serde_json::Value::Object(event));
}

#[cfg(feature = "iroh-transport")]
pub(super) fn hydrate_rpc_result(
    shared: &Arc<SharedCore>,
    kind: &RpcKind,
    value: &serde_json::Value,
) {
    match kind {
        RpcKind::Workspace => {
            if let Ok(workspace) = serde_json::from_value::<WorkspaceSnapshot>(value.clone()) {
                *lock(&shared.workspace) = workspace;
            }
        }
        RpcKind::OpenConversation { conversation_id } => {
            if lock(&shared.connection).conversation_id.as_deref() != Some(conversation_id) {
                return;
            }
            hydrate_open_or_create(shared, value);
        }
        RpcKind::CreateConversation => {
            hydrate_open_or_create(shared, value);
        }
        RpcKind::Snapshot { conversation_id } => {
            if lock(&shared.connection).conversation_id.as_deref() != Some(conversation_id) {
                return;
            }
            if let Ok(snapshot) = serde_json::from_value::<ConversationSnapshot>(value.clone()) {
                let conversation_id = snapshot.conversation_id.clone();
                let snapshot_seq = snapshot.seq;
                lock(&shared.store).replace_snapshot(snapshot);
                if let Some(conversation_id) = conversation_id {
                    let buffered = lock(&shared.buffered_events)
                        .remove(&conversation_id)
                        .unwrap_or_default();
                    for event in buffered {
                        if event
                            .payload
                            .as_ref()
                            .and_then(|payload| payload.get("seq"))
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(event.seq)
                            > snapshot_seq
                        {
                            apply_server_event(shared, event);
                        }
                    }
                }
            }
        }
        RpcKind::HistoryPage { conversation_id } => {
            let current = lock(&shared.connection).conversation_id.clone();
            if current.as_deref() != Some(conversation_id) {
                *lock(&shared.loading_history) = false;
                return;
            }
            if let Ok(page) = serde_json::from_value::<ConversationHistoryPage>(value.clone()) {
                if page.conversation_id.as_deref() != Some(conversation_id) {
                    *lock(&shared.loading_history) = false;
                    return;
                }
                if page.reset {
                    // Keep the visible window until the caller requests a fresh snapshot.
                    *lock(&shared.loading_history) = false;
                } else {
                    lock(&shared.store).prepend_history(&page);
                    *lock(&shared.loading_history) = false;
                }
            }
        }
        RpcKind::Queue { conversation_id } => {
            if lock(&shared.connection).conversation_id.as_deref() != Some(conversation_id) {
                return;
            }
            if let Ok(queue) = serde_json::from_value::<QueueState>(value.clone()) {
                if queue.conversation_id.as_deref() == Some(conversation_id)
                    && queue.revision >= lock(&shared.store).queue.revision
                {
                    lock(&shared.store).queue = queue;
                }
            }
        }
        RpcKind::SessionState { conversation_id } => {
            let response_id = value
                .get("conversationId")
                .or_else(|| value.get("conversation_id"))
                .and_then(serde_json::Value::as_str);
            if response_id == conversation_id.as_deref() {
                *lock(&shared.session_state) = Some(value.clone());
            }
        }
        RpcKind::PendingUi => {
            if let Some(items) = value.as_array() {
                lock(&shared.store).pending_ui = items.clone();
            }
        }
        RpcKind::Generic | RpcKind::Subscribe => {}
    }
}

pub(super) fn hydrate_open_or_create(shared: &Arc<SharedCore>, value: &serde_json::Value) {
    if value.get("projects").is_some() || value.get("conversations").is_some() {
        if let Ok(workspace) = serde_json::from_value::<WorkspaceSnapshot>(value.clone()) {
            *lock(&shared.workspace) = workspace;
        }
    } else if let Some(workspace_value) = value.get("workspace") {
        if let Ok(workspace) = serde_json::from_value::<WorkspaceSnapshot>(workspace_value.clone())
        {
            *lock(&shared.workspace) = workspace;
        }
    }
    if let Some(conversation) = value
        .get("conversation")
        .and_then(|value| value.get("id"))
        .and_then(serde_json::Value::as_str)
    {
        lock(&shared.connection).conversation_id = Some(conversation.into());
    }
    if let Some(messages) = value.get("messages") {
        if let Ok(messages) = serde_json::from_value::<Vec<ChatMessage>>(messages.clone()) {
            let snapshot =
                lock(&shared.store).snapshot(lock(&shared.connection).conversation_id.clone());
            lock(&shared.store).replace_snapshot(ConversationSnapshot {
                conversation_id: snapshot.conversation_id,
                messages,
                message_mode: Some("full".into()),
                history_before_entry_id: None,
                history: None,
                running: snapshot.running,
                queue: snapshot.queue,
                pending_ui: snapshot.pending_ui,
                turn_events: snapshot.turn_events,
                overflowed: snapshot.overflowed,
                seq: snapshot.seq,
            });
        }
    }
}

#[cfg(feature = "iroh-transport")]
pub(super) fn apply_server_event(shared: &Arc<SharedCore>, event: AppEventMessage) {
    let active_epoch = lock(&shared.welcome)
        .as_ref()
        .map(|welcome| welcome.epoch.clone());
    if active_epoch
        .as_deref()
        .is_some_and(|epoch| epoch != event.epoch)
    {
        shared.push_event(serde_json::json!({
            "kind":"resync",
            "scope":event.scope,
            "reason":"event epoch changed",
            "epoch":event.epoch,
            "seq":event.seq
        }));
        return;
    }
    if lock(&shared.welcome).is_none() {
        return;
    }
    let conversation_id = event
        .payload
        .as_ref()
        .and_then(|payload| payload.get("conversationId"))
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned);
    let current_conversation = lock(&shared.connection).conversation_id.clone();
    if let Some(conversation_id) = conversation_id.as_deref() {
        if current_conversation.as_deref() != Some(conversation_id) {
            if let Some(payload) = event.payload.as_ref() {
                if payload.get("type").and_then(serde_json::Value::as_str)
                    == Some("extension_ui_request")
                {
                    let mut store = lock(&shared.store);
                    store
                        .pending_ui
                        .retain(|item| item.get("id") != payload.get("id"));
                    store.pending_ui.push(payload.clone());
                    trim_values(&mut store.pending_ui, MAX_PENDING_EVENTS);
                }
            }
            lock(&shared.wire_cursors).insert(
                event.scope.clone(),
                WireCursor {
                    epoch: event.epoch.clone(),
                    seq: event.seq,
                },
            );
            shared.push_event(
                serde_json::to_value(AppServerMessage::Event(event))
                    .unwrap_or(serde_json::Value::Null),
            );
            return;
        }
    }
    if let Some(conversation_id) = conversation_id.as_deref() {
        let store = lock(&shared.store);
        if event
            .payload
            .as_ref()
            .and_then(|payload| payload.get("seq"))
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|engine_seq| engine_seq <= store.seq)
        {
            return;
        }
        drop(store);
        if shared.has_snapshot_pending(conversation_id) {
            lock(&shared.buffered_events)
                .entry(conversation_id.to_owned())
                .or_default()
                .push(event);
            return;
        }
    }
    if let Some(payload) = event.payload.as_ref() {
        let mut store = lock(&shared.store);
        store.apply_engine_event(payload);
        if payload.get("type").and_then(serde_json::Value::as_str) == Some("extension_ui_request") {
            store
                .pending_ui
                .retain(|item| item.get("id") != payload.get("id"));
            store.pending_ui.push(payload.clone());
            trim_values(&mut store.pending_ui, MAX_PENDING_EVENTS);
        }
    }
    lock(&shared.wire_cursors).insert(
        event.scope.clone(),
        WireCursor {
            epoch: event.epoch.clone(),
            seq: event.seq,
        },
    );
    shared.push_event(
        serde_json::to_value(AppServerMessage::Event(event)).unwrap_or(serde_json::Value::Null),
    );
}

pub(super) fn prompt_message(
    request_id: u64,
    conversation_id: &str,
    text: &str,
    enqueue: bool,
    images: serde_json::Value,
    idempotency_key: String,
) -> AppMessage {
    AppMessage::Call {
        request_id,
        method: "engine:submit-prompt".into(),
        payload: Some(serde_json::json!({
            "conversationId": conversation_id,
            "text": text,
            "enqueue": enqueue,
            "images": images,
        })),
        idempotency_key: Some(idempotency_key),
    }
}

pub(super) fn command_to_app_message(value: &serde_json::Value) -> Result<AppMessage, String> {
    let kind = required_string(value, "kind")?;
    match kind {
        "subscribe" => Ok(AppMessage::Subscribe {
            request_id: value.get("requestId").and_then(serde_json::Value::as_u64),
            scopes: value
                .get("scopes")
                .and_then(serde_json::Value::as_array)
                .ok_or("subscribe scopes are required")?
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
                .collect(),
            since: value
                .get("since")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| error.to_string())?,
        }),
        "unsubscribe" => Ok(AppMessage::Unsubscribe {
            scopes: string_array(value, "scopes")?,
        }),
        "cancel" => Ok(AppMessage::Cancel {
            target_request_id: value
                .get("targetRequestId")
                .and_then(serde_json::Value::as_u64)
                .ok_or("targetRequestId is required")?,
            reason: value
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned),
        }),
        "ping" => Ok(AppMessage::Ping),
        "call" => Ok(AppMessage::Call {
            request_id: value
                .get("requestId")
                .and_then(serde_json::Value::as_u64)
                .ok_or("requestId is required")?,
            method: required_string(value, "method")?.into(),
            payload: value.get("payload").cloned(),
            idempotency_key: value
                .get("idempotencyKey")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned),
        }),
        "query" => Ok(AppMessage::Query {
            request_id: value
                .get("requestId")
                .and_then(serde_json::Value::as_u64)
                .ok_or("requestId is required")?,
            method: required_string(value, "method")?.into(),
            payload: value.get("payload").cloned(),
        }),
        _ => Err(format!("unsupported App Protocol kind: {kind}")),
    }
}
