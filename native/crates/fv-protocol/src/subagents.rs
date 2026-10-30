//! Native collaboration: child threads use the same turn/transcript protocol as their parent.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentConfig {
    pub enabled: bool,
    pub max_agents: u32,
    pub max_depth: u32,
}
impl Default for SubagentConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_agents: 6,
            max_depth: 1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SubagentStatus {
    Idle,
    Running,
    Completed,
    Interrupted,
    Failed,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub agent_id: String,
    pub parent_thread_id: String,
    pub root_thread_id: String,
    pub depth: u32,
    /// Immutable role snapshot for all turns of this child, including after restart.
    #[serde(default)]
    pub role: Option<SubagentRole>,
    #[serde(default)]
    pub fork_context: bool,
    /// Codex-style canonical agent path (`/root/<name>/…`): the spawn-time `task_name` joined
    /// onto the spawner's own path. None for rows written before task names existed.
    #[serde(default)]
    pub task_name: Option<String>,
    /// An ancestor's tool grant is a ceiling even when this child chooses another role.
    #[serde(default)]
    pub tool_ceiling: Option<Vec<String>>,
    pub task: String,
    pub status: SubagentStatus,
    #[serde(default)]
    pub waiting_for_input: bool,
    /// A bounded preview. Read the child thread for its complete transcript.
    pub result: String,
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentListParams {
    /// Omit for the 100 most recent children across roots; a child id selects its root.
    #[serde(default)]
    pub thread_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentListResponse {
    pub agents: Vec<Subagent>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentIdParams {
    pub agent_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRole {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub model: Option<String>,
    pub thinking: Option<crate::types::ThinkingLevel>,
    /// Further restrict the inherited filesystem sandbox; never allows escalation.
    pub read_only: bool,
    /// None grants all eligible tools; Some([]) grants none.
    pub tools: Option<Vec<String>>,
    /// A built-in role ships with the app: it is not stored per install and cannot be edited
    /// or deleted. A saved role with the same id (and different content) shadows it, as in
    /// codex where user-configured agent roles override the compiled-in ones by name.
    #[serde(default)]
    pub builtin: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentToolChoice {
    pub name: String,
    pub description: String,
    pub read_only_allowed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRolesResponse {
    pub roles: Vec<SubagentRole>,
    pub tools: Vec<SubagentToolChoice>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRoleUpsertParams {
    pub role: SubagentRole,
    /// None creates a new role. An edit must name the exact role the editor read.
    pub expected: Option<SubagentRole>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRoleDeleteParams {
    pub expected: SubagentRole,
}
