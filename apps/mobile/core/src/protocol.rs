use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const APP_PROTOCOL: &str = "fastvibe.app";
pub const APP_PROTOCOL_VERSION: u32 = 1;
pub const ALPN: &[u8] = b"fastvibe/app/1";
pub const MAX_VISIBLE_MESSAGES: usize = 120;
pub const MAX_FRAME_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_FRAGMENT_BYTES: usize = 16 * 1024;
pub const MAX_PENDING_EVENTS: usize = 256;
pub const MAX_TURN_EVENTS: usize = 512;

pub const LAST: u8 = 0x01;
pub const BINARY: u8 = 0x02;
pub const PING: u8 = 0x04;
pub const PONG: u8 = 0x08;
pub const CLOSE: u8 = 0x10;
pub const DEFLATE: u8 = 0x20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
#[serde(tag = "kind")]
pub enum MessagePart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        started_at: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ended_at: Option<i64>,
    },
    #[serde(rename = "tool")]
    Tool { tool_id: String },
    #[serde(rename = "model")]
    Model {
        from: Option<EngineModel>,
        to: EngineModel,
    },
    #[serde(rename = "compact")]
    Compact {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        compact: Option<CompactInfo>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineModel {
    pub provider: String,
    #[serde(alias = "id")]
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactInfo {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omitted: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default)]
    pub tools: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<MessagePart>>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred_content: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_cause: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact: Option<CompactInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub revision: u64,
    pub items: Vec<serde_json::Value>,
    #[serde(default)]
    pub pause: Option<String>,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    #[serde(default)]
    pub projects: Vec<serde_json::Value>,
    #[serde(default)]
    pub conversations: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotHistory {
    pub before_entry_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHistoryPage {
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    pub before_entry_id: String,
    pub next_before_entry_id: Option<String>,
    #[serde(default)]
    pub reset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUiRequest {
    pub id: String,
    #[serde(flatten)]
    pub data: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshot {
    pub conversation_id: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub message_mode: Option<String>,
    pub history_before_entry_id: Option<String>,
    #[serde(default)]
    pub history: Option<SnapshotHistory>,
    pub running: bool,
    pub queue: QueueState,
    pub pending_ui: Vec<serde_json::Value>,
    pub turn_events: Vec<serde_json::Value>,
    pub overflowed: bool,
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WireCursor {
    pub epoch: String,
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppHello {
    pub protocol: String,
    pub protocol_version: u32,
    pub client: AppClientIdentity,
    pub capabilities: Vec<String>,
    pub features: AppFeatures,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppClientIdentity {
    pub kind: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppFeatures {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_batch: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_attachments: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_resume: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_summary: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum AppMessage {
    #[serde(rename = "hello")]
    Hello { hello: AppHello },
    #[serde(rename = "call")]
    Call {
        #[serde(rename = "requestId")]
        request_id: u64,
        method: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
        #[serde(rename = "idempotencyKey", skip_serializing_if = "Option::is_none")]
        idempotency_key: Option<String>,
    },
    #[serde(rename = "query")]
    Query {
        #[serde(rename = "requestId")]
        request_id: u64,
        method: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    #[serde(rename = "subscribe")]
    Subscribe {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<u64>,
        scopes: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        since: Option<HashMap<String, WireCursor>>,
    },
    #[serde(rename = "unsubscribe")]
    Unsubscribe { scopes: Vec<String> },
    #[serde(rename = "cancel")]
    Cancel {
        #[serde(rename = "targetRequestId")]
        target_request_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppEventMessage {
    pub scope: String,
    pub seq: u64,
    pub epoch: String,
    pub event_id: String,
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum AppEventEnvelope {
    #[serde(rename = "event")]
    Event(AppEventMessage),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum LegacyAuthMessage {
    #[serde(rename = "auth")]
    Auth {
        ok: bool,
        #[serde(default)]
        device: Option<serde_json::Value>,
        #[serde(default)]
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum AppServerMessage {
    #[serde(rename = "welcome")]
    Welcome {
        handshake: serde_json::Value,
        #[serde(rename = "sessionId")]
        session_id: String,
        capabilities: Vec<String>,
        epoch: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        features: Option<serde_json::Value>,
    },
    #[serde(rename = "result")]
    Result {
        #[serde(rename = "requestId")]
        request_id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<serde_json::Value>,
    },
    #[serde(rename = "event")]
    Event(AppEventMessage),
    #[serde(rename = "events")]
    Events { events: Vec<AppEventEnvelope> },
    #[serde(rename = "resync")]
    Resync {
        scope: String,
        reason: String,
        epoch: String,
        seq: u64,
    },
    #[serde(rename = "subscribed")]
    Subscribed {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<u64>,
        cursors: HashMap<String, WireCursor>,
    },
    #[serde(rename = "pong")]
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileState {
    pub snapshot: Option<ConversationSnapshot>,
    #[serde(default)]
    pub workspace: WorkspaceSnapshot,
    #[serde(default)]
    pub pending_requests: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_state: Option<serde_json::Value>,
    pub wire_cursors: HashMap<String, WireCursor>,
    pub loading_history: bool,
    pub connection: String,
    #[serde(default)]
    pub connection_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub features: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn hello(version: &str) -> AppMessage {
    AppMessage::Hello {
        hello: AppHello {
            protocol: APP_PROTOCOL.into(),
            protocol_version: APP_PROTOCOL_VERSION,
            client: AppClientIdentity {
                kind: "fastvibe-mobile".into(),
                version: version.into(),
            },
            capabilities: vec![
                "conversations".into(),
                "engine".into(),
                "workspace".into(),
                "git".into(),
                "providers".into(),
                // Dart reads settings during catalog initialization and health probes.
                "settings".into(),
            ],
            features: AppFeatures {
                event_batch: Some(true),
                binary_attachments: Some(false),
                conversation_resume: Some(true),
                thinking_summary: Some(true),
            },
        },
    }
}
