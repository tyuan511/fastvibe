use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

/// Error codes follow JSON-RPC where they overlap and add FastVibe's own below -32000.
pub mod code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// The server's bounded queue is full; the client may retry.
    pub const OVERLOADED: i64 = -32001;
    pub const NOT_INITIALIZED: i64 = -32002;
    pub const ALREADY_INITIALIZED: i64 = -32003;
    /// The connection's origin may not call this method (see the policy table).
    pub const FORBIDDEN: i64 = -32004;
    /// A turn is already running in this thread.
    pub const THREAD_BUSY: i64 = -32005;
    /// Nothing is running in this thread, so a steer has nothing to join. The words are a
    /// prompt of their own; the client turns them into one (codex's client does the same).
    pub const NO_ACTIVE_TURN: i64 = -32006;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorObject {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ErrorObject {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

/// One frame on the wire, before its method is looked at.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Message {
    Request {
        id: RequestId,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Notification {
        method: String,
        #[serde(default)]
        params: Value,
    },
    Response {
        id: RequestId,
        result: Value,
    },
    Error {
        id: RequestId,
        error: ErrorObject,
    },
}
