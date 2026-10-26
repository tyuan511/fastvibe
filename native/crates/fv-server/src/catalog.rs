//! Models.dev lifecycle and public invalidation, independent of conversation catalog changes.
use crate::state::ServerState;
use fv_protocol::catalog::{ModelCatalogInfo, ModelCatalogUpdate};
use fv_protocol::{ErrorObject, ServerNotification, jsonrpc::code, types::Empty};
use std::sync::Arc;

pub fn info(state: &ServerState) -> ModelCatalogInfo {
    let catalog = state.catalog.snapshot();
    let s = catalog.stats();
    ModelCatalogInfo {
        models: s.models,
        aliases: s.aliases,
        generated_at: s.generated_at,
        source: s.source.clone(),
        path: s.path.clone(),
        bundled: s.bundled,
    }
}
pub async fn refresh(state: &Arc<ServerState>) -> Result<ModelCatalogUpdate, ErrorObject> {
    let update = state
        .catalog
        .refresh()
        .await
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e))?;
    let state_for_apply = state.clone();
    let applied_update = update.clone();
    tokio::spawn(async move {
        apply(&state_for_apply, &applied_update).await;
    })
    .await
    .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
    Ok(ModelCatalogUpdate {
        catalog: info(state),
        changed: update.changed,
    })
}
async fn apply(state: &ServerState, update: &fv_provider::CatalogUpdate) {
    let mut applied = state.catalog_applied.lock().await;
    if applied.0 >= update.revision {
        return;
    }
    let signature = state.catalog.snapshot().signature().map(str::to_owned);
    let changed = applied.1 != signature;
    if changed {
        futures_util::future::join_all(
            state
                .loaded_runtimes()
                .iter()
                .map(|rt| rt.refresh_prices(state)),
        )
        .await;
        state.broadcast(ServerNotification::ProvidersChanged(Empty {}));
        state.broadcast(ServerNotification::UsageChanged(Empty {}));
    }
    state.broadcast(ServerNotification::ModelCatalogChanged(Empty {}));
    *applied = (update.revision, signature);
}
pub fn start(state: &Arc<ServerState>) {
    // Completion watcher also applies an update whose last RPC waiter disconnected.
    let mut changes = state.catalog.subscribe();
    let weak = Arc::downgrade(state);
    tokio::spawn(async move {
        while changes.changed().await.is_ok() {
            let update = changes.borrow_and_update().clone();
            let Some(state) = weak.upgrade() else {
                break;
            };
            if let Some(update) = update {
                apply(&state, &update).await;
            }
        }
    });
    let weak = Arc::downgrade(state);
    tokio::spawn(async move {
        loop {
            let delay = match weak.upgrade() {
                Some(state) => state.catalog.delay(crate::state::now_ms().max(0) as u64),
                None => break,
            };
            tokio::time::sleep(delay).await;
            let Some(state) = weak.upgrade() else {
                break;
            };
            // Manual refresh during the wait already bought another hour.
            if !state.catalog.due(crate::state::now_ms().max(0) as u64) {
                continue;
            }
            if let Err(error) = refresh(&state).await {
                eprintln!("models.dev refresh: {}", error.message);
            }
        }
    });
}
