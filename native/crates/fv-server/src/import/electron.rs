//! Source-preserving Electron migration, separate from other-agent transcript import.
use crate::state::ServerState;
use fv_import::electron::Snapshot;
use fv_protocol::{ErrorObject, jsonrpc::code, migration::*, types::*};
use fv_store::{StoredProvider, UsageOrigin, UsageRecord};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

fn error(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INTERNAL_ERROR, e.to_string())
}
fn invalid(e: impl Into<String>) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, e)
}
fn default_source() -> PathBuf {
    let home = super::home_dir();
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/FastVibe")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join("FastVibe")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("FastVibe")
    }
}
fn load(state: &ServerState, path: &Path) -> Result<Snapshot, ErrorObject> {
    if !path.is_absolute() {
        return Err(invalid("sourceDir must be absolute"));
    }
    let source = path.canonicalize().map_err(error)?;
    let target = state.data_dir.canonicalize().map_err(error)?;
    if source.starts_with(&target) || target.starts_with(&source) {
        return Err(invalid(
            "Source and native data directories must be separate",
        ));
    }
    let snapshot = fv_import::electron::snapshot(&source).map_err(error)?;
    for (name, rows) in &snapshot.tables {
        for row in rows {
            if let Some(data) = row.get("data").and_then(Value::as_str) {
                serde_json::from_str::<Value>(data).map_err(|_| {
                    invalid(format!(
                        "Invalid source JSON in {name}; repair source or export before migration"
                    ))
                })?;
            }
        }
    }
    for name in [
        "settings.json",
        "providers.json",
        "conversations.json",
        "checkpoints.json",
        "dag.json",
        "message-queue.json",
        "scheduled-tasks.json",
    ] {
        if let Some(bytes) = snapshot.files.get(name) {
            serde_json::from_slice::<Value>(bytes).map_err(|_| {
                invalid(format!(
                    "Invalid source JSON in {name}; repair source or export before migration"
                ))
            })?;
        }
    }
    Ok(snapshot)
}
fn fingerprint(snapshot: &Snapshot) -> String {
    let mut hash = Sha256::new();
    hash.update(snapshot.root.to_string_lossy().as_bytes());
    hash.update(Sha256::digest(&snapshot.api_keys));
    hash.update(serde_json::to_vec(&snapshot.tables).expect("JSON tables"));
    for (path, bytes) in &snapshot.files {
        hash.update(path.as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    format!("{:x}", hash.finalize())
}
fn rows(snapshot: &Snapshot, table: &str) -> Vec<Value> {
    snapshot
        .tables
        .get(table)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            row.get("data")
                .and_then(Value::as_str)
                .and_then(|data| serde_json::from_str(data).ok())
        })
        .collect()
}
fn json_file(snapshot: &Snapshot, name: &str) -> Value {
    snapshot
        .files
        .get(name)
        .and_then(|bytes| serde_json::from_slice(bytes).ok())
        .unwrap_or(Value::Null)
}
fn catalog(snapshot: &Snapshot, table: &str) -> Vec<Value> {
    if snapshot.tables.contains_key(table) {
        return rows(snapshot, table);
    }
    let legacy = json_file(snapshot, "conversations.json");
    legacy
        .get(table)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
fn datasets(snapshot: &Snapshot) -> Vec<MigrationDataset> {
    let mut out=vec![
        MigrationDataset{name:"conversations".into(),count:catalog(snapshot,"conversations").len(),disposition:"import".into(),detail:"Active pi transcript branch, original metadata and full transcript archived".into()},
        MigrationDataset{name:"projects".into(),count:catalog(snapshot,"projects").len(),disposition:"import".into(),detail:"Local folders and names; remote bindings archived".into()},
        MigrationDataset{name:"settings".into(),count:usize::from(snapshot.files.contains_key("settings.json")),disposition:"import".into(),detail:"Mapped preferences imported with explicit overwrite choice; existing native settings kept by default; full source archived".into()},
        MigrationDataset{name:"providers".into(),count:json_file(snapshot,"providers.json")["providers"].as_array().map_or(0,Vec::len),disposition:"import".into(),detail:"Custom endpoints only; API keys require explicit selection".into()},
        MigrationDataset{name:"subscriptionCredentials".into(),count:0,disposition:"exclude".into(),detail:"OAuth, account, subscription tokens and remote credentials are never read or copied".into()},
    ];
    for name in [
        "checkpoints",
        "checkpoint_files",
        "dag_graphs",
        "dag_nodes",
        "queue_items",
        "queue_state",
        "scheduled_tasks",
        "scheduled_runs",
        "reasoning_blocks",
        "memory_outputs",
        "memory_empty",
        "memory_failures",
        "memory_meta",
    ] {
        if let Some(data) = snapshot.tables.get(name) {
            out.push(MigrationDataset {
                name: name.into(),
                count: data.len(),
                disposition: "archive".into(),
                detail: "Preserved as source rows; not activated in native runtime".into(),
            });
        }
    }
    for name in [
        "checkpoints.json",
        "dag.json",
        "message-queue.json",
        "scheduled-tasks.json",
    ] {
        if snapshot.files.contains_key(name) {
            out.push(MigrationDataset {
                name: name.into(),
                count: 1,
                disposition: "archive".into(),
                detail: "Legacy state preserved without executing pending work".into(),
            });
        }
    }
    out.push(MigrationDataset {
        name: "usage".into(),
        count: snapshot
            .files
            .get("runtime/engine/usage-ledger.jsonl")
            .map_or(0, |b| {
                b.split(|c| *c == b'\n').filter(|l| !l.is_empty()).count()
            }),
        disposition: "import".into(),
        detail: "Original session and entry identities deduplicate ledger, transcripts and forks"
            .into(),
    });
    for (name, rows) in &snapshot.tables {
        if !out.iter().any(|dataset| dataset.name == *name) {
            out.push(MigrationDataset {
                name: name.clone(),
                count: rows.len(),
                disposition: "archive".into(),
                detail: "Original source rows preserved; not activated".into(),
            });
        }
    }
    out.push(MigrationDataset{name:"images".into(),count:snapshot.files.keys().filter(|path|path.starts_with("runtime/engine/tool-images/")).count(),disposition:"archive".into(),detail:"Full external and inline source images archived; tool images also copied into native history. User-image messages have no native representation".into()});
    out
}
fn namespace_key(namespace: &str) -> String {
    format!(
        "migration.electron.namespace:{}",
        stable(namespace, "source")
    )
}
fn operation_key(id: &str, keys: bool) -> String {
    format!(
        "migration.electron.operation:{id}:{}",
        if keys { "keys" } else { "data" }
    )
}

fn result_key(id: &str) -> String {
    format!("migration.electron.{id}")
}
fn previous(state: &ServerState, id: &str) -> Result<Option<ElectronMigrationResult>, ErrorObject> {
    state
        .store
        .db
        .get_setting(&result_key(id))
        .map_err(error)?
        .map(|text| serde_json::from_str(&text).map_err(error))
        .transpose()
}
pub fn migration_scan(
    state: &ServerState,
    params: ElectronMigrationScanParams,
) -> Result<ElectronMigrationScanResponse, ErrorObject> {
    let snapshot = load(
        state,
        &params
            .source_dir
            .map(PathBuf::from)
            .unwrap_or_else(default_source),
    )?;
    let id = fingerprint(&snapshot);
    let mut warnings=vec!["Checkpoint, DAG, queue and schedule state is archived, never run. Unsupported settings and original transcripts remain in the archive.".into()];
    if state
        .store
        .db
        .get_setting(&namespace_key(&snapshot.root.display().to_string()))
        .map_err(error)?
        .is_some_and(|old| old != id)
    {
        warnings.push("This source was already migrated from another snapshot. Changed-source reimport is unsupported; commit will be refused.".into());
    }
    Ok(ElectronMigrationScanResponse {
        source_dir: snapshot.root.display().to_string(),
        already_imported: previous(state, &id)?.is_some(),
        fingerprint: id,
        datasets: datasets(&snapshot),
        warnings,
    })
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<(), ErrorObject> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(error)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(error)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(error)?;
    file.write_all(bytes).map_err(error)?;
    file.sync_all().map_err(error)
}
fn stable(namespace: &str, id: &str) -> String {
    format!(
        "electron-{:x}",
        Sha256::digest(format!("{namespace}\0{id}").as_bytes())
    )
}
pub(super) fn request_origin(session: &str, entry: &str) -> UsageOrigin {
    UsageOrigin {
        thread_id: format!("electron:{session}"),
        entry_id: format!("turn:electron:{}:{session}{entry}", session.len()),
    }
}
fn protocol(api: &str) -> Option<ApiProtocol> {
    Some(match api {
        "openai-completions" | "openai-chat-completions" => ApiProtocol::Chat,
        "openai-responses" => ApiProtocol::Responses,
        "anthropic-messages" => ApiProtocol::Anthropic,
        "google-generative-ai" => ApiProtocol::Google,
        _ => return None,
    })
}

pub fn migration_commit(
    state: &ServerState,
    params: ElectronMigrationCommitParams,
) -> Result<ElectronMigrationResult, ErrorObject> {
    // One commit at a time, with a durable per-source journal before publishing anything.
    let _gate = state.workspace_entries_lock.lock().unwrap();
    state
        .store
        .recover_migration(&state.data_dir)
        .map_err(error)?;
    if params.fingerprint.len() != 64 || !params.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(invalid("Invalid migration fingerprint"));
    }
    if state.has_running_turns() {
        return Err(invalid("Wait for running work before migration"));
    }
    let snapshot = load(state, Path::new(&params.source_dir))?;
    if fingerprint(&snapshot) != params.fingerprint {
        return Err(invalid(
            "Electron data changed since scan; scan again before importing",
        ));
    }
    let namespace = snapshot.root.display().to_string();
    let _settings_guard = state.settings_lock.lock().unwrap();
    let _providers_guard = state.providers_lock.lock().unwrap();
    let namespace_key = namespace_key(&namespace);
    if let Some(committed) = state.store.db.get_setting(&namespace_key).map_err(error)?
        && committed != params.fingerprint
    {
        return Err(invalid(
            "This Electron source was already migrated from a different snapshot. Changed-source reimport is unsupported; existing native data was kept.",
        ));
    }
    let prior = previous(state, &params.fingerprint)?;
    if let Some(result) = &prior
        && (!params.include_api_keys
            || state
                .store
                .db
                .get_setting(&operation_key(&params.fingerprint, true))
                .map_err(error)?
                .is_some())
    {
        let mut result = result.clone();
        result.already_imported = true;
        return Ok(result);
    }

    let archive = state
        .data_dir
        .join("electron-migrations")
        .join(&params.fingerprint);
    std::fs::create_dir_all(&archive).map_err(error)?;
    std::fs::set_permissions(&archive, std::fs::Permissions::from_mode(0o700)).map_err(error)?;
    private_write(
        &archive.join("source-tables.json"),
        &serde_json::to_vec(&snapshot.tables).map_err(error)?,
    )?;
    for (name, bytes) in &snapshot.files {
        private_write(&archive.join("source").join(name), bytes)?;
    }
    private_write(&archive.join("journal.json"),&serde_json::to_vec(&json!({"fingerprint":params.fingerprint,"phase":"staging","includeApiKeys":params.include_api_keys})).map_err(error)?)?;
    let mut result = ElectronMigrationResult {
        fingerprint: params.fingerprint.clone(),
        archive_dir: archive.display().to_string(),
        datasets: datasets(&snapshot),
        ..Default::default()
    };
    let provider_data = json_file(&snapshot, "providers.json");
    let mut provider_map = HashMap::new();
    let keys = if params.include_api_keys {
        read_env(&snapshot.api_keys)?
    } else {
        BTreeMap::new()
    };
    let mut providers = Vec::new();
    let mut key_writes = Vec::new();
    for provider in provider_data["providers"].as_array().into_iter().flatten() {
        let old = provider["id"].as_str().unwrap_or("");
        if provider["kind"].as_str() != Some("custom")
            && provider["kind"].as_str() != Some("builtin")
        {
            result.warnings.push(format!(
                "Provider {old}: built-in/subscription configuration archived"
            ));
            continue;
        }
        let source_api = if provider["kind"].as_str() == Some("builtin")
            && provider_data["version"].as_u64().unwrap_or(1) < 2
        {
            "openai-responses"
        } else {
            provider["api"].as_str().unwrap_or("openai-responses")
        };
        let Some(api) = protocol(source_api) else {
            result
                .warnings
                .push(format!("Provider {old}: unsupported protocol archived"));
            continue;
        };
        let id = stable(&namespace, &format!("provider:{old}"));
        let mut models = Vec::new();
        for model in provider["models"].as_array().into_iter().flatten() {
            let mut value = model.clone();
            if let Some(api) = model["api"].as_str().and_then(protocol) {
                value["protocol"] = serde_json::to_value(api).map_err(error)?;
            }
            if let Some(max) = model.get("maxTokens") {
                value["maxOutputTokens"] = max.clone();
            }
            match serde_json::from_value(value) {
                Ok(model) => models.push(model),
                Err(_) => result
                    .warnings
                    .push(format!("Provider {old}: invalid model archived")),
            }
        }
        let base = provider["baseUrl"].as_str().unwrap_or("");
        if !(base.starts_with("https://") || base.starts_with("http://")) {
            result
                .warnings
                .push(format!("Provider {old}: invalid endpoint archived"));
            continue;
        }
        provider_map.insert(old.to_string(), id.clone());
        providers.push(StoredProvider {
            id: id.clone(),
            name: provider["name"].as_str().unwrap_or(old).into(),
            protocol: api,
            base_url: base.into(),
            enabled: provider["enabled"].as_bool().unwrap_or(true),
            models,
        });
        if let Some(key) = provider["apiKeyEnv"]
            .as_str()
            .and_then(|name| keys.get(name))
        {
            key_writes.push((id, key.clone()));
        }
    }
    if let Some(mut result) = prior {
        let mut writes = BTreeMap::new();
        for (id, key) in key_writes {
            if state.store.db.get_provider(&id).map_err(error)?.is_some()
                && !state.store.credentials.has(&id).map_err(error)?
            {
                writes.insert(id, key);
            }
        }
        result.imported_api_keys += writes.len();
        result.already_imported = true;
        let settings = vec![(
            result_key(&params.fingerprint),
            serde_json::to_string(&result).map_err(error)?,
        )];
        state
            .store
            .publish_migration(
                &state.data_dir,
                &operation_key(&params.fingerprint, true),
                &[],
                &writes,
                &[],
                &[],
                &settings,
                &[],
            )
            .map_err(error)?;
        private_write(
            &archive.join("report.json"),
            &serde_json::to_vec_pretty(&result).map_err(error)?,
        )?;
        state.broadcast(fv_protocol::ServerNotification::ProvidersChanged(Empty {}));
        return Ok(result);
    }
    let stage = archive.join("stage");
    // A crash before publication is retried from scratch; deterministic target ids avoid copies.
    if stage.exists() {
        std::fs::remove_dir_all(&stage).map_err(error)?;
    }
    let staged = fv_store::Store::open(&stage).map_err(error)?;
    let mut threads = Vec::new();
    let mut session_targets = HashMap::new();
    let envelope = json_file(&snapshot, "settings.json");
    let source_settings = envelope.get("settings").unwrap_or(&envelope);
    for conversation in catalog(&snapshot, "conversations") {
        let old = conversation["id"].as_str().unwrap_or("");
        if old.is_empty() {
            result
                .warnings
                .push("Conversation without id archived".into());
            continue;
        }
        if conversation["cwd"]
            .as_str()
            .is_some_and(|cwd| cwd.starts_with("remote:"))
        {
            result
                .warnings
                .push(format!("Conversation {old}: remote binding archived"));
            continue;
        }
        let Some(file) = conversation["sessionFile"].as_str() else {
            result
                .warnings
                .push(format!("Conversation {old}: no transcript archived"));
            continue;
        };
        let source_path = Path::new(file)
            .canonicalize()
            .map_err(|_| invalid("Catalog transcript is unavailable; source was preserved"))?;
        let relative = source_path
            .strip_prefix(&snapshot.root)
            .map_err(|_| invalid("Catalog transcript leaves source directory"))?;
        if !snapshot
            .files
            .contains_key(&relative.to_string_lossy().to_string())
        {
            return Err(invalid(
                "Catalog transcript is not in the scanned source snapshot",
            ));
        }
        let archived = archive.join("source").join(relative);
        if !archived.is_file() {
            result
                .warnings
                .push(format!("Conversation {old}: missing transcript"));
            continue;
        }
        let import_path = archive.join("hydrate.jsonl");
        hydrate_images(&snapshot, &archived, &import_path, old)?;
        let imported = fv_import::read_pi(&import_path).map_err(error)?;
        std::fs::remove_file(&import_path).map_err(error)?;
        let id = stable(&namespace, &format!("thread:{old}"));
        if imported.messages.is_empty() {
            result
                .warnings
                .push(format!("Conversation {old}: empty transcript archived"));
            continue;
        }
        if let Some(session) = conversation["sessionId"].as_str() {
            session_targets.insert(session.to_owned(), id.clone());
        }
        if let Some(header) = std::fs::read_to_string(&archived)
            .map_err(error)?
            .lines()
            .next()
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            && let Some(session) = header["id"].as_str()
        {
            session_targets.insert(session.to_owned(), id.clone());
        }
        let messages = imported
            .messages
            .iter()
            .map(|m| staged.images.externalize(&id, m).map_err(error))
            .collect::<Result<Vec<_>, _>>()?;
        let origins = imported
            .origins
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                entry.as_ref().map_or_else(
                    || request_origin(&imported.candidate.source_id, &i.to_string()),
                    |(session, entry)| request_origin(session, entry),
                )
            })
            .collect::<Vec<_>>();
        staged
            .transcripts
            .append_with_origins(&id, &messages, &imported.timestamps, Some(&origins))
            .map_err(error)?;
        let cwd = conversation["cwd"]
            .as_str()
            .filter(|cwd| Path::new(cwd).is_absolute())
            .map(str::to_owned);
        let project = conversation["project"]
            .as_str()
            .filter(|cwd| Path::new(cwd).is_absolute())
            .map(str::to_owned);
        if cwd.as_deref().is_some_and(|cwd| !Path::new(cwd).is_dir()) {
            result.warnings.push(format!(
                "Conversation {old}: working folder is unavailable; its path was preserved"
            ));
        }
        let last_model = imported
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                fv_core::Message::Assistant(a) => a.model.as_deref(),
                _ => None,
            });
        let model = conversation["model"]
            .as_str()
            .or(last_model)
            .and_then(|m| m.split_once('/'))
            .map(|(p, m)| {
                format!(
                    "{}/{m}",
                    provider_map.get(p).map(String::as_str).unwrap_or(p)
                )
            });
        threads.push(Thread {
            id,
            title: conversation["title"]
                .as_str()
                .unwrap_or(&imported.candidate.title)
                .into(),
            cwd,
            project,
            source: Some("electron".into()),
            created_at: conversation["createdAt"]
                .as_i64()
                .unwrap_or(imported.candidate.created_at),
            updated_at: conversation["updatedAt"]
                .as_i64()
                .unwrap_or(imported.candidate.updated_at),
            archived: conversation["archived"].as_bool().unwrap_or(false)
                || source_settings["archivedConversations"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(old))),
            pinned: conversation["pinned"].as_bool().unwrap_or(false),
            unread: false,
            worktree: None,
            model,
            thinking: conversation
                .get("thinkingLevel")
                .and_then(|v| serde_json::from_value(v.clone()).ok()),
        });
        result.warnings.extend(
            imported
                .skipped
                .into_iter()
                .map(|w| format!("Conversation {old}: {w}")),
        );
    }
    let mut usage = Vec::new();
    // All paid requests count, including superseded branches hidden from active history.
    for (name, bytes) in &snapshot.files {
        if !name.starts_with("runtime/engine/agent/sessions/") || !name.ends_with(".jsonl") {
            continue;
        }
        let mut session = String::new();
        let mut current = None;
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            let value: Value = serde_json::from_slice(line).map_err(error)?;
            if value["type"] == "session" {
                session = value["id"].as_str().unwrap_or(name).into();
            }
            if value["type"] == "model_change" {
                current = Some(format!(
                    "{}/{}",
                    value["provider"].as_str().unwrap_or("unknown"),
                    value["modelId"].as_str().unwrap_or("unknown")
                ));
            }
            if value["type"] != "message" || value["message"]["role"] != "assistant" {
                continue;
            }
            let Some(entry) = value["id"].as_str() else {
                return Err(invalid("Assistant source entry has no usage identity"));
            };
            let message = &value["message"];
            let u = &message["usage"];
            let source_session = value["fastvibeUsageSessionId"].as_str().unwrap_or(&session);
            usage.push(UsageRecord {
                origin: request_origin(source_session, entry),
                at: message["timestamp"].as_i64().unwrap_or_else(|| {
                    value["timestamp"]
                        .as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.timestamp_millis())
                        .unwrap_or(0)
                }),
                model: message["model"]
                    .as_str()
                    .map(|m| format!("{}/{m}", message["provider"].as_str().unwrap_or("unknown")))
                    .or_else(|| current.clone()),
                usage: fv_core::Usage {
                    input_tokens: u["input"].as_u64().unwrap_or(0),
                    output_tokens: u["output"].as_u64().unwrap_or(0),
                    cache_read_tokens: u["cacheRead"].as_u64().unwrap_or(0),
                    cache_write_tokens: u["cacheWrite"].as_u64().unwrap_or(0),
                },
                tool_calls: message["content"].as_array().map_or(0, |parts| {
                    parts.iter().filter(|p| p["type"] == "toolCall").count() as u64
                }),
            });
        }
    }
    if let Some(bytes) = snapshot.files.get("runtime/engine/usage-ledger.jsonl") {
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            let value: Value = serde_json::from_slice(line).map_err(error)?;
            let (Some(session), Some(entry)) =
                (value["sessionId"].as_str(), value["entryId"].as_str())
            else {
                return Err(invalid("Malformed Electron usage identity"));
            };
            usage.push(UsageRecord {
                origin: request_origin(session, entry),
                at: value["at"].as_i64().unwrap_or(0),
                model: Some(format!(
                    "{}/{}",
                    value["provider"].as_str().unwrap_or("unknown"),
                    value["model"].as_str().unwrap_or("unknown")
                )),
                usage: fv_core::Usage {
                    input_tokens: value["input"].as_u64().unwrap_or(0),
                    output_tokens: value["output"].as_u64().unwrap_or(0),
                    cache_read_tokens: value["cacheRead"].as_u64().unwrap_or(0),
                    cache_write_tokens: value["cacheWrite"].as_u64().unwrap_or(0),
                },
                tool_calls: value["toolCalls"].as_u64().unwrap_or(0),
            });
        }
    }
    for record in &mut usage {
        if let Some(session) = record.origin.thread_id.strip_prefix("electron:")
            && let Some(target) = session_targets.get(session)
        {
            record.origin.thread_id = target.clone();
        }
    }
    // Preserve current native preferences; only populate an unconfigured settings document.
    let mut settings = Vec::new();
    if params.overwrite_settings
        || state
            .store
            .db
            .get_setting("app.settings")
            .map_err(error)?
            .is_none()
    {
        let envelope = json_file(&snapshot, "settings.json");
        let source = envelope.get("settings").unwrap_or(&envelope);
        let mut target = serde_json::to_value(crate::settings::read(state)?).map_err(error)?;
        for key in [
            "themeMode",
            "lightTheme",
            "darkTheme",
            "glass",
            "uiFontSize",
            "replySuggestions",
            "autoReviewApprovals",
            "autoCompactionEnabled",
            "codeModeEnabled",
            "toolSearchEnabled",
            "collapseThinking",
            "customSystemPrompt",
            "sendOnEnter",
            "browserHomepage",
            "browserSearchEngine",
            "browserDownloadDir",
            "browserUseSystem",
            "browserEngine",
            "autoArchiveAfterDays",
            "keepAwake",
            "resourcePanelOpen",
            "proxyUrl",
        ] {
            if let Some(value) = source.get(key) {
                target[key] = value.clone();
            }
        }
        for (old, new) in [("uiLanguage", "language"), ("aiLanguage", "aiLanguage")] {
            if let Some(language) = source[old].as_str() {
                match language {
                    "en" => {
                        target[new] = serde_json::to_value(UiLanguage::English).map_err(error)?
                    }
                    "zh" => {
                        target[new] = serde_json::to_value(UiLanguage::Chinese).map_err(error)?
                    }
                    _ => result
                        .warnings
                        .push(format!("Unsupported {old} preference archived")),
                }
            }
        }
        let notification_keys = [
            "notifyDone",
            "notifyError",
            "notifyApproval",
            "notifyUpdate",
        ];
        if notification_keys
            .iter()
            .any(|key| source.get(key).is_some())
        {
            target["notifications"] = notification_keys
                .iter()
                .any(|key| source.get(key).and_then(Value::as_bool).unwrap_or(true))
                .into();
        }
        for (old, new) in [
            ("sidebarCollapsedProjects", "closedProjects"),
            ("sidebarExpandedProjects", "expandedProjects"),
        ] {
            if let Some(value) = source.get(old) {
                target["sidebar"][new] = value.clone();
            }
        }
        for (old, new) in [
            ("sidebarWidth", "width"),
            ("sidebarCollapsed", "collapsed"),
            ("sidebarProjectOrder", "projectOrder"),
        ] {
            if let Some(value) = source.get(old) {
                target["sidebar"][new] = value.clone();
            }
        }
        if let Some(order) = source["sidebarOrder"].as_object() {
            let mut mapped = serde_json::Map::new();
            for (section, ids) in order {
                let section = if section == "recent" {
                    "chats"
                } else {
                    section
                };
                mapped.insert(
                    section.to_owned(),
                    Value::Array(
                        ids.as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(|id| Value::String(stable(&namespace, &format!("thread:{id}"))))
                            .collect(),
                    ),
                );
            }
            target["sidebar"]["order"] = Value::Object(mapped);
        }
        if let Some(days) = source["autoArchiveDays"].as_u64() {
            target["autoArchiveAfterDays"] = if days == 0 { Value::Null } else { days.into() };
        }
        if let Some(default) = source.get("defaultModel")
            && let (Some(provider), Some(model)) =
                (default["provider"].as_str(), default["id"].as_str())
        {
            if let Some(provider) = provider_map.get(provider) {
                settings.push(("default_model".into(), format!("{provider}/{model}")));
            } else {
                result.warnings.push(
                    "Default model uses an excluded provider; original preference archived".into(),
                );
            }
        }
        if let Some(level) = source["thinkingLevel"]
            .as_str()
            .filter(|level| ["minimal", "low", "medium", "high", "xhigh", "max"].contains(level))
        {
            settings.push(("default_thinking".into(), level.into()));
        }
        for (path, default) in source["projectDefaults"].as_object().into_iter().flatten() {
            if let (Some(provider), Some(model)) = (
                default["model"]["provider"].as_str(),
                default["model"]["id"].as_str(),
            ) && let Some(provider) = provider_map.get(provider)
            {
                let thinking = default
                    .get("thinkingLevel")
                    .filter(|v| {
                        v.as_str().is_some_and(|s| {
                            ["minimal", "low", "medium", "high", "xhigh", "max"].contains(&s)
                        })
                    })
                    .cloned()
                    .unwrap_or(Value::Null);
                settings.push((
                    format!("project.model-defaults:{path}"),
                    json!({"model":format!("{provider}/{model}"),"thinking":thinking}).to_string(),
                ));
            }
        }
        if let Ok(target) = serde_json::from_value::<AppSettings>(target) {
            settings.push((
                "app.settings".to_string(),
                serde_json::to_string(&target).map_err(error)?,
            ));
        } else {
            result.warnings.push(
                "Some Electron settings cannot be represented; original settings archived".into(),
            );
        }
    }
    if !params.overwrite_settings
        && state
            .store
            .db
            .get_setting("app.settings")
            .map_err(error)?
            .is_some()
    {
        result.warnings.push(
            "Existing native settings kept; all Electron settings preserved in archive".into(),
        );
    }
    let mut projects: Vec<Value> = state
        .store
        .db
        .get_setting("app.projects")
        .map_err(error)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for project in catalog(&snapshot, "projects") {
        let Some(path) = project["cwd"].as_str() else {
            continue;
        };
        if project["kind"].as_str() == Some("remote") {
            result
                .warnings
                .push(format!("Project {path}: remote binding archived"));
            continue;
        }
        if projects.iter().any(|p| p["path"].as_str() == Some(path)) {
            continue;
        }
        projects.push(json!({"path":path,"name":project["name"],"folders":project["folders"].as_array().cloned().unwrap_or_default()}));
        result.imported_projects += 1;
    }
    settings.push((
        "app.projects".into(),
        serde_json::to_string(&projects).map_err(error)?,
    ));
    result.imported_threads = threads.len();
    result.imported_providers = providers.len();
    result.imported_api_keys = key_writes.len();
    result.imported_usage = usage
        .iter()
        .map(|r| (&r.origin.thread_id, &r.origin.entry_id))
        .collect::<std::collections::HashSet<_>>()
        .len();
    private_write(
        &archive.join("report.json"),
        &serde_json::to_vec_pretty(&result).map_err(error)?,
    )?;
    let mut artifacts = Vec::new();
    let publication = archive.join("publication");
    if publication.exists() {
        std::fs::remove_dir_all(&publication).map_err(error)?;
    }
    let prepared = fv_store::TranscriptStore::new(publication.join("sessions")).map_err(error)?;
    for thread in &threads {
        if state.thread(&thread.id)?.is_some() {
            return Err(invalid(
                "Migration target conversation already exists without this migration receipt",
            ));
        }
        let loaded = staged.transcripts.read(&thread.id).map_err(error)?;
        let mut messages = loaded.messages.clone();
        for message in &mut messages {
            if let fv_core::Message::ToolImages { images, .. } = message {
                for image in images {
                    if let fv_core::ImageSource::File { path } = &mut image.source {
                        let source = PathBuf::from(&*path);
                        let name = source
                            .file_name()
                            .ok_or_else(|| invalid("Invalid staged image path"))?;
                        let target = state
                            .data_dir
                            .join("tool-images")
                            .join(&thread.id)
                            .join(name);
                        artifacts.push(fv_store::MigrationFile {
                            staged: source,
                            target: target.clone(),
                        });
                        *path = target.display().to_string();
                    }
                }
            }
        }
        prepared
            .copy_loaded(&thread.id, &loaded, &messages)
            .map_err(error)?;
        artifacts.push(fv_store::MigrationFile {
            staged: prepared.path(&thread.id),
            target: state.store.transcripts.path(&thread.id),
        });
    }
    for provider in &providers {
        if state
            .store
            .db
            .get_provider(&provider.id)
            .map_err(error)?
            .is_some()
        {
            return Err(invalid(
                "Migration target provider already exists without this migration receipt",
            ));
        }
    }
    let keys = key_writes.into_iter().collect::<BTreeMap<_, _>>();
    settings.push((namespace_key, params.fingerprint.clone()));
    settings.push((
        result_key(&params.fingerprint),
        serde_json::to_string(&result).map_err(error)?,
    ));
    state
        .store
        .publish_migration(
            &state.data_dir,
            &operation_key(&params.fingerprint, params.include_api_keys),
            &artifacts,
            &keys,
            &threads,
            &providers,
            &settings,
            &usage,
        )
        .map_err(error)?;
    private_write(
        &archive.join("report.json"),
        &serde_json::to_vec_pretty(&result).map_err(error)?,
    )?;
    private_write(&archive.join("journal.json"), b"{\"phase\":\"committed\"}")?;
    state.broadcast(fv_protocol::ServerNotification::CatalogChanged(
        CatalogChanged {},
    ));
    state.broadcast(fv_protocol::ServerNotification::UsageChanged(Empty {}));
    state.broadcast(fv_protocol::ServerNotification::ProvidersChanged(Empty {}));
    crate::settings::invalidate_cache(state);
    let applied = crate::settings::read(state)?;
    state.auto_compaction.store(
        applied.auto_compaction_enabled,
        std::sync::atomic::Ordering::Release,
    );
    state.keep_awake.set(applied.keep_awake);
    state.broadcast(fv_protocol::ServerNotification::SettingsChanged(applied));
    Ok(result)
}
fn read_env(bytes: &[u8]) -> Result<BTreeMap<String, String>, ErrorObject> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("Invalid API key file encoding"))?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let (name, value) = line
                .trim()
                .strip_prefix("export ")
                .unwrap_or(line.trim())
                .split_once('=')?;
            let value = value.trim().trim_matches('"').trim_matches('\'');
            Some((name.trim().to_string(), value.to_string()))
        })
        .collect())
}

fn hydrate_images(
    snapshot: &Snapshot,
    archived: &Path,
    out: &Path,
    conversation: &str,
) -> Result<(), ErrorObject> {
    use base64::Engine;
    let text = std::fs::read_to_string(archived).map_err(error)?;
    let mut body = String::new();
    for line in text.lines() {
        let mut value: Value = serde_json::from_str(line).map_err(error)?;
        if let Some(parts) = value
            .get_mut("message")
            .and_then(|m| m.get_mut("content"))
            .and_then(Value::as_array_mut)
        {
            for part in parts {
                let Some(reference) = part.get("fastvibeImage") else {
                    continue;
                };
                let folder = reference["folder"].as_str().unwrap_or("");
                let file = reference["file"].as_str().unwrap_or("");
                if folder.is_empty()
                    || folder.starts_with('.')
                    || folder.contains('/')
                    || folder.contains('\\')
                    || file.contains("..")
                    || !file.starts_with("model/")
                {
                    return Err(invalid("Invalid tool image reference"));
                }
                let own = format!("runtime/engine/tool-images/{conversation}/{file}");
                let prior = format!("runtime/engine/tool-images/{folder}/{file}");
                let bytes = snapshot
                    .files
                    .get(&own)
                    .or_else(|| snapshot.files.get(&prior))
                    .ok_or_else(|| invalid("Referenced tool image missing from source snapshot"))?;
                *part = json!({"type":"image","mimeType":reference["mimeType"],"data":base64::engine::general_purpose::STANDARD.encode(bytes)});
            }
        }
        body.push_str(&serde_json::to_string(&value).map_err(error)?);
        body.push('\n');
    }
    private_write(out, body.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn migration_is_read_only_deduplicates_fork_usage_and_survives_repeat_commit() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let sessions = source.path().join("runtime/engine/agent/sessions/p");
        std::fs::create_dir_all(&sessions).unwrap();
        let transcript = sessions.join("s.jsonl");
        std::fs::write(&transcript,concat!(r#"{"type":"session","id":"s","cwd":"/missing"}"#,"\n",r#"{"type":"message","id":"u","parentId":null,"timestamp":1000,"message":{"role":"user","content":"hello"}}"#,"\n",r#"{"type":"message","id":"a","parentId":"u","timestamp":2000,"fastvibeUsageSessionId":"oldest","message":{"role":"assistant","provider":"p","model":"m","content":[{"type":"text","text":"answer"}],"usage":{"input":3,"output":4,"cacheRead":5,"cacheWrite":6}}}"#,"\n")).unwrap();
        let catalog = json!({"conversations":[{"id":"c","title":"Keep me","sessionFile":transcript,"sessionId":"oldest","cwd":"/missing","project":"/missing","createdAt":1000,"updatedAt":2000}],"projects":[{"cwd":"/missing","name":"Old project"}]});
        std::fs::write(
            source.path().join("conversations.json"),
            serde_json::to_vec(&catalog).unwrap(),
        )
        .unwrap();
        std::fs::write(
            source.path().join("settings.json"),
            r#"{"version":1,"settings":{"uiLanguage":"en","aiLanguage":"en","autoArchiveDays":0,"themeMode":"dark","notifyDone":false,"notifyError":false,"notifyApproval":false,"notifyUpdate":false,"customSystemPrompt":"private instructions"}}"#,
        )
        .unwrap();
        std::fs::write(
            source.path().join("message-queue.json"),
            r#"{"pending":"never execute this"}"#,
        )
        .unwrap();
        std::fs::write(source.path().join("runtime/engine/usage-ledger.jsonl"),r#"{"sessionId":"oldest","entryId":"a","provider":"p","model":"m","at":2000,"input":3,"output":4,"cacheRead":5,"cacheWrite":6,"toolCalls":0}"#).unwrap();
        std::fs::write(
            source.path().join("runtime/engine/agent/oauth.json"),
            "subscription-secret",
        )
        .unwrap();
        std::fs::write(source.path().join("providers.json"),r#"{"version":3,"providers":[{"id":"p","kind":"custom","name":"My API","baseUrl":"https://example.invalid/v1","api":"openai-responses","apiKeyEnv":"MY_API_KEY","enabled":true,"models":[{"id":"m"}]}]}"#).unwrap();
        std::fs::write(
            source.path().join("runtime/engine/agent/.env"),
            "MY_API_KEY=private-key\n",
        )
        .unwrap();
        let before = fv_import::electron::snapshot(source.path()).unwrap();
        let agent = crate::agent_with_builtin_tools(std::sync::Arc::new(
            fv_agent::testing::ScriptedModel::new([]),
        ));
        let state = ServerState::new(target.path().to_path_buf(), agent).unwrap();
        let scan = migration_scan(
            &state,
            ElectronMigrationScanParams {
                source_dir: Some(source.path().display().to_string()),
            },
        )
        .unwrap();
        assert!(state.threads(true).unwrap().is_empty());
        assert!(
            scan.datasets
                .iter()
                .any(|d| d.name == "message-queue.json" && d.disposition == "archive")
        );
        let params = ElectronMigrationCommitParams {
            source_dir: scan.source_dir,
            fingerprint: scan.fingerprint,
            include_api_keys: false,
            overwrite_settings: false,
        };
        let result = migration_commit(&state, params.clone()).unwrap();
        assert_eq!(result.imported_threads, 1);
        assert_eq!(result.imported_projects, 1);
        assert_eq!(result.imported_api_keys, 0);
        assert!(
            state
                .store
                .credentials
                .get(&stable(
                    &source.path().canonicalize().unwrap().display().to_string(),
                    "provider:p"
                ))
                .unwrap()
                .is_none()
        );
        assert!(
            !Path::new(&result.archive_dir)
                .join("source/runtime/engine/agent/.env")
                .exists()
        );
        let key_target = tempfile::tempdir().unwrap();
        let key_state = ServerState::new(
            key_target.path().to_path_buf(),
            crate::agent_with_builtin_tools(std::sync::Arc::new(
                fv_agent::testing::ScriptedModel::new([]),
            )),
        )
        .unwrap();
        key_state
            .store
            .db
            .set_setting(
                "app.settings",
                Some(
                    &serde_json::to_string(&AppSettings {
                        auto_archive_after_days: Some(30),
                        ..Default::default()
                    })
                    .unwrap(),
                ),
            )
            .unwrap();
        let mut with_keys = params.clone();
        with_keys.include_api_keys = true;
        with_keys.overwrite_settings = true;
        let keyed = migration_commit(&key_state, with_keys).unwrap();
        assert_eq!(keyed.imported_api_keys, 1);
        assert_eq!(
            crate::settings::read(&key_state)
                .unwrap()
                .auto_archive_after_days,
            None
        );
        assert_eq!(
            key_state
                .store
                .credentials
                .get(&stable(
                    &source.path().canonicalize().unwrap().display().to_string(),
                    "provider:p"
                ))
                .unwrap()
                .as_deref(),
            Some("private-key")
        );
        assert_eq!(
            crate::settings::read(&key_state)
                .unwrap()
                .custom_system_prompt,
            "private instructions"
        );
        assert_eq!(state.store.db.usage_records().unwrap().len(), 1);
        let state = std::sync::Arc::new(state);
        let stats = crate::usage::collect(
            state.clone(),
            fv_protocol::usage::UsageParams {
                range: fv_protocol::usage::UsageRange::All,
                timezone: "UTC".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(stats.conversations.len(), 1);
        assert_eq!(stats.conversations[0].title.as_deref(), Some("Keep me"));
        assert_eq!(stats.conversations[0].project.as_deref(), Some("/missing"));
        assert_eq!(
            stats.conversations[0].thread_id.as_deref(),
            Some(state.threads(true).unwrap()[0].id.as_str())
        );
        assert_eq!(
            state.store.db.usage_records().unwrap()[0]
                .usage
                .cache_write_tokens,
            6
        );
        assert_eq!(state.threads(true).unwrap()[0].title, "Keep me");
        assert_eq!(
            state.threads(true).unwrap()[0].cwd.as_deref(),
            Some("/missing")
        );
        assert_eq!(
            crate::settings::read(&state).unwrap().custom_system_prompt,
            "private instructions"
        );
        assert!(
            !Path::new(&result.archive_dir)
                .join("source/runtime/engine/agent/oauth.json")
                .exists()
        );
        assert!(Path::new(&result.archive_dir).join("report.json").is_file());
        assert!(
            migration_commit(&state, params.clone())
                .unwrap()
                .already_imported
        );
        assert_eq!(state.threads(true).unwrap().len(), 1);
        let imported_id = state.threads(true).unwrap()[0].id.clone();
        let transcript_before = std::fs::read(state.store.transcripts.path(&imported_id)).unwrap();
        let settings_before = state.store.db.get_setting("app.settings").unwrap();
        let usage_before = state.store.db.usage_records().unwrap();
        let mut followup = params.clone();
        followup.include_api_keys = true;
        followup.overwrite_settings = true;
        let followed = migration_commit(&state, followup.clone()).unwrap();
        assert_eq!(followed.imported_api_keys, 1);
        assert!(followed.already_imported);
        assert_eq!(
            std::fs::read(state.store.transcripts.path(&imported_id)).unwrap(),
            transcript_before
        );
        assert_eq!(
            state.store.db.get_setting("app.settings").unwrap(),
            settings_before
        );
        assert_eq!(state.store.db.usage_records().unwrap(), usage_before);
        let provider = stable(
            &source.path().canonicalize().unwrap().display().to_string(),
            "provider:p",
        );
        assert_eq!(
            state.store.credentials.get(&provider).unwrap().as_deref(),
            Some("private-key")
        );
        assert_eq!(
            migration_commit(&state, followup)
                .unwrap()
                .imported_api_keys,
            1
        );
        assert_eq!(
            crate::settings::read(&state).unwrap().language,
            UiLanguage::English
        );
        assert!(!crate::settings::read(&state).unwrap().notifications);
        assert_eq!(
            crate::settings::read(&state).unwrap().ai_language,
            UiLanguage::English
        );
        assert_eq!(
            crate::settings::read(&state).unwrap().theme_mode,
            ThemeMode::Dark
        );
        let after = fv_import::electron::snapshot(source.path()).unwrap();
        assert_eq!(before.tables, after.tables);
        assert_eq!(before.files, after.files);
        let scan = migration_scan(
            &state,
            ElectronMigrationScanParams {
                source_dir: Some(source.path().display().to_string()),
            },
        )
        .unwrap();
        std::fs::write(source.path().join("settings.json"), "{}").unwrap();
        let changed = migration_scan(
            &state,
            ElectronMigrationScanParams {
                source_dir: Some(source.path().display().to_string()),
            },
        )
        .unwrap();
        let rejected = migration_commit(
            &state,
            ElectronMigrationCommitParams {
                source_dir: changed.source_dir,
                fingerprint: changed.fingerprint,
                include_api_keys: true,
                overwrite_settings: true,
            },
        )
        .unwrap_err();
        assert!(rejected.message.contains("different snapshot"));
        assert_eq!(
            std::fs::read(state.store.transcripts.path(&imported_id)).unwrap(),
            transcript_before
        );
        assert_eq!(state.store.db.usage_records().unwrap(), usage_before);

        // A changed scan identity is rejected on a fresh target, before publication.
        let fresh = tempfile::tempdir().unwrap();
        let fresh = ServerState::new(
            fresh.path().to_path_buf(),
            crate::agent_with_builtin_tools(std::sync::Arc::new(
                fv_agent::testing::ScriptedModel::new([]),
            )),
        )
        .unwrap();
        assert!(
            migration_commit(
                &fresh,
                ElectronMigrationCommitParams {
                    source_dir: scan.source_dir,
                    fingerprint: scan.fingerprint,
                    include_api_keys: false,
                    overwrite_settings: false,
                }
            )
            .is_err()
        );
        assert!(fresh.threads(true).unwrap().is_empty());
    }
}
