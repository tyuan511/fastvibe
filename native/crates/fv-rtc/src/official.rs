//! Cloud-only authentication boundary. A call is admitted solely after an `incoming`
//! message on this account's authenticated signaling socket. DTLS verifies the SDP
//! fingerprint. There is no password exchange or Electron protocol adapter.
use crate::{
    Error, Result,
    account::{AccountSession, bounded_json, private_write},
    peer::{AnswerPeer, Signal, TransportConfig},
};
use futures_util::{SinkExt, StreamExt};
use fv_protocol::official::{OfficialPeer, OfficialState, OfficialStatus};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, time::Duration};
use tokio::{
    io::DuplexStream,
    sync::{mpsc, watch},
    task::JoinSet,
};
use tokio_tungstenite::tungstenite::{
    Message, client::IntoClientRequest, protocol::WebSocketConfig,
};
use tokio_util::sync::CancellationToken;
use webrtc::ice_transport::ice_server::RTCIceServer;

/// Already authenticated by the account service + DTLS. The owner splits `stream`
/// and calls `fv_server::serve_connection(state, ClientOrigin::Official, read, write)`.
/// Dropping it disconnects the peer; no server dependency is needed in this crate.
pub struct AcceptedConnection {
    pub stream: DuplexStream,
    pub peer: OfficialPeer,
}

#[derive(Clone, Debug)]
pub struct OfficialConfig {
    pub install_id: String,
    pub name: String,
    pub platform: String,
    pub transport: TransportConfig,
    pub connect_timeout: Duration,
}
impl OfficialConfig {
    pub fn new(install_id: String, name: String, platform: String) -> Self {
        Self {
            install_id,
            name,
            platform,
            transport: TransportConfig::default(),
            connect_timeout: Duration::from_secs(30),
        }
    }
}

/// One enabled account generation. Dropping/shutting down closes signaling and every
/// phone. On sign-out/account replacement the host must drop this handle before creating
/// its successor; no late registration task can then reopen the old account.
pub struct OfficialConnection {
    pub accepted: mpsc::Receiver<AcceptedConnection>,
    pub state: watch::Receiver<OfficialState>,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
impl OfficialConnection {
    pub fn start(account: AccountSession, config: OfficialConfig) -> Result<Self> {
        if !valid_install_id(&config.install_id)
            || config.name.is_empty()
            || config.name.chars().count() > 64
            || config.platform.len() > 40
        {
            return Err(Error::Protocol("invalid device registration"));
        }
        let (accepted_tx, accepted) = mpsc::channel(8);
        let initial = OfficialState {
            enabled: true,
            name: config.name.clone(),
            status: OfficialStatus::Connecting,
            device_id: None,
            peers: Vec::new(),
            error: None,
        };
        let (state_tx, state) = watch::channel(initial);
        let stop = CancellationToken::new();
        let task_stop = stop.clone();
        let task = tokio::spawn(async move {
            let outcome = tokio::select! {
                _ = task_stop.cancelled() => Ok(()),
                result = run(account, config, accepted_tx, state_tx.clone(), task_stop.clone()) => result,
            };
            task_stop.cancel();
            state_tx.send_modify(|state| {
                state.status = if outcome.is_ok() {
                    OfficialStatus::Off
                } else {
                    OfficialStatus::Error
                };
                state.error = outcome.err().map(|e| e.to_string());
                state.peers.clear();
            });
        });
        Ok(Self {
            accepted,
            state,
            stop,
            task,
        })
    }
    pub async fn shutdown(mut self) {
        self.stop.cancel();
        let _ = (&mut self.task).await;
    }
}
impl Drop for OfficialConnection {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[derive(Deserialize)]
struct Registration {
    device: Device,
}
#[derive(Deserialize)]
struct Device {
    id: String,
}
#[derive(Deserialize)]
struct IceList {
    ice_servers: Vec<IceServer>,
}
#[derive(Deserialize)]
struct IceServer {
    urls: Vec<String>,
}
async fn register(account: &AccountSession, config: &OfficialConfig) -> Result<String> {
    let response = account
        .call(
            reqwest::Method::PUT,
            "/api/devices/me",
            Some(&json!({
                "install_id": config.install_id, "name": config.name, "platform": config.platform,
            })),
        )
        .await?;
    let reply: Registration = bounded_json(response).await?;
    if reply.device.id.is_empty() || reply.device.id.len() > 128 {
        return Err(Error::Response);
    }
    Ok(reply.device.id)
}
pub(crate) async fn stun_servers(account: &AccountSession) -> Result<Vec<RTCIceServer>> {
    let response = account
        .call::<()>(reqwest::Method::GET, "/api/rtc/ice", None)
        .await?;
    let reply: IceList = bounded_json(response).await?;
    // The phone allocates TURN, the answerer only gathers STUN. Avoid a second account
    // allocation for every call. A remote relay pairs with our host/srflx candidates.
    Ok(reply
        .ice_servers
        .into_iter()
        .take(16)
        .filter_map(|entry| {
            let urls: Vec<_> = entry
                .urls
                .into_iter()
                .filter(|url| url.starts_with("stun:") && url.len() <= 1024)
                .take(8)
                .collect();
            (!urls.is_empty()).then_some(RTCIceServer {
                urls,
                ..Default::default()
            })
        })
        .collect())
}

async fn run(
    account: AccountSession,
    config: OfficialConfig,
    accepted: mpsc::Sender<AcceptedConnection>,
    state: watch::Sender<OfficialState>,
    stop: CancellationToken,
) -> Result<()> {
    let mut attempt = 0_u32;
    let mut calls = JoinSet::new();
    // One cancellable directory per account generation, independent of signaling
    // reconnects. Existing peers own snapshots and are never reconfigured on refresh.
    let mut ice = crate::ice::IceDirectory::start(account.clone(), stop.child_token());
    ice.warm().await;
    loop {
        let result = async {
            let device_id = register(&account, &config).await?;
            state.send_modify(|s| {
                s.device_id = Some(device_id.clone());
                s.status = OfficialStatus::Connecting;
                s.error = None;
            });
            signaling(
                &account,
                &config,
                &device_id,
                &ice.servers,
                &accepted,
                &state,
                &stop,
                &mut calls,
            )
            .await
        }
        .await;
        match result {
            Err(Error::Unauthorized | Error::Signaling("replaced" | "removed")) => {
                stop.cancel();
                calls.abort_all();
                while calls.join_next().await.is_some() {}
                return result;
            }
            Err(Error::Http(status)) if (400..500).contains(&status) && status != 429 => {
                stop.cancel();
                calls.abort_all();
                while calls.join_next().await.is_some() {}
                return Err(Error::Http(status));
            }
            _ => {}
        }
        state.send_modify(|s| {
            s.status = OfficialStatus::Connecting;
            s.error = Some("Signaling unavailable; reconnecting".into());
        });
        let delay = Duration::from_secs((1_u64 << attempt.min(5)).min(30));
        attempt = attempt.saturating_add(1);
        tokio::select! { _ = stop.cancelled() => break, _ = tokio::time::sleep(delay) => {} }
    }
    calls.abort_all();
    while calls.join_next().await.is_some() {}
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn signaling(
    account: &AccountSession,
    config: &OfficialConfig,
    device_id: &str,
    ice: &watch::Receiver<Vec<RTCIceServer>>,
    accepted: &mpsc::Sender<AcceptedConnection>,
    state: &watch::Sender<OfficialState>,
    stop: &CancellationToken,
    calls: &mut JoinSet<()>,
) -> Result<()> {
    let mut url = account.issuer().endpoint("/api/rtc/signal");
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| Error::Issuer)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| Error::Transport)?;
    request
        .headers_mut()
        .insert("authorization", account.authorization()?);
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(64 * 1024))
        .max_frame_size(Some(64 * 1024));
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async_with_config(request, Some(ws_config), false),
    )
    .await
    .map_err(|_| Error::Timeout)?
    .map_err(|e| match e {
        tokio_tungstenite::tungstenite::Error::Http(r)
            if matches!(r.status().as_u16(), 401 | 403) =>
        {
            Error::Unauthorized
        }
        _ => Error::Transport,
    })?;
    send(&mut socket, json!({"type":"hello", "role":"device", "device_id": device_id, "platform": config.platform})).await?;
    let hello = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(hello);
    let mut ready = false;
    let mut ice_updates = ice.clone();
    let mut probe = tokio::time::interval(Duration::from_secs(15));
    probe.tick().await;
    let mut pong_deadline = None;
    let (out_tx, mut outbound) = mpsc::channel::<Value>(128);
    let mut active: HashMap<String, mpsc::Sender<CallInput>> = HashMap::new();
    loop {
        active.retain(|_, tx| !tx.is_closed());
        while calls.try_join_next().is_some() {}
        tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            _ = &mut hello, if !ready => return Err(Error::Timeout),
            changed = ice_updates.changed() => {
                if changed.is_err() { return Err(Error::Unauthorized); }
            },
            _ = probe.tick() => {
                socket.send(Message::Ping(Vec::new().into())).await.map_err(|_| Error::Transport)?;
                pong_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(8));
            }
            _ = async { if let Some(deadline) = pong_deadline { tokio::time::sleep_until(deadline).await } else { std::future::pending::<()>().await } } => return Err(Error::Timeout),
            Some(message) = outbound.recv() => send(&mut socket, message).await?,
            message = socket.next() => {
                let message = message.ok_or(Error::Transport)?.map_err(|_| Error::Transport)?;
                match message {
                    Message::Pong(_) => { pong_deadline = None; }
                    Message::Ping(bytes) => { socket.send(Message::Pong(bytes)).await.map_err(|_| Error::Transport)?; }
                    Message::Close(close) => return Err(match close.map(|c| u16::from(c.code)) { Some(4001) => Error::Signaling("replaced"), Some(4005) => Error::Signaling("removed"), _ => Error::Transport }),
                    Message::Text(text) => {
                        let message: Value = serde_json::from_str(&text).map_err(|_| Error::Response)?;
                        let cid = message.get("cid").and_then(Value::as_str).unwrap_or("");
                        match message.get("type").and_then(Value::as_str) {
                            Some("hello") if !ready && message.get("role").and_then(Value::as_str) == Some("device") => { ready = true; state.send_modify(|s| { s.status = OfficialStatus::Online; s.error = None; }); }
                            Some("incoming") if ready && !cid.is_empty() && cid.len() <= 128 && !active.contains_key(cid) => {
                                if active.len() >= 8 || calls.len() >= 8 { send(&mut socket, json!({"type":"hangup","cid":cid})).await?; continue; }
                                let peer = OfficialPeer { id: cid.into(), name: message.pointer("/peer/name").and_then(Value::as_str).unwrap_or("Phone").chars().take(80).collect(), platform: message.pointer("/peer/platform").and_then(Value::as_str).map(|p| p.chars().take(40).collect()) };
                                let (tx, rx) = mpsc::channel(64);
                                active.insert(cid.into(), tx);
                                let ice = ice.borrow().clone(); let config = config.clone(); let accepted = accepted.clone();
                                let out = out_tx.clone(); let stop = stop.child_token(); let state = state.clone();
                                calls.spawn(async move { let _ = call(peer, ice, config, rx, out, accepted, stop, state).await; });
                            }
                            Some("signal") if ready => {
                                if let Some(tx) = active.get(cid) {
                                    let data = message.get("data").ok_or(Error::Response)?;
                                    if serde_json::to_vec(data).map_err(|_| Error::Response)?.len() > 16 * 1024 { return Err(Error::Protocol("signal too large")); }
                                    match serde_json::from_value::<Signal>(data.clone()) {
                                        Ok(signal) => { if tx.try_send(CallInput::Signal(signal)).is_err() { active.remove(cid); } }
                                        Err(_) => { let _ = tx.try_send(CallInput::Hangup); active.remove(cid); }
                                    }
                                }
                            }
                            Some("hangup") => { if let Some(tx) = active.get(cid) { let _ = tx.try_send(CallInput::Hangup); } }
                            Some("error") if message.get("code").and_then(Value::as_str) == Some("device_not_found") => return Err(Error::Signaling("removed")),
                            Some("error") => { if let Some(tx) = active.remove(cid) { let _ = tx.try_send(CallInput::Hangup); } }
                            _ => {}
                        }
                    }
                    _ => return Err(Error::Protocol("invalid signaling message")),
                }
            }
        }
    }
}
async fn send(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    value: Value,
) -> Result<()> {
    let text = serde_json::to_string(&value).map_err(|_| Error::Response)?;
    if text.len() > 64 * 1024 {
        return Err(Error::Protocol("signal too large"));
    }
    tokio::time::timeout(
        Duration::from_secs(8),
        socket.send(Message::Text(text.into())),
    )
    .await
    .map_err(|_| Error::Timeout)?
    .map_err(|_| Error::Transport)
}
enum CallInput {
    Signal(Signal),
    Hangup,
}
#[allow(clippy::too_many_arguments)]
async fn call(
    peer: OfficialPeer,
    ice: Vec<RTCIceServer>,
    config: OfficialConfig,
    mut incoming: mpsc::Receiver<CallInput>,
    outbound: mpsc::Sender<Value>,
    accepted: mpsc::Sender<AcceptedConnection>,
    stop: CancellationToken,
    state: watch::Sender<OfficialState>,
) -> Result<()> {
    let (signals_tx, mut signals) = mpsc::channel(64);
    let mut answer = AnswerPeer::new(ice, signals_tx, config.transport).await?;
    let mut opened = answer.take_opened();
    let peer_stop = answer.cancellation();
    let deadline = tokio::time::sleep(config.connect_timeout);
    tokio::pin!(deadline);
    let mut connected = false;
    let result = async {
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = peer_stop.cancelled() => break,
                _ = &mut deadline, if !connected => return Err(Error::Timeout),
                channel = &mut opened, if !connected => {
                    let stream = channel.map_err(|_| Error::Protocol("channel closed before opening"))?;
                    accepted.try_send(AcceptedConnection { stream, peer: peer.clone() }).map_err(|_| Error::Protocol("too many accepted connections"))?;
                    connected = true;
                    state.send_modify(|s| s.peers.push(peer.clone()));
                }
                Some(signal) = signals.recv() => {
                    outbound.try_send(json!({"type":"signal", "cid":peer.id, "data": signal})).map_err(|_| Error::Transport)?;
                }
                input = incoming.recv() => match input {
                    Some(CallInput::Signal(signal)) if !connected => {
                        if let Some(response) = answer.apply(signal).await? {
                            outbound.try_send(json!({"type":"signal", "cid":peer.id, "data":response})).map_err(|_| Error::Transport)?;
                        }
                    }
                    Some(CallInput::Hangup) | None if !connected => break,
                    // Once connected, a hangup only frees the service's signaling slot.
                    None => { tokio::select! { _ = stop.cancelled() => {}, _ = peer_stop.cancelled() => {} }; break; }
                    _ => {}
                }
            }
        }
        Ok(())
    }.await;
    answer.close().await;
    state.send_modify(|s| s.peers.retain(|p| p.id != peer.id));
    let _ = outbound.try_send(json!({"type":"hangup", "cid":peer.id}));
    result
}

fn valid_install_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| (0x21..=0x7e).contains(&b))
}
/// Persist a fresh native installation identity; never re-use the Electron identity.
pub fn install_id(file: &Path) -> Result<String> {
    match std::fs::read_to_string(file) {
        Ok(id) if valid_install_id(id.trim()) => return Ok(id.trim().into()),
        Ok(_) => return Err(Error::Storage),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let id = format!("native_{}", uuid::Uuid::new_v4().simple());
    private_write(file, id.as_bytes())?;
    Ok(id)
}
