use super::*;

impl CoreHandle {
    pub(super) fn command_rpc(
        &self,
        value: &serde_json::Value,
        query: bool,
    ) -> Result<serde_json::Value, String> {
        let method = required_string(value, "method")?.to_owned();
        let payload = value
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let kind = match method.as_str() {
            "engine:get-snapshot" => payload
                .get("conversationId")
                .or_else(|| payload.get("conversation_id"))
                .and_then(serde_json::Value::as_str)
                .map(|conversation_id| RpcKind::Snapshot {
                    conversation_id: conversation_id.to_owned(),
                })
                .unwrap_or(RpcKind::Generic),
            "engine:get-messages-page" => payload
                .get("conversationId")
                .or_else(|| payload.get("conversation_id"))
                .and_then(serde_json::Value::as_str)
                .map(|conversation_id| RpcKind::HistoryPage {
                    conversation_id: conversation_id.to_owned(),
                })
                .unwrap_or(RpcKind::Generic),
            method
                if method == "engine:get-state"
                    || method == "engine:set-model"
                    || method == "engine:set-thinking"
                    || method == "engine:set-interrupt" =>
            {
                RpcKind::SessionState {
                    conversation_id: payload
                        .get("conversationId")
                        .or_else(|| payload.get("conversation_id"))
                        .and_then(serde_json::Value::as_str)
                        .map(ToOwned::to_owned),
                }
            }
            method if method.starts_with("engine:queue-") || method == "engine:clear-queue" => {
                payload
                    .get("conversationId")
                    .or_else(|| payload.get("conversation_id"))
                    .and_then(serde_json::Value::as_str)
                    .map(|conversation_id| RpcKind::Queue {
                        conversation_id: conversation_id.to_owned(),
                    })
                    .unwrap_or(RpcKind::Generic)
            }
            _ => RpcKind::Generic,
        };
        let request_id = self.send_rpc(
            if query { "query" } else { "call" },
            &method,
            value
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            value
                .get("idempotencyKey")
                .or_else(|| value.get("idempotency_key"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned),
            kind,
        )?;
        Ok(serde_json::json!({"requested": true, "requestId": request_id}))
    }

    pub(super) fn send_rpc(
        &self,
        action: &str,
        method: &str,
        payload: serde_json::Value,
        idempotency_key: Option<String>,
        kind: RpcKind,
    ) -> Result<u64, String> {
        #[cfg(feature = "iroh-transport")]
        {
            let sender = lock(&self.shared.connection)
                .outbound
                .clone()
                .ok_or("not connected")?;
            if lock(&self.shared.connection).status != "ready" {
                return Err("connection is not ready".into());
            }
            let request_id = self.shared.next_request_id();
            let message = AppMessage::Call {
                request_id,
                method: method.to_owned(),
                payload: (!payload.is_null()).then_some(payload),
                idempotency_key,
            };
            self.shared.register_rpc(
                request_id,
                PendingRpc {
                    action: action.to_owned(),
                    method: method.to_owned(),
                    kind,
                    created_at: Instant::now(),
                },
            );
            if let Err(error) = sender.send(TransportCommand::Message(message)) {
                self.shared.take_rpc(request_id);
                return Err(error.to_string());
            }
            Ok(request_id)
        }
        #[cfg(not(feature = "iroh-transport"))]
        {
            let _ = (action, method, payload, idempotency_key, kind);
            Err("iroh-transport feature is disabled".into())
        }
    }

    pub(super) fn command_apply(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let input = value
            .get("value")
            .or_else(|| value.get("event"))
            .ok_or("apply requires value or event")?;
        self.apply_value(input)?;
        Ok(serde_json::json!({"snapshot": self.shared.snapshot()}))
    }

    pub(crate) fn poll_result(&self, limit: Option<&serde_json::Value>) -> serde_json::Value {
        for (request_id, pending) in self.shared.expire_rpcs() {
            if matches!(pending.kind, RpcKind::HistoryPage { .. }) {
                *lock(&self.shared.loading_history) = false;
            }
            #[cfg(feature = "iroh-transport")]
            if let Some(sender) = lock(&self.shared.connection).outbound.clone() {
                let _ = sender.send(TransportCommand::Message(AppMessage::Cancel {
                    target_request_id: request_id,
                    reason: Some("timeout".into()),
                }));
            }
            #[cfg(feature = "iroh-transport")]
            self.shared.push_event(serde_json::json!({
                "kind":"rpcResult",
                "requestId": request_id,
                "action": pending.action,
                "method": pending.method,
                "ok": false,
                "error": {"code":"mobile.timeout","message":"remote App Protocol request timed out"}
            }));
        }
        let limit = limit
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(64)
            .clamp(1, MAX_PENDING_EVENTS as u64) as usize;
        let mut events = lock(&self.shared.events);
        let mut result = Vec::with_capacity(events.len().min(limit));
        for _ in 0..limit {
            let Some(event) = events.pop_front() else {
                break;
            };
            result.push(event);
        }
        let overflowed = {
            let mut overflowed = lock(&self.shared.event_overflowed);
            let value = *overflowed;
            *overflowed = false;
            value
        };
        serde_json::json!({"events": result, "overflowed": overflowed})
    }
}
