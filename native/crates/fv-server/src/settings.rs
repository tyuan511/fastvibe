//! The preferences every client shares. One JSON document under one key, so a
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
    read_db(&state.store.db).map_err(internal)
}

pub(crate) fn read_db(db: &fv_store::Db) -> Result<AppSettings, fv_store::StoreError> {
    let stored = db.get_setting(KEY)?;
    Ok(stored
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

pub fn set(state: &ServerState, mut patch: AppSettingsPatch) -> Result<AppSettings, ErrorObject> {
    use fv_protocol::shortcuts::{self, Chord, ShortcutEdit};
    let invalid = |e| ErrorObject::new(code::INVALID_PARAMS, e);
    if patch.shortcuts.is_some() && patch.shortcut.is_some() {
        return Err(invalid("Use either shortcuts or shortcut in one patch"));
    }
    if let Some(overrides) = &patch.shortcuts {
        patch.shortcuts = Some(shortcuts::normalize(overrides).map_err(invalid)?);
    }
    if let Some(ShortcutEdit::Set { binding, .. }) = &mut patch.shortcut {
        *binding = Chord::parse(binding).map_err(invalid)?.serialize();
    }
    let _guard = state.settings_lock.lock().unwrap();
    let mut settings = read(state)?;
    if let Some(expected) = &patch.expected_custom_system_prompt {
        if patch.custom_system_prompt.is_none() {
            return Err(ErrorObject::new(
                code::INVALID_PARAMS,
                "expectedCustomSystemPrompt requires customSystemPrompt",
            ));
        }
        if expected != &settings.custom_system_prompt {
            return Err(ErrorObject::new(
                code::INVALID_PARAMS,
                "The Agent instructions changed in another client. Reload them before saving.",
            ));
        }
    }
    settings.apply(patch);
    write(state, settings)
}

/// The primary folder identifies a sidebar group; carry its preferences with its chats.
pub fn relocate_project(state: &ServerState, old: &str, new: &str) -> Result<(), ErrorObject> {
    let _guard = state.settings_lock.lock().unwrap();
    let mut settings = read(state)?;
    let sidebar = &mut settings.sidebar;
    for paths in [
        &mut sidebar.closed_projects,
        &mut sidebar.expanded_projects,
        &mut sidebar.project_order,
    ] {
        for path in paths.iter_mut() {
            if path == old {
                *path = new.into();
            }
        }
    }
    if let Some(ids) = sidebar.order.remove(&format!("project:{old}")) {
        sidebar.order.insert(format!("project:{new}"), ids);
    }
    write(state, settings)?;
    Ok(())
}

fn write(state: &ServerState, settings: AppSettings) -> Result<AppSettings, ErrorObject> {
    let text = serde_json::to_string(&settings).map_err(internal)?;
    state
        .store
        .db
        .set_setting(KEY, Some(&text))
        .map_err(internal)?;
    state.auto_compaction.store(
        settings.auto_compaction_enabled,
        std::sync::atomic::Ordering::Release,
    );
    state.broadcast(ServerNotification::SettingsChanged(settings.clone()));
    Ok(settings)
}
