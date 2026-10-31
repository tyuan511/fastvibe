//! Native remote management and bounded file transfer, shared by every transport.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfigureParams {
    pub enabled: bool,
    pub port: u16,
    #[serde(default)]
    pub name: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RemotePasswordParams {
    pub password: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRevokeParams {
    pub device_id: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RemoteDevice {
    pub id: String,
    pub label: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub port: u16,
    pub listening: bool,
    pub password_configured: bool,
    pub devices: Vec<RemoteDevice>,
    pub name: String,
    pub install_id: String,
    /// Listener origins, suitable for building a QR code. Never contains credentials.
    pub addresses: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileParams {
    pub thread_id: String,
    pub path: String,
    pub offset: u64,
    /// Zero requests metadata only; at most 512 KiB per call.
    pub length: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub size: u64,
    pub mtime_ms: u64,
    pub offset: u64,
    pub data: String,
    pub eof: bool,
}
