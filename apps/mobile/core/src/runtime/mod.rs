use crate::support::*;
use crate::*;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod account;
mod commands;
mod connection;
mod events;
mod rpc;
use events::*;

#[derive(Debug, Clone)]
pub(crate) enum RpcKind {
    Generic,
    Workspace,
    OpenConversation { conversation_id: String },
    CreateConversation,
    Snapshot { conversation_id: String },
    HistoryPage { conversation_id: String },
    Queue { conversation_id: String },
    SessionState { conversation_id: Option<String> },
    PendingUi,
    Subscribe,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingRpc {
    action: String,
    method: String,
    kind: RpcKind,
    created_at: Instant,
}

const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const WELCOME_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct SharedCore {
    protocol: Mutex<()>,
    store: Mutex<TranscriptStore>,
    workspace: Mutex<WorkspaceSnapshot>,
    pub(crate) wire_cursors: Mutex<HashMap<String, WireCursor>>,
    events: Mutex<VecDeque<serde_json::Value>>,
    event_overflowed: Mutex<bool>,
    connection: Mutex<ConnectionMeta>,
    pending_rpcs: Mutex<HashMap<u64, PendingRpc>>,
    next_request_id: std::sync::atomic::AtomicU64,
    buffered_events: Mutex<HashMap<String, Vec<AppEventMessage>>>,
    session_state: Mutex<Option<serde_json::Value>>,
    welcome: Mutex<Option<WelcomeState>>,
    loading_history: Mutex<bool>,
}

#[derive(Debug, Clone)]
pub(crate) struct WelcomeState {
    session_id: String,
    epoch: String,
    capabilities: Vec<String>,
    features: serde_json::Value,
}

pub(crate) struct ConnectionMeta {
    status: String,
    device_id: Option<String>,
    endpoint_id: Option<String>,
    conversation_id: Option<String>,
    error: Option<String>,
    generation: u64,
    #[cfg(feature = "iroh-transport")]
    outbound: Option<tokio::sync::mpsc::UnboundedSender<TransportCommand>>,
}

#[cfg(feature = "iroh-transport")]
enum TransportCommand {
    Message(AppMessage),
    Close,
}

impl Default for ConnectionMeta {
    fn default() -> Self {
        Self {
            status: "disconnected".into(),
            device_id: None,
            endpoint_id: None,
            conversation_id: None,
            error: None,
            generation: 0,
            #[cfg(feature = "iroh-transport")]
            outbound: None,
        }
    }
}

impl SharedCore {
    fn new() -> Self {
        Self {
            protocol: Mutex::new(()),
            store: Mutex::new(TranscriptStore::default()),
            workspace: Mutex::new(WorkspaceSnapshot::default()),
            wire_cursors: Mutex::new(HashMap::new()),
            events: Mutex::new(VecDeque::new()),
            event_overflowed: Mutex::new(false),
            connection: Mutex::new(ConnectionMeta::default()),
            pending_rpcs: Mutex::new(HashMap::new()),
            next_request_id: std::sync::atomic::AtomicU64::new(1),
            buffered_events: Mutex::new(HashMap::new()),
            session_state: Mutex::new(None),
            welcome: Mutex::new(None),
            loading_history: Mutex::new(false),
        }
    }

    #[cfg(feature = "iroh-transport")]
    fn push_event(&self, event: serde_json::Value) {
        let mut events = lock(&self.events);
        if events.len() >= MAX_PENDING_EVENTS {
            events.pop_front();
            *lock(&self.event_overflowed) = true;
        }
        events.push_back(event);
    }

    fn next_request_id(&self) -> u64 {
        self.next_request_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn register_rpc(&self, request_id: u64, pending: PendingRpc) {
        lock(&self.pending_rpcs).insert(request_id, pending);
    }

    fn take_rpc(&self, request_id: u64) -> Option<PendingRpc> {
        lock(&self.pending_rpcs).remove(&request_id)
    }

    fn has_snapshot_pending(&self, conversation_id: &str) -> bool {
        lock(&self.pending_rpcs).values().any(|pending| {
            matches!(&pending.kind, RpcKind::Snapshot { conversation_id: id } if id == conversation_id)
        })
    }

    fn clear_connection_protocol(&self) {
        lock(&self.pending_rpcs).clear();
        lock(&self.buffered_events).clear();
        lock(&self.wire_cursors).clear();
        *lock(&self.welcome) = None;
    }

    fn clear_projection(&self) {
        lock(&self.events).clear();
        *lock(&self.event_overflowed) = false;
        *lock(&self.store) = TranscriptStore::default();
        *lock(&self.workspace) = WorkspaceSnapshot::default();
        *lock(&self.session_state) = None;
        *lock(&self.loading_history) = false;
    }

    fn expire_rpcs(&self) -> Vec<(u64, PendingRpc)> {
        let now = Instant::now();
        let mut pending = lock(&self.pending_rpcs);
        let expired_ids: Vec<_> = pending
            .iter()
            .filter(|(_, rpc)| now.duration_since(rpc.created_at) >= RPC_TIMEOUT)
            .map(|(id, _)| *id)
            .collect();
        expired_ids
            .into_iter()
            .filter_map(|id| pending.remove(&id).map(|rpc| (id, rpc)))
            .collect()
    }

    pub(crate) fn snapshot(&self) -> ConversationSnapshot {
        let conversation_id = lock(&self.connection).conversation_id.clone();
        lock(&self.store).snapshot(conversation_id)
    }

    fn state(&self) -> MobileState {
        let connection = lock(&self.connection);
        let welcome = lock(&self.welcome).clone();
        let pending_requests = lock(&self.pending_rpcs)
            .iter()
            .map(|(request_id, pending)| {
                serde_json::json!({
                    "requestId": request_id,
                    "action": pending.action,
                    "method": pending.method,
                })
            })
            .collect();
        MobileState {
            snapshot: Some(lock(&self.store).snapshot(connection.conversation_id.clone())),
            workspace: lock(&self.workspace).clone(),
            pending_requests,
            session_state: lock(&self.session_state).clone(),
            wire_cursors: lock(&self.wire_cursors).clone(),
            loading_history: *lock(&self.loading_history),
            connection: connection.status.clone(),
            connection_generation: connection.generation,
            session_id: welcome.as_ref().map(|value| value.session_id.clone()),
            capabilities: welcome
                .as_ref()
                .map(|value| value.capabilities.clone())
                .unwrap_or_default(),
            features: welcome.map(|value| value.features),
            device_id: connection.device_id.clone(),
            endpoint_id: connection.endpoint_id.clone(),
            conversation_id: connection.conversation_id.clone(),
            error: connection.error.clone(),
        }
    }
}

#[cfg(feature = "mobile-client")]
pub(crate) struct LoginState {
    verifier: String,
    state: String,
}

#[cfg(feature = "mobile-client")]
#[derive(Default)]
struct RegistrationCache {
    device: Option<(String, String, String, String, Instant)>,
    endpoint: Option<(String, String, Instant)>,
}

#[cfg(feature = "mobile-client")]
const REGISTRATION_TTL: Duration = Duration::from_secs(5 * 60);

pub struct CoreHandle {
    pub(crate) shared: Arc<SharedCore>,
    #[cfg(any(feature = "mobile-client", feature = "iroh-transport"))]
    runtime: tokio::runtime::Runtime,
    #[cfg(feature = "mobile-client")]
    account: Mutex<Option<mobile_client::AccountClient>>,
    #[cfg(feature = "mobile-client")]
    login: Mutex<Option<LoginState>>,
    #[cfg(feature = "iroh-transport")]
    identity: Mutex<Option<String>>,
    #[cfg(feature = "iroh-transport")]
    endpoint_pool: Arc<tokio::sync::Mutex<crate::iroh_transport::IrohEndpointPool>>,
    #[cfg(feature = "mobile-client")]
    registrations: Arc<Mutex<RegistrationCache>>,
}

#[cfg(all(test, feature = "mobile-client", feature = "iroh-transport"))]
mod reuse_tests;
#[cfg(test)]
mod tests;
