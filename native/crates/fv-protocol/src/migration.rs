//! Explicit, local Electron data migration. Scan is read-only; commit copies a staged snapshot.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ElectronMigrationScanParams {
    /// Absolute Electron userData directory; absent selects this user's standard location.
    #[serde(default)]
    pub source_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MigrationDataset {
    pub name: String,
    pub count: usize,
    /// `import`, `archive`, or `exclude`.
    pub disposition: String,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ElectronMigrationScanResponse {
    pub source_dir: String,
    /// Content identity of the scanned source. Commit rejects a changed source.
    pub fingerprint: String,
    pub datasets: Vec<MigrationDataset>,
    pub warnings: Vec<String>,
    pub already_imported: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ElectronMigrationCommitParams {
    pub source_dir: String,
    pub fingerprint: String,
    /// Keys are copied only when explicitly selected; OAuth/subscription credentials never are.
    #[serde(default)]
    pub include_api_keys: bool,
    /// Explicit conflict choice: replace mapped native preferences with Electron preferences.
    #[serde(default)]
    pub overwrite_settings: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ElectronMigrationResult {
    pub fingerprint: String,
    pub imported_threads: usize,
    pub imported_projects: usize,
    pub imported_providers: usize,
    pub imported_api_keys: usize,
    pub imported_usage: usize,
    pub already_imported: bool,
    /// Private destination containing original non-secret data and the machine-readable report.
    pub archive_dir: String,
    pub datasets: Vec<MigrationDataset>,
    pub warnings: Vec<String>,
}
