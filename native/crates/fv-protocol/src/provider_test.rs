use crate::types::ApiProtocol;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderTestParams {
    pub provider_id: String,
    pub model_id: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderTestStatus {
    Passed,
    Partial,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderTestTools {
    Passed,
    Unconfirmed,
    Failed,
    NotTested,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderTestError {
    Auth,
    Protocol,
    RateLimit,
    Network,
    Timeout,
    Model,
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub model: String,
    pub api: Option<ApiProtocol>,
    pub status: ProviderTestStatus,
    pub tools: ProviderTestTools,
    pub first_token_ms: Option<u64>,
    pub elapsed_ms: u64,
    pub error_code: Option<ProviderTestError>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_accept_ids_only_and_serialize_only_safe_result_fields() {
        let valid = serde_json::json!({"providerId":"p","modelId":"m"});
        assert!(serde_json::from_value::<ProviderTestParams>(valid.clone()).is_ok());
        for extra in ["baseUrl", "apiKey", "headers", "prompt"] {
            let mut invalid = valid.clone();
            invalid[extra] = serde_json::json!("not accepted");
            assert!(serde_json::from_value::<ProviderTestParams>(invalid).is_err());
        }
        let r = ProviderTestResult {
            model: "m".into(),
            api: Some(ApiProtocol::Responses),
            status: ProviderTestStatus::Partial,
            tools: ProviderTestTools::Failed,
            first_token_ms: Some(20),
            elapsed_ms: 40,
            error_code: Some(ProviderTestError::RateLimit),
        };
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["errorCode"], "rate-limit");
        assert_eq!(json.as_object().unwrap().len(), 7);
        assert_eq!(
            serde_json::from_value::<ProviderTestResult>(json).unwrap(),
            r
        );
    }
}
