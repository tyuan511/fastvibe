//! Read-only adapters for bringing transcripts from other coding agents into the native client.
//! Scanning and reading never mutate the source or FastVibe's store; a later import commit can
//! use the returned engine messages after the user has selected a candidate.

use std::path::{Path, PathBuf};

use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::{
    ImportCandidate, ImportReadParams, ImportReadResponse, ImportScanParams, ImportScanResponse,
};

use crate::state::ServerState;

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, message)
}

fn claude_root() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("projects")
}

fn source_path(source: &str, source_id: &str) -> Result<PathBuf, ErrorObject> {
    if source != "claude-code" {
        return Err(invalid(format!("unsupported import source: {source}")));
    }
    let root = claude_root()
        .canonicalize()
        .map_err(|_| invalid("Claude Code project directory is unavailable"))?;
    let path = Path::new(source_id)
        .canonicalize()
        .map_err(|_| invalid("import candidate does not exist"))?;
    if !path.starts_with(&root)
        || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
    {
        return Err(invalid(
            "import candidate is outside the Claude Code transcript directory",
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
    if let Some(source) = params.source.as_deref()
        && source != "claude-code"
    {
        return Err(invalid(format!("unsupported import source: {source}")));
    }
    let candidates = fv_import::scan_claude(&claude_root())
        .map_err(|error| ErrorObject::new(code::INTERNAL_ERROR, error.to_string()))?
        .into_iter()
        .map(candidate)
        .collect();
    Ok(ImportScanResponse { candidates })
}

pub fn read(
    _state: &ServerState,
    params: ImportReadParams,
) -> Result<ImportReadResponse, ErrorObject> {
    let path = source_path(&params.source, &params.source_id)?;
    let imported = fv_import::read_claude(&path)
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
