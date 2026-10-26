use crate::state::ServerState;
use fv_protocol::{ErrorObject, jsonrpc::code, types::*};

pub(crate) fn search(
    state: &ServerState,
    params: ThreadSearchParams,
) -> Result<ThreadSearchResponse, ErrorObject> {
    let query = params.query.trim().to_lowercase();
    if query.chars().count() > 256 {
        return Err(ErrorObject::new(
            code::INVALID_PARAMS,
            "search query is limited to 256 characters",
        ));
    }
    let mut hits = Vec::new();
    if query.is_empty() {
        return Ok(ThreadSearchResponse { hits });
    }
    let mut threads = state.threads(params.include_archived)?;
    threads.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    for thread in threads {
        let snippet = match state.loaded_runtime(&thread.id) {
            Some(rt) => rt.search(&query),
            None => state
                .store
                .transcripts
                .search(&thread.id, &query)
                .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?,
        };
        if snippet.is_some()
            || thread.title.to_lowercase().contains(&query)
            || thread
                .project
                .as_ref()
                .is_some_and(|p| p.to_lowercase().contains(&query))
        {
            hits.push(ThreadSearchHit { thread, snippet });
            if hits.len() == 50 {
                break;
            }
        }
    }
    Ok(ThreadSearchResponse { hits })
}
