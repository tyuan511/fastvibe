use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum UsageRange {
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
    #[serde(rename = "90d")]
    Quarter,
    #[default]
    #[serde(rename = "365d")]
    Year,
    #[serde(rename = "all")]
    All,
}
fn utc() -> String {
    "UTC".into()
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageParams {
    #[serde(default)]
    pub range: UsageRange,
    /// IANA zone of the viewing client; historical DST is applied per timestamp.
    #[serde(default = "utc")]
    pub timezone: String,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageMetrics {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub tokens: u64,
    pub requests: u64,
    pub tool_calls: u64,
    /// USD at current catalog rates. None means unpriced, rather than free.
    pub cost: Option<f64>,
    pub unpriced_requests: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UsageDay {
    pub date: String,
    #[serde(flatten)]
    pub metrics: UsageMetrics,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    #[serde(flatten)]
    pub metrics: UsageMetrics,
    pub active_days: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageModel {
    pub provider: String,
    pub provider_name: Option<String>,
    pub model: String,
    #[serde(flatten)]
    pub metrics: UsageMetrics,
    pub days: Vec<UsageDay>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageConversation {
    pub session_id: String,
    pub thread_id: Option<String>,
    pub title: Option<String>,
    pub project: Option<String>,
    #[serde(flatten)]
    pub metrics: UsageMetrics,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub range: UsageRange,
    pub timezone: String,
    pub from: String,
    pub to: String,
    pub totals: UsageTotals,
    pub days: Vec<UsageDay>,
    pub models: Vec<UsageModel>,
    pub conversations: Vec<UsageConversation>,
    pub sessions: u64,
    pub longest_session_minutes: f64,
    pub current_streak: u64,
    pub longest_streak: u64,
    pub invalid_timestamps: u64,
}
