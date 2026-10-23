//! Providers and models: what the user configures, and how a conversation's model name turns
//! into something that can be called.
//!
//! A conversation names its model as `provider_id/model_id`. The provider's address and model
//! list are in the database; its key is in `credentials.json` and goes nowhere but into the
//! request made to that provider.

use std::sync::Arc;

use fv_agent::Model;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::*;
use fv_protocol::{ErrorObject, ServerNotification};
use fv_provider::{GenaiModel, ModelConfig, Protocol};
use fv_store::StoredProvider;

use crate::state::ServerState;

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn internal(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}

pub fn to_protocol(p: ApiProtocol) -> Protocol {
    match p {
        ApiProtocol::Chat => Protocol::OpenAiChat,
        ApiProtocol::Responses => Protocol::OpenAiResponses,
        ApiProtocol::Anthropic => Protocol::Anthropic,
        ApiProtocol::Google => Protocol::Google,
    }
}

pub fn thinking_level(l: ThinkingLevel) -> fv_provider::ThinkingLevel {
    use fv_provider::ThinkingLevel as T;
    match l {
        ThinkingLevel::Minimal => T::Minimal,
        ThinkingLevel::Low => T::Low,
        ThinkingLevel::Medium => T::Medium,
        ThinkingLevel::High => T::High,
        ThinkingLevel::Xhigh => T::Xhigh,
        ThinkingLevel::Max => T::Max,
    }
}

fn level_name(l: ThinkingLevel) -> &'static str {
    match l {
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "xhigh",
        ThinkingLevel::Max => "max",
    }
}

fn level_from(name: &str) -> Option<ThinkingLevel> {
    Some(match name {
        "minimal" => ThinkingLevel::Minimal,
        "low" => ThinkingLevel::Low,
        "medium" => ThinkingLevel::Medium,
        "high" => ThinkingLevel::High,
        "xhigh" => ThinkingLevel::Xhigh,
        "max" => ThinkingLevel::Max,
        _ => return None,
    })
}

/// What a clients sees of a stored provider.
fn info(state: &ServerState, p: StoredProvider) -> Result<ProviderInfo, ErrorObject> {
    let has_key = state.store.credentials.has(&p.id).map_err(internal)?;
    Ok(ProviderInfo {
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        base_url: p.base_url,
        has_key,
        enabled: p.enabled,
        models: p.models,
    })
}

pub fn list(state: &ServerState) -> Result<ProviderListResponse, ErrorObject> {
    let providers = state.store.db.list_providers().map_err(internal)?;
    Ok(ProviderListResponse {
        providers: providers
            .into_iter()
            .map(|p| info(state, p))
            .collect::<Result<_, _>>()?,
    })
}

/// `My Relay (EU)` → `my-relay-eu`, made unique among the providers there are.
fn new_id(state: &ServerState, name: &str) -> Result<String, ErrorObject> {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let base = if slug.is_empty() { "provider" } else { slug };
    let taken: Vec<String> = state
        .store
        .db
        .list_providers()
        .map_err(internal)?
        .into_iter()
        .map(|p| p.id)
        .collect();
    let mut id = base.to_string();
    let mut n = 2;
    while taken.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    Ok(id)
}

fn validate_url(url: &str) -> Result<String, ErrorObject> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.len() < 9 {
        return Err(invalid("the base URL must start with http:// or https://"));
    }
    Ok(url.to_string())
}

pub fn upsert(
    state: &ServerState,
    params: ProviderUpsertParams,
) -> Result<ProviderUpsertResponse, ErrorObject> {
    let name = params.name.trim().to_string();
    if name.is_empty() {
        return Err(invalid("the provider needs a name"));
    }
    let base_url = validate_url(&params.base_url)?;
    let mut seen = std::collections::HashSet::new();
    for m in &params.models {
        if m.id.trim().is_empty() {
            return Err(invalid("a model has no id"));
        }
        if !seen.insert(m.id.clone()) {
            return Err(invalid(format!("the model `{}` is listed twice", m.id)));
        }
    }
    let id = match params.id {
        Some(id) => {
            if state
                .store
                .db
                .get_provider(&id)
                .map_err(internal)?
                .is_none()
            {
                return Err(invalid(format!("there is no provider `{id}`")));
            }
            id
        }
        None => new_id(state, &name)?,
    };
    // The key is write-only: absent keeps what is stored, empty clears it.
    match params.api_key.as_deref().map(str::trim) {
        None => {}
        Some("") => state.store.credentials.remove(&id).map_err(internal)?,
        Some(key) => state.store.credentials.set(&id, key).map_err(internal)?,
    }
    let stored = StoredProvider {
        id,
        name,
        protocol: params.protocol,
        base_url,
        enabled: params.enabled,
        models: params.models,
    };
    state.store.db.put_provider(&stored).map_err(internal)?;
    let provider = info(state, stored)?;
    state.broadcast(ServerNotification::ProvidersChanged(Empty {}));
    Ok(ProviderUpsertResponse { provider })
}

pub fn delete(state: &ServerState, id: &str) -> Result<(), ErrorObject> {
    if !state.store.db.delete_provider(id).map_err(internal)? {
        return Err(invalid(format!("there is no provider `{id}`")));
    }
    // The key goes with it, and so does a default that named it.
    state.store.credentials.remove(id).map_err(internal)?;
    let mut defaults = read_defaults(state)?;
    if defaults
        .model
        .as_deref()
        .and_then(|m| m.split_once('/'))
        .is_some_and(|(p, _)| p == id)
    {
        defaults.model = None;
        write_defaults(state, &defaults)?;
    }
    state.broadcast(ServerNotification::ProvidersChanged(Empty {}));
    Ok(())
}

pub fn reorder(state: &ServerState, ids: &[String]) -> Result<ProviderListResponse, ErrorObject> {
    state.store.db.reorder_providers(ids).map_err(internal)?;
    state.broadcast(ServerNotification::ProvidersChanged(Empty {}));
    list(state)
}

pub async fn fetch_models(
    state: &ServerState,
    params: FetchModelsParams,
) -> Result<FetchModelsResponse, ErrorObject> {
    let (protocol, base_url, key) = match params.provider_id {
        Some(id) => {
            let p = state
                .store
                .db
                .get_provider(&id)
                .map_err(internal)?
                .ok_or_else(|| invalid(format!("there is no provider `{id}`")))?;
            // A key typed into the form wins over the stored one, so a changed key can be tried first.
            let key = match params.api_key.filter(|k| !k.trim().is_empty()) {
                Some(k) => k,
                None => state
                    .store
                    .credentials
                    .get(&id)
                    .map_err(internal)?
                    .unwrap_or_default(),
            };
            (p.protocol, params.base_url.unwrap_or(p.base_url), key)
        }
        None => (
            params
                .protocol
                .ok_or_else(|| invalid("say which protocol the provider speaks"))?,
            params
                .base_url
                .ok_or_else(|| invalid("say the provider's base URL"))?,
            params.api_key.unwrap_or_default(),
        ),
    };
    let base_url = validate_url(&base_url)?;
    let fetched = fv_provider::fetch_models(to_protocol(protocol), &base_url, &key)
        .await
        .map_err(invalid)?;
    let models = fetched
        .into_iter()
        .map(|m| ModelInfo {
            protocol: None,
            supports_images: true,
            context_window: None,
            max_output_tokens: None,
            name: m.name,
            id: m.id,
        })
        .collect();
    Ok(FetchModelsResponse { models })
}

pub fn model_list(state: &ServerState) -> Result<ModelListResponse, ErrorObject> {
    let mut models = Vec::new();
    for p in state.store.db.list_providers().map_err(internal)? {
        if !p.enabled || !state.store.credentials.has(&p.id).map_err(internal)? {
            continue;
        }
        for m in &p.models {
            models.push(ModelEntry {
                provider_id: p.id.clone(),
                provider_name: p.name.clone(),
                label: format!("{}/{}", p.id, m.id),
                model: m.clone(),
            });
        }
    }
    Ok(ModelListResponse { models })
}

const DEFAULT_MODEL: &str = "default_model";
const DEFAULT_THINKING: &str = "default_thinking";

pub fn read_defaults(state: &ServerState) -> Result<ModelDefaults, ErrorObject> {
    let model = state
        .store
        .db
        .get_setting(DEFAULT_MODEL)
        .map_err(internal)?;
    let thinking = state
        .store
        .db
        .get_setting(DEFAULT_THINKING)
        .map_err(internal)?
        .and_then(|s| level_from(&s));
    Ok(ModelDefaults { model, thinking })
}

fn write_defaults(state: &ServerState, d: &ModelDefaults) -> Result<(), ErrorObject> {
    state
        .store
        .db
        .set_setting(DEFAULT_MODEL, d.model.as_deref())
        .map_err(internal)?;
    state
        .store
        .db
        .set_setting(DEFAULT_THINKING, d.thinking.map(level_name))
        .map_err(internal)?;
    Ok(())
}

pub fn set_defaults(state: &ServerState, d: ModelDefaults) -> Result<ModelDefaults, ErrorObject> {
    if let Some(label) = &d.model {
        resolve(state, label, None).map_err(invalid)?;
    }
    write_defaults(state, &d)?;
    state.broadcast(ServerNotification::ProvidersChanged(Empty {}));
    Ok(d)
}

/// Whether the server has any provider configured; without one, the model the server was
/// started with (a command-line one, or a test's) is what every conversation uses.
pub fn any_configured(state: &ServerState) -> bool {
    state
        .store
        .db
        .list_providers()
        .map(|p| !p.is_empty())
        .unwrap_or(false)
}

/// Turn `provider_id/model_id` into a model that can be called, or say why it cannot.
pub fn resolve(
    state: &ServerState,
    label: &str,
    thinking: Option<ThinkingLevel>,
) -> Result<Arc<dyn Model>, String> {
    let (provider_id, model_id) = label
        .split_once('/')
        .ok_or_else(|| format!("`{label}` is not a model name (expected provider/model)"))?;
    let provider = state
        .store
        .db
        .get_provider(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!("The provider `{provider_id}` no longer exists. Choose another model.")
        })?;
    if !provider.enabled {
        return Err(format!("The provider `{}` is turned off.", provider.name));
    }
    let model = provider
        .models
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| {
            format!(
                "`{}` has no model `{model_id}`. Choose another model.",
                provider.name
            )
        })?;
    let key = state
        .store
        .credentials
        .get(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!(
                "`{}` has no API key. Add one in its settings.",
                provider.name
            )
        })?;
    let protocol = match model.protocol {
        Some(p) => to_protocol(p),
        None => fv_provider::infer_protocol(&model.id, to_protocol(provider.protocol)),
    };
    let mut config = ModelConfig::new(label, &model.id, protocol, &provider.base_url, &key);
    config.thinking = thinking.map(thinking_level);
    config.max_output_tokens = model.max_output_tokens;
    config.images = model.supports_images;
    config.context_window = model.context_window;
    GenaiModel::new(config)
        .map(|m| Arc::new(m) as Arc<dyn Model>)
        .map_err(|e| e.message)
}

/// The model and thinking level a conversation's next turn uses, or the reason it has none.
pub fn model_for(state: &ServerState, thread: &Thread) -> Arc<dyn Model> {
    use fv_agent::testing::FailingModel;
    let defaults = read_defaults(state).unwrap_or_default();
    let label = thread.model.clone().or(defaults.model);
    let thinking = thread.thinking.or(defaults.thinking);
    match label {
        Some(label) => match resolve(state, &label, thinking) {
            Ok(m) => m,
            Err(message) => Arc::new(FailingModel(message)),
        },
        // Nothing chosen. With no providers at all the server's own model is used (the
        // command-line one); with providers, the user has to pick.
        None if any_configured(state) => Arc::new(FailingModel(
            "No model is selected. Choose one for this conversation, or set a default.".into(),
        )),
        None => state.agent.model.clone(),
    }
}

/// Set (or clear) a conversation's model.
pub fn set_thread_model(
    state: &ServerState,
    params: ThreadModelParams,
) -> Result<Thread, ErrorObject> {
    let mut thread = state
        .thread(&params.thread_id)?
        .ok_or_else(|| invalid("thread not found"))?;
    if let Some(label) = &params.model {
        resolve(state, label, None).map_err(invalid)?;
    }
    thread.model = params.model;
    thread.thinking = params.thinking;
    state.store.db.put_thread(&thread).map_err(internal)?;
    state.broadcast(ServerNotification::CatalogChanged(CatalogChanged {}));
    Ok(thread)
}

/// How full a thread's context window is, for a client that has just opened it.
pub fn token_usage(state: &ServerState, thread: &Thread, thread_id: &str) -> Option<TokenUsage> {
    let model = model_for(state, thread);
    let history = state.runtime(thread_id).history();
    let used = fv_agent::context_used(&history);
    (used > 0).then(|| TokenUsage {
        used,
        window: fv_agent::context_window(model.as_ref()),
    })
}
