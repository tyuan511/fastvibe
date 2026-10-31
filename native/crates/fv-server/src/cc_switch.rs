//! Read-only CC Switch source; keys stay in this process and imports only write FastVibe data.
use crate::state::ServerState;
use fv_protocol::{ErrorObject, jsonrpc::code, types::*};
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

struct Draft {
    id: String,
    name: String,
    app_label: String,
    base_url: String,
    protocol: ApiProtocol,
    key: String,
    models: Vec<String>,
}
fn failure() -> ErrorObject {
    ErrorObject::new(
        code::INVALID_PARAMS,
        "Could not read the CC Switch database.",
    )
}
fn path() -> Result<PathBuf, ErrorObject> {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".cc-switch/cc-switch.db"))
        .ok_or_else(failure)
}
pub async fn scan(state: &ServerState) -> Result<ProviderImportScan, ErrorObject> {
    scan_path(state, &path()?)
}
fn scan_path(state: &ServerState, path: &Path) -> Result<ProviderImportScan, ErrorObject> {
    let taken = existing(state)?;
    let candidates = drafts(path)?
        .into_iter()
        .map(|d| {
            let importable = !taken.contains(&finger(d.protocol, &d.base_url, &d.key));
            ProviderImportCandidate {
                id: d.id,
                name: d.name,
                app_label: d.app_label,
                base_url: d.base_url,
                protocol: d.protocol,
                model_count: d.models.len(),
                importable,
                reason: (!importable).then(|| "Already imported".into()),
            }
        })
        .collect();
    Ok(ProviderImportScan {
        found: path.exists(),
        path: path.display().to_string(),
        candidates,
    })
}
pub async fn import(
    state: &ServerState,
    ids: Vec<String>,
) -> Result<ProviderListResponse, ErrorObject> {
    import_path(state, &path()?, ids).await
}
async fn import_path(
    state: &ServerState,
    path: &Path,
    ids: Vec<String>,
) -> Result<ProviderListResponse, ErrorObject> {
    let wanted: HashSet<_> = ids.into_iter().collect();
    let mut taken = existing(state)?;
    let proxy = crate::settings::read(state)?.proxy_url;
    for draft in drafts(path)? {
        let fingerprint = finger(draft.protocol, &draft.base_url, &draft.key);
        if !wanted.contains(&draft.id) || taken.contains(&fingerprint) {
            continue;
        }
        let fetched = fv_provider::fetch_models_with_proxy(
            crate::providers::to_protocol(draft.protocol),
            &draft.base_url,
            &draft.key,
            (!proxy.is_empty()).then_some(proxy.as_str()),
        )
        .await
        .ok()
        .filter(|models| !models.is_empty());
        let catalog = state.catalog.snapshot();
        let models: Vec<ModelInfo> = match fetched {
            Some(models) => models
                .into_iter()
                .map(|m| {
                    let mut model = crate::model_detail::fresh(&catalog, &m.id, draft.protocol);
                    if m.name.is_some() {
                        model.name = m.name;
                    }
                    model
                })
                .collect(),
            None => draft
                .models
                .iter()
                .map(|id| crate::model_detail::fresh(&catalog, id, draft.protocol))
                .collect(),
        };
        if models.is_empty() {
            return Err(ErrorObject::new(
                code::INVALID_PARAMS,
                "The provider listed no models and CC Switch recorded none. Add a model before importing.",
            ));
        }
        // Recheck under the provider mutation lock after the network wait.
        let _lock = state.providers_lock.lock().unwrap();
        if existing(state)?.contains(&fingerprint) {
            continue;
        }
        crate::providers::upsert_locked(
            state,
            ProviderUpsertParams {
                id: None,
                name: draft.name,
                protocol: draft.protocol,
                base_url: draft.base_url,
                api_key: Some(draft.key),
                enabled: true,
                models,
                expected: None,
            },
        )?;
        taken.insert(fingerprint);
    }
    crate::providers::list(state)
}
fn existing(state: &ServerState) -> Result<HashSet<String>, ErrorObject> {
    let mut out = HashSet::new();
    for p in state.store.db.list_providers().map_err(|_| failure())? {
        if let Some(key) = state.store.credentials.get(&p.id).map_err(|_| failure())? {
            out.insert(finger(p.protocol, &p.base_url, &key));
        }
    }
    Ok(out)
}
fn finger(protocol: ApiProtocol, url: &str, key: &str) -> String {
    let normalized = reqwest::Url::parse(url.trim())
        .map(|mut u| {
            let path = u.path().trim_end_matches('/').to_string();
            u.set_path(&path);
            u.set_query(None);
            u.set_fragment(None);
            u.to_string().trim_end_matches('/').to_string()
        })
        .unwrap_or_else(|_| url.trim_end_matches('/').to_lowercase());
    format!(
        "{protocol:?}|{normalized}|{:x}",
        Sha256::digest(key.as_bytes())
    )
}
fn drafts(path: &Path) -> Result<Vec<Draft>, ErrorObject> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    // SQLite READ_ONLY can create source -shm files. Recover only a private DB+WAL copy.
    let scratch = tempfile::tempdir().map_err(|_| failure())?;
    let copy = scratch.path().join("source.db");
    let wal_path = PathBuf::from(format!("{}-wal", path.display()));
    let read_bounded = |path: &Path| -> Result<Vec<u8>, ErrorObject> {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| failure())?
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| failure())?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err(failure());
        }
        Ok(bytes)
    };
    let before = read_bounded(path)?;
    let wal = if wal_path.exists() {
        Some(read_bounded(&wal_path)?)
    } else {
        None
    };
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(&copy, &before).map_err(|_| failure())?;
    std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| failure())?;
    if let Some(wal) = &wal {
        let wal_copy = scratch.path().join("source.db-wal");
        std::fs::write(&wal_copy, wal).map_err(|_| failure())?;
        std::fs::set_permissions(&wal_copy, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| failure())?;
    }
    let wal_after = if wal_path.exists() {
        Some(read_bounded(&wal_path)?)
    } else {
        None
    };
    if before != read_bounded(path)? || wal != wal_after {
        return Err(ErrorObject::new(
            code::INVALID_PARAMS,
            "CC Switch changed during the scan. Close it and scan again.",
        ));
    }
    let db = Connection::open(&copy).map_err(|_| failure())?;
    let mut statement = db
        .prepare(
            "SELECT id, app_type, name, settings_config, meta FROM providers ORDER BY app_type, id",
        )
        .map_err(|_| failure())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|_| failure())?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let (id, app, name, settings, meta) = row.map_err(|_| failure())?;
        if settings.len() > 1024 * 1024 {
            return Err(ErrorObject::new(
                code::INVALID_PARAMS,
                "A CC Switch provider configuration is too large to import.",
            ));
        }
        let Ok(settings) = serde_json::from_str::<Value>(&settings) else {
            continue;
        };
        let meta: Value = meta
            .and_then(|m| serde_json::from_str(&m).ok())
            .unwrap_or(Value::Null);
        if ["codex_oauth", "github_copilot", "xai_oauth"]
            .contains(&text(&meta, "providerType").as_str())
            || settings
                .pointer("/auth/tokens")
                .is_some_and(Value::is_object)
            || settings.pointer("/auth/auth_mode").and_then(Value::as_str) == Some("chatgpt")
        {
            continue;
        }
        let Some((url, key, protocol, mut models)) = extract(&app, &settings, &meta) else {
            continue;
        };
        let Ok(parsed) = reqwest::Url::parse(&url) else {
            continue;
        };
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || key.is_empty()
            || key.contains('\n')
            || key.contains('\r')
        {
            continue;
        }
        let url = url.trim_end_matches('/').to_string();
        if !seen.insert(finger(protocol, &url, &key)) {
            continue;
        }
        models.retain(|m| !m.is_empty());
        models.sort();
        models.dedup();
        let app_label = match app.as_str() {
            "claude" => "Claude Code",
            "claude-desktop" => "Claude Desktop",
            "codex" => "Codex",
            "gemini" => "Gemini",
            "opencode" => "OpenCode",
            "pi" => "Pi",
            "hermes" => "Hermes",
            "openclaw" => "OpenClaw",
            "mcode" => "MiniMax Code",
            _ => &app,
        }
        .to_string();
        out.push(Draft {
            id: format!("{app}:{id}"),
            name: if name.trim().is_empty() {
                app_label.clone()
            } else {
                name.trim().into()
            },
            app_label,
            base_url: url,
            protocol,
            key,
            models,
        });
    }
    Ok(out)
}
fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .into()
}
fn first(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .map(|k| text(v, k))
        .find(|v| !v.is_empty() && v != "null")
        .unwrap_or_default()
}
fn format(raw: &str, fallback: ApiProtocol) -> ApiProtocol {
    match raw.to_lowercase().replace('-', "_").as_str() {
        "chat" | "openai_chat" | "openai_completions" => ApiProtocol::Chat,
        "responses" | "openai_responses" => ApiProtocol::Responses,
        "anthropic" | "anthropic_messages" => ApiProtocol::Anthropic,
        "google" | "gemini" | "google_generative_ai" => ApiProtocol::Google,
        _ => fallback,
    }
}
fn quoted(config: &str, key: &str) -> String {
    config
        .lines()
        .find_map(|line| {
            let (left, right) = line.split_once('=')?;
            if left.trim() != key {
                return None;
            }
            let right = right.trim();
            let quote = right.chars().next()?;
            if quote != '"' && quote != '\'' {
                return None;
            }
            right[1..].split(quote).next().map(str::to_string)
        })
        .unwrap_or_default()
}
fn extract(
    app: &str,
    s: &Value,
    meta: &Value,
) -> Option<(String, String, ApiProtocol, Vec<String>)> {
    let env = &s["env"];
    Some(match app {
        "claude" | "claude-desktop" => (
            text(env, "ANTHROPIC_BASE_URL"),
            first(
                env,
                &[
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                    "OPENROUTER_API_KEY",
                    "GOOGLE_API_KEY",
                ],
            ),
            format(&text(meta, "apiFormat"), ApiProtocol::Anthropic),
            [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
            ]
            .iter()
            .map(|k| text(env, k))
            .collect(),
        ),
        "codex" => {
            let config = text(s, "config");
            let wire = quoted(&config, "wire_api");
            (
                quoted(&config, "base_url"),
                first(&s["auth"], &["OPENAI_API_KEY"]),
                if wire == "chat" {
                    ApiProtocol::Chat
                } else {
                    ApiProtocol::Responses
                },
                vec![quoted(&config, "model")],
            )
        }
        "gemini" => (
            first(env, &["GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL"]),
            first(env, &["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
            ApiProtocol::Google,
            vec![text(env, "GEMINI_MODEL")],
        ),
        "opencode" | "mcode" => (
            first(&s["options"], &["baseURL", "baseUrl"]),
            text(&s["options"], "apiKey"),
            if text(s, "npm").contains("anthropic") {
                ApiProtocol::Anthropic
            } else {
                ApiProtocol::Chat
            },
            s["models"]
                .as_object()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default(),
        ),
        "pi" => (
            first(s, &["baseUrl", "base_url"]),
            first(s, &["apiKey", "api_key"]),
            format(&text(s, "api"), ApiProtocol::Chat),
            s["models"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| {
                    m.as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| text(m, "id"))
                })
                .collect(),
        ),
        "hermes" | "openclaw" => (
            first(s, &["base_url", "baseUrl"]),
            first(s, &["api_key", "apiKey"]),
            ApiProtocol::Chat,
            vec![text(s, "model")],
        ),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn read_only_scan_deduplicates_and_never_serializes_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cc-switch.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE providers(id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT)").unwrap();
        let fixture_key = "private-fixture-key";
        let settings = serde_json::json!({"env":{"ANTHROPIC_BASE_URL":"https://example.com/v1/","ANTHROPIC_API_KEY":fixture_key,"ANTHROPIC_MODEL":"claude-a"}}).to_string();
        for id in ["a", "b"] {
            db.execute(
                "INSERT INTO providers VALUES(?1,'claude','Example',?2,'{}')",
                [&id, &settings.as_str()],
            )
            .unwrap();
        }
        drop(db);
        let before = std::fs::read(&path).unwrap();
        let agent = crate::agent_with_builtin_tools(std::sync::Arc::new(
            fv_agent::testing::ScriptedModel::new([]),
        ));
        let state = ServerState::new(dir.path().join("app"), agent).unwrap();
        let scan = scan_path(&state, &path).unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert!(scan.candidates[0].importable);
        assert!(!serde_json::to_string(&scan).unwrap().contains(fixture_key));
        assert_eq!(before, std::fs::read(&path).unwrap());
        assert!(!path.with_extension("db-wal").exists());
        assert!(!path.with_extension("db-shm").exists());
    }

    #[test]
    fn committed_wal_is_read_without_source_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cc-switch.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE providers(id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT)").unwrap();
        let settings = serde_json::json!({"base_url":"https://example.com/v1", "api_key":"wal-private-key", "model":"a"}).to_string();
        db.execute(
            "INSERT INTO providers VALUES('a','hermes','WAL',?1,'{}')",
            [&settings],
        )
        .unwrap();
        let wal_path = PathBuf::from(format!("{}-wal", path.display()));
        let shm_path = PathBuf::from(format!("{}-shm", path.display()));
        let before = (
            std::fs::read(&path).unwrap(),
            std::fs::read(&wal_path).unwrap(),
            std::fs::read(&shm_path).unwrap(),
        );
        assert_eq!(drafts(&path).unwrap().len(), 1);
        assert_eq!(
            before,
            (
                std::fs::read(&path).unwrap(),
                std::fs::read(&wal_path).unwrap(),
                std::fs::read(&shm_path).unwrap()
            )
        );
    }

    #[tokio::test]
    async fn imports_only_selected_api_key_sources_and_deduplicates_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cc-switch.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE providers(id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT)").unwrap();
        let settings = serde_json::json!({"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1/v1/","ANTHROPIC_API_KEY":"private-import-key","ANTHROPIC_MODEL":"claude-a"}}).to_string();
        db.execute(
            "INSERT INTO providers VALUES('a','claude','Example',?1,'{}')",
            [&settings],
        )
        .unwrap();
        let oauth = serde_json::json!({"config":"base_url = \"https://example.com\"", "auth":{"OPENAI_API_KEY":"oauth-key","tokens":{"access_token":"never-import"}}}).to_string();
        db.execute(
            "INSERT INTO providers VALUES('b','codex','Subscription',?1,'{}')",
            [&oauth],
        )
        .unwrap();
        drop(db);
        let before = std::fs::read(&path).unwrap();
        let agent = crate::agent_with_builtin_tools(std::sync::Arc::new(
            fv_agent::testing::ScriptedModel::new([]),
        ));
        let state = ServerState::new(dir.path().join("app"), agent).unwrap();
        assert_eq!(scan_path(&state, &path).unwrap().candidates.len(), 1);
        assert!(
            import_path(&state, &path, vec!["other".into()])
                .await
                .unwrap()
                .providers
                .is_empty()
        );
        let imported = import_path(&state, &path, vec!["claude:a".into()])
            .await
            .unwrap();
        assert_eq!(imported.providers.len(), 1);
        assert_eq!(imported.providers[0].models[0].id, "claude-a");
        assert!(imported.providers[0].has_key);
        assert!(
            !serde_json::to_string(&imported)
                .unwrap()
                .contains("private-import-key")
        );
        assert!(!scan_path(&state, &path).unwrap().candidates[0].importable);
        assert_eq!(
            import_path(&state, &path, vec!["claude:a".into()])
                .await
                .unwrap()
                .providers
                .len(),
            1
        );
        assert_eq!(before, std::fs::read(&path).unwrap());
        assert_eq!(
            state
                .store
                .credentials
                .get(&imported.providers[0].id)
                .unwrap()
                .as_deref(),
            Some("private-import-key")
        );
    }
}
