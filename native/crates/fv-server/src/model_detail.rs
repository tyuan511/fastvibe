//! Per-model edits replace one row under the provider lock. Secrets are never part of this API.
use crate::state::ServerState;
use fv_protocol::models::*;
use fv_protocol::types::*;
use fv_protocol::{ErrorObject, ServerNotification, jsonrpc::code};
use fv_provider::{Catalog, InputModality};
fn invalid(s: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, s)
}
fn internal(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}
fn modality(m: InputModality) -> ModelInput {
    match m {
        InputModality::Text => ModelInput::Text,
        InputModality::Image => ModelInput::Image,
        InputModality::Video => ModelInput::Video,
        InputModality::File => ModelInput::File,
    }
}
fn level(l: fv_provider::ThinkingLevel) -> ThinkingLevel {
    use fv_provider::ThinkingLevel as T;
    match l {
        T::Minimal => ThinkingLevel::Minimal,
        T::Low => ThinkingLevel::Low,
        T::Medium => ThinkingLevel::Medium,
        T::High => ThinkingLevel::High,
        T::Xhigh => ThinkingLevel::Xhigh,
        T::Max => ThinkingLevel::Max,
    }
}
/// Older native builds inferred protocols at request time without storing the pin. Capture
/// that existing route once, before explicit inheritance becomes meaningful. This is idempotent
/// across an interrupted startup; a new install marks its empty list before accepting providers.
pub fn migrate_protocols(store: &fv_store::Store) -> Result<(), fv_store::StoreError> {
    const KEY: &str = "model_detail_protocol_v1";
    if store.db.get_setting(KEY)?.is_some() {
        return Ok(());
    }
    for mut provider in store.db.list_providers()? {
        let mut changed = false;
        if matches!(
            provider.protocol,
            ApiProtocol::Chat | ApiProtocol::Responses
        ) {
            for model in &mut provider.models {
                if !model.edited
                    && model.protocol.is_none()
                    && let Some(protocol) = automatic_protocol(&model.id, provider.protocol)
                {
                    model.protocol = Some(protocol);
                    changed = true;
                }
            }
        }
        if changed {
            store.db.put_provider(&provider)?;
        }
    }
    store.db.set_setting(KEY, Some("1"))?;
    Ok(())
}

pub fn hydrate(catalog: &Catalog, model: &ModelInfo) -> ModelInfo {
    if model.edited {
        return model.clone();
    }
    if let Some(meta) = catalog.describe(&model.id) {
        ModelInfo {
            name: model
                .name
                .clone()
                .or_else(|| catalog.entry(&model.id).map(|e| e.name.clone())),
            supports_images: meta.input.contains(&InputModality::Image),
            context_window: Some(meta.context_window),
            max_output_tokens: Some(meta.max_tokens),
            reasoning: Some(meta.reasoning),
            input: Some(meta.input.iter().copied().map(modality).collect()),
            thinking_levels: Some(meta.thinking_levels.iter().copied().map(level).collect()),
            ..model.clone()
        }
    } else {
        ModelInfo {
            context_window: Some(model.context_window.unwrap_or(128_000)),
            max_output_tokens: Some(model.max_output_tokens.unwrap_or(8_192)),
            input: model.input.clone().or_else(|| {
                Some(if model.supports_images {
                    vec![ModelInput::Text, ModelInput::Image]
                } else {
                    vec![ModelInput::Text]
                })
            }),
            ..model.clone()
        }
    }
}
pub fn automatic_protocol(id: &str, provider: ApiProtocol) -> Option<ApiProtocol> {
    let inferred = fv_provider::infer_protocol(id, crate::providers::to_protocol(provider));
    let p = match inferred {
        fv_provider::Protocol::OpenAiChat => ApiProtocol::Chat,
        fv_provider::Protocol::OpenAiResponses => ApiProtocol::Responses,
        fv_provider::Protocol::Anthropic => ApiProtocol::Anthropic,
        fv_provider::Protocol::Google => ApiProtocol::Google,
    };
    (p != provider).then_some(p)
}
pub fn fresh(catalog: &Catalog, id: &str, provider: ApiProtocol) -> ModelInfo {
    hydrate(
        catalog,
        &ModelInfo {
            id: id.into(),
            protocol: automatic_protocol(id, provider),
            supports_images: false,
            reasoning: Some(false),
            thinking_levels: Some(Vec::new()),
            ..Default::default()
        },
    )
}
/// All validation happens before writing keys or replacing a provider. Legacy partial models
/// remain accepted; edited models must carry the complete metadata the editor promises.
pub fn normalize(mut m: ModelInfo) -> Result<ModelInfo, ErrorObject> {
    if m.id.trim().is_empty() || m.id.trim() != m.id {
        return Err(invalid(
            "a model id must be nonempty and have no surrounding spaces",
        ));
    }
    for (name, n) in [
        ("context window", m.context_window),
        ("output limit", m.max_output_tokens),
    ] {
        if n == Some(0) || (m.edited && n.is_none()) {
            return Err(invalid(format!("{name} must be a positive integer")));
        }
    }
    m.name = m
        .name
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty());
    if m.edited && (m.reasoning.is_none() || m.input.is_none()) {
        return Err(invalid(
            "edited models need reasoning and input capabilities",
        ));
    }
    if let Some(input) = &mut m.input {
        let order = [
            ModelInput::Text,
            ModelInput::Image,
            ModelInput::Video,
            ModelInput::File,
        ];
        *input = order
            .into_iter()
            .filter(|v| *v == ModelInput::Text || input.contains(v))
            .collect();
        m.supports_images = input.contains(&ModelInput::Image);
    }
    if let Some(levels) = &mut m.thinking_levels {
        levels.sort();
        levels.dedup();
    }
    if m.reasoning == Some(false) {
        m.thinking_levels = Some(Vec::new());
    }
    if m.reasoning == Some(true)
        && (m.thinking_levels.as_ref().is_some_and(Vec::is_empty)
            || (m.edited && m.thinking_levels.is_none()))
    {
        return Err(invalid(
            "a reasoning model needs at least one thinking level",
        ));
    }
    if m.edited && m.name.is_none() {
        m.name = Some(m.id.clone());
    }
    Ok(m)
}
fn detail(catalog: &Catalog, model: ModelInfo, provider_protocol: ApiProtocol) -> ModelDetail {
    let price = |p: &fv_provider::Price| ModelPrice {
        input: p.input,
        output: p.output,
        cache_read: p.cache_read,
        cache_write: p.cache_write,
    };
    let (base, tiers) = catalog
        .price(&model.id)
        .map(|(p, t)| {
            (
                Some(price(p)),
                t.iter()
                    .map(|t| ModelPriceTier {
                        over: t.over,
                        price: price(&t.price),
                    })
                    .collect(),
            )
        })
        .unwrap_or_default();
    ModelDetail {
        model: hydrate(catalog, &model),
        provider_protocol,
        price: base,
        price_tiers: tiers,
    }
}
pub fn get(state: &ServerState, p: ProviderModelParams) -> Result<ModelDetail, ErrorObject> {
    let provider = state
        .store
        .db
        .get_provider(&p.provider_id)
        .map_err(internal)?
        .ok_or_else(|| invalid("provider no longer exists"))?;
    let model = provider
        .models
        .into_iter()
        .find(|m| m.id == p.model_id)
        .ok_or_else(|| invalid("model no longer exists"))?;
    Ok(detail(&state.catalog.snapshot(), model, provider.protocol))
}
pub fn update(
    state: &ServerState,
    p: ProviderModelUpdateParams,
) -> Result<ModelDetail, ErrorObject> {
    let _lock = state.providers_lock.lock().unwrap();
    let catalog = state.catalog.snapshot();
    let mut provider = state
        .store
        .db
        .get_provider(&p.provider_id)
        .map_err(internal)?
        .ok_or_else(|| invalid("provider no longer exists"))?;
    let model = provider
        .models
        .iter_mut()
        .find(|m| m.id == p.model_id)
        .ok_or_else(|| invalid("model no longer exists"))?;
    if hydrate(&catalog, model) != p.expected {
        return Err(invalid(
            "model changed elsewhere; reload its details before saving",
        ));
    }
    let next = match p.model {
        Some(mut next) => {
            if next.id != p.model_id {
                return Err(invalid("editing a model cannot change its id"));
            }
            next.edited = true;
            normalize(next)?
        }
        None => fresh(&catalog, &p.model_id, provider.protocol),
    };
    *model = next.clone();
    state.store.db.put_provider(&provider).map_err(internal)?;
    state.broadcast(ServerNotification::ProvidersChanged(Empty {}));
    Ok(detail(&catalog, next, provider.protocol))
}
