//! The folders the user works in, kept as one JSON list. A conversation started in a folder
//! adds it, so a project exists as soon as something was done there.

use std::path::Path;

use fv_protocol::jsonrpc::code;
use fv_protocol::types::{CatalogChanged, ProjectInfo, ProjectListResponse};
use fv_protocol::{ErrorObject, ServerNotification};

use crate::state::ServerState;

const KEY: &str = "app.projects";

fn internal(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}

fn info(path: &str) -> ProjectInfo {
    let name = Path::new(path.trim_end_matches('/'))
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    ProjectInfo {
        path: path.to_string(),
        name,
    }
}

fn read(state: &ServerState) -> Result<Vec<String>, ErrorObject> {
    Ok(state
        .store
        .db
        .get_setting(KEY)
        .map_err(internal)?
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

fn write(state: &ServerState, paths: &[String]) -> Result<(), ErrorObject> {
    let text = serde_json::to_string(paths).map_err(internal)?;
    state
        .store
        .db
        .set_setting(KEY, Some(&text))
        .map_err(internal)
}

pub fn list(state: &ServerState) -> Result<ProjectListResponse, ErrorObject> {
    Ok(ProjectListResponse {
        projects: read(state)?.iter().map(|p| info(p)).collect(),
    })
}

/// Add a folder (a no-op when it is already there). It has to exist and be a directory.
pub fn add(state: &ServerState, path: &str) -> Result<ProjectInfo, ErrorObject> {
    let path = path.trim_end_matches('/');
    if !Path::new(path).is_dir() {
        return Err(ErrorObject::new(
            code::INVALID_PARAMS,
            format!("{path} is not a folder"),
        ));
    }
    let mut paths = read(state)?;
    if !paths.iter().any(|p| p == path) {
        paths.push(path.to_string());
        write(state, &paths)?;
        state.broadcast(ServerNotification::CatalogChanged(CatalogChanged {}));
    }
    Ok(info(path))
}

/// Take a folder off the list. Its conversations stay; they are listed with the plain chats.
pub fn remove(state: &ServerState, path: &str) -> Result<ProjectListResponse, ErrorObject> {
    let path = path.trim_end_matches('/');
    let mut paths = read(state)?;
    paths.retain(|p| p != path);
    write(state, &paths)?;
    state.broadcast(ServerNotification::CatalogChanged(CatalogChanged {}));
    list(state)
}

/// A conversation was started in `path`: it is a project from now on.
pub fn note_used(state: &ServerState, path: &str) {
    if Path::new(path).is_dir() {
        let _ = add(state, path);
    }
}
