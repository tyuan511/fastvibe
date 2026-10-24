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
    ThreadUpdate => "thread/update": ThreadUpdateParams => ThreadStartResponse,
    ThreadDelete => "thread/delete": ThreadIdParams => Empty,
    ThreadCompactStart => "thread/compact/start": ThreadIdParams => Empty,
    ThreadModelSet => "thread/model/set": ThreadModelParams => ThreadStartResponse,
    ProviderList => "provider/list": Empty => ProviderListResponse,
    ProviderUpsert => "provider/upsert": ProviderUpsertParams => ProviderUpsertResponse,
    ProviderDelete => "provider/delete": ProviderIdParams => Empty,
    ProviderReorder => "provider/reorder": ProviderReorderParams => ProviderListResponse,
    ProviderFetchModels => "provider/fetchModels": FetchModelsParams => FetchModelsResponse,
    ModelList => "model/list": Empty => ModelListResponse,
    ModelDefaultsGet => "model/defaults/get": Empty => ModelDefaults,
    ModelDefaultsSet => "model/defaults/set": ModelDefaults => ModelDefaults,
    ProjectList => "project/list": Empty => ProjectListResponse,
    ProjectAdd => "project/add": ProjectPathParams => ProjectInfo,
    ProjectRemove => "project/remove": ProjectPathParams => ProjectListResponse,
    SettingsGet => "settings/get": Empty => AppSettings,
    SettingsSet => "settings/set": AppSettingsPatch => AppSettings,
}

notifications!(ClientNotification {
    Initialized => "initialized": Empty,
});

notifications!(ServerNotification {
    ThreadStarted => "thread/started": Thread,
    CatalogChanged => "catalog/changed": CatalogChanged,
    // A provider or the default model changed; model pickers read `model/list` again.
    ProvidersChanged => "providers/changed": Empty,
    // Appearance settings changed (by any client, this one included).
    SettingsChanged => "settings/changed": AppSettings,
    TurnStarted => "turn/started": ThreadEvent<TurnRef>,
    TurnCompleted => "turn/completed": ThreadEvent<TurnCompleted>,
    ThreadStatusChanged => "thread/status/changed": ThreadEvent<ThreadStatus>,
    ItemStarted => "item/started": ThreadEvent<ItemRef>,
    ItemCompleted => "item/completed": ThreadEvent<ItemRef>,
    AgentMessageDelta => "item/agentMessage/delta": ThreadEvent<Delta>,
    ReasoningDelta => "item/reasoning/delta": ThreadEvent<Delta>,
    ToolCallArgumentsDelta => "item/toolCall/argumentsDelta": ThreadEvent<Delta>,
    TurnPlanUpdated => "turn/plan/updated": ThreadEvent<PlanUpdated>,
    ThreadTokenUsageUpdated => "thread/tokenUsage/updated": ThreadEvent<TokenUsage>,
    ServerRequestResolved => "serverRequest/resolved": ThreadEvent<RequestResolved>,
});

/// Server → client requests that wait for an answer. The client replies with a JSON-RPC
/// response carrying the result type named on each variant, or with an error to decline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "method")]
pub enum ServerRequest {
    /// Questions for the user; answered with a [`UserInputResponse`].
    #[serde(rename = "item/question/request")]
    UserInput {
        id: RequestId,
        params: UserInputRequest,
    },
}

impl ServerRequest {
    pub fn id(&self) -> &RequestId {
        match self {
            ServerRequest::UserInput { id, .. } => id,
        }
    }

    pub fn method(&self) -> &'static str {
        match self {
            ServerRequest::UserInput { .. } => "item/question/request",
        }
    }
}
