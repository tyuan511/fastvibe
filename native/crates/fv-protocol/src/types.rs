//! Thread → Turn → Item, and the parameter/response types of the methods.

use schemars::JsonSchema;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::jsonrpc::RequestId;

pub type ThreadId = String;
pub type TurnId = String;
pub type ItemId = String;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ClientOrigin {
    Local,
    Lan,
    Official,
    Ssh,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    /// Accept methods and notifications marked experimental.
    #[serde(default)]
    pub experimental_api: bool,
    /// Notification methods this client does not want.
    #[serde(default)]
    pub opt_out_notifications: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    pub protocol_version: u32,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    pub server_version: String,
    pub protocol_version: u32,
    /// Where the server keeps its data; informational for clients on the same machine.
    pub data_dir: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Empty {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: ThreadId,
    pub title: String,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub unread: bool,
    /// `provider/model` this conversation uses; the default model when absent.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<ThinkingLevel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListParams {
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResponse {
    pub threads: Vec<Thread>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartParams {
    pub cwd: Option<String>,
    pub project: Option<String>,
    /// `provider/model`; the server's default when absent.
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<ThinkingLevel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartResponse {
    pub thread: Thread,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdParams {
    pub thread_id: ThreadId,
}

/// `thread/resume`: the snapshot and the subscription are one atomic step. Events with a
/// `seq` at or below `seq` here are already reflected in `turns` and must be dropped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeResponse {
    pub thread: Thread,
    /// How full the conversation's context window is, when it can be told.
    #[serde(default)]
    pub token_usage: Option<TokenUsage>,
    pub turns: Vec<Turn>,
    pub seq: u64,
    pub running: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: TurnId,
    pub items: Vec<Item>,
    /// When the user's message was accepted (milliseconds since the epoch).
    #[serde(default)]
    pub started_at: Option<i64>,
    /// When the last tool call finished: the end of the work a settled turn folds away
    /// (用时), as opposed to the whole turn (耗时).
    #[serde(default)]
    pub process_ended_at: Option<i64>,
    #[serde(default)]
    pub completed_at: Option<i64>,
}

impl Turn {
    pub fn new(id: TurnId, items: Vec<Item>) -> Self {
        Self {
            id,
            items,
            started_at: None,
            process_ended_at: None,
            completed_at: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Item {
    UserMessage {
        id: ItemId,
        text: String,
    },
    AgentMessage {
        id: ItemId,
        text: String,
    },
    Reasoning {
        id: ItemId,
        text: String,
    },
    ToolCall {
        id: ItemId,
        name: String,
        arguments: serde_json::Value,
        output: Option<String>,
        is_error: bool,
    },
    Error {
        id: ItemId,
        message: String,
    },
    /// The conversation was summarized to make room; everything before this is no longer
    /// sent to the model (but is still shown).
    ContextCompaction {
        id: ItemId,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    pub thread_id: ThreadId,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResponse {
    pub turn_id: TurnId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEvent<T> {
    pub thread_id: ThreadId,
    /// Monotonic per thread.
    pub seq: u64,
    #[serde(flatten)]
    pub body: T,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub turn_id: TurnId,
    pub item: Item,
    #[serde(default)]
    pub at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub turn_id: TurnId,
    pub item_id: ItemId,
    pub delta: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnRef {
    pub turn_id: TurnId,
    /// When it happened, by the server's clock.
    #[serde(default)]
    pub at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogChanged {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Completed,
    /// Stopped by the user (`turn/interrupt`). Not a failure.
    Interrupted,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompleted {
    pub turn_id: TurnId,
    pub status: TurnStatus,
    pub error: Option<String>,
    #[serde(default)]
    pub at: Option<i64>,
}

/// `running` is true from the moment a turn is accepted until it has fully settled.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatus {
    pub running: bool,
}

// ---- the plan (update_plan)

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub step: String,
    pub status: PlanStatus,
}

/// The model replaced its checklist. Each update is the whole list, not a change to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanUpdated {
    pub turn_id: TurnId,
    pub explanation: Option<String>,
    pub plan: Vec<PlanStep>,
}

// ---- questions to the user (request_user_input)

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// What the answer is filed under.
    pub id: String,
    /// A short heading, 12 characters or fewer.
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    /// Offer a free-form "Other" answer besides the options.
    pub is_other: bool,
}

/// `item/question/request`: the agent is stopped until the user answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserInputRequest {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    /// The tool call the questions belong to.
    pub call_id: String,
    pub questions: Vec<Question>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UserInputAnswer {
    pub answers: Vec<String>,
}

/// The client's answer to an `item/question/request`: each question's id to what was chosen or
/// typed. A client that will not answer replies with an error instead.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UserInputResponse {
    pub answers: BTreeMap<String, UserInputAnswer>,
}

/// A request to the client has been answered or withdrawn (by whichever client got there
/// first, or because the turn was stopped); every other client takes its prompt down.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestResolved {
    pub request_id: RequestId,
}

// ---- providers and models

/// The wire format a provider speaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApiProtocol {
    /// OpenAI Chat Completions, and everything that imitates it.
    Chat,
    /// OpenAI Responses.
    Responses,
    /// Anthropic Messages.
    Anthropic,
    /// Google Gemini.
    Google,
}

/// How hard the model is asked to think. There is deliberately no "off".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// What the provider calls it.
    pub id: String,
    pub name: Option<String>,
    /// This model's own protocol, when it differs from its provider's.
    #[serde(default)]
    pub protocol: Option<ApiProtocol>,
    /// Whether it can look at images.
    #[serde(default = "default_true")]
    pub supports_images: bool,
    #[serde(default)]
    pub context_window: Option<u32>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
}

fn default_true() -> bool {
    true
}

/// A provider as clients see it. The API key is never part of it: `has_key` says one is set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub protocol: ApiProtocol,
    pub base_url: String,
    pub has_key: bool,
    pub enabled: bool,
    pub models: Vec<ModelInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListResponse {
    pub providers: Vec<ProviderInfo>,
}

/// Create a provider (no `id`) or replace one. The key is write-only: absent keeps the stored
/// one, an empty string clears it, anything else replaces it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpsertParams {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub protocol: ApiProtocol,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ModelInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpsertResponse {
    pub provider: ProviderInfo,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIdParams {
    pub provider_id: String,
}

/// The providers in the order they should be listed; one left out goes to the end.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReorderParams {
    pub ids: Vec<String>,
}

/// Ask a provider which models it has: a saved one (`provider_id`, using its stored key) or one
/// not saved yet (`protocol`, `base_url`, `api_key`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsParams {
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub protocol: Option<ApiProtocol>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsResponse {
    pub models: Vec<ModelInfo>,
}

/// One model a conversation can use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub provider_id: String,
    pub provider_name: String,
    pub model: ModelInfo,
    /// `provider_id/model_id`: what a conversation stores to name it.
    pub label: String,
}

/// The models of every enabled provider that has a key, in provider order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResponse {
    pub models: Vec<ModelEntry>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelDefaults {
    /// `provider/model` used by a conversation that names none.
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadModelParams {
    pub thread_id: ThreadId,
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
}

/// How much of the model's context window the conversation takes. Summarizing starts at 90%.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub used: u64,
    pub window: u64,
}
