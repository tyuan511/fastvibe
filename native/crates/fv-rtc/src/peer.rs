//! Established webrtc-rs ICE/DTLS/SCTP implementation with a bounded native stream.
use crate::{
    Error, Result,
    frames::{self, Incoming, LineLimit},
};
use bytes::Bytes;
use fv_protocol::official::{RTC_CHANNEL, RTC_PROTOCOL};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;
use webrtc::{
    api::{APIBuilder, setting_engine::SettingEngine},
    data_channel::{RTCDataChannel, data_channel_state::RTCDataChannelState},
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    peer_connection::{
        RTCPeerConnection, configuration::RTCConfiguration,
        sdp::session_description::RTCSessionDescription,
    },
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Signal {
    Offer { sdp: String, protocol: String },
    Answer { sdp: String, protocol: String },
    Candidate { candidate: String, mid: String },
}
impl Signal {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Offer { sdp, protocol } | Self::Answer { sdp, protocol }
                if protocol == RTC_PROTOCOL && sdp.len() <= 15 * 1024 && !sdp.is_empty() =>
            {
                Ok(())
            }
            Self::Candidate { candidate, mid } if candidate.len() <= 2048 && mid.len() <= 128 => {
                Ok(())
            }
            _ => Err(Error::Protocol("invalid or unsupported signaling protocol")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct TransportConfig {
    pub heartbeat_interval: Duration,
    pub heartbeat_timeout: Duration,
    pub write_timeout: Duration,
    /// Only local interop tests should gather loopback candidates.
    pub include_loopback: bool,
}
impl Default for TransportConfig {
    fn default() -> Self {
        Self {
            heartbeat_interval: Duration::from_secs(15),
            heartbeat_timeout: Duration::from_secs(8),
            write_timeout: Duration::from_secs(15),
            include_loopback: false,
        }
    }
}

/// One answerer created only for a cloud-authenticated incoming call. It cannot
/// authenticate a signaling source itself: OfficialConnection owns that boundary.
pub struct AnswerPeer {
    pc: Arc<RTCPeerConnection>,
    opened: Option<oneshot::Receiver<DuplexStream>>,
    have_offer: bool,
    early: Vec<RTCIceCandidateInit>,
    stop: CancellationToken,
}
impl AnswerPeer {
    pub async fn new(
        ice_servers: Vec<RTCIceServer>,
        signals: mpsc::Sender<Signal>,
        config: TransportConfig,
    ) -> Result<Self> {
        // webrtc-rs enables ring while reqwest enables aws-lc; select explicitly
        // before DTLS/TURN TLS constructs a rustls config. Respect a host's prior choice.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut settings = SettingEngine::default();
        settings.set_include_loopback_candidate(config.include_loopback);
        // Never disable DTLS fingerprint verification. The fingerprint is carried by the
        // account-authenticated signaling channel, which binds this transport to its peer.
        let pc = Arc::new(
            APIBuilder::new()
                .with_setting_engine(settings)
                .build()
                .new_peer_connection(RTCConfiguration {
                    ice_servers,
                    ..Default::default()
                })
                .await?,
        );
        let stop = CancellationToken::new();
        let callback_stop = stop.clone();
        pc.on_ice_candidate(Box::new(move |candidate| {
            let signals = signals.clone();
            let stop = callback_stop.clone();
            Box::pin(async move {
                if let Some(candidate) = candidate {
                    match candidate.to_json() {
                        Ok(candidate) => {
                            let signal = Signal::Candidate {
                                candidate: candidate.candidate,
                                mid: candidate.sdp_mid.unwrap_or_else(|| "0".into()),
                            };
                            if signals.try_send(signal).is_err() {
                                stop.cancel();
                            }
                        }
                        Err(_) => stop.cancel(),
                    }
                }
            })
        }));
        let (opened_tx, opened) = oneshot::channel();
        let opened_tx = Arc::new(std::sync::Mutex::new(Some(opened_tx)));
        let weak_pc = Arc::downgrade(&pc);
        let channel_config = config.clone();
        let channel_stop = stop.clone();
        pc.on_data_channel(Box::new(move |channel| {
            let tx = opened_tx.clone();
            let pc = weak_pc.clone();
            let config = channel_config.clone();
            let stop = channel_stop.clone();
            Box::pin(async move {
                if channel.label() != RTC_CHANNEL
                    || channel.protocol() != RTC_PROTOCOL
                    || !channel.ordered()
                    || channel.max_retransmits().is_some()
                    || channel.max_packet_lifetime().is_some()
                {
                    let _ = channel.close().await;
                    return;
                }
                let sender = tx.lock().expect("channel gate").take();
                let Some(sender) = sender else {
                    let _ = channel.close().await;
                    return;
                };
                let Some(pc) = pc.upgrade() else {
                    return;
                };
                // Install receive callbacks before returning from on_data_channel. Otherwise
                // the first initialize frame can outrun the task awaiting on_open.
                let stream = channel_stream(pc, channel.clone(), config, stop);
                channel.on_open(Box::new(move || {
                    Box::pin(async move {
                        let _ = sender.send(stream);
                    })
                }));
            })
        }));
        Ok(Self {
            pc,
            opened: Some(opened),
            have_offer: false,
            early: Vec::new(),
            stop,
        })
    }
    pub async fn apply(&mut self, signal: Signal) -> Result<Option<Signal>> {
        signal.validate()?;
        match signal {
            Signal::Offer { sdp, .. } => {
                if self.have_offer {
                    return Err(Error::Protocol("duplicate offer"));
                }
                self.pc
                    .set_remote_description(RTCSessionDescription::offer(sdp)?)
                    .await?;
                self.have_offer = true;
                let answer = self.pc.create_answer(None).await?;
                let signal = Signal::Answer {
                    sdp: answer.sdp.clone(),
                    protocol: RTC_PROTOCOL.into(),
                };
                signal.validate()?;
                self.pc.set_local_description(answer).await?;
                for candidate in self.early.drain(..) {
                    self.pc.add_ice_candidate(candidate).await?;
                }
                Ok(Some(signal))
            }
            Signal::Candidate { candidate, mid } => {
                let candidate = RTCIceCandidateInit {
                    candidate,
                    sdp_mid: Some(mid),
                    ..Default::default()
                };
                if self.have_offer {
                    self.pc.add_ice_candidate(candidate).await?;
                } else if self.early.len() < 64 {
                    self.early.push(candidate);
                } else {
                    return Err(Error::Protocol("too many early candidates"));
                }
                Ok(None)
            }
            _ => Err(Error::Protocol("answer sent to answerer")),
        }
    }
    pub fn take_opened(&mut self) -> oneshot::Receiver<DuplexStream> {
        self.opened.take().expect("opened receiver taken once")
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.stop.clone()
    }
    pub async fn close(&self) {
        self.stop.cancel();
        let _ = self.pc.close().await;
    }
}
impl Drop for AnswerPeer {
    fn drop(&mut self) {
        self.stop.cancel();
        let pc = self.pc.clone();
        // Drop runs inside the transport runtime; peer cleanup releases UDP sockets and tasks.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = pc.close().await;
            });
        }
    }
}

/// An abort/drop of the caller's stream closes the transport. Bounded duplex and ingress
/// queues prevent a same-account peer or a stalled server from growing memory indefinitely.
pub fn channel_stream(
    pc: Arc<RTCPeerConnection>,
    channel: Arc<RTCDataChannel>,
    config: TransportConfig,
    stop: CancellationToken,
) -> DuplexStream {
    let (client, transport) = tokio::io::duplex(64 * 1024);
    let (mut from_server, mut to_server) = tokio::io::split(transport);
    let (incoming_tx, mut incoming) = mpsc::channel::<Bytes>(64);
    let (control_tx, mut controls) = mpsc::channel::<u8>(8);
    let pong = Arc::new(AtomicBool::new(true));
    let callback_stop = stop.clone();
    let callback_pong = pong.clone();
    channel.on_message(Box::new(move |message| {
        let tx = incoming_tx.clone();
        let controls = control_tx.clone();
        let stop = callback_stop.clone();
        let pong = callback_pong.clone();
        Box::pin(async move {
            if message.is_string {
                stop.cancel();
                return;
            }
            match frames::parse(&message.data) {
                Ok(Incoming::Data(_)) => {
                    if tx.try_send(message.data.slice(1..)).is_err() {
                        stop.cancel();
                    }
                }
                Ok(Incoming::Ping) => {
                    if controls.try_send(frames::PONG).is_err() {
                        stop.cancel();
                    }
                }
                Ok(Incoming::Pong) => {
                    pong.store(true, Ordering::Release);
                }
                Ok(Incoming::Close) | Err(_) => stop.cancel(),
            }
        })
    }));
    let closed = stop.clone();
    channel.on_close(Box::new(move || {
        let stop = closed.clone();
        Box::pin(async move {
            stop.cancel();
        })
    }));
    tokio::spawn(async move {
        let reader = async {
            let mut limit = LineLimit::default();
            while let Some(data) = incoming.recv().await {
                limit.check(&data)?;
                tokio::time::timeout(config.write_timeout, to_server.write_all(&data))
                    .await
                    .map_err(|_| Error::Timeout)??;
            }
            Ok::<_, Error>(())
        };
        let writer = async {
            // Handlers precede on_open, but heartbeat/server writes wait for SCTP.
            while channel.ready_state() != RTCDataChannelState::Open {
                if channel.ready_state() == RTCDataChannelState::Closed {
                    return Err(Error::Protocol("closed channel"));
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let mut buffer = vec![0; 16 * 1024 - 1];
            let mut limit = LineLimit::default();
            let mut beat = tokio::time::interval(config.heartbeat_interval);
            beat.tick().await;
            let mut deadline = None;
            loop {
                tokio::select! {
                    n = from_server.read(&mut buffer) => {
                        let n = n?;
                        if n == 0 { break; }
                        limit.check(&buffer[..n])?;
                        for part in frames::fragment(&buffer[..n]) { send_bounded(&channel, Bytes::from(part), config.write_timeout).await?; }
                    }
                    control = controls.recv() => {
                        if let Some(control) = control { send_bounded(&channel, Bytes::from(vec![control]), config.write_timeout).await?; }
                    }
                    _ = beat.tick() => {
                        pong.store(false, Ordering::Release);
                        send_bounded(&channel, Bytes::from_static(&[frames::PING]), config.write_timeout).await?;
                        deadline = Some(tokio::time::Instant::now() + config.heartbeat_timeout);
                    }
                    _ = async { if let Some(at) = deadline { tokio::time::sleep_until(at).await } else { std::future::pending::<()>().await } } => {
                        if !pong.load(Ordering::Acquire) { return Err(Error::Timeout); }
                        deadline = None;
                    }
                }
            }
            Ok::<_, Error>(())
        };
        tokio::select! { _ = stop.cancelled() => {}, _ = reader => {}, _ = writer => {} }
        stop.cancel();
        let _ = tokio::time::timeout(
            Duration::from_millis(200),
            channel.send(&Bytes::from_static(&[frames::CLOSE])),
        )
        .await;
        let _ = pc.close().await;
    });
    client
}
async fn send_bounded(channel: &RTCDataChannel, data: Bytes, timeout: Duration) -> Result<()> {
    tokio::time::timeout(timeout, async {
        while channel.buffered_amount().await > 256 * 1024 {
            if channel.ready_state() != RTCDataChannelState::Open {
                return Err(Error::Protocol("closed channel"));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        channel.send(&data).await?;
        Ok(())
    })
    .await
    .map_err(|_| Error::Timeout)?
}
