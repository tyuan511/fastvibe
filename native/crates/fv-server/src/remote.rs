//! Opt-in native LAN transport. HTTP authenticates before a socket enters the call table.
use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use fv_protocol::{ErrorObject, jsonrpc::code, remote::*};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;

use crate::{ServerState, auth::AuthStore};

#[derive(Clone, Serialize, Deserialize)]
struct Config {
    enabled: bool,
    port: u16,
    #[serde(default = "default_name")]
    name: String,
}
fn default_name() -> String {
    crate::remote_discovery::DEFAULT_NAME.to_owned()
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 7777,
            name: default_name(),
        }
    }
}

struct Running {
    address: SocketAddr,
    stop: watch::Sender<bool>,
}

pub struct Remote {
    state: Weak<ServerState>,
    auth: Arc<AuthStore>,
    config: Mutex<Config>,
    running: Mutex<Option<Running>>,
    discovery: Mutex<crate::remote_discovery::RemoteDiscovery>,
    operation: tokio::sync::Mutex<()>,
    login_slots: Arc<tokio::sync::Semaphore>,
}

fn invalid(error: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, error.to_string())
}
fn registry() -> &'static Mutex<HashMap<PathBuf, Arc<Remote>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<Remote>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

impl Remote {
    pub fn for_state(state: &Arc<ServerState>) -> Result<Arc<Self>, ErrorObject> {
        let mut registry = registry().lock().unwrap();
        if let Some(remote) = registry.get(&state.data_dir) {
            if remote
                .state
                .upgrade()
                .is_some_and(|existing| Arc::ptr_eq(&existing, state))
            {
                return Ok(remote.clone());
            }
            remote.stop();
        }
        let config = match std::fs::read(state.data_dir.join("native-remote.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(invalid)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Config::default(),
            Err(error) => return Err(invalid(error)),
        };
        let remote = Arc::new(Self {
            state: Arc::downgrade(state),
            auth: Arc::new(
                AuthStore::open(state.data_dir.join("native-remote-access.json"))
                    .map_err(invalid)?,
            ),
            config: Mutex::new(config),
            running: Mutex::new(None),
            discovery: Mutex::new(
                crate::remote_discovery::RemoteDiscovery::new(&state.data_dir).map_err(invalid)?,
            ),
            operation: tokio::sync::Mutex::new(()),
            login_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        });
        registry.insert(state.data_dir.clone(), remote.clone());
        Ok(remote)
    }

    pub fn status(&self) -> RemoteStatus {
        let config = self.config.lock().unwrap().clone();
        let running = self.running.lock().unwrap();
        RemoteStatus {
            enabled: config.enabled,
            port: config.port,
            listening: running.is_some(),
            password_configured: self.auth.configured(),
            name: config.name,
            install_id: self.discovery.lock().unwrap().install_id().to_owned(),
            devices: self
                .auth
                .devices()
                .into_iter()
                .map(|device| RemoteDevice {
                    id: device.id,
                    label: device.label,
                })
                .collect(),
            // Wildcard bind addresses are not usable QR origins. Enumerate real interfaces.
            addresses: running
                .as_ref()
                .map(|run| interface_origins(run.address.port()))
                .unwrap_or_default(),
        }
    }

    pub async fn restore(self: &Arc<Self>) -> Result<(), ErrorObject> {
        let _operation = self.operation.lock().await;
        self.sync().await
    }

    pub async fn configure(
        self: &Arc<Self>,
        params: RemoteConfigureParams,
    ) -> Result<RemoteStatus, ErrorObject> {
        if params.port == 0 {
            return Err(invalid("port must be between 1 and 65535"));
        }
        let _operation = self.operation.lock().await;
        let previous = self.config.lock().unwrap().clone();
        *self.config.lock().unwrap() = Config {
            enabled: params.enabled,
            port: params.port,
            name: params
                .name
                .as_deref()
                .map(crate::remote_discovery::instance_name)
                .unwrap_or_else(|| previous.name.clone()),
        };
        if let Err(error) = self.sync().await {
            *self.config.lock().unwrap() = previous;
            let _ = self.sync().await;
            return Err(error);
        }
        self.persist()?;
        Ok(self.status())
    }

    pub async fn set_password(
        self: &Arc<Self>,
        password: String,
    ) -> Result<RemoteStatus, ErrorObject> {
        if password.len() > 1024 {
            return Err(invalid("password is too long"));
        }
        let _operation = self.operation.lock().await;
        let auth = self.auth.clone();
        tokio::task::spawn_blocking(move || {
            if password.is_empty() {
                auth.clear_password()
            } else {
                auth.set_password(&password)
            }
        })
        .await
        .map_err(invalid)?
        .map_err(invalid)?;
        self.sync().await?;
        Ok(self.status())
    }

    pub fn revoke(&self, device_id: &str) -> Result<RemoteStatus, ErrorObject> {
        self.auth.revoke(device_id).map_err(invalid)?;
        Ok(self.status())
    }

    fn persist(&self) -> Result<(), ErrorObject> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| invalid("server stopped"))?;
        let config = self.config.lock().unwrap().clone();
        let temporary = state
            .data_dir
            .join(format!("native-remote.{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, serde_json::to_vec(&config).map_err(invalid)?)
            .map_err(invalid)?;
        std::fs::rename(temporary, state.data_dir.join("native-remote.json")).map_err(invalid)
    }

    fn sync(
        self: &Arc<Self>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ErrorObject>> + Send + '_>>
    {
        Box::pin(async move {
            let config = self.config.lock().unwrap().clone();
            let desired = config.enabled && self.auth.configured();
            {
                let mut running = self.running.lock().unwrap();
                if running
                    .as_ref()
                    .is_some_and(|run| desired && run.address.port() == config.port)
                {
                    self.sync_discovery(&config, running.as_ref().map(|run| run.address));
                    return Ok(());
                }
                self.discovery.lock().unwrap().stop();
                if let Some(run) = running.take() {
                    let _ = run.stop.send(true);
                }
            }
            if !desired {
                return Ok(());
            }
            let listener = bind_dual_stack(config.port).map_err(invalid)?;
            let address = listener.local_addr().map_err(invalid)?;
            let (stop, mut stopped) = watch::channel(false);
            self.monitor_interfaces(stop.subscribe());
            *self.running.lock().unwrap() = Some(Running { address, stop });
            self.sync_discovery(&config, Some(address));
            let router = Router::new()
            .route("/api/hello", get(|| async { Json(serde_json::json!({"protocolVersion": fv_protocol::PROTOCOL_VERSION, "transport": "fv-protocol"})) }))
            .route("/api/login", post(login))
            .route("/ws", get(upgrade))
            .layer(axum::extract::DefaultBodyLimit::max(4096))
            .with_state(self.clone());
            tokio::spawn(async move {
                let _ = axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = stopped.changed().await;
                    })
                    .await;
            });
            Ok(())
        })
    }

    /// Address recovery belongs to discovery, not the listener: wildcard sockets and
    /// authenticated connections survive interface changes. The watch subscription ties
    /// this small task to exactly one listener generation and Weak avoids retaining Remote.
    fn monitor_interfaces(self: &Arc<Self>, mut stopped: watch::Receiver<bool>) {
        let remote = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut previous = None;
            loop {
                tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    _ = interval.tick() => {},
                }
                let Some(remote) = remote.upgrade() else {
                    break;
                };
                let _operation = remote.operation.lock().await;
                if *stopped.borrow() {
                    break;
                }
                let config = remote.config.lock().unwrap().clone();
                let running = remote.running.lock().unwrap();
                let Some(run) = running.as_ref() else {
                    break;
                };
                if !config.enabled || !remote.auth.configured() {
                    break;
                }
                let origins = interface_origins(run.address.port());
                if previous.as_ref() == Some(&origins) {
                    continue;
                }
                match remote.discovery.lock().unwrap().sync(
                    true,
                    true,
                    run.address.port(),
                    &config.name,
                    &origins,
                ) {
                    Ok(()) => previous = Some(origins),
                    Err(error) => eprintln!("Native LAN discovery unavailable: {error}"),
                }
            }
        });
    }

    fn sync_discovery(&self, config: &Config, address: Option<SocketAddr>) {
        let origins = address
            .map(|a| interface_origins(a.port()))
            .unwrap_or_default();
        if let Err(error) = self.discovery.lock().unwrap().sync(
            address.is_some() && config.enabled,
            self.auth.configured(),
            config.port,
            &config.name,
            &origins,
        ) {
            eprintln!("Native LAN discovery unavailable: {error}");
        }
    }

    pub fn stop(&self) {
        let mut running = self.running.lock().unwrap();
        self.discovery.lock().unwrap().stop();
        if let Some(run) = running.take() {
            let _ = run.stop.send(true);
        }
    }
}

pub fn shutdown(state: &ServerState) {
    if let Some(remote) = registry().lock().unwrap().remove(&state.data_dir) {
        remote.stop();
    }
}

/// Explicitly enables IPv4-mapped connections on the IPv6 listener, with IPv4 fallback only
/// when IPv6 is unavailable. No listener is constructed before enabled + password are true.
pub fn bind_dual_stack(port: u16) -> std::io::Result<tokio::net::TcpListener> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV6,
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    );
    match socket.and_then(|socket| {
        socket.set_only_v6(false)?;
        socket.set_reuse_address(true)?;
        socket.bind(&SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port).into())?;
        socket.listen(128)?;
        socket.set_nonblocking(true)?;
        tokio::net::TcpListener::from_std(socket.into())
    }) {
        Ok(listener) => Ok(listener),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EAFNOSUPPORT | libc::EPROTONOSUPPORT | libc::EADDRNOTAVAIL)
            ) =>
        {
            let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port))?;
            listener.set_nonblocking(true)?;
            tokio::net::TcpListener::from_std(listener)
        }
        Err(error) => Err(error),
    }
}

#[derive(Deserialize)]
struct Login {
    password: String,
    label: String,
}
async fn login(State(remote): State<Arc<Remote>>, Json(login): Json<Login>) -> Response {
    if !remote.config.lock().unwrap().enabled || !remote.auth.configured() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = remote.login_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let auth = remote.auth.clone();
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        auth.login(&login.password, &login.label)
    })
    .await
    {
        Ok(Ok((token, device))) => {
            Json(serde_json::json!({"token":token,"device":{"id":device.id,"label":device.label}}))
                .into_response()
        }
        Ok(Err(crate::auth::AuthError::RateLimited(_))) => {
            StatusCode::TOO_MANY_REQUESTS.into_response()
        }
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn upgrade(
    State(remote): State<Arc<Remote>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if headers.contains_key("origin") {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !remote.config.lock().unwrap().enabled {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(token) = headers
        .get("authorization")
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
        .map(str::to_owned)
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if remote.auth.authenticate(&token).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.max_message_size(64 * 1024 * 1024)
        .max_frame_size(64 * 1024 * 1024)
        .on_upgrade(move |socket| serve_socket(remote, token, socket))
        .into_response()
}

async fn serve_socket(remote: Arc<Remote>, token: String, socket: WebSocket) {
    let Some(state) = remote.state.upgrade() else {
        return;
    };
    // Authentication happened before this call can register a connection or see a broadcast.
    let (server, adapter) = tokio::io::duplex(64 * 1024);
    let (server_read, server_write) = tokio::io::split(server);
    let mut serving = tokio::spawn(crate::serve_connection(
        state,
        fv_protocol::types::ClientOrigin::Lan,
        server_read,
        server_write,
    ));
    let (adapter_read, mut adapter_write) = tokio::io::split(adapter);
    let mut lines = BufReader::new(adapter_read).lines();
    let (mut sink, mut stream) = socket.split();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut alive = true;
    let mut authorization = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = &mut serving => break,
            _ = authorization.tick() => {
                if !remote.config.lock().unwrap().enabled || remote.auth.authenticate(&token).is_none() { break; }
            }
            _ = heartbeat.tick() => {
                if !alive { break; }
                alive = false;
                if !matches!(tokio::time::timeout(Duration::from_secs(15), sink.send(WsMessage::Ping(Vec::new().into()))).await, Ok(Ok(()))) { break; }
            }
            incoming = stream.next() => match incoming {
                Some(Ok(WsMessage::Text(text))) => {
                    alive = true;
                    // One websocket message is one native JSON-RPC frame, never an envelope.
                    if text.contains('\n') || text.contains('\r') { break; }
                    if !matches!(tokio::time::timeout(Duration::from_secs(15), async {
                        adapter_write.write_all(text.as_bytes()).await?;
                        adapter_write.write_all(b"\n").await
                    }).await, Ok(Ok(()))) { break; }
                }
                Some(Ok(WsMessage::Pong(_))) => alive = true,
                Some(Ok(WsMessage::Ping(bytes))) => { if sink.send(WsMessage::Pong(bytes)).await.is_err() { break; } }
                _ => break,
            },
            outgoing = lines.next_line() => match outgoing {
                Ok(Some(text)) => {
                    // A full frame is allowed, but no stalled socket can accumulate an unbounded
                    // queue: the duplex + call-table channel apply pressure and writes have a deadline.
                    match tokio::time::timeout(Duration::from_secs(15), sink.send(WsMessage::Text(text.into()))).await {
                        Ok(Ok(())) => {}, _ => break,
                    }
                }
                _ => break,
            },
        }
    }
    drop(adapter_write);
    drop(lines);
    if !serving.is_finished()
        && tokio::time::timeout(Duration::from_secs(2), &mut serving)
            .await
            .is_err()
    {
        serving.abort();
        let _ = serving.await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
}

pub(super) fn interface_origins(port: u16) -> Vec<String> {
    // getifaddrs reports each concrete interface; no DNS request or external service is involved.
    let mut addresses = Vec::new();
    unsafe {
        let mut first = std::ptr::null_mut();
        if libc::getifaddrs(&mut first) != 0 {
            return addresses;
        }
        let mut cursor = first;
        while let Some(interface) = cursor.as_ref() {
            if !interface.ifa_addr.is_null()
                && interface.ifa_flags & libc::IFF_LOOPBACK as u32 == 0
                && interface.ifa_flags & libc::IFF_UP as u32 != 0
            {
                let family = (*interface.ifa_addr).sa_family as i32;
                if family == libc::AF_INET {
                    let address = &*(interface.ifa_addr as *const libc::sockaddr_in);
                    let ip = std::net::Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes());
                    if !ip.is_unspecified() && !ip.is_link_local() {
                        addresses.push(format!("http://{ip}:{port}"));
                    }
                } else if family == libc::AF_INET6 {
                    let address = &*(interface.ifa_addr as *const libc::sockaddr_in6);
                    let ip = std::net::Ipv6Addr::from(address.sin6_addr.s6_addr);
                    if !ip.is_unspecified() && !ip.is_unicast_link_local() {
                        addresses.push(format!("http://[{ip}]:{port}"));
                    }
                }
            }
            cursor = interface.ifa_next;
        }
        libc::freeifaddrs(first);
    }
    addresses.sort();
    addresses.dedup();
    addresses
}
