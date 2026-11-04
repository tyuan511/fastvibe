use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::thread;

fn http_steps(
    steps: Vec<(&'static str, u16, serde_json::Value)>,
) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
        for (path, status, body) in steps {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "missing HTTP step {path}");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            assert!(first.contains(&format!(" {path} HTTP/1.1")), "{first}");
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            let body = body.to_string();
            write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    (origin, task)
}

fn ok(core: &CoreHandle, value: serde_json::Value) -> serde_json::Value {
    let response = core.command(value);
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}

fn register(core: &CoreHandle, name: &str) {
    assert_eq!(
        ok(
            core,
            serde_json::json!({"action":"registerDevice","installId":"install","name":name,"platform":"android"})
        )["deviceId"],
        "phone"
    );
}
fn endpoint(core: &CoreHandle) {
    ok(
        core,
        serde_json::json!({"action":"registerEndpoint","deviceId":"phone","endpointId":"endpoint"}),
    );
}

#[test]
fn registration_reuses_only_successful_matching_fresh_account_context() {
    let device = serde_json::json!({"device":{"id":"phone"}});
    let (origin, server) = http_steps(vec![
        ("/api/devices/me", 200, device.clone()),
        ("/api/devices/phone/iroh", 200, serde_json::json!({})),
        ("/api/devices/me", 200, device.clone()),
        ("/api/devices/phone/iroh", 200, serde_json::json!({})),
        ("/api/devices/me", 200, device.clone()),
        ("/api/devices/phone/iroh", 200, serde_json::json!({})),
        ("/api/devices/phone/iroh", 200, serde_json::json!({})),
        ("/api/devices/me", 200, device),
    ]);
    let core = CoreHandle::new();
    ok(&core, serde_json::json!({"action":"identity"}));
    ok(
        &core,
        serde_json::json!({"action":"setToken","origin":origin,"token":"first"}),
    );
    register(&core, "Phone");
    endpoint(&core);
    ok(&core, serde_json::json!({"action":"disconnect"}));
    assert_eq!(
        ok(
            &core,
            serde_json::json!({"action":"setToken","origin":origin,"token":"first"})
        )["reused"],
        true
    );
    register(&core, "Phone");
    endpoint(&core); // No HTTP requests on reconnect.
    {
        let mut cache = lock(&core.registrations);
        cache.device.as_mut().unwrap().4 = Instant::now() - REGISTRATION_TTL;
        cache.endpoint.as_mut().unwrap().2 = Instant::now() - REGISTRATION_TTL;
    }
    register(&core, "Phone");
    endpoint(&core); // TTL must trigger both requests.
    ok(
        &core,
        serde_json::json!({"action":"setToken","origin":origin,"token":"second"}),
    );
    register(&core, "Phone");
    endpoint(&core);
    ok(
        &core,
        serde_json::json!({"action":"setIdentity","secretKey":"01".repeat(32)}),
    );
    register(&core, "Phone");
    endpoint(&core); // Identity change invalidates only endpoint registration.
    register(&core, "Renamed");
    endpoint(&core);
    ok(&core, serde_json::json!({"action":"clearAccount"}));
    assert!(lock(&core.account).is_none());
    assert!(lock(&core.registrations).device.is_none());
    server.join().unwrap();
}

#[test]
fn failed_or_revoked_registration_cannot_poison_the_reuse_cache() {
    let device = serde_json::json!({"device":{"id":"phone"}});
    let (origin, server) = http_steps(vec![
        ("/api/devices/me", 503, serde_json::json!({})),
        ("/api/devices/me", 200, device.clone()),
        ("/api/devices/phone/iroh", 403, serde_json::json!({})),
        ("/api/devices/me", 200, device),
        ("/api/devices/phone/iroh", 200, serde_json::json!({})),
    ]);
    let core = CoreHandle::new();
    ok(
        &core,
        serde_json::json!({"action":"setToken","origin":origin,"token":"token"}),
    );
    assert_eq!(core.command(serde_json::json!({"action":"registerDevice","installId":"install","name":"Phone","platform":"android"}))["ok"], false);
    register(&core, "Phone");
    assert_eq!(core.command(serde_json::json!({"action":"registerEndpoint","deviceId":"phone","endpointId":"endpoint"}))["ok"], false);
    register(&core, "Phone");
    endpoint(&core);
    server.join().unwrap();
}

#[test]
fn old_welcome_and_error_frames_cannot_reopen_or_close_a_new_generation() {
    let core = CoreHandle::new();
    let welcome = |session: &str, compatible: bool| AppServerMessage::Welcome {
        session_id: session.into(),
        capabilities: vec!["settings".into()],
        epoch: "epoch".into(),
        features: None,
        handshake: serde_json::json!({"protocol":if compatible {APP_PROTOCOL} else {"old"},"protocolVersion":APP_PROTOCOL_VERSION}),
    };
    lock(&core.shared.connection).generation = 1;
    handle_server_message(&core.shared, 1, welcome("old", true));
    assert_eq!(core.shared.state().session_id.as_deref(), Some("old"));
    ok(&core, serde_json::json!({"action":"disconnect"}));
    handle_server_message(&core.shared, 1, welcome("late", true));
    assert_eq!(core.shared.state().connection, "disconnected");
    assert!(core.shared.state().session_id.is_none());
    handle_server_message(&core.shared, 2, welcome("new", true));
    handle_server_message(&core.shared, 1, welcome("bad", false));
    assert_eq!(core.shared.state().connection, "ready");
    assert_eq!(core.shared.state().session_id.as_deref(), Some("new"));
}

#[test]
fn account_scope_change_closes_endpoints_but_plain_disconnect_keeps_them() {
    let core = CoreHandle::new();
    ok(
        &core,
        serde_json::json!({"action":"setToken","origin":"https://example.invalid","token":"a"}),
    );
    let key = core.identity_key().unwrap();
    let endpoint = core.runtime.block_on(async {
        core.endpoint_pool
            .lock()
            .await
            .endpoint(key, &[relay(9)])
            .await
            .unwrap()
    });
    ok(&core, serde_json::json!({"action":"disconnect"}));
    assert!(!endpoint.is_closed());
    ok(
        &core,
        serde_json::json!({"action":"setToken","origin":"https://example.invalid/","token":"a"}),
    );
    assert!(!endpoint.is_closed());
    ok(
        &core,
        serde_json::json!({"action":"setToken","origin":"https://example.invalid","token":"b"}),
    );
    assert!(endpoint.is_closed());
    assert!(
        core.runtime
            .block_on(async { core.endpoint_pool.lock().await.current() })
            .is_none()
    );
}

#[test]
fn disconnect_is_a_generation_and_projection_barrier() {
    let core = CoreHandle::new();
    lock(&core.shared.connection).generation = 10;
    core.shared
        .push_event(serde_json::json!({"type":"welcome","sessionId":"old"}));
    *lock(&core.shared.event_overflowed) = true;
    *lock(&core.shared.session_state) = Some(serde_json::json!({"conversationId":"old"}));
    lock(&core.shared.workspace).active_id = Some("old".into());
    *lock(&core.shared.loading_history) = true;
    ok(&core, serde_json::json!({"action":"disconnect"}));
    let response = core.command(serde_json::json!({"action":"poll"}));
    assert_eq!(response["state"]["connectionGeneration"], 11);
    assert_eq!(response["result"]["generation"], 11);
    assert_eq!(response["result"]["events"], serde_json::json!([]));
    assert_eq!(response["result"]["overflowed"], false);
    assert_eq!(
        response["state"]["workspace"]["activeId"],
        serde_json::Value::Null
    );
    assert_eq!(response["state"]["loadingHistory"], false);
    assert!(lock(&core.shared.session_state).is_none());
}

fn relay(port: u16) -> crate::relay_config::MobileRelayNode {
    crate::relay_config::MobileRelayNode {
        relay_id: format!("relay-{port}"),
        url: format!("http://127.0.0.1:{port}"),
        quic_port: Some(port),
        token: "test-token".into(),
    }
}

#[test]
fn direct_hint_validation_is_bounded_and_never_replaces_identity() {
    use crate::iroh_transport::parse_direct_addresses;
    assert!(
        parse_direct_addresses(Some(&serde_json::json!(["127.0.0.1:7777", "[::1]:8888"]))).is_ok()
    );
    for value in [
        serde_json::json!(["0.0.0.0:8"]),
        serde_json::json!(["239.0.0.1:8"]),
        serde_json::json!(["192.168.1.1:0"]),
        serde_json::json!(["host:8"]),
        serde_json::json!(vec!["127.0.0.1:8"; 9]),
    ] {
        assert!(parse_direct_addresses(Some(&value)).is_err());
    }
}

#[tokio::test]
async fn endpoint_pool_reuses_ports_and_replaces_revoked_relays_and_identity() {
    use crate::iroh_transport::IrohEndpointPool;
    let mut pool = IrohEndpointPool::default();
    let key = iroh::SecretKey::generate();
    let first = pool
        .endpoint(key.clone(), &[relay(9), relay(10)])
        .await
        .unwrap();
    let second = pool.endpoint(key, &[relay(10)]).await.unwrap();
    assert_eq!(first.bound_sockets(), second.bound_sockets());
    assert!(
        second
            .remove_relay(&relay(9).url.parse::<iroh::RelayUrl>().unwrap())
            .await
            .is_none()
    );
    assert!(
        second
            .remove_relay(&relay(10).url.parse::<iroh::RelayUrl>().unwrap())
            .await
            .is_some()
    );
    let changed = iroh::SecretKey::generate();
    let replacement = pool.endpoint(changed.clone(), &[relay(10)]).await.unwrap();
    assert!(first.is_closed());
    assert_eq!(replacement.id(), changed.public());
    pool.clear().await;
    assert!(replacement.is_closed());
}

#[tokio::test]
async fn cancelled_relay_update_cannot_leave_untracked_nodes_in_the_endpoint() {
    use crate::iroh_transport::IrohEndpointPool;
    use std::future::Future;
    let key = iroh::SecretKey::generate();
    let mut pool = IrohEndpointPool::default();
    let endpoint = pool.endpoint(key.clone(), &[]).await.unwrap();
    let nodes: Vec<_> = (10000..10512).map(relay).collect();
    {
        // Poll without yielding to the actor: its bounded channel makes the update
        // suspend after applying only part of the map, just as a cancelled dial can.
        let mut update = Box::pin(pool.endpoint(key.clone(), &nodes));
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(update.as_mut().poll(&mut context).is_pending());
    }
    let retained = pool.endpoint(key, &[]).await.unwrap();
    assert_eq!(endpoint.bound_sockets(), retained.bound_sockets());
    for node in nodes {
        assert!(
            retained
                .remove_relay(&node.url.parse().unwrap())
                .await
                .is_none(),
            "cancelled update retained a relay absent from the next configuration"
        );
    }
    pool.clear().await;
}

#[tokio::test]
async fn local_hint_dials_with_every_relay_unavailable_and_reuses_endpoint() {
    use crate::iroh_transport::{IrohClient, IrohEndpointPool};
    let server = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(iroh::RelayMode::Disabled)
        .bind()
        .await
        .unwrap();
    let port = server
        .bound_sockets()
        .iter()
        .find(|socket| socket.is_ipv4())
        .unwrap()
        .port();
    let direct: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let server_id = server.id();
    let accepting = server.clone();
    let task = tokio::spawn(async move {
        for _ in 0..2 {
            let connection = accepting.accept().await.unwrap().await.unwrap();
            let (_, mut recv) = connection.accept_bi().await.unwrap();
            let mut bytes = [0u8; 64];
            assert!(recv.read(&mut bytes).await.unwrap().is_some());
        }
    });
    let mut pool = IrohEndpointPool::default();
    let endpoint = pool
        .endpoint(iroh::SecretKey::generate(), &[relay(9)])
        .await
        .unwrap();
    for _ in 0..2 {
        let client = tokio::time::timeout(
            Duration::from_secs(5),
            IrohClient::connect_on(endpoint.clone(), server_id, &[relay(9)], &[direct]),
        )
        .await
        .unwrap()
        .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        client.connection.close(0u32.into(), b"done");
        assert!(!endpoint.is_closed());
    }
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    pool.clear().await;
    server.close().await;
}
