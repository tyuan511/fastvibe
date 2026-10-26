use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogInfo {
    pub models: usize,
    pub aliases: usize,
    pub generated_at: u64,
    pub source: String,
    pub path: String,
    pub bundled: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModelCatalogUpdate {
    pub catalog: ModelCatalogInfo,
    pub changed: bool,
}
