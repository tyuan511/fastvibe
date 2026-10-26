//! Diagnostics use the same immutable route/configuration as turns, with no conversation,
//! tools runtime, ledger or broadcast side effects.
use crate::state::ServerState;
use fv_protocol::provider_test::*;
use fv_protocol::types::ApiProtocol;
use fv_protocol::{ErrorObject, jsonrpc::code};
use fv_provider::{
    GenaiModel, ModelConfig, ProbeBudget, ProbeError, ProbeReport, ProbeStatus, ProbeTools,
};
use std::sync::Arc;
use std::time::{Duration, Instant};
pub(crate) const CHECK_LIMIT: usize = 4;
#[derive(PartialEq, Eq)]
struct Snapshot {
    config: ModelConfig,
    api: ApiProtocol,
    tokens: u32,
}
fn snapshot(
    state: &ServerState,
    p: &ProviderTestParams,
) -> Result<Snapshot, (Option<ApiProtocol>, ProbeError)> {
    let _lock = state.providers_lock.lock().unwrap();
    let provider = state
        .store
        .db
        .get_provider(&p.provider_id)
        .map_err(|_| (None, ProbeError::Unknown))?
        .filter(|p| p.enabled)
        .ok_or((None, ProbeError::Model))?;
    let model = provider
        .models
        .iter()
        .find(|m| m.id == p.model_id)
        .ok_or((None, ProbeError::Model))?;
    let api = model.protocol.unwrap_or(provider.protocol);
    let key = state
        .store
        .credentials
        .get(&p.provider_id)
        .map_err(|_| (Some(api), ProbeError::Unknown))?
        .filter(|k| !k.trim().is_empty())
        .ok_or((Some(api), ProbeError::Auth))?;
    let catalog = state.catalog.snapshot();
    let meta = crate::providers::with_catalog_meta(&catalog, model);
    let config = crate::providers::model_config(
        &catalog,
        &format!("{}/{}", provider.id, model.id),
        &provider,
        model,
        &key,
        None,
    );
    // Native does not emit the SDK's guessed "thinking off" fields. A declared reasoning model
    // gets the same small 1024-token room as the existing client's guarded side requests.
    let tokens = if meta.reasoning == Some(true) {
        1024
    } else {
        256
    };
    Ok(Snapshot {
        config,
        api,
        tokens,
    })
}
pub async fn run(
    state: &Arc<ServerState>,
    p: ProviderTestParams,
) -> Result<ProviderTestResult, ErrorObject> {
    let _permit = state
        .model_checks
        .clone()
        .try_acquire_owned()
        .map_err(|_| ErrorObject::new(code::OVERLOADED, "too many model checks are running"))?;
    let start = Instant::now();
    let finish = |api, mut result: ProbeReport| {
        result.elapsed_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
        report(p.model_id.clone(), api, result)
    };
    let captured = match snapshot(state, &p) {
        Ok(s) => s,
        Err((api, error)) => return Ok(finish(api, ProbeReport::failed(error))),
    };
    let api = Some(captured.api);
    let mut config = captured.config.clone();
    config.max_retries = 0;
    let build = tokio::task::spawn_blocking(move || GenaiModel::new(config));
    let model = match tokio::time::timeout(Duration::from_secs(5), build).await {
        Ok(Ok(Ok(model))) => model,
        Err(_) => {
            return Ok(finish(api, ProbeReport::failed(ProbeError::Timeout)));
        }
        _ => {
            return Ok(finish(api, ProbeReport::failed(ProbeError::Unknown)));
        }
    };
    let offset = start.elapsed();
    let mut result = model
        .probe(ProbeBudget {
            total: Duration::from_secs(45).saturating_sub(offset),
            output_tokens: captured.tokens,
            ..Default::default()
        })
        .await;
    // A key rotation, endpoint/model edit, disable or deletion cannot label a different
    // configuration as tested. The private comparison includes the key; the result never does.
    if snapshot(state, &p).ok().as_ref() != Some(&captured) {
        result = ProbeReport::failed(ProbeError::Model);
    }
    result.elapsed_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
    if let Some(first) = &mut result.first_token_ms {
        *first = first.saturating_add(offset.as_millis().min(u64::MAX as u128) as u64);
    }
    Ok(finish(api, result))
}
fn report(model: String, api: Option<ApiProtocol>, r: ProbeReport) -> ProviderTestResult {
    ProviderTestResult {
        model,
        api,
        status: match r.status {
            ProbeStatus::Passed => ProviderTestStatus::Passed,
            ProbeStatus::Partial => ProviderTestStatus::Partial,
            ProbeStatus::Failed => ProviderTestStatus::Failed,
        },
        tools: match r.tools {
            ProbeTools::Passed => ProviderTestTools::Passed,
            ProbeTools::Unconfirmed => ProviderTestTools::Unconfirmed,
            ProbeTools::Failed => ProviderTestTools::Failed,
            ProbeTools::NotTested => ProviderTestTools::NotTested,
        },
        first_token_ms: r.first_token_ms,
        elapsed_ms: r.elapsed_ms,
        error_code: r.error.map(|e| match e {
            ProbeError::Auth => ProviderTestError::Auth,
            ProbeError::Protocol => ProviderTestError::Protocol,
            ProbeError::RateLimit => ProviderTestError::RateLimit,
            ProbeError::Network => ProviderTestError::Network,
            ProbeError::Timeout => ProviderTestError::Timeout,
            ProbeError::Model => ProviderTestError::Model,
            ProbeError::Unknown => ProviderTestError::Unknown,
        }),
    }
}
