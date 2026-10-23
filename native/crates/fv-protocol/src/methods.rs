//! The one list of methods. Everything else is derived from it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Rpc;
use crate::jsonrpc::RequestId;
use crate::types::*;

macro_rules! client_requests {
    ($($variant:ident => $name:literal : $params:ty => $response:ty,)*) => {
        $(
            pub struct $variant;
            impl Rpc for $variant {
                const METHOD: &'static str = $name;
                type Params = $params;
                type Response = $response;
            }
        )*

        /// A request from a client, with its `id` and typed `params`.
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "method")]
        pub enum ClientRequest {
            $(
                #[serde(rename = $name)]
                $variant {
                    id: RequestId,
                    params: $params,
                },
            )*
        }

        impl ClientRequest {
            pub fn id(&self) -> &RequestId {
                match self { $(ClientRequest::$variant { id, .. } => id,)* }
            }

            pub fn method(&self) -> &'static str {
                match self { $(ClientRequest::$variant { .. } => $name,)* }
            }
        }

        /// Every client-callable method name, for tests and the policy-coverage check.
        pub const CLIENT_METHODS: &[&str] = &[$($name,)*];
    };
}

macro_rules! notifications {
    ($enum:ident { $($variant:ident => $name:literal : $payload:ty,)* }) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "method", content = "params")]
        pub enum $enum {
            $(#[serde(rename = $name)] $variant($payload),)*
        }

        impl $enum {
            pub fn method(&self) -> &'static str {
                match self { $($enum::$variant(_) => $name,)* }
            }
        }
    };
}

client_requests! {
    Initialize => "initialize": InitializeParams => InitializeResponse,
    ThreadList => "thread/list": ThreadListParams => ThreadListResponse,
    ThreadStart => "thread/start": ThreadStartParams => ThreadStartResponse,
    ThreadResume => "thread/resume": ThreadIdParams => ThreadResumeResponse,
    ThreadUnsubscribe => "thread/unsubscribe": ThreadIdParams => Empty,
    TurnStart => "turn/start": TurnStartParams => TurnStartResponse,
    TurnInterrupt => "turn/interrupt": ThreadIdParams => Empty,
}

notifications!(ClientNotification {
    Initialized => "initialized": Empty,
});

notifications!(ServerNotification {
    ThreadStarted => "thread/started": Thread,
    CatalogChanged => "catalog/changed": CatalogChanged,
    TurnStarted => "turn/started": ThreadEvent<TurnRef>,
    TurnCompleted => "turn/completed": ThreadEvent<TurnCompleted>,
    ThreadStatusChanged => "thread/status/changed": ThreadEvent<ThreadStatus>,
    ItemStarted => "item/started": ThreadEvent<ItemRef>,
    ItemCompleted => "item/completed": ThreadEvent<ItemRef>,
    AgentMessageDelta => "item/agentMessage/delta": ThreadEvent<Delta>,
    ReasoningDelta => "item/reasoning/delta": ThreadEvent<Delta>,
    ToolCallArgumentsDelta => "item/toolCall/argumentsDelta": ThreadEvent<Delta>,
});

/// Server → client requests that wait for an answer (questions, client-side tools).
/// None are defined yet; the enum exists so the transport can already route them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "method")]
pub enum ServerRequest {}
