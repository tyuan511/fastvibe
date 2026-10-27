//! The one list of methods. Everything else is derived from it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Rpc;
use crate::jsonrpc::RequestId;
use crate::office::*;
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
    ThreadSearch => "thread/search": ThreadSearchParams => ThreadSearchResponse,
    ThreadStart => "thread/start": ThreadStartParams => ThreadStartResponse,
    ThreadResume => "thread/resume": ThreadIdParams => ThreadResumeResponse,
    ThreadUnsubscribe => "thread/unsubscribe": ThreadIdParams => Empty,
    TurnStart => "turn/start": TurnStartParams => TurnStartResponse,
    TurnSteer => "turn/steer": TurnSteerParams => TurnSteerResponse,
    TurnInterrupt => "turn/interrupt": ThreadIdParams => Empty,
    TurnRewind => "turn/rewind": TurnRewindParams => TurnRewindResponse,
    TurnEnqueue => "turn/enqueue": TurnEnqueueParams => QueueItem,
    TurnQueueRemove => "turn/queue/remove": QueueItemParams => Empty,
    TurnQueueSendNow => "turn/queue/sendNow": QueueItemParams => Empty,
    TurnQueueResume => "turn/queue/resume": ThreadIdParams => Empty,
    ThreadUpdate => "thread/update": ThreadUpdateParams => ThreadStartResponse,
    ThreadFork => "thread/fork": ThreadIdParams => ThreadStartResponse,
    ThreadDelete => "thread/delete": ThreadIdParams => Empty,
    ThreadWorktreeCreate => "thread/worktree/create": ThreadWorktreeCreateParams => ThreadStartResponse,
    ThreadWorktreeBind => "thread/worktree/bind": ThreadWorktreeBindParams => ThreadStartResponse,
    ThreadWorktreeUnbind => "thread/worktree/unbind": ThreadWorktreeUnbindParams => ThreadStartResponse,
    ThreadWorktreeList => "thread/worktree/list": ThreadIdParams => ThreadWorktreeListResponse,
    ThreadCompactStart => "thread/compact/start": ThreadIdParams => Empty,
    ThreadModelSet => "thread/model/set": ThreadModelParams => ThreadStartResponse,
    ProviderList => "provider/list": Empty => ProviderListResponse,
    ProviderUpsert => "provider/upsert": ProviderUpsertParams => ProviderUpsertResponse,
    ProviderDelete => "provider/delete": ProviderIdParams => Empty,
    ProviderReorder => "provider/reorder": ProviderReorderParams => ProviderListResponse,
    ProviderFetchModels => "provider/fetchModels": FetchModelsParams => FetchModelsResponse,
    ModelCatalogGet => "model/catalog/get": Empty => crate::catalog::ModelCatalogInfo,
    ModelCatalogRefresh => "model/catalog/refresh": Empty => crate::catalog::ModelCatalogUpdate,
    ProviderModelTest => "provider/model/test": crate::provider_test::ProviderTestParams => crate::provider_test::ProviderTestResult,
    ProviderModelGet => "provider/model/get": crate::models::ProviderModelParams => crate::models::ModelDetail,
    ProviderModelUpdate => "provider/model/update": crate::models::ProviderModelUpdateParams => crate::models::ModelDetail,
    ModelList => "model/list": Empty => ModelListResponse,
    ModelDefaultsGet => "model/defaults/get": Empty => ModelDefaults,
    ModelDefaultsSet => "model/defaults/set": ModelDefaults => ModelDefaults,
    ProjectList => "project/list": Empty => ProjectListResponse,
    ProjectCreate => "project/create": ProjectCreateParams => ProjectInfo,
    ProjectUpdate => "project/update": ProjectUpdateParams => ProjectInfo,
    ProjectRemove => "project/remove": ProjectPathParams => ProjectListResponse,
    WorkspaceReadDir => "workspace/readDir": ReadDirParams => ReadDirResponse,
    OfficeRender => "office/render": OfficeWatchParams => OfficeRenderResponse,
    OfficeWatchStart => "office/watchStart": OfficeWatchParams => OfficeWatchState,
    OfficeWatchStop => "office/watchStop": OfficeLeaseParams => Empty,
    OfficeWatchStateGet => "office/watchState": OfficeLeaseParams => OfficeWatchState,
    OfficeSelectionGet => "office/selection": OfficeLeaseParams => OfficeSelection,
    WorkspacePreview => "workspace/preview": PreviewParams => FilePreview,
    WorkspaceSearchFiles => "workspace/searchFiles": SearchFilesParams => SearchFilesResponse,
    WorkspaceWriteFile => "workspace/writeFile": WriteFileParams => Empty,
    WorkspaceCreateEntry => "workspace/createEntry": CreateEntryParams => DirEntry,
    WorkspaceRenameEntry => "workspace/renameEntry": RenameEntryParams => DirEntry,
    WorkspaceDeleteEntry => "workspace/deleteEntry": DeleteEntryParams => Empty,
    WorkspaceGitStatus => "workspace/gitStatus": CwdParams => GitStatus,
    WorkspaceGitDiff => "workspace/gitDiff": GitDiffParams => GitDiff,
    WorkspaceGitComparison => "workspace/gitComparison": GitComparisonParams => GitComparison,
    WorkspaceGitHistory => "workspace/gitHistory": GitHistoryParams => GitHistory,
    WorkspaceGitStage => "workspace/gitStage": GitPathsParams => GitStatus,
    WorkspaceGitUnstage => "workspace/gitUnstage": GitPathsParams => GitStatus,
    WorkspaceGitDiscard => "workspace/gitDiscard": GitPathsParams => GitStatus,
    WorkspaceGitDeleteUntracked => "workspace/gitDeleteUntracked": GitPathsParams => GitStatus,
    WorkspaceGitCommit => "workspace/gitCommit": GitCommitParams => GitStatus,
    TerminalStart => "terminal/start": TerminalStartParams => TerminalSession,
    TerminalWrite => "terminal/write": TerminalWriteParams => Empty,
    TerminalResize => "terminal/resize": TerminalResizeParams => Empty,
    TerminalRead => "terminal/read": TerminalReadParams => TerminalFrame,
    TerminalCopy => "terminal/copy": TerminalCopyParams => TerminalCopyResponse,
    TerminalKill => "terminal/kill": TerminalIdParams => Empty,
    SettingsGet => "settings/get": Empty => AppSettings,
    SettingsReset => "settings/reset": Empty => AppSettings,
    StatsUsage => "stats/usage": crate::usage::UsageParams => crate::usage::UsageStats,
    SettingsSet => "settings/set": AppSettingsPatch => AppSettings,
    SkillList => "skill/list": SkillListParams => SkillListResponse,
    MemoryRead => "memory/read": Empty => MemoryState,
    MemoryConfigure => "memory/configure": MemoryConfig => MemoryState,
    MemoryRun => "memory/run": Empty => MemoryState,
    MemoryClear => "memory/clear": Empty => MemoryState,
    SkillRead => "skill/read": SkillNameParams => SkillReadResponse,
    SkillCreate => "skill/create": SkillCreateParams => Empty,
    SkillImport => "skill/import": SkillImportParams => Empty,
    McpList => "mcp/list": Empty => McpListResponse,
    McpSet => "mcp/set": McpSetParams => McpListResponse,
    McpUpdate => "mcp/update": McpUpdateParams => McpListResponse,
    McpAuthBegin => "mcp/auth/begin": McpAuthBeginParams => McpAuthBeginResponse,
    McpAuthComplete => "mcp/auth/complete": McpAuthCompleteParams => McpListResponse,
    McpAuthCancel => "mcp/auth/cancel": McpAuthCancelParams => Empty,
    McpAuthForget => "mcp/auth/forget": McpServerParams => McpListResponse,
    McpImport => "mcp/import": McpImportParams => McpListResponse,
    McpReconnect => "mcp/reconnect": McpServerParams => McpListResponse,
    McpResources => "mcp/resources": McpResourceListParams => McpResourceResponse,
    McpResourceTemplates => "mcp/resourceTemplates": McpResourceListParams => McpResourceResponse,
    McpReadResource => "mcp/readResource": McpResourceParams => McpResourceResponse,
    ScheduleList => "schedule/list": Empty => crate::schedules::ScheduleSnapshot,
    ScheduleUpsert => "schedule/upsert": crate::schedules::ScheduleUpsertParams => crate::schedules::ScheduledTask,
    ScheduleDelete => "schedule/delete": crate::schedules::ScheduleDeleteParams => Empty,
    ScheduleRunNow => "schedule/runNow": crate::schedules::ScheduleIdParams => crate::schedules::ScheduledRun,
    ScheduleStop => "schedule/stop": crate::schedules::ScheduleIdParams => Empty,
    ScheduleHistory => "schedule/history": crate::schedules::ScheduleHistoryParams => crate::schedules::ScheduleHistory,
    SubagentRoleList => "subagent/role/list": Empty => crate::subagents::SubagentRolesResponse,
    SubagentRoleUpsert => "subagent/role/upsert": crate::subagents::SubagentRoleUpsertParams => crate::subagents::SubagentRolesResponse,
    SubagentRoleDelete => "subagent/role/delete": crate::subagents::SubagentRoleDeleteParams => crate::subagents::SubagentRolesResponse,
    SubagentList => "subagent/list": crate::subagents::SubagentListParams => crate::subagents::SubagentListResponse,
    SubagentClose => "subagent/close": crate::subagents::SubagentIdParams => crate::subagents::Subagent,
    SubagentResume => "subagent/resume": crate::subagents::SubagentIdParams => crate::subagents::Subagent,
    SubagentConfigGet => "subagent/config/get": Empty => crate::subagents::SubagentConfig,
    SubagentConfigSet => "subagent/config/set": crate::subagents::SubagentConfig => crate::subagents::SubagentConfig,
    SkillRemove => "skill/remove": SkillNameParams => Empty,
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
    ModelCatalogChanged => "model/catalog/changed": Empty,
    UsageChanged => "stats/usageChanged": Empty,
    SkillsChanged => "skills/changed": Empty,
    SubagentRolesChanged => "subagent/rolesChanged": Empty,
    SchedulesChanged => "schedule/changed": Empty,
    SubagentsChanged => "subagent/changed": Empty,
    MemoryChanged => "memory/changed": MemoryState,
    McpChanged => "mcp/changed": Empty,
    WorkspaceEntryChanged => "workspace/entryChanged": WorkspaceEntryChange,
    TurnStarted => "turn/started": ThreadEvent<TurnRef>,
    TurnCompleted => "turn/completed": ThreadEvent<TurnCompleted>,
    ThreadStatusChanged => "thread/status/changed": ThreadEvent<ThreadStatus>,
    ItemStarted => "item/started": ThreadEvent<ItemRef>,
    ItemCompleted => "item/completed": ThreadEvent<ItemRef>,
    AgentMessageDelta => "item/agentMessage/delta": ThreadEvent<Delta>,
    ReasoningDelta => "item/reasoning/delta": ThreadEvent<Delta>,
    ToolCallArgumentsDelta => "item/toolCall/argumentsDelta": ThreadEvent<Delta>,
    TurnPlanUpdated => "turn/plan/updated": ThreadEvent<PlanUpdated>,
    ThreadStatsUpdated => "thread/stats/updated": ThreadEvent<SessionStats>,
    ThreadTokenUsageUpdated => "thread/tokenUsage/updated": ThreadEvent<TokenUsage>,
    ThreadQueueChanged => "thread/queue/changed": ThreadEvent<QueueState>,
    TurnRewound => "turn/rewound": ThreadEvent<Rewound>,
    ThreadSuggestionChanged => "thread/suggestion/changed": ThreadEvent<Suggestion>,
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
    /// A command or patch that needs the user's say-so; answered with an [`ApprovalResponse`].
    #[serde(rename = "item/approval/request")]
    Approval {
        id: RequestId,
        params: ApprovalRequestParams,
    },
}

impl ServerRequest {
    pub fn id(&self) -> &RequestId {
        match self {
            ServerRequest::UserInput { id, .. } | ServerRequest::Approval { id, .. } => id,
        }
    }

    pub fn method(&self) -> &'static str {
        match self {
            ServerRequest::UserInput { .. } => "item/question/request",
            ServerRequest::Approval { .. } => "item/approval/request",
        }
    }
}
