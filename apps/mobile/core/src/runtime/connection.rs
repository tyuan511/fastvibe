use super::*;

#[cfg(feature = "iroh-transport")]
const DIAL_TIMEOUT: Duration = Duration::from_secs(15);

#[cfg(feature = "iroh-transport")]
struct CloseConnection(iroh::endpoint::Connection);

#[cfg(feature = "iroh-transport")]
impl Drop for CloseConnection {
    fn drop(&mut self) {
        self.0.close(0u32.into(), b"mobile connection retired");
    }
}

#[cfg(feature = "iroh-transport")]
pub(super) fn report_connection_failure(
    shared: &Arc<SharedCore>,
    generation: u64,
    status: &str,
    message: String,
    code: Option<&str>,
) -> bool {
    let _protocol = lock(&shared.protocol);
    let mut connection = lock(&shared.connection);
    if connection.generation != generation {
        return false;
    }
    connection.status = status.into();
    connection.error = Some(message.clone());
    connection.outbound = None;

    let mut event = serde_json::json!({"type":"connection_error","message":message});
    if let Some(code) = code {
        event["code"] = serde_json::Value::String(code.into());
    }
    shared.push_event(event);
    true
}

impl CoreHandle {
    #[cfg(feature = "iroh-transport")]
    async fn scoped_endpoint(
        pool: &Arc<tokio::sync::Mutex<crate::iroh_transport::IrohEndpointPool>>,
        shared: &Arc<SharedCore>,
        generation: u64,
        key: iroh::SecretKey,
        nodes: &[crate::relay_config::MobileRelayNode],
    ) -> Result<iroh::Endpoint, Box<dyn std::error::Error + Send + Sync>> {
        let mut pool = pool.lock().await;
        if lock(&shared.connection).generation != generation {
            return Err("dial cancelled".into());
        }
        let endpoint = pool.endpoint(key, nodes).await?;
        if lock(&shared.connection).generation != generation {
            return Err("dial cancelled".into());
        }
        Ok(endpoint)
    }
    #[cfg(feature = "iroh-transport")]
    pub(super) fn command_connect(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let remote_id = required_string(value, "remoteId")
            .or_else(|_| required_string(value, "remote_id"))?
            .to_owned();
        let direct_addresses =
            crate::iroh_transport::parse_direct_addresses(value.get("directAddresses"))?;
        let prefer_direct = value
            .get("preferDirect")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if prefer_direct && direct_addresses.is_empty() {
            return Err("preferDirect requires a local address".into());
        }
        // A direct-preferred dial is an explicit mode, not an empty relay lease.
        let relay_nodes = if prefer_direct {
            Vec::new()
        } else {
            crate::relay_config::parse_relay_nodes(value.get("relay").unwrap_or(value))?
        };
        let remote = remote_id
            .parse::<iroh::EndpointId>()
            .map_err(|error| error.to_string())?;
        let key = self.identity_key()?;
        let endpoint_id = key.public().to_string();
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let generation = {
            let _protocol = lock(&self.shared.protocol);
            let mut connection = lock(&self.shared.connection);
            if let Some(existing) = connection.outbound.take() {
                let _ = existing.send(TransportCommand::Close);
            }
            connection.status = "connecting".into();
            connection.error = None;
            connection.generation = connection.generation.wrapping_add(1);
            connection.endpoint_id = Some(endpoint_id.clone());
            connection.conversation_id = value
                .get("conversationId")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned);
            connection.outbound = Some(sender);
            self.shared.clear_connection_protocol();
            self.shared.clear_projection();
            connection.generation
        };
        let shared = Arc::clone(&self.shared);
        let pool = Arc::clone(&self.endpoint_pool);
        #[cfg(feature = "mobile-client")]
        let fallback_account = lock(&self.account)
            .as_ref()
            .cloned()
            .zip(lock(&shared.connection).device_id.clone());
        #[cfg(feature = "mobile-client")]
        let registrations = Arc::clone(&self.registrations);
        let local_endpoint_id = endpoint_id.clone();
        self.runtime.spawn(async move {
            let mut dial = Box::pin(async {
                let endpoint = Self::scoped_endpoint(&pool, &shared, generation, key.clone(), &relay_nodes).await?;
                if prefer_direct {
                    let local = tokio::time::timeout(Duration::from_millis(1500),
                        crate::iroh_transport::IrohClient::connect_on(endpoint, remote, &[], &direct_addresses)).await;
                    if let Ok(Ok(client)) = local { return Ok(client); }
                    if lock(&shared.connection).generation != generation { return Err("dial cancelled".into()); }
                    #[cfg(feature = "mobile-client")]
                    {
                        let (account, device_id) = fallback_account.as_ref().ok_or("local route failed; no account for relay fallback")?;
                        let lease = account.relay(device_id, &local_endpoint_id).await;
                        let nodes = {
                            let _protocol = lock(&shared.protocol);
                            if lock(&shared.connection).generation != generation { return Err("dial cancelled".into()); }
                            if let Err(error) = &lease {
                                if error.downcast_ref::<mobile_client::AccountHttpError>()
                                    .is_some_and(|error| matches!(error.status.as_u16(), 401 | 403 | 404)) {
                                    *lock(&registrations) = RegistrationCache::default();
                                }
                            }
                            let lease = lease?;
                            shared.push_event(serde_json::json!({"type":"relay_lease","expiresAt":lease.expires_at}));
                            lease.relays
                        };
                        let endpoint = Self::scoped_endpoint(&pool, &shared, generation, key, &nodes).await?;
                        return crate::iroh_transport::IrohClient::connect_on(endpoint, remote, &nodes, &direct_addresses).await
                            .map_err(|error| crate::relay_config::redact_relay_tokens(&error.to_string(), &nodes).into());
                    }
                    #[cfg(not(feature = "mobile-client"))]
                    return Err("local route unavailable".into());
                }
                crate::iroh_transport::IrohClient::connect_on(endpoint, remote, &relay_nodes, &direct_addresses).await
            });
            let dial_deadline = tokio::time::sleep(DIAL_TIMEOUT);
            tokio::pin!(dial_deadline);
            let mut pending_messages = Vec::new();
            let client = loop {
                if lock(&shared.connection).generation != generation {
                    return;
                }
                tokio::select! {
                    biased;
                    command = receiver.recv() => match command {
                        Some(TransportCommand::Message(message)) => pending_messages.push(message),
                        Some(TransportCommand::Close) | None => return,
                    },
                    _ = &mut dial_deadline => {
                        let message = format!("iroh connection timed out after {}s", DIAL_TIMEOUT.as_secs());
                        report_connection_failure(&shared, generation, "error", message.clone(), None);
                        return;
                    },
                    result = &mut dial => break result,
                }
            };
            let client = match client {
                Ok(client) => client,
                Err(error) => {
                    let message = crate::relay_config::redact_relay_tokens(&error.to_string(), &relay_nodes);
                    report_connection_failure(&shared, generation, "error", message, None);
                    return;
                }
            };
            let (mut writer, mut reader) = client.split();
            let _close_connection = CloseConnection(reader.connection.clone());
            {
                let _protocol = lock(&shared.protocol);
                let mut connection = lock(&shared.connection);
                if connection.generation != generation {
                    return;
                }
                connection.status = "connected".into();
                shared.push_event(serde_json::json!({"type":"connection","status":"connected"}));
            }

            let mut transport_failed = false;
            for message in pending_messages {
                if let Err(error) = writer.send_json(&message).await {
                    let message = crate::relay_config::redact_relay_tokens(&error.to_string(), &relay_nodes);
                    report_connection_failure(
                        &shared,
                        generation,
                        "error",
                        message.clone(),
                        None,
                    );
                    transport_failed = true;
                    break;
                }
            }

            if !transport_failed {
                let welcome_deadline = tokio::time::sleep(WELCOME_TIMEOUT);
                tokio::pin!(welcome_deadline);
                let mut hello_sent = false;
                loop {
                    if lock(&shared.connection).generation != generation {
                        return;
                    }
                    tokio::select! {
                        _ = &mut welcome_deadline, if lock(&shared.welcome).is_none() => {
                            let message = "welcome timeout".to_owned();
                            report_connection_failure(
                                &shared,
                                generation,
                                "error",
                                message.clone(),
                                Some("protocol.welcome_timeout"),
                            );
                            break;
                        },
                        command = receiver.recv() => match command {
                            Some(TransportCommand::Message(message)) => {
                                if let Err(error) = writer.send_json(&message).await {
                                    let message = crate::relay_config::redact_relay_tokens(&error.to_string(), &relay_nodes);
                                    report_connection_failure(
                                        &shared,
                                        generation,
                                        "error",
                                        message.clone(),
                                        None,
                                    );
                                    break;
                                }
                            }
                            Some(TransportCommand::Close) | None => {
                                let _ = writer.close_frame(1000, "mobile closed").await;
                                break;
                            }
                        },
                        incoming = reader.read_next() => match incoming {
                            Ok(crate::iroh_transport::IrohRead::Message(message)) => handle_server_message(&shared, generation, message),
                            Ok(crate::iroh_transport::IrohRead::LegacyAuth) => {
                                if !hello_sent {
                                    if let Err(error) = writer.send_json(&crate::hello("0.1.0")).await {
                                        let message = crate::relay_config::redact_relay_tokens(&error.to_string(), &relay_nodes);
                                        report_connection_failure(
                                            &shared,
                                            generation,
                                            "error",
                                            message.clone(),
                                            None,
                                        );
                                        break;
                                    }
                                    hello_sent = true;
                                }
                                let _protocol = lock(&shared.protocol);
                                if lock(&shared.connection).generation == generation {
                                    shared.push_event(serde_json::json!({"type":"auth","ok":true}));
                                }
                            },
                            Ok(crate::iroh_transport::IrohRead::Ping) => {
                                if let Err(error) = writer.send_control(PONG).await {
                                    let message = crate::relay_config::redact_relay_tokens(&error.to_string(), &relay_nodes);
                                    report_connection_failure(
                                        &shared,
                                        generation,
                                        "error",
                                        message.clone(),
                                        None,
                                    );
                                    break;
                                }
                            },
                            Ok(crate::iroh_transport::IrohRead::Pong) => {
                                let _protocol = lock(&shared.protocol);
                                if lock(&shared.connection).generation == generation {
                                    shared.push_event(serde_json::json!({"type":"pong"}));
                                }
                            },
                            Ok(crate::iroh_transport::IrohRead::Close { code, reason }) => {
                                let reason = crate::relay_config::redact_relay_tokens(&reason, &relay_nodes);
                                let message = if reason.is_empty() {
                                    format!("remote closed connection (code {code})")
                                } else {
                                    format!("remote closed connection (code {code}): {reason}")
                                };
                                let _protocol = lock(&shared.protocol);
                                let mut connection = lock(&shared.connection);
                                if connection.generation != generation {
                                    return;
                                }
                                connection.status = "error".into();
                                connection.error = Some(message);
                                connection.outbound = None;
                                shared.push_event(serde_json::json!({"type":"remote_close","code":code,"reason":reason}));
                                break;
                            }
                            Err(error) => {
                                let message = crate::relay_config::redact_relay_tokens(&error.to_string(), &relay_nodes);
                                report_connection_failure(
                                    &shared,
                                    generation,
                                    "error",
                                    message.clone(),
                                    None,
                                );
                                break;
                            }
                        },
                    }
                }
            }

            let _protocol = lock(&shared.protocol);
            let mut connection = lock(&shared.connection);
            if connection.generation != generation {
                return;
            }
            if connection.status != "error" && connection.status != "disconnected" {
                connection.status = "disconnected".into();
            }
            connection.outbound = None;
            shared.clear_connection_protocol();
        });
        Ok(
            serde_json::json!({"status":"connecting","remoteId":remote_id,"endpointId":endpoint_id,"generation":generation}),
        )
    }

    #[cfg(not(feature = "iroh-transport"))]
    pub(super) fn command_connect(
        &self,
        _: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("iroh-transport feature is disabled".into())
    }

    pub(super) fn command_disconnect(&self) -> Result<serde_json::Value, String> {
        let _protocol = lock(&self.shared.protocol);
        let mut connection = lock(&self.shared.connection);
        #[cfg(feature = "iroh-transport")]
        if let Some(sender) = connection.outbound.take() {
            let _ = sender.send(TransportCommand::Close);
        }
        connection.generation = connection.generation.wrapping_add(1);
        connection.status = "disconnected".into();
        connection.error = None;
        connection.conversation_id = None;
        self.shared.clear_connection_protocol();
        self.shared.clear_projection();
        Ok(serde_json::json!({"status":"disconnected","generation":connection.generation}))
    }

    pub(super) fn command_clear_account(&self) -> Result<serde_json::Value, String> {
        self.command_disconnect()?;
        #[cfg(feature = "iroh-transport")]
        self.runtime.block_on(async {
            self.endpoint_pool.lock().await.clear().await;
        });
        #[cfg(feature = "mobile-client")]
        {
            *lock(&self.account) = None;
            *lock(&self.login) = None;
            *lock(&self.registrations) = RegistrationCache::default();
        }
        lock(&self.shared.connection).device_id = None;
        Ok(serde_json::json!({"status":"signed-out"}))
    }

    pub(super) fn command_network_changed(&self) -> Result<serde_json::Value, String> {
        #[cfg(feature = "iroh-transport")]
        self.runtime.block_on(async {
            let endpoint = self.endpoint_pool.lock().await.current();
            if let Some(endpoint) = endpoint {
                endpoint.network_change().await;
            }
        });
        Ok(serde_json::json!({"status":"network-updated"}))
    }

    pub(super) fn command_send_message(
        &self,
        value: &serde_json::Value,
        _: bool,
    ) -> Result<serde_json::Value, String> {
        let message: AppMessage = match value.get("message") {
            Some(message) => {
                serde_json::from_value(message.clone()).map_err(|error| error.to_string())?
            }
            None => command_to_app_message(value)?,
        };
        #[cfg(feature = "iroh-transport")]
        {
            let sender = lock(&self.shared.connection)
                .outbound
                .clone()
                .ok_or("not connected")?;
            sender
                .send(TransportCommand::Message(message))
                .map_err(|_| "connection closed".to_string())?;
            Ok(serde_json::json!({"sent":true}))
        }
        #[cfg(not(feature = "iroh-transport"))]
        {
            let _ = message;
            Err("iroh-transport feature is disabled".into())
        }
    }

    pub(super) fn command_prompt(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let conversation_id = required_string_any(value, &["conversationId", "conversation_id"])?;
        let text = value
            .get("text")
            .or_else(|| value.get("message"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let images = value
            .get("images")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        if text.is_empty() && !images.as_array().is_some_and(|images| !images.is_empty()) {
            return Err("text, message, or images is required".into());
        }
        lock(&self.shared.connection).conversation_id = Some(conversation_id.to_owned());
        let request_id = self.shared.next_request_id();
        let idempotency_key = value
            .get("idempotencyKey")
            .or_else(|| value.get("idempotency_key"))
            .and_then(serde_json::Value::as_str)
            .filter(|key| !key.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("mobile-prompt-{request_id}"));
        let enqueue = value
            .get("enqueue")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let prompt_submit = lock(&self.shared.welcome)
            .as_ref()
            .and_then(|welcome| welcome.features.get("promptSubmit"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let (method, payload) = if prompt_submit {
            (
                "engine:submit-prompt",
                serde_json::json!({
                    "conversationId": conversation_id,
                    "text": text,
                    "enqueue": enqueue,
                    "images": images,
                }),
            )
        } else {
            (
                "engine:prompt",
                serde_json::json!({
                    "conversationId": conversation_id,
                    "message": text,
                    "streamingBehavior": value
                        .get("streamingBehavior")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!("followUp")),
                    "images": images,
                }),
            )
        };
        #[cfg(feature = "iroh-transport")]
        {
            let sender = lock(&self.shared.connection)
                .outbound
                .clone()
                .ok_or("not connected")?;
            if lock(&self.shared.connection).status != "ready" {
                return Err("connection is not ready".into());
            }
            let pending_kind = match method {
                "engine:queue-add"
                | "engine:queue-cancel"
                | "engine:queue-recall"
                | "engine:queue-send-now"
                | "engine:queue-reorder"
                | "engine:queue-resume"
                | "engine:clear-queue" => RpcKind::Queue {
                    conversation_id: conversation_id.to_owned(),
                },
                _ => RpcKind::Generic,
            };
            let pending = PendingRpc {
                action: "submitPrompt".into(),
                method: method.into(),
                kind: pending_kind,
                created_at: Instant::now(),
            };
            let message = AppMessage::Call {
                request_id,
                method: method.into(),
                payload: Some(payload),
                idempotency_key: Some(idempotency_key),
            };
            self.shared.register_rpc(request_id, pending);
            if let Err(error) = sender.send(TransportCommand::Message(message)) {
                self.shared.take_rpc(request_id);
                return Err(error.to_string());
            }
            Ok(serde_json::json!({"requestId": request_id, "method": method}))
        }
        #[cfg(not(feature = "iroh-transport"))]
        {
            let _ = (request_id, method, payload, idempotency_key);
            Err("iroh-transport feature is disabled".into())
        }
    }
}
