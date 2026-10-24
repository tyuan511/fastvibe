//! The projects: a folder (or several) the user works in. One JSON list under one key, each
//! entry its primary folder (the identity), an optional name and the other folders. A
//! conversation started in a folder adds it, so a project exists as soon as something was done
//! there.

use std::path::Path;

use fv_protocol::jsonrpc::code;
use fv_protocol::types::{
    CatalogChanged, ProjectCreateParams, ProjectInfo, ProjectListResponse, ProjectUpdateParams,
};
use fv_protocol::{ErrorObject, ServerNotification};
use serde::{Deserialize, Serialize};

use crate::state::ServerState;

const KEY: &str = "app.projects";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Stored {
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    folders: Vec<String>,
}

/// What an older build wrote: a bare path.
#[derive(Deserialize)]
#[serde(untagged)]
enum Entry {
    Path(String),
    Project(Stored),
}

fn internal(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn folder_name(path: &str) -> String {
    Path::new(path.trim_end_matches('/'))
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn info(p: &Stored) -> ProjectInfo {
    ProjectInfo {
        path: p.path.clone(),
        name: p.name.clone().unwrap_or_else(|| folder_name(&p.path)),
        folders: p.folders.clone(),
    }
}

fn read(state: &ServerState) -> Result<Vec<Stored>, ErrorObject> {
    let Some(text) = state.store.db.get_setting(KEY).map_err(internal)? else {
        return Ok(Vec::new());
    };
    let entries: Vec<Entry> = serde_json::from_str(&text).unwrap_or_default();
    Ok(entries
        .into_iter()
        .map(|e| match e {
            Entry::Path(path) => Stored {
                path,
                name: None,
                folders: Vec::new(),
            },
            Entry::Project(p) => p,
        })
        .collect())
}

fn write(state: &ServerState, projects: &[Stored]) -> Result<(), ErrorObject> {
    let text = serde_json::to_string(projects).map_err(internal)?;
    state
        .store
        .db
        .set_setting(KEY, Some(&text))
        .map_err(internal)
}

fn changed(state: &ServerState) {
    state.broadcast(ServerNotification::CatalogChanged(CatalogChanged {}));
}

pub fn list(state: &ServerState) -> Result<ProjectListResponse, ErrorObject> {
    Ok(ProjectListResponse {
        projects: read(state)?.iter().map(info).collect(),
    })
}

/// Every folder must exist; blanks and repeats are dropped; the first is the primary one.
fn clean_folders(folders: Vec<String>) -> Result<Vec<String>, ErrorObject> {
    let mut out: Vec<String> = Vec::new();
    for folder in folders {
        let folder = folder.trim().trim_end_matches('/').to_string();
        if folder.is_empty() || out.contains(&folder) {
            continue;
        }
        if !Path::new(&folder).is_dir() {
            return Err(invalid(format!("{folder} is not a folder")));
        }
        out.push(folder);
    }
    if out.is_empty() {
        return Err(invalid("a project needs at least one folder"));
    }
    Ok(out)
}

/// A name that is just the folder's own name is not stored: it follows the folder.
fn clean_name(name: Option<String>, primary: &str) -> Option<String> {
    name.map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty() && *n != folder_name(primary))
}

pub fn create(
    state: &ServerState,
    params: ProjectCreateParams,
) -> Result<ProjectInfo, ErrorObject> {
    let mut folders = clean_folders(params.folders)?;
    let path = folders.remove(0);
    let mut projects = read(state)?;
    // A folder that is already a project is that project, not a second one.
    if let Some(existing) = projects.iter().find(|p| p.path == path) {
        return Ok(info(existing));
    }
    let project = Stored {
        name: clean_name(params.name, &path),
        path,
        folders,
    };
    projects.push(project.clone());
    write(state, &projects)?;
    changed(state);
    Ok(info(&project))
}

pub fn update(
    state: &ServerState,
    params: ProjectUpdateParams,
) -> Result<ProjectInfo, ErrorObject> {
    let mut projects = read(state)?;
    let Some(index) = projects.iter().position(|p| p.path == params.path) else {
        return Err(invalid("no such project"));
    };
    let mut folders = clean_folders(params.folders)?;
    let path = folders.remove(0);
    if path != params.path && projects.iter().any(|p| p.path == path) {
        return Err(invalid("that folder is already another project"));
    }
    // The conversations follow the primary folder; each keeps the cwd it was started with.
    if path != params.path {
        for mut thread in state.threads(true)? {
            if thread.project.as_deref() == Some(params.path.as_str()) {
                thread.project = Some(path.clone());
                state.store.db.put_thread(&thread).map_err(internal)?;
            }
        }
    }
    let project = Stored {
        name: clean_name(params.name, &path),
        path,
        folders,
    };
    projects[index] = project.clone();
    write(state, &projects)?;
    changed(state);
    Ok(info(&project))
}

/// Take a project off the list. Its conversations stay; they are listed with the plain chats.
pub fn remove(state: &ServerState, path: &str) -> Result<ProjectListResponse, ErrorObject> {
    let path = path.trim_end_matches('/');
    let mut projects = read(state)?;
    projects.retain(|p| p.path != path);
    write(state, &projects)?;
    changed(state);
    list(state)
}

/// A conversation was started in `path`: it is a project from now on.
pub fn note_used(state: &ServerState, path: &str) {
    if Path::new(path).is_dir() {
        let _ = create(
            state,
            ProjectCreateParams {
                name: None,
                folders: vec![path.to_string()],
            },
        );
    }
}

/// The project a conversation belongs to, if it is listed.
pub fn of_thread(state: &ServerState, project: &str) -> Option<ProjectInfo> {
    read(state)
        .ok()?
        .iter()
        .find(|p| p.path == project)
        .map(info)
}

/// What the model is told when its project has more than one folder: the folders, which one it
/// works in, and that it may use absolute paths for the rest. A single folder says nothing.
pub fn folders_prompt(project: &ProjectInfo, cwd: &str) -> Option<String> {
    if project.folders.is_empty() {
        return None;
    }
    let mut lines = vec![
        "This project includes more than one folder. You may read and modify every folder listed below. Use absolute paths for anything outside the current working directory. Folders can belong to different git repositories; commit inside the repository that owns the files.".to_string(),
        format!("Current working directory: {cwd}"),
        "Folders:".to_string(),
    ];
    for (i, folder) in std::iter::once(&project.path)
        .chain(&project.folders)
        .enumerate()
    {
        let role = if folder == cwd {
            "working directory"
        } else if i == 0 {
            "primary folder"
        } else {
            "additional folder"
        };
        let git = if Path::new(folder).join(".git").exists() {
            "git repository"
        } else {
            "not a git repository"
        };
        lines.push(format!("- {folder} ({role}; {git})"));
    }
    Some(lines.join("\n"))
}
