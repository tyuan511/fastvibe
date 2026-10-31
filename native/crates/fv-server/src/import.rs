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

mod electron;
pub use electron::{migration_commit, migration_scan};

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
    persist_import(state, imported)
}

fn persist_import(
    state: &ServerState,
    imported: fv_import::ImportedSession,
) -> Result<ThreadStartResponse, ErrorObject> {
    use sha2::{Digest, Sha256};
    let _guard = state.workspace_entries_lock.lock().unwrap();
    if imported.messages.is_empty() || imported.messages.len() != imported.timestamps.len() {
        return Err(invalid("import candidate has no complete conversation"));
    }
    let source_identity = format!(
        "{}\0{}",
        imported.candidate.source, imported.candidate.source_id
    );
    let id = format!("import-{:x}", Sha256::digest(source_identity.as_bytes()));
    if let Some(thread) = state.thread(&id)? {
        return Ok(ThreadStartResponse { thread });
    }
    let cwd = imported
        .candidate
        .cwd
        .clone()
        .filter(|cwd| Path::new(cwd).is_dir());
    let imported_thread = fv_protocol::types::Thread {
        id,
        title: imported.candidate.title,
        cwd,
        project: None,
        source: Some(imported.candidate.source),
        created_at: imported.candidate.created_at,
        updated_at: imported.candidate.updated_at,
        archived: false,
        pinned: false,
        unread: false,
        worktree: None,
        model: None,
        thinking: None,
    };
    let origins = imported
        .messages
        .iter()
        .enumerate()
        .map(|(i, _)| {
            imported
                .origins
                .get(i)
                .and_then(Option::as_ref)
                .map_or_else(
                    || fv_store::UsageOrigin {
                        thread_id: imported_thread.id.clone(),
                        entry_id: format!(
                            "turn:import:{}:{}:{i}",
                            source_identity.len(),
                            source_identity
                        ),
                    },
                    |(session, entry)| electron::request_origin(session, entry),
                )
        })
        .collect::<Vec<_>>();
    let staged_dir =
        tempfile::tempdir().map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
    let staged = fv_store::TranscriptStore::new(staged_dir.path().to_path_buf())
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
    staged
        .append_with_origins(
            &imported_thread.id,
            &imported.messages,
            &imported.timestamps,
            Some(&origins),
        )
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
    let loaded = staged
        .read(&imported_thread.id)
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
    let messages = imported
        .messages
        .iter()
        .map(|m| state.store.images.externalize(&imported_thread.id, m))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
    state
        .store
        .transcripts
        .install_loaded(&imported_thread.id, &loaded, &messages)
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
    state
        .store
        .db
        .put_thread(&imported_thread)
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?;
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
