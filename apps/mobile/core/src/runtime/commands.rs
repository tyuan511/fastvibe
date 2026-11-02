use super::*;

impl CoreHandle {
    pub(crate) fn new() -> Self {
        Self {
            shared: Arc::new(SharedCore::new()),
            #[cfg(any(feature = "mobile-client", feature = "iroh-transport"))]
            runtime: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("mobile core tokio runtime"),
            #[cfg(feature = "mobile-client")]
            account: Mutex::new(None),
            #[cfg(feature = "mobile-client")]
            login: Mutex::new(None),
            #[cfg(feature = "iroh-transport")]
            identity: Mutex::new(None),
        }
    }

    pub(crate) fn apply_value(&self, value: &serde_json::Value) -> Result<(), String> {
        if value.get("messages").is_some() {
            let snapshot = serde_json::from_value::<ConversationSnapshot>(value.clone())
                .map_err(|error| error.to_string())?;
            let conversation_id = snapshot.conversation_id.clone();
            lock(&self.shared.store).replace_snapshot(snapshot);
            if let Some(conversation_id) = conversation_id {
                let buffered = lock(&self.shared.buffered_events)
                    .remove(&conversation_id)
                    .unwrap_or_default();
                #[cfg(feature = "iroh-transport")]
                for event in buffered {
                    apply_server_event(&self.shared, event);
                }
                #[cfg(not(feature = "iroh-transport"))]
                let _ = buffered;
            }
        } else {
            lock(&self.shared.store).apply_engine_event(value);
        }
        Ok(())
    }

    pub(crate) fn command(&self, value: serde_json::Value) -> serde_json::Value {
        let action = value
            .get("action")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let result = match action {
            "snapshot" => self.command_snapshot(&value),
            "listConversations" | "list_conversations" | "conversationsList" => {
                self.command_workspace(&value)
            }
            "openConversation" | "open_conversation" | "conversationsOpen" => {
                self.command_open_conversation(&value)
            }
            "createConversation" | "create_conversation" | "conversationsCreate" => {
                self.command_create_conversation(&value)
            }
            "getMessagesPage" | "get_messages_page" => self.command_messages_page(&value),
            "pendingUi" | "getPendingUi" | "get_pending_ui" => {
                self.command_pending_ui(&value)
            }
            "permissionRespond" | "permission_respond" | "respondPermission" => {
                self.command_permission_respond(&value)
            }
            "abort" | "engineAbort" | "engine_abort" => self.command_abort(&value),
            "call" | "query" => self.command_rpc(&value, action == "query"),
            "apply" => self.command_apply(&value),
            "poll" => Ok(self.poll_result(value.get("limit"))),
            "loginUrl" | "login_url" => self.command_login_url(&value),
            "exchangeToken" | "exchange_token" => self.command_exchange_token(&value),
            "setToken" | "set_token" => self.command_set_token(&value),
            "identity" | "getIdentity" | "get_identity" => self.command_identity(),
            "setIdentity" | "set_identity" => self.command_set_identity(&value),
            "registerDevice" | "register_device" => self.command_register_device(&value),
            "registerEndpoint" | "register_endpoint" | "registerDeviceEndpoint" | "register_device_endpoint" => self.command_register_endpoint(&value),
            "devices" | "listDevices" | "list_devices" => self.command_devices(),
            "relay" | "relayToken" | "relay_token" => self.command_relay(&value),
            "connect" => self.command_connect(&value),
            "disconnect" => self.command_disconnect(),
            "subscribe" => self.command_subscribe(&value),
            "unsubscribe" => self.command_send_message(&serde_json::json!({
                "message": {
                    "kind": "unsubscribe",
                    "scopes": value.get("scopes").cloned().unwrap_or_else(|| serde_json::json!([])),
                }
            }), false),
            "cancel" => self.command_send_message(&serde_json::json!({
                "message": {
                    "kind": "cancel",
                    "targetRequestId": value.get("targetRequestId").cloned().unwrap_or(serde_json::Value::Null),
                    "reason": value.get("reason").cloned(),
                }
            }), false),
            "prompt" | "submitPrompt" | "submit_prompt" => self.command_prompt(&value),
            _ => Err(format!("unknown action: {action}")),
        };
        match result {
            Ok(result) => serde_json::json!({
                "ok": true,
                "action": action,
                "result": result,
                "state": self.shared.state(),
            }),
            Err(error) => serde_json::json!({
                "ok": false,
                "action": action,
                "error": {"code": "mobile.core", "message": error},
                "state": self.shared.state(),
            }),
        }
    }

    pub(super) fn command_subscribe(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let scopes = value
            .get("scopes")
            .and_then(serde_json::Value::as_array)
            .ok_or("subscribe scopes are required")?
            .iter()
            .map(|scope| {
                scope
                    .as_str()
                    .map(ToOwned::to_owned)
                    .ok_or_else(|| "subscribe scopes must contain strings".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if scopes.is_empty() {
            return Err("subscribe scopes are required".into());
        }
        let request_id = self.shared.next_request_id();
        let since = value
            .get("since")
            .cloned()
            .map(serde_json::from_value::<HashMap<String, WireCursor>>)
            .transpose()
            .map_err(|error| error.to_string())?;
        #[cfg(feature = "iroh-transport")]
        {
            let sender = lock(&self.shared.connection)
                .outbound
                .clone()
                .ok_or("not connected")?;
            if lock(&self.shared.connection).status != "ready" {
                return Err("connection is not ready".into());
            }
            self.shared.register_rpc(
                request_id,
                PendingRpc {
                    action: "subscribe".into(),
                    method: "subscribe".into(),
                    kind: RpcKind::Subscribe,
                    created_at: Instant::now(),
                },
            );
            if let Err(error) = sender.send(TransportCommand::Message(AppMessage::Subscribe {
                request_id: Some(request_id),
                scopes,
                since,
            })) {
                self.shared.take_rpc(request_id);
                return Err(error.to_string());
            }
            Ok(serde_json::json!({"requested": true, "requestId": request_id}))
        }
        #[cfg(not(feature = "iroh-transport"))]
        {
            let _ = (request_id, scopes, since);
            Err("iroh-transport feature is disabled".into())
        }
    }

    pub(super) fn command_snapshot(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let conversation_id = required_string_any(value, &["conversationId", "conversation_id"])?;
        lock(&self.shared.connection).conversation_id = Some(conversation_id.to_owned());
        {
            let mut store = lock(&self.shared.store);
            let current = store.snapshot(Some(conversation_id.to_owned()));
            store.replace_snapshot(ConversationSnapshot {
                conversation_id: Some(conversation_id.to_owned()),
                messages: Vec::new(),
                message_mode: Some("window".into()),
                history_before_entry_id: None,
                history: None,
                running: false,
                queue: QueueState::default(),
                pending_ui: Vec::new(),
                turn_events: Vec::new(),
                overflowed: false,
                seq: current.seq,
            });
        }
        let mut payload = serde_json::json!({"conversationId": conversation_id});
        if let Some(history_limit) = value
            .get("historyLimit")
            .and_then(serde_json::Value::as_u64)
        {
            payload["historyLimit"] = serde_json::json!(history_limit.clamp(1, 50));
        }
        let request_id = self.send_rpc(
            "snapshot",
            "engine:get-snapshot",
            payload,
            None,
            RpcKind::Snapshot {
                conversation_id: conversation_id.to_owned(),
            },
        )?;
        Ok(serde_json::json!({"requested": true, "requestId": request_id}))
    }

    pub(super) fn command_workspace(
        &self,
        _: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let request_id = self.send_rpc(
            "listConversations",
            "conversations:list",
            serde_json::Value::Null,
            None,
            RpcKind::Workspace,
        )?;
        Ok(serde_json::json!({"requested": true, "requestId": request_id}))
    }

    pub(super) fn command_open_conversation(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = required_string_any(value, &["id", "conversationId", "conversation_id"])?;
        lock(&self.shared.connection).conversation_id = Some(id.to_owned());
        {
            let mut store = lock(&self.shared.store);
            let current = store.snapshot(Some(id.to_owned()));
            store.replace_snapshot(ConversationSnapshot {
                conversation_id: Some(id.to_owned()),
                messages: Vec::new(),
                message_mode: Some("window".into()),
                history_before_entry_id: None,
                history: None,
                running: false,
                queue: QueueState::default(),
                pending_ui: Vec::new(),
                turn_events: Vec::new(),
                overflowed: false,
                seq: current.seq,
            });
        }
        let request_id = self.send_rpc(
            "openConversation",
            "conversations:open",
            serde_json::json!({"id": id, "activate": false}),
            None,
            RpcKind::OpenConversation {
                conversation_id: id.to_owned(),
            },
        )?;
        Ok(serde_json::json!({"requested": true, "requestId": request_id, "conversationId": id}))
    }

    pub(super) fn command_create_conversation(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let mut payload = serde_json::Map::new();
        for key in ["project", "activate", "reuseEmpty"] {
            if let Some(value) = value.get(key) {
                payload.insert(key.to_owned(), value.clone());
            }
        }
        let request_id = self.send_rpc(
            "createConversation",
            "conversations:create",
            serde_json::Value::Object(payload),
            None,
            RpcKind::CreateConversation,
        )?;
        Ok(serde_json::json!({"requested": true, "requestId": request_id}))
    }

    pub(super) fn command_messages_page(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let conversation_id = required_string_any(value, &["conversationId", "conversation_id"])?;
        let before_entry_id = required_string_any(value, &["beforeEntryId", "before_entry_id"])?;
        let turn_limit = value
            .get("turnLimit")
            .or_else(|| value.get("turn_limit"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(12)
            .clamp(1, 50);
        let request_id = self.send_rpc(
            "getMessagesPage",
            "engine:get-messages-page",
            serde_json::json!({
                "conversationId": conversation_id,
                "beforeEntryId": before_entry_id,
                "turnLimit": turn_limit,
            }),
            None,
            RpcKind::HistoryPage {
                conversation_id: conversation_id.to_owned(),
            },
        )?;
        *lock(&self.shared.loading_history) = true;
        Ok(serde_json::json!({"requested": true, "requestId": request_id}))
    }

    pub(super) fn command_pending_ui(
        &self,
        _: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let request_id = self.send_rpc(
            "pendingUi",
            "engine:get-pending-ui",
            serde_json::Value::Null,
            None,
            RpcKind::PendingUi,
        )?;
        Ok(serde_json::json!({"requested": true, "requestId": request_id}))
    }

    pub(super) fn command_permission_respond(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = required_string(value, "id")?;
        let mut payload = serde_json::Map::new();
        payload.insert("id".into(), serde_json::Value::String(id.into()));
        for key in ["confirmed", "value", "cancelled", "answers"] {
            if let Some(value) = value.get(key) {
                payload.insert(key.to_owned(), value.clone());
            }
        }
        let request_id = self.send_rpc(
            "permissionRespond",
            "engine:permission-respond",
            serde_json::Value::Object(payload),
            None,
            RpcKind::Generic,
        )?;
        Ok(serde_json::json!({"requested": true, "requestId": request_id}))
    }

    pub(super) fn command_abort(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let conversation_id = required_string_any(value, &["conversationId", "conversation_id"])?;
        let request_id = self.send_rpc(
            "abort",
            "engine:abort",
            serde_json::json!({"conversationId": conversation_id}),
            None,
            RpcKind::Generic,
        )?;
        Ok(serde_json::json!({"requested": true, "requestId": request_id}))
    }
}
