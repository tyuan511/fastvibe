use crate::{
    ALPN, AppMessage, AppServerMessage, FrameAssembler, IncomingFrame, LegacyAuthMessage,
    MAX_FRAGMENT_BYTES, MAX_FRAME_BYTES, PING, PONG, close_frame, control_frame, hello,
    split_frame_with_options,
};
use iroh::{
    Endpoint, EndpointAddr, RelayConfig, RelayMap, RelayMode, SecretKey, endpoint::presets,
};
use tokio::io::AsyncWriteExt;

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
            LegacyAuthMessage::Auth { ok: false, error, .. } => {
                Err(error.unwrap_or_else(|| "legacy authentication failed".into()).into())
            }
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

impl IrohClient {
    pub async fn connect(
        key: SecretKey,
        remote: iroh::EndpointId,
        relay_url: &str,
        relay_token: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let url = relay_url.parse::<iroh::RelayUrl>()?;
        let relay = RelayConfig::new(url.clone(), None).with_auth_token(relay_token.to_owned());
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Custom(RelayMap::from_iter([relay])))
            .bind()
            .await?;
        let addr = EndpointAddr::new(remote).with_relay_url(url);
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
        assert!(decode_server_frame(br#"{"push":"remote:state","payload":{"enabled":true}}"#).unwrap().is_none());
        assert!(matches!(decode_server_frame(br#"{"type":"auth","ok":true}"#).unwrap(), Some(IrohRead::LegacyAuth)));
        assert!(matches!(decode_server_frame(br#"{"kind":"pong"}"#).unwrap(), Some(IrohRead::Message(AppServerMessage::Pong))));
    }

    #[test]
    fn malformed_messages_and_auth_rejection_are_not_ignored() {
        assert!(decode_server_frame(br#"{"payload":{}}"#).is_err());
        assert!(decode_server_frame(br#"{"kind":"unknown","push":"remote:state","payload":{}}"#).is_err());
        assert!(decode_server_frame(br#"{"type":"auth","ok":false,"error":"denied"}"#).is_err());
    }
}
