use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use iroh::endpoint::presets;
use iroh::{Endpoint, RelayConfig, RelayMap, RelayMode, SecretKey};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::{Mutex, mpsc};

const ALPN: &[u8] = b"fastvibe/app/1";
const MAX_CHUNK: usize = 64 * 1024;
const FRAME_LENGTH_BYTES: usize = std::mem::size_of::<u32>();
const MAX_FRAGMENT_BYTES: usize = MAX_CHUNK + 1;

#[derive(Debug)]
enum FragmentReadError {
    Io(std::io::Error),
    TruncatedLengthPrefix,
    InvalidLength(usize),
}

impl std::fmt::Display for FragmentReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "failed to read iroh fragment: {error}"),
            Self::TruncatedLengthPrefix => {
                formatter.write_str("truncated iroh fragment length prefix")
            }
            Self::InvalidLength(length) => write!(
                formatter,
                "invalid iroh fragment length {length}; expected 1..={MAX_FRAGMENT_BYTES} bytes"
            ),
        }
    }
}

impl std::error::Error for FragmentReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::TruncatedLengthPrefix | Self::InvalidLength(_) => None,
        }
    }
}

impl From<std::io::Error> for FragmentReadError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

async fn read_fragment<R>(reader: &mut R) -> Result<Option<Vec<u8>>, FragmentReadError>
where
    R: AsyncRead + Unpin,
{
    let mut length_bytes = [0u8; FRAME_LENGTH_BYTES];
    if reader.read(&mut length_bytes[..1]).await? == 0 {
        return Ok(None);
    }
    match reader.read_exact(&mut length_bytes[1..]).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(FragmentReadError::TruncatedLengthPrefix);
        }
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_be_bytes(length_bytes) as usize;
    if length == 0 || length > MAX_FRAGMENT_BYTES {
        return Err(FragmentReadError::InvalidLength(length));
    }
    let mut fragment = vec![0u8; length];
    reader.read_exact(&mut fragment).await?;
    Ok(Some(fragment))
}

fn frame_fragment(fragment: &[u8]) -> Result<Vec<u8>, FragmentReadError> {
    if fragment.is_empty() || fragment.len() > MAX_FRAGMENT_BYTES {
        return Err(FragmentReadError::InvalidLength(fragment.len()));
    }
    let length = u32::try_from(fragment.len()).expect("MAX_FRAGMENT_BYTES fits in u32");
    let mut framed = Vec::with_capacity(FRAME_LENGTH_BYTES + fragment.len());
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(fragment);
    Ok(framed)
}

type SendHandle = Arc<Mutex<iroh::endpoint::SendStream>>;
type ConnectionHandle = iroh::endpoint::Connection;

type Connections = Arc<Mutex<HashMap<String, SendHandle>>>;
type Handles = Arc<Mutex<HashMap<String, ConnectionHandle>>>;

#[derive(Clone)]
struct Runtime {
    endpoint: Arc<Mutex<Option<Endpoint>>>,
    connections: Connections,
    handles: Handles,
    next_connection: Arc<AtomicU64>,
    events: mpsc::UnboundedSender<Value>,
    secret_key: Arc<Mutex<Option<SecretKey>>>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    let stdout = tokio::io::stdout();
    let mut output = BufWriter::new(stdout);
    let writer = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            if output
                .write_all(event.to_string().as_bytes())
                .await
                .is_err()
                || output.write_all(b"\n").await.is_err()
                || output.flush().await.is_err()
            {
                break;
            }
        }
    });

    let runtime = Runtime {
        endpoint: Arc::new(Mutex::new(None)),
        connections: Arc::new(Mutex::new(HashMap::new())),
        handles: Arc::new(Mutex::new(HashMap::new())),
        next_connection: Arc::new(AtomicU64::new(1)),
        events: event_tx,
        secret_key: Arc::new(Mutex::new(None)),
    };
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    while let Some(line) = lines.next_line().await? {
        let command: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let _ = runtime
                    .events
                    .send(json!({"type":"error","message":format!("invalid command: {error}")}));
                continue;
            }
        };
        match handle_command(&runtime, command).await {
            Ok(true) => break,
            Ok(false) => {}
            Err(error) => {
                // A malformed command must not take down the long-lived transport. Valid
                // writes report their connection and sequence below so only that waiter
                // fails; command-shape errors remain unscoped diagnostics.
                let _ = runtime
                    .events
                    .send(json!({"type":"error","message":error.to_string()}));
            }
        }
    }
    shutdown(&runtime).await;
    drop(runtime.events);
    let _ = writer.await;
    Ok(())
}

async fn handle_command(
    runtime: &Runtime,
    command: Value,
) -> Result<bool, Box<dyn std::error::Error>> {
    match command.get("type").and_then(Value::as_str) {
        Some("identity") => {
            let path = required_string(&command, "statePath")?;
            let key = load_or_create_key(Path::new(path))?;
            let endpoint_id = key.public().to_string();
            *runtime.secret_key.lock().await = Some(key);
            let _ = runtime
                .events
                .send(json!({"type":"identity","endpointId":endpoint_id}));
        }
        Some("connect") => {
            let key = runtime
                .secret_key
                .lock()
                .await
                .clone()
                .ok_or("identity must be loaded first")?;
            let remote_id = required_string(&command, "remoteId")?.parse::<iroh::EndpointId>()?;
            let relay_url = required_string(&command, "relayUrl")?;
            let relay_token = required_string(&command, "relayToken")?;
            let relay_id = required_string(&command, "relayId")?;
            let endpoint = bind(key, relay_url, &relay_token).await?;
            let url = relay_url.parse::<iroh::RelayUrl>()?;
            let connection = endpoint
                .connect(iroh::EndpointAddr::new(remote_id).with_relay_url(url), ALPN)
                .await?;
            let id = format!(
                "iroh-{}",
                runtime.next_connection.fetch_add(1, Ordering::Relaxed)
            );
            let (send, mut recv) = connection.open_bi().await?;
            runtime
                .connections
                .lock()
                .await
                .insert(id.clone(), Arc::new(Mutex::new(send)));
            runtime
                .handles
                .lock()
                .await
                .insert(id.clone(), connection.clone());
            emit_path(&runtime, &id, &connection);
            let _ = runtime.events.send(json!({"type":"connected","connectionId":id,"remoteId":remote_id.to_string(),"outbound":true,"relayId":relay_id}));
            let read_runtime = runtime.clone();
            let read_id = id.clone();
            tokio::spawn(async move {
                loop {
                    match read_fragment(&mut recv).await {
                        Ok(Some(fragment)) => {
                            emit_path(&read_runtime, &read_id, &connection);
                            let size = fragment.len();
                            let _ = read_runtime.events.send(json!({"type":"data","connectionId":read_id,"data":BASE64.encode(&fragment),"bytes":size}));
                        }
                        Ok(None) => break,
                        Err(error) => {
                            let _ = read_runtime.events.send(json!({"type":"error","connectionId":read_id,"message":error.to_string()}));
                            connection.close(0u32.into(), error.to_string().as_bytes());
                            break;
                        }
                    }
                }
                read_runtime.connections.lock().await.remove(&read_id);
                read_runtime.handles.lock().await.remove(&read_id);
                let _ = read_runtime
                    .events
                    .send(json!({"type":"closed","connectionId":read_id}));
            });
        }
        Some("start") => {
            let key = runtime
                .secret_key
                .lock()
                .await
                .clone()
                .ok_or("identity must be loaded first")?;
            if runtime.endpoint.lock().await.is_some() {
                let _ = runtime.events.send(json!({"type":"started","endpointId":key.public().to_string(),"alreadyRunning":true}));
                return Ok(false);
            }
            let relay_url = required_string(&command, "relayUrl")?;
            let relay_token = required_string(&command, "relayToken")?;
            let relay_id = required_string(&command, "relayId")?;
            let expires_at = required_string(&command, "expiresAt")?;
            let endpoint = bind(key, relay_url, &relay_token).await?;
            let endpoint_id = endpoint.id().to_string();
            *runtime.endpoint.lock().await = Some(endpoint.clone());
            let accept_runtime = runtime.clone();
            tokio::spawn(async move {
                accept_loop(accept_runtime, endpoint).await;
            });
            let _ = runtime.events.send(json!({
                "type":"started",
                "endpointId":endpoint_id,
                "relayId":relay_id,
                "expiresAt":expires_at
            }));
        }
        Some("refresh") => {
            let relay_url = required_string(&command, "relayUrl")?;
            let relay_token = required_string(&command, "relayToken")?;
            let endpoint = runtime
                .endpoint
                .lock()
                .await
                .clone()
                .ok_or("sidecar is not started")?;
            let url = relay_url.parse::<iroh::RelayUrl>()?;
            let config =
                RelayConfig::new(url.clone(), None).with_auth_token(relay_token.to_owned());
            endpoint.insert_relay(url, Arc::new(config)).await;
            let _ = runtime.events.send(json!({"type":"refreshed"}));
        }
        Some("send") => {
            let connection_id = required_string(&command, "connectionId")?;
            let sequence = command
                .get("seq")
                .and_then(Value::as_u64)
                .ok_or("seq is required")?;
            let encoded = required_string(&command, "data")?;
            let bytes = match BASE64.decode(encoded) {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = runtime.events.send(json!({
                        "type":"error",
                        "connectionId":connection_id,
                        "seq":sequence,
                        "message":error.to_string()
                    }));
                    return Ok(false);
                }
            };
            let handle = match runtime.connections.lock().await.get(connection_id).cloned() {
                Some(handle) => handle,
                None => {
                    let _ = runtime.events.send(json!({
                        "type":"error",
                        "connectionId":connection_id,
                        "seq":sequence,
                        "message":"unknown connection"
                    }));
                    return Ok(false);
                }
            };
            let framed = match frame_fragment(&bytes) {
                Ok(framed) => framed,
                Err(error) => {
                    let _ = runtime.events.send(json!({
                        "type":"error",
                        "connectionId":connection_id,
                        "seq":sequence,
                        "message":error.to_string()
                    }));
                    return Ok(false);
                }
            };
            let write_result = {
                let mut stream = handle.lock().await;
                stream.write_all(&framed).await
            };
            if let Err(error) = write_result {
                let _ = runtime.events.send(json!({
                    "type":"error",
                    "connectionId":connection_id,
                    "seq":sequence,
                    "message":error.to_string()
                }));
                return Ok(false);
            }
            let _ = runtime.events.send(json!({"type":"sent","seq":sequence,"connectionId":connection_id,"bytes":bytes.len()}));
            let _ = runtime.events.send(json!({"type":"traffic","connectionId":connection_id,"direction":"out","bytes":bytes.len()}));
        }
        Some("close") => {
            let id = required_string(&command, "connectionId")?;
            if let Some(connection) = runtime.handles.lock().await.remove(id) {
                connection.close(0u32.into(), b"client closed");
            }
            runtime.connections.lock().await.remove(id);
        }
        Some("stop") => return Ok(true),
        Some(other) => {
            let _ = runtime
                .events
                .send(json!({"type":"error","message":format!("unknown command: {other}")}));
        }
        None => {
            let _ = runtime
                .events
                .send(json!({"type":"error","message":"command type is required"}));
        }
    }
    Ok(false)
}

async fn bind(
    key: SecretKey,
    relay_url: &str,
    relay_token: &str,
) -> Result<Endpoint, Box<dyn std::error::Error>> {
    let relay_url = relay_url.parse::<iroh::RelayUrl>()?;
    let relay = RelayConfig::new(relay_url, None).with_auth_token(relay_token.to_owned());
    let map = RelayMap::from_iter([relay]);
    Ok(Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Custom(map))
        .bind()
        .await?)
}

async fn accept_loop(runtime: Runtime, endpoint: Endpoint) {
    loop {
        let incoming = match endpoint.accept().await {
            Some(incoming) => incoming,
            None => break,
        };
        let runtime = runtime.clone();
        tokio::spawn(async move {
            let connection = match incoming.await {
                Ok(connection) => connection,
                Err(error) => {
                    let _ = runtime.events.send(json!({"type":"error","message":format!("incoming connection failed: {error}")}));
                    return;
                }
            };
            let id = format!(
                "iroh-{}",
                runtime.next_connection.fetch_add(1, Ordering::Relaxed)
            );
            let remote_id = connection.remote_id().to_string();
            let (send, mut recv) = match connection.accept_bi().await {
                Ok(streams) => streams,
                Err(error) => {
                    let _ = runtime.events.send(json!({"type":"error","message":format!("incoming stream failed: {error}")}));
                    return;
                }
            };
            runtime
                .connections
                .lock()
                .await
                .insert(id.clone(), Arc::new(Mutex::new(send)));
            runtime
                .handles
                .lock()
                .await
                .insert(id.clone(), connection.clone());
            emit_path(&runtime, &id, &connection);
            let _ = runtime
                .events
                .send(json!({"type":"connected","connectionId":id,"remoteId":remote_id}));
            loop {
                match read_fragment(&mut recv).await {
                    Ok(Some(fragment)) => {
                        emit_path(&runtime, &id, &connection);
                        let size = fragment.len();
                        let _ = runtime.events.send(json!({
                            "type":"data",
                            "connectionId":id,
                            "data":BASE64.encode(&fragment),
                            "bytes":size
                        }));
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = runtime.events.send(
                            json!({"type":"error","connectionId":id,"message":error.to_string()}),
                        );
                        connection.close(0u32.into(), error.to_string().as_bytes());
                        break;
                    }
                }
            }
            runtime.connections.lock().await.remove(&id);
            runtime.handles.lock().await.remove(&id);
            let _ = runtime
                .events
                .send(json!({"type":"closed","connectionId":id}));
        });
    }
}

fn emit_path(runtime: &Runtime, id: &str, connection: &ConnectionHandle) {
    let path = connection
        .paths()
        .iter()
        .find(|path| path.is_selected())
        .map(|path| if path.is_relay() { "relay" } else { "direct" })
        .unwrap_or("connecting");
    let _ = runtime
        .events
        .send(json!({"type":"path","connectionId":id,"path":path}));
}

async fn shutdown(runtime: &Runtime) {
    let handles = std::mem::take(&mut *runtime.handles.lock().await);
    for (_, connection) in handles {
        connection.close(0u32.into(), b"sidecar stopped");
    }
    runtime.connections.lock().await.clear();
    if let Some(endpoint) = runtime.endpoint.lock().await.take() {
        endpoint.close().await;
    }
}

fn required_string<'a>(
    value: &'a Value,
    name: &str,
) -> Result<&'a str, Box<dyn std::error::Error>> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required").into())
}

fn load_or_create_key(path: &Path) -> Result<SecretKey, Box<dyn std::error::Error>> {
    if let Ok(bytes) = std::fs::read(path) {
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "invalid iroh identity length")?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let key = SecretKey::generate();
    std::fs::write(path, key.to_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::{
        FRAME_LENGTH_BYTES, FragmentReadError, MAX_FRAGMENT_BYTES, frame_fragment, read_fragment,
    };
    use tokio::io::{AsyncWriteExt, duplex};

    #[tokio::test]
    async fn reads_split_prefix_and_coalesced_fragments() {
        let (mut writer, mut reader) = duplex(128);
        let first = frame_fragment(b"first").unwrap();
        let second = frame_fragment(b"second").unwrap();
        let mut wire = first.clone();
        wire.extend_from_slice(&second);
        let producer = tokio::spawn(async move {
            writer.write_all(&wire[..1]).await.unwrap();
            writer
                .write_all(&wire[1..FRAME_LENGTH_BYTES + 1])
                .await
                .unwrap();
            writer
                .write_all(&wire[FRAME_LENGTH_BYTES + 1..])
                .await
                .unwrap();
            writer.shutdown().await.unwrap();
        });

        assert_eq!(
            read_fragment(&mut reader).await.unwrap(),
            Some(b"first".to_vec())
        );
        assert_eq!(
            read_fragment(&mut reader).await.unwrap(),
            Some(b"second".to_vec())
        );
        assert_eq!(read_fragment(&mut reader).await.unwrap(), None);
        producer.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_truncated_length_prefixes() {
        for prefix_bytes in 1..FRAME_LENGTH_BYTES {
            let (mut writer, mut reader) = duplex(16);
            writer
                .write_all(&3u32.to_be_bytes()[..prefix_bytes])
                .await
                .unwrap();
            writer.shutdown().await.unwrap();
            assert!(matches!(
                read_fragment(&mut reader).await,
                Err(FragmentReadError::TruncatedLengthPrefix)
            ));
        }
    }

    #[tokio::test]
    async fn rejects_zero_length_fragments() {
        let (mut writer, mut reader) = duplex(16);
        writer.write_all(&0u32.to_be_bytes()).await.unwrap();
        assert!(matches!(
            read_fragment(&mut reader).await,
            Err(FragmentReadError::InvalidLength(0))
        ));
    }

    #[tokio::test]
    async fn rejects_fragments_larger_than_the_desktop_ceiling() {
        let (mut writer, mut reader) = duplex(16);
        let length = (MAX_FRAGMENT_BYTES as u32 + 1).to_be_bytes();
        writer.write_all(&length).await.unwrap();
        assert!(matches!(
            read_fragment(&mut reader).await,
            Err(FragmentReadError::InvalidLength(length)) if length == MAX_FRAGMENT_BYTES + 1
        ));
    }

    #[test]
    fn prefixes_each_fragment_with_big_endian_length() {
        assert_eq!(
            frame_fragment(&[1, 2, 3]).unwrap(),
            vec![0, 0, 0, 3, 1, 2, 3]
        );
        assert_eq!(
            frame_fragment(&vec![0; MAX_FRAGMENT_BYTES]).unwrap().len(),
            MAX_FRAGMENT_BYTES + FRAME_LENGTH_BYTES
        );
    }
}
