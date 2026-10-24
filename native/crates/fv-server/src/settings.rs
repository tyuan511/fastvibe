//! The settings every client shares: how the app looks. One JSON document under one key, so a
//! field added later needs no migration (a missing one reads as its default).

use fv_protocol::jsonrpc::code;
use fv_protocol::types::{AppSettings, AppSettingsPatch};
use fv_protocol::{ErrorObject, ServerNotification};

use crate::state::ServerState;

const KEY: &str = "app.settings";

fn internal(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}

pub fn read(state: &ServerState) -> Result<AppSettings, ErrorObject> {
    let stored = state.store.db.get_setting(KEY).map_err(internal)?;
    Ok(stored
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

pub fn set(state: &ServerState, patch: AppSettingsPatch) -> Result<AppSettings, ErrorObject> {
    let mut settings = read(state)?;
    settings.apply(patch);
    let text = serde_json::to_string(&settings).map_err(internal)?;
    state
        .store
        .db
        .set_setting(KEY, Some(&text))
        .map_err(internal)?;
    state.broadcast(ServerNotification::SettingsChanged(settings.clone()));
    Ok(settings)
}
