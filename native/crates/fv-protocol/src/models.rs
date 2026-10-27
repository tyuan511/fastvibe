//! Model capabilities shared by editing, menus and request resolution.
use crate::types::{ApiProtocol, ModelInfo, ThinkingLevel};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ModelInput {
    Text,
    Image,
    Video,
    File,
}
impl Default for ModelInfo {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: None,
            protocol: None,
            supports_images: true,
            web_search: false,
            context_window: None,
            max_output_tokens: None,
            edited: false,
            reasoning: None,
            input: None,
            thinking_levels: None,
        }
    }
}
impl ThinkingLevel {
    pub const ALL: [Self; 6] = [
        Self::Minimal,
        Self::Low,
        Self::Medium,
        Self::High,
        Self::Xhigh,
        Self::Max,
    ];
}
impl ModelInfo {
    pub fn allowed_thinking(&self) -> Vec<ThinkingLevel> {
        if self.reasoning == Some(false) {
            return Vec::new();
        }
        let fallback = if self.reasoning == Some(true) {
            vec![
                ThinkingLevel::Low,
                ThinkingLevel::Medium,
                ThinkingLevel::High,
            ]
        } else {
            ThinkingLevel::ALL.to_vec()
        };
        let mut levels = self.thinking_levels.clone().unwrap_or(fallback);
        levels.sort();
        levels.dedup();
        levels
    }
    /// Same clamp as the existing SDK: nearest supported level upward, then downward. The
    /// absence of an explicit request leaves the model alone; it never asks to disable thought.
    pub fn effective_thinking(&self, requested: Option<ThinkingLevel>) -> Option<ThinkingLevel> {
        let requested = requested?;
        let allowed = self.allowed_thinking();
        allowed
            .iter()
            .copied()
            .find(|l| *l >= requested)
            .or_else(|| allowed.last().copied())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelParams {
    pub provider_id: String,
    pub model_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelUpdateParams {
    pub provider_id: String,
    pub model_id: String,
    pub expected: ModelInfo,
    /// None restores catalog defaults; Some saves a complete tuned model without changing id.
    pub model: Option<ModelInfo>,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelPriceTier {
    pub over: u64,
    pub price: ModelPrice,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelDetail {
    pub model: ModelInfo,
    pub provider_protocol: ApiProtocol,
    pub price: Option<ModelPrice>,
    pub price_tiers: Vec<ModelPriceTier>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn effort_choices_and_clamps_follow_declared_capabilities_without_disabling_thought() {
        use ThinkingLevel::*;
        let model = ModelInfo {
            reasoning: Some(true),
            thinking_levels: Some(vec![High, Low, High]),
            ..Default::default()
        };
        assert_eq!(model.allowed_thinking(), vec![Low, High]);
        for (requested, expected) in [
            (Minimal, Low),
            (Low, Low),
            (Medium, High),
            (High, High),
            (Xhigh, High),
            (Max, High),
        ] {
            assert_eq!(model.effective_thinking(Some(requested)), Some(expected));
        }
        assert_eq!(model.effective_thinking(None), None);
        let disabled = ModelInfo {
            reasoning: Some(false),
            ..model.clone()
        };
        assert!(disabled.allowed_thinking().is_empty());
        assert_eq!(disabled.effective_thinking(Some(Max)), None);
        assert!(
            ModelInfo {
                thinking_levels: Some(vec![]),
                ..Default::default()
            }
            .allowed_thinking()
            .is_empty()
        );
        assert_eq!(ModelInfo::default().allowed_thinking(), ThinkingLevel::ALL);
    }
    #[test]
    fn old_records_remain_readable_and_edits_roundtrip_without_a_price_override() {
        let old: ModelInfo =
            serde_json::from_value(serde_json::json!({"id":"m","name":null,"contextWindow":64000}))
                .unwrap();
        assert!(!old.edited && old.supports_images && old.reasoning.is_none());
        let update = ProviderModelUpdateParams {
            provider_id: "p".into(),
            model_id: "m".into(),
            expected: old.clone(),
            model: Some(ModelInfo {
                id: "m".into(),
                edited: true,
                reasoning: Some(true),
                input: Some(vec![ModelInput::Text, ModelInput::File]),
                thinking_levels: Some(vec![ThinkingLevel::Max]),
                ..old
            }),
        };
        let json = serde_json::to_value(&update).unwrap();
        assert_eq!(json["model"]["edited"], true);
        assert!(json["model"].get("cost").is_none());
        assert_eq!(
            serde_json::from_value::<ProviderModelUpdateParams>(json).unwrap(),
            update
        );
        assert!(serde_json::from_value::<ThinkingLevel>(serde_json::json!("off")).is_err());
    }
}
