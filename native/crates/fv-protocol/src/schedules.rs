//! Durable native schedules. Wall-clock repeats use an explicit IANA timezone.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ScheduleRule {
    Once {
        at: String,
    },
    Daily {
        time: String,
        time_zone: String,
    },
    /// Sunday = 0, Saturday = 6.
    Weekly {
        time: String,
        time_zone: String,
        days: Vec<u32>,
    },
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MissedPolicy {
    #[default]
    RunLatest,
    Skip,
}
fn hour() -> u32 {
    3600
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDefinition {
    pub name: String,
    pub prompt: String,
    pub project: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<crate::types::ThinkingLevel>,
    pub rule: ScheduleRule,
    #[serde(default = "hour")]
    pub max_run_seconds: u32,
    #[serde(default)]
    pub missed_policy: MissedPolicy,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Stopped,
    Interrupted,
    Missed,
}
impl ScheduleRunStatus {
    pub fn terminal(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
            Self::Interrupted => "interrupted",
            Self::Missed => "missed",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    /// Changes when the definition/enabled state changes, including consuming a one-off.
    pub version: u64,
    pub definition: ScheduleDefinition,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_status: Option<ScheduleRunStatus>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub id: String,
    pub task_id: String,
    pub task_name: String,
    pub task_version: u64,
    pub scheduled_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub manual: bool,
    pub status: ScheduleRunStatus,
    pub stopping: bool,
    #[serde(default)]
    pub waiting_for_input: bool,
    pub thread_id: Option<String>,
    pub error: Option<String>,
    /// Bounded preview; the conversation is the complete output.
    pub result: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSnapshot {
    pub revision: u64,
    pub tasks: Vec<ScheduledTask>,
    pub active: Option<ScheduledRun>,
    pub queued: Vec<ScheduledRun>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleUpsertParams {
    pub task_id: Option<String>,
    pub expected_version: Option<u64>,
    pub definition: ScheduleDefinition,
    pub enabled: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleIdParams {
    pub task_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDeleteParams {
    pub task_id: String,
    pub expected_version: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleHistoryParams {
    pub task_id: String,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub limit: Option<u32>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleHistory {
    pub runs: Vec<ScheduledRun>,
    pub total: u32,
    pub offset: u32,
}
