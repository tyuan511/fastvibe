//! Native official RTC contract. SDP signaling explicitly negotiates this protocol;
//! an Electron App Protocol offer must never become an authenticated native connection.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const RTC_PROTOCOL: &str = "fv-protocol-v1";
pub const RTC_CHANNEL: &str = "fastvibe-native";
pub const RTC_FRAGMENT_BYTES: usize = 16 * 1024;
pub const RTC_MAX_FRAME_BYTES: usize = 24 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum OfficialStatus {
    Off,
    SignedOut,
    Connecting,
    Online,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OfficialPeer {
    pub id: String,
    pub name: String,
    pub platform: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OfficialState {
    pub enabled: bool,
    pub name: String,
    pub status: OfficialStatus,
    pub device_id: Option<String>,
    pub peers: Vec<OfficialPeer>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OfficialConfigureParams {
    pub enabled: bool,
    pub name: String,
}
