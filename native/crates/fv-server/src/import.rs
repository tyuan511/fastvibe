//! Read-only adapters for bringing transcripts from other coding agents into the native client.
//! Scanning and reading never mutate the source or FastVibe's store; a later import commit can
//! use the returned engine messages after the user has selected a candidate.

use std::path::{Path, PathBuf};

use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::{
    ImportCandidate, ImportCommitParams, ImportReadParams, ImportReadResponse, ImportScanParams,
    ImportScanResponse, ThreadStartResponse,
};

use crate::state::ServerState;

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn source_root(source: &str) -> Result<PathBuf, ErrorObject> {
    source_root_in(&home_dir(), source)
}

/// The same mapping, rooted at an explicit home so a test can lay out a store without touching
/// the one the machine is really using.
fn source_root_in(home: &Path, source: &str) -> Result<PathBuf, ErrorObject> {
    let home = home.to_path_buf();
    match source {
        "claude-code" => Ok(home.join(".claude").join("projects")),
        "pi" => Ok(home.join(".pi").join("agent").join("sessions")),
        "codex" => Ok(home.join(".codex")),
        "opencode" => Ok(home.join(".local").join("share").join("opencode")),
        "zcode" => Ok(home.join(".zcode").join("cli").join("db")),
        _ => Err(invalid(format!("unsupported import source: {source}"))),
    }
}

fn source_path(source: &str, source_id: &str) -> Result<PathBuf, ErrorObject> {
    let root = source_root(source)?
        .canonicalize()
        .map_err(|_| invalid("import source directory is unavailable"))?;
    let path = Path::new(source_id)
        .canonicalize()
        .map_err(|_| invalid("import candidate does not exist"))?;
    if !path.starts_with(&root)
        || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
    {
        return Err(invalid(
            "import candidate is outside the source transcript directory",
        ));
    }
    Ok(path)
}

fn candidate(candidate: fv_import::Candidate) -> ImportCandidate {
    ImportCandidate {
        source: candidate.source,
        source_id: candidate.source_id,
        title: candidate.title,
        cwd: candidate.cwd,
        created_at: candidate.created_at,
        updated_at: candidate.updated_at,
        message_count: candidate.message_count,
        bytes: candidate.bytes,
    }
}

pub fn scan(
    _state: &ServerState,
    params: ImportScanParams,
) -> Result<ImportScanResponse, ErrorObject> {
    scan_in(&home_dir(), params)
}

fn scan_in(home: &Path, params: ImportScanParams) -> Result<ImportScanResponse, ErrorObject> {
    let sources = params
        .source
        .as_deref()
        .map(|source| vec![source])
        .unwrap_or_else(|| vec!["claude-code", "pi", "codex", "opencode", "zcode"]);
    let mut candidates = Vec::new();
    for source in sources {
        // One unreadable store must not take the others down with it: an agent that changed
        // its database schema used to fail this whole call, so the panel showed nothing at
        // all — not even the agents whose sessions were perfectly readable.
        let scanned = match source {
            "claude-code" => fv_import::scan_claude(&source_root_in(home, source)?),
            "pi" => fv_import::scan_pi(&source_root_in(home, source)?),
            "codex" => fv_import::scan_codex(&source_root_in(home, source)?),
            "opencode" => {
                fv_import::scan_opencode(&source_root_in(home, source)?.join("opencode.db"))
            }
            "zcode" => fv_import::scan_zcode(&source_root_in(home, source)?.join("db.sqlite")),
            _ => return Err(invalid(format!("unsupported import source: {source}"))),
        };
        match scanned {
            Ok(scanned) => candidates.extend(scanned.into_iter().map(candidate)),
            Err(error) => eprintln!("[import] could not scan {source}: {error}"),
        }
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.updated_at));
    Ok(ImportScanResponse { candidates })
}

pub fn read(
    _state: &ServerState,
    params: ImportReadParams,
) -> Result<ImportReadResponse, ErrorObject> {
    let imported = match params.source.as_str() {
        "claude-code" | "pi" | "codex" => {
            let path = source_path(&params.source, &params.source_id)?;
            match params.source.as_str() {
                "claude-code" => fv_import::read_claude(&path),
                "pi" => fv_import::read_pi(&path),
                "codex" => fv_import::read_codex(&path),
                _ => unreachable!(),
            }
        }
        "opencode" => fv_import::read_opencode(
            &source_root("opencode")?.join("opencode.db"),
            &params.source_id,
        ),
        "zcode" => {
            fv_import::read_zcode(&source_root("zcode")?.join("db.sqlite"), &params.source_id)
        }
        _ => {
            return Err(invalid(format!(
                "unsupported import source: {}",
                params.source
            )));
        }
    }
    .map_err(|error| ErrorObject::new(code::INTERNAL_ERROR, error.to_string()))?;
    let messages = imported
        .messages
        .into_iter()
        .map(|message| {
            serde_json::to_value(message)
                .map_err(|error| ErrorObject::new(code::INTERNAL_ERROR, error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ImportReadResponse {
        candidate: candidate(imported.candidate),
        messages,
        skipped: imported.skipped,
    })
}

pub fn commit(
    state: &ServerState,
    params: ImportCommitParams,
) -> Result<ThreadStartResponse, ErrorObject> {
    let imported = match params.source.as_str() {
        "claude-code" | "pi" | "codex" => {
            let path = source_path(&params.source, &params.source_id)?;
            match params.source.as_str() {
                "claude-code" => fv_import::read_claude(&path),
                "pi" => fv_import::read_pi(&path),
                "codex" => fv_import::read_codex(&path),
                _ => unreachable!(),
            }
        }
        "opencode" => fv_import::read_opencode(
            &source_root("opencode")?.join("opencode.db"),
            &params.source_id,
        ),
        "zcode" => {
            fv_import::read_zcode(&source_root("zcode")?.join("db.sqlite"), &params.source_id)
        }
        _ => {
            return Err(invalid(format!(
                "unsupported import source: {}",
                params.source
            )));
        }
    }
    .map_err(|error| ErrorObject::new(code::INTERNAL_ERROR, error.to_string()))?;
    if imported.messages.is_empty() || imported.messages.len() != imported.timestamps.len() {
        return Err(invalid("import candidate has no complete conversation"));
    }
    let thread = state.create_thread(imported.candidate.cwd.clone(), None, None, None)?;
    if let Err(error) = state.store.transcripts.append_imported(
        &thread.id,
        &imported.messages,
        &imported.timestamps,
        &imported.candidate.source_id,
    ) {
        let _ = state.delete_thread(&thread.id);
        return Err(ErrorObject::new(code::INTERNAL_ERROR, error.to_string()));
    }
    let mut imported_thread = thread.clone();
    imported_thread.title = imported.candidate.title;
    imported_thread.source = Some(imported.candidate.source);
    imported_thread.updated_at = imported_thread
        .created_at
        .max(imported.candidate.updated_at);
    state
        .store
        .db
        .put_thread(&imported_thread)
        .map_err(|error| ErrorObject::new(code::INTERNAL_ERROR, error.to_string()))?;
    state.broadcast(fv_protocol::ServerNotification::CatalogChanged(
        fv_protocol::types::CatalogChanged {},
    ));
    Ok(ThreadStartResponse {
        thread: imported_thread,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_store_that_cannot_be_read_does_not_hide_the_others() {
        let home = tempfile::tempdir().unwrap();
        // An empty file is a valid SQLite database with no tables in it, so scanning it fails
        // the way a store from a future OpenCode release would. That failure used to abort the
        // whole scan, which is why one unreadable agent emptied the panel for all of them.
        let opencode = source_root_in(home.path(), "opencode").unwrap();
        std::fs::create_dir_all(&opencode).unwrap();
        std::fs::write(opencode.join("opencode.db"), b"").unwrap();
        let response = scan_in(
            home.path(),
            ImportScanParams {
                source: Some("opencode".into()),
            },
        )
        .unwrap();
        assert!(response.candidates.is_empty());
    }

    #[test]
    fn every_source_maps_under_the_given_home() {
        let home = Path::new("/home/someone");
        for source in ["claude-code", "pi", "codex", "opencode", "zcode"] {
            let root = source_root_in(home, source).unwrap();
            assert!(
                root.starts_with(home),
                "{source} escaped the home directory"
            );
        }
    }
}
