use super::*;
use flate2::Compression;
use flate2::write::DeflateEncoder;
use std::io::Write;

#[cfg(feature = "iroh-transport")]
#[test]
fn connection_failure_survives_poll_and_late_failure_cannot_undo_cancel() {
    let core = CoreHandle::new();
    lock(&core.shared.connection).generation = 7;
    lock(&core.shared.connection).status = "ready".into();
    assert!(connection::report_connection_failure(
        &core.shared,
        7,
        "error",
        "iroh read failed: peer reset stream".into(),
        None,
    ));
    let polled = core.command(serde_json::json!({"action":"poll"}));
    assert_eq!(polled["state"]["connection"], "error");
    assert_eq!(
        polled["state"]["error"],
        "iroh read failed: peer reset stream"
    );
    assert_eq!(polled["result"]["events"][0]["type"], "connection_error");
    assert_eq!(
        core.shared.state().error.as_deref(),
        Some("iroh read failed: peer reset stream")
    );

    core.command_disconnect().unwrap();
    assert!(!connection::report_connection_failure(
        &core.shared,
        7,
        "error",
        "late read error".into(),
        None,
    ));
    let state = core.shared.state();
    assert_eq!(state.connection, "disconnected");
    assert!(state.error.is_none());
    assert!(lock(&core.shared.events).is_empty());
}

#[cfg(feature = "iroh-transport")]
#[test]
fn stale_connection_failure_does_not_change_new_attempt_or_publish_event() {
    let shared = Arc::new(SharedCore::new());
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    {
        let mut current = lock(&shared.connection);
        current.generation = 2;
        current.status = "connecting".into();
        current.outbound = Some(sender);
    }
    assert!(!connection::report_connection_failure(
        &shared,
        1,
        "error",
        "old dial timed out".into(),
        None,
    ));
    assert_eq!(shared.state().connection, "connecting");
    assert!(shared.state().error.is_none());
    assert!(lock(&shared.events).is_empty());
    lock(&shared.connection)
        .outbound
        .as_ref()
        .unwrap()
        .send(TransportCommand::Close)
        .unwrap();
    assert!(matches!(receiver.try_recv(), Ok(TransportCommand::Close)));
}

fn message(id: &str) -> ChatMessage {
    ChatMessage {
        id: id.into(),
        role: "assistant".into(),
        text: String::new(),
        thinking: None,
        tools: Vec::new(),
        parts: Some(Vec::new()),
        created_at: 1,
        completed_at: None,
        run_started_at: None,
        kind: Some("message".into()),
        custom_type: None,
        error: None,
        stop: None,
        retry: None,
        deferred_content: None,
        stop_cause: None,
        compact: None,
    }
}

#[cfg(feature = "mobile-client")]
#[test]
fn mobile_http_request_bodies_match_cloud_contract() {
    assert_eq!(
        mobile_client::register_device_body("install-1", "Phone", "android"),
        serde_json::json!({"install_id":"install-1","name":"Phone","platform":"android"})
    );
    assert_eq!(
        mobile_client::register_endpoint_body("endpoint-1"),
        serde_json::json!({"endpoint_id":"endpoint-1"})
    );
    assert_eq!(
        mobile_client::relay_body("device-1", "endpoint-1"),
        serde_json::json!({"device_id":"device-1","endpoint_id":"endpoint-1"})
    );
}

#[cfg(feature = "mobile-client")]
#[test]
fn mobile_response_aliases_decode_server_snake_case() {
    let user: mobile_client::AccountUser = serde_json::from_value(serde_json::json!({
        "id":"u1","login":"octocat","avatar_url":"https://example.test/a.png","email":"a@example.test"
    })).unwrap();
    assert_eq!(
        user.avatar_url.as_deref(),
        Some("https://example.test/a.png")
    );
    let device: mobile_client::MobileDevice = serde_json::from_value(serde_json::json!({
        "id":"d1","name":"Mac","platform":"darwin",
        "iroh_endpoint_id":"endpoint-1","online":false,"last_seen_at":"2026-11-01T00:00:00Z"
    }))
    .unwrap();
    assert_eq!(device.online, Some(false));
    assert_eq!(device.last_seen.as_deref(), Some("2026-11-01T00:00:00Z"));
    let unknown: mobile_client::MobileDevice = serde_json::from_value(serde_json::json!({
        "id":"d2","name":"Offline","platform":"darwin","iroh_endpoint_id":"endpoint-2"
    }))
    .unwrap();
    assert_eq!(unknown.online, None);
    assert!(unknown.iroh_endpoint_id.is_some());
    let relay: mobile_client::MobileRelayConfig = serde_json::from_value(serde_json::json!({
        "relay_id":"r1","url":"https://relay.test/","quic_port":7842,
        "token":"relay-token","expires_at":"2026-11-01T00:10:00Z",
        "usage":{"period_start":"2026-11-01T00:00:00Z","resets_at":"2026-12-01T00:00:00Z","used_bytes":1,"quota_bytes":2,"remaining_bytes":1}
    })).unwrap();
    assert_eq!(relay.quic_port, 7842);
    assert_eq!(relay.usage.unwrap().remaining_bytes, 1);
}

#[cfg(feature = "iroh-transport")]
#[test]
fn identity_command_is_stable_and_restorable() {
    let first = CoreHandle::new();
    let generated = first.command(serde_json::json!({"action":"identity"}));
    assert_eq!(generated["ok"], true);
    let secret = generated["result"]["secretKey"].as_str().unwrap();
    assert_eq!(secret.len(), 64);
    let endpoint = generated["result"]["endpointId"].as_str().unwrap();
    let again = first.command(serde_json::json!({"action":"get_identity"}));
    assert_eq!(again["result"]["secretKey"], secret);
    assert_eq!(again["result"]["endpointId"], endpoint);

    let second = CoreHandle::new();
    let restored = second.command(serde_json::json!({"action":"setIdentity","secretKey":secret}));
    assert_eq!(restored["result"]["secretKey"], secret);
    assert_eq!(restored["result"]["endpointId"], endpoint);
}

#[cfg(feature = "iroh-transport")]
#[test]
fn prompt_message_has_idempotency_key_and_exact_engine_payload() {
    let message = prompt_message(
        9,
        "conversation-1",
        "hello",
        false,
        serde_json::json!([]),
        "prompt-key".into(),
    );
    assert_eq!(
        serde_json::to_value(message).unwrap(),
        serde_json::json!({
            "kind":"call","requestId":9,"method":"engine:submit-prompt",
            "payload":{"conversationId":"conversation-1","text":"hello","enqueue":false,"images":[]},
            "idempotencyKey":"prompt-key"
        })
    );
}
#[test]
fn hello_uses_desktop_camel_case_shapes() {
    let value = serde_json::to_value(hello("test")).unwrap();
    assert_eq!(value["kind"], "hello");
    assert_eq!(value["hello"]["protocolVersion"], APP_PROTOCOL_VERSION);
    assert_eq!(value["hello"]["features"]["eventBatch"], true);
    assert!(value["hello"]["features"].get("event_batch").is_none());
}

#[test]
fn app_protocol_includes_cancel_unsubscribe_event_id_and_subscribed() {
    let cancel = serde_json::to_value(AppMessage::Cancel {
        target_request_id: 7,
        reason: Some("timeout".into()),
    })
    .unwrap();
    assert_eq!(
        cancel,
        serde_json::json!({"kind":"cancel","targetRequestId":7,"reason":"timeout"})
    );
    let unsubscribe = serde_json::to_value(AppMessage::Unsubscribe {
        scopes: vec!["*".into()],
    })
    .unwrap();
    assert_eq!(
        unsubscribe,
        serde_json::json!({"kind":"unsubscribe","scopes":["*"]})
    );
    let event = AppServerMessage::Event(AppEventMessage {
        scope: "conversation:c1".into(),
        seq: 2,
        epoch: "e".into(),
        event_id: "e:conversation:c1:2".into(),
        channel: "engine:event".into(),
        payload: None,
    });
    let value = serde_json::to_value(event).unwrap();
    assert_eq!(value["eventId"], "e:conversation:c1:2");
    let subscribed = serde_json::to_value(AppServerMessage::Subscribed {
        request_id: Some(3),
        cursors: HashMap::new(),
    })
    .unwrap();
    assert_eq!(subscribed["kind"], "subscribed");
    assert_eq!(subscribed["requestId"], 3);
}

#[test]
fn subscribe_command_has_exact_conversation_scope_shape() {
    let message = command_to_app_message(&serde_json::json!({
        "kind":"subscribe",
        "requestId":7,
        "scopes":["conversation:c1"],
        "since":{"conversation:c1":{"epoch":"epoch-1","seq":4}}
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(message).unwrap(),
        serde_json::json!({
            "kind":"subscribe","requestId":7,"scopes":["conversation:c1"],
            "since":{"conversation:c1":{"epoch":"epoch-1","seq":4}}
        })
    );
}
#[test]
fn event_batches_are_events_not_arbitrary_server_messages() {
    let batch = AppServerMessage::Events {
        events: vec![AppEventEnvelope::Event(AppEventMessage {
            scope: "installation".into(),
            seq: 1,
            epoch: "e".into(),
            event_id: "id".into(),
            channel: "notice".into(),
            payload: Some(serde_json::json!({"type":"notice"})),
        })],
    };
    let value = serde_json::to_value(&batch).unwrap();
    assert_eq!(value["events"][0]["kind"], "event");
    assert_eq!(value["events"][0]["eventId"], "id");
    assert_eq!(
        serde_json::from_value::<AppServerMessage>(value).unwrap(),
        batch
    );
}

#[test]
fn frame_assembler_reassembles_fragments_and_interleaved_control() {
    let bytes = vec![7u8; MAX_FRAGMENT_BYTES * 2 + 3];
    let frames = split_frame(&bytes, false);
    let mut assembler = FrameAssembler::new(MAX_FRAME_BYTES);
    assert_eq!(assembler.push(&frames[0]).unwrap(), IncomingFrame::Partial);
    assert_eq!(assembler.push(&[PING]).unwrap(), IncomingFrame::Ping);
    assert_eq!(assembler.push(&frames[1]).unwrap(), IncomingFrame::Partial);
    let result = assembler.push(&frames[2]).unwrap();
    assert_eq!(
        result,
        IncomingFrame::Frame {
            data: bytes,
            binary: false
        }
    );
    assert_eq!(assembler.push(&[PONG]).unwrap(), IncomingFrame::Pong);
}

#[test]
fn frame_assembler_bounds_and_compression_match_desktop() {
    let mut assembler = FrameAssembler::new(3);
    assert_eq!(
        assembler.push(&[0, 1, 2, 3]).unwrap(),
        IncomingFrame::Partial
    );
    assert_eq!(
        assembler.push(&[LAST, 5, 6]).unwrap_err(),
        FrameError::FrameTooLarge
    );

    let input = b"repeated text repeated text repeated text";
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(3));
    encoder.write_all(input).unwrap();
    let packed = encoder.finish().unwrap();
    let frame = split_frame_with_options(&packed, false, true, MAX_FRAGMENT_BYTES);
    let mut assembler = FrameAssembler::new(MAX_FRAME_BYTES);
    let result = assembler.push(&frame[0]).unwrap();
    assert_eq!(
        result,
        IncomingFrame::Frame {
            data: input.to_vec(),
            binary: false
        }
    );
}

#[test]
fn close_frame_truncates_at_utf8_boundary() {
    let frame = close_frame(1002, &"界".repeat(100));
    assert!(frame.len() <= 126);
    assert_eq!(
        FrameAssembler::new(MAX_FRAME_BYTES).push(&frame).unwrap(),
        IncomingFrame::Close {
            code: 1002,
            reason: String::from_utf8_lossy(&frame[3..]).into_owned()
        }
    );
}

#[cfg(feature = "iroh-transport")]
#[test]
fn iroh_fragment_prefix_is_four_byte_big_endian_and_allows_transport_max() {
    assert_eq!(iroh_transport::IROH_MAX_FRAGMENT_BYTES, 65_537);
    let length = 65_537u32.to_be_bytes();
    assert_eq!(length, [0, 1, 0, 1]);
}
#[test]
fn legacy_auth_ack_is_wire_compatible_before_welcome() {
    let auth: LegacyAuthMessage = serde_json::from_value(serde_json::json!({
        "type":"auth",
        "ok":true,
        "device":{"id":"desktop-1","label":"Mac"}
    }))
    .unwrap();
    assert_eq!(
        auth,
        LegacyAuthMessage::Auth {
            ok: true,
            device: Some(serde_json::json!({"id":"desktop-1","label":"Mac"})),
            error: None,
        }
    );
    let rejected: LegacyAuthMessage = serde_json::from_value(serde_json::json!({
        "type":"auth","ok":false,"error":"令牌无效"
    }))
    .unwrap();
    assert!(matches!(
        rejected,
        LegacyAuthMessage::Auth { ok: false, .. }
    ));
}

#[cfg(feature = "iroh-transport")]
#[test]
fn desktop_snapshot_hydrates_camel_case_parts_queue_pause_and_history() {
    let shared = Arc::new(SharedCore::new());
    lock(&shared.connection).conversation_id = Some("c1".into());
    let value = serde_json::json!({
        "conversationId":"c1",
        "messages":[{
            "id":"reply", "role":"assistant", "text":"Actual reply", "createdAt":1,
            "tools":[{"id":"tool-1","name":"read","status":"success"}],
            "parts":[
                {"kind":"thinking","text":"Thinking","startedAt":2,"endedAt":3},
                {"kind":"tool","toolId":"tool-1"},
                {"kind":"text","text":"Actual reply"}
            ]
        }],
        "messageMode":"window", "history":{"beforeEntryId":"older"},
        "running":false,
        "queue":{"conversationId":"c1","revision":4,"items":[],"pause":"manual"},
        "pendingUi":[], "turnEvents":[], "overflowed":false, "seq":42
    });
    shared.register_rpc(1, PendingRpc {
        action:"snapshot".into(), method:"engine:get-snapshot".into(),
        kind:RpcKind::Snapshot { conversation_id:"c1".into() }, created_at:Instant::now(),
    });
    events::apply_rpc_result(&shared, 1, true, Some(value), None);
    let snapshot = shared.snapshot();
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].text, "Actual reply");
    let serialized = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(serialized["messages"][0]["parts"][1]["toolId"], "tool-1");
    assert_eq!(serialized["messages"][0]["parts"][0]["startedAt"], 2);
    assert_eq!(snapshot.queue.pause.as_deref(), Some("manual"));
    assert_eq!(snapshot.history_before_entry_id.as_deref(), Some("older"));
    assert_eq!(lock(&shared.events).pop_front().unwrap()["ok"], true);
}

#[cfg(feature = "iroh-transport")]
#[test]
fn malformed_snapshot_is_reported_as_failed_rpc_instead_of_empty_success() {
    let shared = Arc::new(SharedCore::new());
    for (request_id, value) in [
        (1, serde_json::json!({"conversationId":"c1","messages":[]})),
        (2, serde_json::to_value(TranscriptStore::default().snapshot(Some("other".into()))).unwrap()),
    ] {
        shared.register_rpc(request_id, PendingRpc {
            action:"snapshot".into(), method:"engine:get-snapshot".into(),
            kind:RpcKind::Snapshot { conversation_id:"c1".into() }, created_at:Instant::now(),
        });
        events::apply_rpc_result(&shared, request_id, true, Some(value), None);
        let event = lock(&shared.events).pop_front().unwrap();
        assert_eq!(event["ok"], false);
        assert_eq!(event["error"]["code"], "mobile.invalid_snapshot");
    }
}

#[test]
fn snapshot_nested_history_and_prepend_keep_oldest_messages() {
    let snapshot = ConversationSnapshot {
        conversation_id: Some("c1".into()),
        messages: vec![message("new")],
        message_mode: Some("window".into()),
        history_before_entry_id: None,
        history: Some(SnapshotHistory {
            before_entry_id: Some("old-cursor".into()),
        }),
        running: false,
        queue: QueueState::default(),
        pending_ui: vec![],
        turn_events: vec![],
        overflowed: false,
        seq: 4,
    };
    let mut store = TranscriptStore::new(2);
    store.replace_snapshot(snapshot);
    store.prepend_history(&ConversationHistoryPage {
        conversation_id: Some("c1".into()),
        messages: vec![message("old-1"), message("old-2")],
        before_entry_id: "old-cursor".into(),
        next_before_entry_id: Some("older".into()),
        reset: false,
    });
    let ids: Vec<_> = store
        .snapshot(Some("c1".into()))
        .messages
        .into_iter()
        .map(|item| item.id)
        .collect();
    assert_eq!(ids, vec!["old-1", "old-2"]);
    assert_eq!(store.history_before.as_deref(), Some("older"));
}

#[test]
fn transcript_event_engine_seq_is_separate_from_wire_seq() {
    let mut store = TranscriptStore::new(4);
    store.replace_snapshot(ConversationSnapshot {
        conversation_id: Some("c1".into()),
        messages: vec![],
        message_mode: Some("window".into()),
        history_before_entry_id: None,
        history: None,
        running: false,
        queue: QueueState::default(),
        pending_ui: vec![],
        turn_events: vec![],
        overflowed: false,
        seq: 42,
    });
    store.apply_engine_event(&serde_json::json!({"type":"notice","seq":3,"message":"new"}));
    assert_eq!(store.turn_events.len(), 1);
    assert_eq!(store.seq, 42);
}

#[test]
fn queue_result_hydration_requires_matching_conversation_and_newer_revision() {
    let shared = Arc::new(SharedCore::new());
    lock(&shared.connection).conversation_id = Some("c1".into());
    lock(&shared.store).queue = QueueState {
        conversation_id: Some("c1".into()),
        revision: 4,
        items: vec![],
        pause: None,
        paused: false,
    };
    hydrate_rpc_result(
        &shared,
        &RpcKind::Queue {
            conversation_id: "c1".into(),
        },
        &serde_json::json!({"conversationId":"c1","revision":3,"items":[{"id":"old"}],"pause":null,"paused":false}),
    );
    assert_eq!(lock(&shared.store).queue.revision, 4);
    hydrate_rpc_result(
        &shared,
        &RpcKind::Queue {
            conversation_id: "c1".into(),
        },
        &serde_json::json!({"conversationId":"c1","revision":5,"items":[{"id":"new"}],"paused":false}),
    );
    assert_eq!(lock(&shared.store).queue.revision, 5);
    hydrate_rpc_result(
        &shared,
        &RpcKind::Queue {
            conversation_id: "c2".into(),
        },
        &serde_json::json!({"conversationId":"c2","revision":9,"items":[{"id":"wrong"}],"paused":false}),
    );
    assert_eq!(
        lock(&shared.store).queue.conversation_id.as_deref(),
        Some("c1")
    );
}

#[test]
fn history_result_rejects_stale_conversation_and_reset_keeps_visible_messages() {
    let shared = Arc::new(SharedCore::new());
    lock(&shared.connection).conversation_id = Some("c1".into());
    lock(&shared.store).apply_message(message("visible"));
    hydrate_rpc_result(
        &shared,
        &RpcKind::HistoryPage {
            conversation_id: "c1".into(),
        },
        &serde_json::json!({"conversationId":"c2","messages":[{"id":"wrong","role":"assistant","text":"x","createdAt":1}],"beforeEntryId":"b","nextBeforeEntryId":null,"reset":false}),
    );
    assert_eq!(
        lock(&shared.store).snapshot(Some("c1".into())).messages[0].id,
        "visible"
    );
    hydrate_rpc_result(
        &shared,
        &RpcKind::HistoryPage {
            conversation_id: "c1".into(),
        },
        &serde_json::json!({"conversationId":"c1","messages":[],"beforeEntryId":"b","nextBeforeEntryId":null,"reset":true}),
    );
    assert_eq!(
        lock(&shared.store).snapshot(Some("c1".into())).messages[0].id,
        "visible"
    );
}

#[test]
fn background_conversation_event_does_not_mutate_active_transcript() {
    let shared = Arc::new(SharedCore::new());
    *lock(&shared.welcome) = Some(WelcomeState {
        session_id: "s".into(),
        epoch: "e".into(),
        capabilities: vec![],
        features: serde_json::Value::Null,
    });
    lock(&shared.connection).conversation_id = Some("c1".into());
    lock(&shared.store).apply_message(message("active"));
    apply_server_event(
        &shared,
        AppEventMessage {
            scope: "conversation:c2".into(),
            seq: 1,
            epoch: "e".into(),
            event_id: "e:c2:1".into(),
            channel: "engine:event".into(),
            payload: Some(
                serde_json::json!({"type":"message","conversationId":"c2","message":{"id":"background","role":"assistant","text":"background","createdAt":1}}),
            ),
        },
    );
    assert_eq!(
        lock(&shared.store).snapshot(Some("c1".into())).messages[0].id,
        "active"
    );
}

#[test]
fn transcript_keeps_interleaved_parts_and_bounds_history() {
    let mut store = TranscriptStore::new(2);
    for index in 0..4 {
        let mut value = message(&index.to_string());
        value.parts = Some(vec![
            MessagePart::Thinking {
                text: "inspect".into(),
                started_at: Some(1),
                ended_at: Some(2),
            },
            MessagePart::Tool {
                tool_id: "tool-1".into(),
            },
            MessagePart::Text {
                text: "done".into(),
            },
        ]);
        store.apply_message(value);
    }
    let snapshot = store.snapshot(Some("c1".into()));
    assert_eq!(snapshot.messages.len(), 2);
    assert!(snapshot.overflowed);
    assert!(matches!(
        snapshot.messages[0].parts.as_ref().unwrap()[0],
        MessagePart::Thinking { .. }
    ));
}

#[test]
fn engine_event_updates_full_tool_call_without_dropping_details() {
    let mut store = TranscriptStore::new(4);
    store.apply_engine_event(&serde_json::json!({
        "type":"message_update", "messageId":"m1",
        "assistantMessageEvent":{"type":"toolcall_delta","partial":{"content":[{"id":"t1","name":"read","arguments":{"path":"README.md"}}]}}
    }));
    store.apply_engine_event(&serde_json::json!({
        "type":"tool_execution_end", "toolCallId":"t1", "output":"contents",
        "details":{"lines":42}, "isError":false
    }));
    let tool = &store.snapshot(Some("c1".into())).messages[0].tools[0];
    assert_eq!(tool.status, "done");
    assert_eq!(tool.result.as_deref(), Some("contents"));
    assert_eq!(tool.details.as_ref().unwrap()["lines"], 42);
}

#[test]
fn handle_command_and_poll_are_bounded_and_independent() {
    let first = CoreHandle::new();
    let second = CoreHandle::new();
    let response = first.command(serde_json::json!({"action":"apply","value":{"conversationId":"c1","messages":[],"messageMode":"window","historyBeforeEntryId":null,"running":false,"queue":{"items":[],"paused":false},"pendingUi":[],"turnEvents":[],"overflowed":false,"seq":4}}));
    assert_eq!(response["ok"], true);
    assert_eq!(response["state"]["snapshot"]["seq"], 4);
    assert_eq!(second.shared.state().snapshot.unwrap().seq, 0);
    let polled = first.command(serde_json::json!({"action":"poll"}));
    assert_eq!(polled["ok"], true);
    assert_eq!(polled["result"]["events"].as_array().unwrap().len(), 0);
}
