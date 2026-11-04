use crate::relay_config::MobileRelayNode;
use crate::{
    ALPN, AppMessage, AppServerMessage, FrameAssembler, IncomingFrame, LegacyAuthMessage,
    MAX_FRAGMENT_BYTES, MAX_FRAME_BYTES, PING, PONG, close_frame, control_frame, hello,
    split_frame_with_options,
};
use iroh::{
    Endpoint, EndpointAddr, RelayConfig, RelayMap, RelayMode, SecretKey, endpoint::presets,
};
use iroh_relay::RelayQuicConfig;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

/// Route hints never grant identity: QUIC still pins the remote EndpointId.
/// A bounded list also prevents a discovery record from growing a dial unboundedly.
pub fn parse_direct_addresses(
    value: Option<&serde_json::Value>,
) -> Result<Vec<SocketAddr>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or("directAddresses must be an array")?;
    if values.len() > 8 {
        return Err("at most 8 direct addresses are allowed".into());
    }
    let mut result = Vec::new();
    for value in values {
        let address = value
            .as_str()
            .ok_or("direct address must be a socket address")?
            .parse::<SocketAddr>()
            .map_err(|_| "invalid direct socket address")?;
        let ip = address.ip();
        if address.port() == 0
            || ip.is_unspecified()
            || ip.is_multicast()
            || matches!(ip, std::net::IpAddr::V4(ip) if ip.is_broadcast())
        {
            return Err("direct address must be unicast with a nonzero port".into());
        }
        if !result.contains(&address) {
            result.push(address);
        }
    }
    Ok(result)
}

/// The phone's long-lived CoreHandle owns this pool, not an individual RPC session.
/// All relays remain candidates when local hints are supplied.
#[derive(Default)]
pub struct IrohEndpointPool {
    current: Option<(Endpoint, Vec<MobileRelayNode>)>,
    updating: bool,
}

impl IrohEndpointPool {
    pub async fn endpoint(
        &mut self,
        key: SecretKey,
        relays: &[MobileRelayNode],
    ) -> Result<Endpoint, Box<dyn std::error::Error + Send + Sync>> {
        if self
            .current
            .as_ref()
            .is_some_and(|(endpoint, _)| endpoint.id() != key.public() || endpoint.is_closed())
        {
            self.clear().await;
        }
        if let Some((endpoint, previous)) = self.current.as_mut() {
            // Map mutation happens before iroh's notification await. Track each
            // prospective key first; a cancelled update must be fully reconciled
            // by the next caller, including removal of partially applied nodes.
            let resync = self.updating;
            self.updating = true;
            for node in relays {
                if resync || !previous.contains(node) {
                    let url = node.url.parse::<iroh::RelayUrl>()?;
                    let config =
                        RelayConfig::new(url.clone(), node.quic_port.map(RelayQuicConfig::new))
                            .with_auth_token(node.token.clone());
                    previous.retain(|old| old.url != node.url);
                    previous.push(node.clone());
                    endpoint.insert_relay(url, Arc::new(config)).await;
                }
            }
            for node in previous.iter() {
                if !relays.iter().any(|current| current.url == node.url) {
                    endpoint
                        .remove_relay(&node.url.parse::<iroh::RelayUrl>()?)
                        .await;
                }
            }
            *previous = relays.to_vec();
            self.updating = false;
            return Ok(endpoint.clone());
        }
        let map = if relays.is_empty() {
            RelayMap::empty()
        } else {
            relay_routes(key.public(), relays)?.0
        };
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Custom(map))
            .bind()
            .await?;
        self.current = Some((endpoint.clone(), relays.to_vec()));
        self.updating = false;
        Ok(endpoint)
    }

    pub fn current(&self) -> Option<Endpoint> {
        self.current.as_ref().map(|(endpoint, _)| endpoint.clone())
    }

    pub async fn clear(&mut self) {
        self.updating = false;
        if let Some((endpoint, _)) = self.current.take() {
            endpoint.close().await;
        }
    }
}

pub const IROH_MAX_FRAGMENT_BYTES: usize = 65_537;

async fn write_fragment(
    send: &mut iroh::endpoint::SendStream,
    fragment: &[u8],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if fragment.is_empty() || fragment.len() > IROH_MAX_FRAGMENT_BYTES {
        return Err("invalid iroh fragment length".into());
    }
    send.write_all(&(fragment.len() as u32).to_be_bytes())
        .await?;
    send.write_all(fragment).await?;
    Ok(())
}

async fn read_fragment(
    recv: &mut iroh::endpoint::RecvStream,
    stream_buffer: &mut Vec<u8>,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    loop {
        if stream_buffer.len() >= 4 {
            let length = u32::from_be_bytes(stream_buffer[..4].try_into().unwrap()) as usize;
            if length == 0 || length > IROH_MAX_FRAGMENT_BYTES {
                return Err(format!(
                    "invalid iroh fragment length: {length} (prefix {:02x}{:02x}{:02x}{:02x})",
                    stream_buffer[0], stream_buffer[1], stream_buffer[2], stream_buffer[3],
                )
                .into());
            }
            if stream_buffer.len() >= 4 + length {
                let fragment = stream_buffer[4..4 + length].to_vec();
                stream_buffer.drain(..4 + length);
                return Ok(fragment);
            }
        }
        let mut chunk = vec![0u8; IROH_MAX_FRAGMENT_BYTES + 4];
        let Some(read) = recv.read(&mut chunk).await? else {
            return Err("iroh stream ended before a complete fragment".into());
        };
        if read == 0 {
            return Err("iroh stream ended before a complete fragment".into());
        }
        stream_buffer.extend_from_slice(&chunk[..read]);
    }
}

pub enum IrohRead {
    Message(AppServerMessage),
    LegacyAuth,
    Ping,
    Pong,
    Close { code: u16, reason: String },
}

fn decode_server_frame(
    data: &[u8],
) -> Result<Option<IrohRead>, Box<dyn std::error::Error + Send + Sync>> {
    let value: serde_json::Value = serde_json::from_slice(data)?;
    if let Ok(auth) = serde_json::from_value::<LegacyAuthMessage>(value.clone()) {
        return match auth {
            LegacyAuthMessage::Auth { ok: true, .. } => Ok(Some(IrohRead::LegacyAuth)),
            LegacyAuthMessage::Auth {
                ok: false, error, ..
            } => Err(error
                .unwrap_or_else(|| "legacy authentication failed".into())
                .into()),
        };
    }
    // Trusted transports can receive legacy broadcasts before their hello is processed.
    // Their state is recovered through the canonical snapshot after welcome.
    if value.get("kind").is_none()
        && value.get("push").is_some_and(serde_json::Value::is_string)
        && value.get("payload").is_some()
    {
        return Ok(None);
    }
    Ok(Some(IrohRead::Message(serde_json::from_value(value)?)))
}

pub struct IrohClient {
    pub endpoint: Endpoint,
    pub connection: iroh::endpoint::Connection,
    pub send: iroh::endpoint::SendStream,
    pub recv: iroh::endpoint::RecvStream,
    assembler: FrameAssembler,
    stream_buffer: Vec<u8>,
}

pub struct IrohWriter {
    send: iroh::endpoint::SendStream,
}

pub struct IrohReader {
    pub endpoint: Endpoint,
    pub connection: iroh::endpoint::Connection,
    recv: iroh::endpoint::RecvStream,
    assembler: FrameAssembler,
    stream_buffer: Vec<u8>,
}

/// Populate both local relay discovery and the peer's candidate paths. Iroh 1.4
/// retains every Relay transport address and races its initial datagrams, so a
/// dead first candidate does not consume the whole dial deadline.
fn relay_routes(
    remote: iroh::EndpointId,
    relays: &[MobileRelayNode],
) -> Result<(RelayMap, EndpointAddr), Box<dyn std::error::Error + Send + Sync>> {
    if relays.is_empty() {
        return Err("relay node list must not be empty".into());
    }
    let mut configs = Vec::with_capacity(relays.len());
    let mut addr = EndpointAddr::new(remote);
    for node in relays {
        let url = node.url.parse::<iroh::RelayUrl>()?;
        configs.push(
            RelayConfig::new(url.clone(), node.quic_port.map(RelayQuicConfig::new))
                .with_auth_token(node.token.clone()),
        );
        addr = addr.with_relay_url(url);
    }
    Ok((RelayMap::from_iter(configs), addr))
}

impl IrohClient {
    pub async fn connect(
        key: SecretKey,
        remote: iroh::EndpointId,
        relay_url: &str,
        relay_token: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::connect_relays(
            key,
            remote,
            &[MobileRelayNode {
                relay_id: String::new(),
                url: relay_url.to_owned(),
                quic_port: None,
                token: relay_token.to_owned(),
            }],
        )
        .await
    }

    pub async fn connect_relays(
        key: SecretKey,
        remote: iroh::EndpointId,
        relays: &[MobileRelayNode],
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let (map, _) = relay_routes(remote, relays)?;
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Custom(map))
            .bind()
            .await?;
        Self::connect_on(endpoint, remote, relays, &[]).await
    }

    pub async fn connect_on(
        endpoint: Endpoint,
        remote: iroh::EndpointId,
        relays: &[MobileRelayNode],
        direct_addresses: &[SocketAddr],
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let mut addr = if relays.is_empty() {
            if direct_addresses.is_empty() {
                return Err("a direct-only dial requires an address".into());
            }
            EndpointAddr::new(remote)
        } else {
            relay_routes(remote, relays)?.1
        };
        for address in direct_addresses {
            addr = addr.with_ip_addr(*address);
        }
        let connection = endpoint.connect(addr, ALPN).await?;
        let (mut send, recv) = connection.open_bi().await?;
        let hello = serde_json::to_vec(&hello("0.1.0"))?;
        for frame in split_frame_with_options(&hello, false, false, MAX_FRAGMENT_BYTES) {
            write_fragment(&mut send, &frame).await?;
        }
        send.flush().await?;
        Ok(Self {
            endpoint,
            connection,
            send,
            recv,
            assembler: FrameAssembler::new(MAX_FRAME_BYTES),
            stream_buffer: Vec::new(),
        })
    }

    pub async fn send_json(
        &mut self,
        message: &AppMessage,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let bytes = serde_json::to_vec(message)?;
        for frame in split_frame_with_options(&bytes, false, false, MAX_FRAGMENT_BYTES) {
            write_fragment(&mut self.send, &frame).await?;
        }
        self.send.flush().await?;
        Ok(())
    }

    pub async fn send_control(
        &mut self,
        kind: u8,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        write_fragment(&mut self.send, &control_frame(kind)).await?;
        self.send.flush().await?;
        Ok(())
    }

    pub async fn read_next(
        &mut self,
    ) -> Result<IrohRead, Box<dyn std::error::Error + Send + Sync>> {
        loop {
            let chunk = read_fragment(&mut self.recv, &mut self.stream_buffer).await?;
            match self.assembler.push(&chunk)? {
                IncomingFrame::Partial => continue,
                IncomingFrame::Frame { data, binary } => {
                    if binary {
                        return Err("unexpected binary App Protocol frame".into());
                    }
                    if let Some(message) = decode_server_frame(&data)? {
                        return Ok(message);
                    }
                }
                IncomingFrame::Ping => return Ok(IrohRead::Ping),
                IncomingFrame::Pong => return Ok(IrohRead::Pong),
                IncomingFrame::Close { code, reason } => {
                    return Ok(IrohRead::Close { code, reason });
                }
            }
        }
    }

    pub async fn read_chunk(
        &mut self,
        buffer: &mut [u8],
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.recv.read(buffer).await?.unwrap_or(0))
    }

    pub async fn close(&self) {
        self.connection.close(0u32.into(), b"mobile closed");
        self.endpoint.close().await;
    }

    pub fn split(self) -> (IrohWriter, IrohReader) {
        (
            IrohWriter { send: self.send },
            IrohReader {
                endpoint: self.endpoint,
                connection: self.connection,
                recv: self.recv,
                assembler: self.assembler,
                stream_buffer: self.stream_buffer,
            },
        )
    }

    pub fn _server_message_type(_: &AppServerMessage) {}
}

impl IrohWriter {
    pub async fn send_json(
        &mut self,
        message: &AppMessage,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let bytes = serde_json::to_vec(message)?;
        for frame in split_frame_with_options(&bytes, false, false, MAX_FRAGMENT_BYTES) {
            write_fragment(&mut self.send, &frame).await?;
        }
        self.send.flush().await?;
        Ok(())
    }

    pub async fn send_control(
        &mut self,
        kind: u8,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        write_fragment(&mut self.send, &control_frame(kind)).await?;
        self.send.flush().await?;
        Ok(())
    }

    pub async fn close_frame(
        &mut self,
        code: u16,
        reason: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        write_fragment(&mut self.send, &close_frame(code, reason)).await?;
        self.send.flush().await?;
        Ok(())
    }
}

impl IrohReader {
    pub async fn read_next(
        &mut self,
    ) -> Result<IrohRead, Box<dyn std::error::Error + Send + Sync>> {
        loop {
            let chunk = read_fragment(&mut self.recv, &mut self.stream_buffer).await?;
            match self.assembler.push(&chunk)? {
                IncomingFrame::Partial => continue,
                IncomingFrame::Frame { data, binary } => {
                    if binary {
                        return Err("unexpected binary App Protocol frame".into());
                    }
                    if let Some(message) = decode_server_frame(&data)? {
                        return Ok(message);
                    }
                }
                IncomingFrame::Ping => return Ok(IrohRead::Ping),
                IncomingFrame::Pong => return Ok(IrohRead::Pong),
                IncomingFrame::Close { code, reason } => {
                    return Ok(IrohRead::Close { code, reason });
                }
            }
        }
    }
}

impl IrohClient {
    pub async fn send_control_pong(
        &mut self,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.send_control(PONG).await
    }
}

#[allow(dead_code)]
fn _ping_constant() -> u8 {
    PING
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_broadcast_before_welcome_does_not_abort_handshake() {
        assert!(
            decode_server_frame(br#"{"push":"remote:state","payload":{"enabled":true}}"#)
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            decode_server_frame(br#"{"type":"auth","ok":true}"#).unwrap(),
            Some(IrohRead::LegacyAuth)
        ));
        assert!(matches!(
            decode_server_frame(br#"{"kind":"pong"}"#).unwrap(),
            Some(IrohRead::Message(AppServerMessage::Pong))
        ));
    }

    #[test]
    fn every_relay_is_a_dial_candidate_with_its_own_credential_and_quic_port() {
        let remote = SecretKey::generate().public();
        let nodes = vec![
            MobileRelayNode {
                relay_id: "dead-first".into(),
                url: "http://127.0.0.1:1/".into(),
                quic_port: Some(7842),
                token: "first-token".into(),
            },
            MobileRelayNode {
                relay_id: "healthy".into(),
                url: "https://healthy.example/".into(),
                quic_port: Some(8842),
                token: "second-token".into(),
            },
        ];
        let (map, addr) = relay_routes(remote, &nodes).unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(addr.relay_urls().count(), 2);
        for node in &nodes {
            let url = node.url.parse::<iroh::RelayUrl>().unwrap();
            assert!(addr.relay_urls().any(|candidate| candidate == &url));
            let configured = map.get(&url).unwrap();
            assert_eq!(configured.auth_token.as_deref(), Some(node.token.as_str()));
            assert_eq!(
                configured.quic.as_ref().unwrap().port,
                node.quic_port.unwrap()
            );
        }
        assert!(relay_routes(remote, &[]).is_err());
    }

    #[tokio::test]
    #[ignore = "requires FASTVIBE_TEST_RELAY_BIN pointing to the local relay fixture"]
    async fn dead_first_relay_still_connects_through_healthy_second_relay() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        use std::time::Duration;
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let binary = std::env::var("FASTVIBE_TEST_RELAY_BIN").expect("local relay fixture binary");
        let mut child = Child(
            Command::new(binary)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = std::io::BufReader::new(stdout)
                .read_line(&mut line)
                .map(|_| line);
            let _ = sender.send(result);
        });
        let ready = receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        let healthy_url = ready
            .trim()
            .strip_prefix("READY ")
            .unwrap()
            .parse::<iroh::RelayUrl>()
            .unwrap();
        let server = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![ALPN.to_vec()])
            .clear_ip_transports()
            .relay_mode(RelayMode::Custom(RelayMap::from_iter([RelayConfig::new(
                healthy_url.clone(),
                None,
            )])))
            .bind()
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), server.online())
            .await
            .unwrap();
        let server_endpoint = server.clone();
        let receive = tokio::spawn(async move {
            let connection = server_endpoint.accept().await.unwrap().await.unwrap();
            let (_send, mut recv) = connection.accept_bi().await.unwrap();
            let fragment = read_fragment(&mut recv, &mut Vec::new()).await.unwrap();
            let mut assembler = FrameAssembler::new(MAX_FRAME_BYTES);
            let IncomingFrame::Frame { data, .. } = assembler.push(&fragment).unwrap() else {
                panic!("complete hello frame")
            };
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&data).unwrap()["kind"],
                "hello"
            );
            connection
        });
        let nodes = vec![
            MobileRelayNode {
                relay_id: "dead-first".into(),
                url: "http://127.0.0.1:1/".into(),
                quic_port: Some(7842),
                token: "unusable-token".into(),
            },
            MobileRelayNode {
                relay_id: "healthy".into(),
                url: healthy_url.to_string(),
                quic_port: Some(7842),
                token: "healthy-token".into(),
            },
        ];
        let client = tokio::time::timeout(
            Duration::from_secs(10),
            IrohClient::connect_relays(SecretKey::generate(), server.id(), &nodes),
        )
        .await
        .expect("healthy second relay must not wait for the first")
        .unwrap();
        let connection = tokio::time::timeout(Duration::from_secs(3), receive)
            .await
            .unwrap()
            .unwrap();
        client.close().await;
        connection.close(0u32.into(), b"test complete");
        server.close().await;
    }

    #[test]
    fn malformed_messages_and_auth_rejection_are_not_ignored() {
        assert!(decode_server_frame(br#"{"payload":{}}"#).is_err());
        assert!(
            decode_server_frame(br#"{"kind":"unknown","push":"remote:state","payload":{}}"#)
                .is_err()
        );
        assert!(decode_server_frame(br#"{"type":"auth","ok":false,"error":"denied"}"#).is_err());
    }
}
