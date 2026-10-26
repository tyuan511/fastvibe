//! OAuth is protocol-driven: the asking client owns the browser and callback listener.
//! Only the server exchanges codes and holds tokens. Old connections cannot resurrect a
//! credential after logout, and a changed endpoint never receives another endpoint's token.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fv_protocol::types::{McpServerConfig, McpTransport};
use rmcp::transport::auth::{
    AuthClient, AuthError, AuthorizationManager, AuthorizationSession, CredentialRefreshGuard,
    CredentialStore, OAuthClientConfig, StoredCredentials,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, watch};

const FLOW_LIFETIME: Duration = Duration::from_secs(600);
const MAX_FLOWS: usize = 16;

#[derive(Clone, Serialize, Deserialize)]
struct Identity {
    client_id: String,
    client_secret: Option<String>,
    scopes: Vec<String>,
    redirect_uri: String,
}

impl Identity {
    fn from_sdk(config: &OAuthClientConfig) -> Self {
        Self {
            client_id: config.client_id.clone(),
            client_secret: config.client_secret.clone(),
            scopes: config.scopes.clone(),
            redirect_uri: config.redirect_uri.clone(),
        }
    }

    fn to_sdk(&self) -> OAuthClientConfig {
        let mut config = OAuthClientConfig::new(&self.client_id, &self.redirect_uri)
            .with_scopes(self.scopes.clone());
        if let Some(secret) = &self.client_secret {
            config = config.with_client_secret(secret);
        }
        config
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Document {
    version: u8,
    server_id: String,
    url: String,
    identity: Identity,
    credentials: StoredCredentials,
}

struct Binding {
    path: PathBuf,
    server_id: String,
    url: String,
    epoch: AtomicU64,
    flow_epoch: AtomicU64,
    io: AsyncMutex<()>,
    refresh: Arc<AsyncMutex<()>>,
    changes: watch::Sender<u64>,
}

/// Each transport captures an epoch. Logout/reauthorization invalidates already-running
/// transports before a new credential is written, including a refresh currently in flight.
#[derive(Clone)]
struct Store {
    binding: Arc<Binding>,
    epoch: u64,
}

impl Store {
    fn check(&self) -> Result<(), AuthError> {
        if self.binding.epoch.load(Ordering::Acquire) != self.epoch {
            Err(AuthError::AuthorizationRequired)
        } else {
            Ok(())
        }
    }

    async fn document(&self) -> Result<Option<Document>, AuthError> {
        let _guard = self.binding.io.lock().await;
        self.check()?;
        read_document(&self.binding).await
    }
}

fn store_error(error: impl std::fmt::Display) -> AuthError {
    AuthError::CredentialStoreError(error.to_string())
}

async fn read_document(binding: &Binding) -> Result<Option<Document>, AuthError> {
    let bytes = match tokio::fs::read(&binding.path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(store_error(error)),
    };
    let document: Document = serde_json::from_slice(&bytes).map_err(store_error)?;
    if document.version != 1
        || document.server_id != binding.server_id
        || document.url != binding.url
    {
        return Err(store_error("MCP OAuth credential binding mismatch"));
    }
    Ok(Some(document))
}

#[async_trait::async_trait]
impl CredentialStore for Store {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        Ok(self.document().await?.map(|document| document.credentials))
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let _guard = self.binding.io.lock().await;
        self.check()?;
        let mut document = read_document(&self.binding)
            .await?
            .ok_or(AuthError::AuthorizationRequired)?;
        document.credentials = credentials;
        write_document(&self.binding.path, &document)
            .await
            .map_err(store_error)?;
        self.binding.changes.send_modify(|revision| *revision += 1);
        Ok(())
    }

    async fn clear(&self) -> Result<(), AuthError> {
        let _guard = self.binding.io.lock().await;
        self.check()?;
        remove_file(&self.binding.path).await.map_err(store_error)?;
        self.binding.changes.send_modify(|revision| *revision += 1);
        Ok(())
    }

    async fn acquire_refresh_guard(&self) -> Result<Option<CredentialRefreshGuard>, AuthError> {
        let guard = self.binding.refresh.clone().lock_owned().await;
        self.check()?;
        Ok(Some(CredentialRefreshGuard::new(guard)))
    }

    async fn on_refresh_token_rejected(
        &self,
        attempted: &StoredCredentials,
    ) -> Result<(), AuthError> {
        let _guard = self.binding.io.lock().await;
        self.check()?;
        if let Some(document) = read_document(&self.binding).await?
            && serde_json::to_value(&document.credentials).map_err(store_error)?
                == serde_json::to_value(attempted).map_err(store_error)?
        {
            remove_file(&self.binding.path).await.map_err(store_error)?;
            self.binding.changes.send_modify(|revision| *revision += 1);
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
struct Staging(Arc<AsyncMutex<Option<StoredCredentials>>>);

#[async_trait::async_trait]
impl CredentialStore for Staging {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        Ok(self.0.lock().await.clone())
    }
    async fn save(&self, value: StoredCredentials) -> Result<(), AuthError> {
        *self.0.lock().await = Some(value);
        Ok(())
    }
    async fn clear(&self) -> Result<(), AuthError> {
        *self.0.lock().await = None;
        Ok(())
    }
}

struct Control {
    owner: u64,
    server_id: String,
    // 0: exchange may proceed; 1: canceled; 2: the commit has started.
    state: AtomicU8,
}

impl Control {
    fn cancel(&self) {
        let _ = self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire);
    }
}

struct Pending {
    owner: u64,
    expires: Instant,
    config: McpServerConfig,
    session: AuthorizationSession,
    staging: Staging,
    identity: Identity,
    binding: Arc<Binding>,
    epoch: u64,
    flow_epoch: u64,
    _permit: tokio::sync::OwnedSemaphorePermit,
    issuer: Option<String>,
    issuer_required: bool,
    control: Arc<Control>,
}

pub(crate) struct Commit {
    pub config: McpServerConfig,
    binding: Arc<Binding>,
    epoch: u64,
    flow_epoch: u64,
    document: Document,
    control: Arc<Control>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

pub(crate) struct Begin {
    pub flow_id: String,
    pub authorization_url: String,
}

pub(crate) struct OAuth {
    directory: PathBuf,
    bindings: Mutex<BTreeMap<String, Arc<Binding>>>,
    pending: Mutex<BTreeMap<String, Pending>>,
    permits: Arc<tokio::sync::Semaphore>,
    changes: watch::Sender<u64>,
    controls: Mutex<BTreeMap<String, std::sync::Weak<Control>>>,
}

impl OAuth {
    pub fn new(directory: PathBuf, changes: watch::Sender<u64>) -> Self {
        Self {
            directory,
            bindings: Mutex::new(BTreeMap::new()),
            pending: Mutex::new(BTreeMap::new()),
            permits: Arc::new(tokio::sync::Semaphore::new(MAX_FLOWS)),
            changes,
            controls: Mutex::new(BTreeMap::new()),
        }
    }

    fn binding(&self, config: &McpServerConfig) -> Arc<Binding> {
        let url = config.url.clone().unwrap_or_default();
        let key = format!("{:x}", Sha256::digest(format!("{}\0{url}", config.id)));
        self.bindings
            .lock()
            .unwrap()
            .entry(key.clone())
            .or_insert_with(|| {
                Arc::new(Binding {
                    path: self.directory.join(format!("{key}.json")),
                    server_id: config.id.clone(),
                    url,
                    epoch: AtomicU64::new(0),
                    flow_epoch: AtomicU64::new(0),
                    io: AsyncMutex::new(()),
                    refresh: Arc::new(AsyncMutex::new(())),
                    changes: self.changes.clone(),
                })
            })
            .clone()
    }

    pub fn present(&self, config: &McpServerConfig) -> bool {
        config.transport == McpTransport::Http && self.binding(config).path.is_file()
    }

    pub fn configuration_changed(&self, config: &McpServerConfig) {
        self.cancel_controls(|control| control.server_id == config.id);
        self.binding(config)
            .flow_epoch
            .fetch_add(1, Ordering::AcqRel);
        self.pending
            .lock()
            .unwrap()
            .retain(|_, flow| flow.config.id != config.id);
    }

    pub fn cancel_all(&self) {
        self.cancel_controls(|_| true);
        self.pending.lock().unwrap().clear();
    }

    pub fn cancel_owner(&self, owner: u64) {
        self.cancel_controls(|control| control.owner == owner);
        self.pending
            .lock()
            .unwrap()
            .retain(|_, flow| flow.owner != owner);
    }

    pub fn cancel(&self, owner: u64, flow: &str) -> Result<(), String> {
        {
            let mut controls = self.controls.lock().unwrap();
            if let Some(control) = controls.get(flow).and_then(std::sync::Weak::upgrade) {
                if control.owner != owner {
                    return Err("授权流程属于另一个连接".into());
                }
                control.cancel();
            }
            controls.remove(flow);
        }
        let mut pending = self.pending.lock().unwrap();
        if pending.get(flow).is_some_and(|flow| flow.owner != owner) {
            return Err("授权流程属于另一个连接".into());
        }
        pending.remove(flow);
        Ok(())
    }

    fn cancel_controls(&self, matches: impl Fn(&Control) -> bool) {
        self.controls.lock().unwrap().retain(|_, weak| {
            let Some(control) = weak.upgrade() else {
                return false;
            };
            if matches(&control) {
                control.cancel();
                false
            } else {
                true
            }
        });
    }

    pub fn configuration(&self, owner: u64, flow_id: &str) -> Result<McpServerConfig, String> {
        let pending = self.pending.lock().unwrap();
        let flow = pending
            .get(flow_id)
            .filter(|flow| flow.owner == owner && flow.expires > Instant::now())
            .ok_or("授权已过期、已取消或属于另一个连接")?;
        Ok(flow.config.clone())
    }

    pub async fn begin(
        &self,
        owner: u64,
        config: McpServerConfig,
        redirect_uri: String,
        client_id: Option<String>,
        client_secret: Option<String>,
        scopes: Vec<String>,
    ) -> Result<Begin, String> {
        if config.transport != McpTransport::Http {
            return Err("OAuth 只用于 HTTP MCP 服务器".into());
        }
        if config
            .headers
            .keys()
            .any(|key| key.eq_ignore_ascii_case("authorization"))
        {
            return Err("请先移除 Authorization 请求头，再使用 OAuth 登录".into());
        }
        validate_redirect(&redirect_uri)?;
        if client_secret.is_some() && client_id.is_none() {
            return Err("Client Secret 需要同时填写 Client ID".into());
        }
        {
            let mut pending = self.pending.lock().unwrap();
            pending.retain(|_, flow| flow.expires > Instant::now());
            if pending.len() >= MAX_FLOWS {
                return Err("已有太多等待中的授权，请先完成或取消".into());
            }
        }
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| "已有太多等待中的授权")?;
        let binding = self.binding(&config);
        let epoch = binding.epoch.load(Ordering::Acquire);
        let flow_epoch = binding.flow_epoch.load(Ordering::Acquire);
        let mut manager = new_manager(&binding.url).await?;
        let metadata = manager
            .resolve_metadata()
            .await
            .map_err(|e| e.to_string())?;
        let issuer = metadata.metadata.issuer.clone();
        let issuer_required = metadata
            .metadata
            .additional_fields
            .get("authorization_response_iss_parameter_supported")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        manager.set_metadata(metadata.metadata);
        let scopes = if scopes.is_empty() {
            manager.select_initial_scopes(&[]).await
        } else {
            scopes
        };
        let client = if let Some(client_id) = client_id {
            let mut config =
                OAuthClientConfig::new(client_id, &redirect_uri).with_scopes(scopes.clone());
            if let Some(secret) = client_secret {
                config = config.with_client_secret(secret);
            }
            config
        } else {
            manager
                .register_client(
                    "FastVibe",
                    &redirect_uri,
                    &scopes.iter().map(String::as_str).collect::<Vec<_>>(),
                )
                .await
                .map_err(|e| e.to_string())?
        };
        let identity = Identity::from_sdk(&client);
        manager
            .configure_client(client)
            .map_err(|e| e.to_string())?;
        let staging = Staging::default();
        manager.set_credential_store(staging.clone());
        let url = manager
            .get_authorization_url(&scopes.iter().map(String::as_str).collect::<Vec<_>>())
            .await
            .map_err(|e| e.to_string())?;
        let flow_id = uuid::Uuid::new_v4().to_string();
        let control = Arc::new(Control {
            owner,
            server_id: config.id.clone(),
            state: AtomicU8::new(0),
        });
        {
            let mut controls = self.controls.lock().unwrap();
            controls.retain(|_, control| control.strong_count() > 0);
            controls.insert(flow_id.clone(), Arc::downgrade(&control));
        }
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, flow| flow.expires > Instant::now());
        if pending.len() >= MAX_FLOWS {
            return Err("已有太多等待中的授权".into());
        }
        if binding.epoch.load(Ordering::Acquire) != epoch
            || binding.flow_epoch.load(Ordering::Acquire) != flow_epoch
        {
            return Err("MCP 配置或登录状态已变化，请重新登录".into());
        }
        pending.insert(
            flow_id.clone(),
            Pending {
                owner,
                expires: Instant::now() + FLOW_LIFETIME,
                config,
                session: AuthorizationSession::for_scope_upgrade(
                    manager,
                    url.clone(),
                    &redirect_uri,
                ),
                staging,
                identity,
                binding,
                epoch,
                flow_epoch,
                _permit: permit,
                issuer,
                issuer_required,
                control,
            },
        );
        Ok(Begin {
            flow_id,
            authorization_url: url,
        })
    }

    pub async fn complete(
        &self,
        owner: u64,
        flow_id: &str,
        callback: &str,
        current: &McpServerConfig,
    ) -> Result<Commit, String> {
        let flow = {
            let mut pending = self.pending.lock().unwrap();
            pending.retain(|_, flow| flow.expires > Instant::now());
            let flow = pending
                .get(flow_id)
                .ok_or("授权已过期或已取消，请重新登录")?;
            if flow.owner != owner {
                return Err("授权流程属于另一个连接".into());
            }
            if &flow.config != current {
                return Err("MCP 配置已变化，请重新登录".into());
            }
            validate_callback(
                &flow.session.redirect_uri,
                &flow.session.auth_url,
                callback,
                flow.issuer.as_deref(),
                flow.issuer_required,
            )?;
            pending
                .remove(flow_id)
                .expect("flow checked under the same lock")
        };
        if flow.control.state.load(Ordering::Acquire) != 0 {
            return Err("授权已取消".into());
        }
        flow.session
            .handle_callback_url(callback)
            .await
            .map_err(|e| e.to_string())?;
        let credentials = flow
            .staging
            .load()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("授权服务器没有返回凭据")?;
        Ok(Commit {
            config: flow.config.clone(),
            binding: flow.binding,
            epoch: flow.epoch,
            flow_epoch: flow.flow_epoch,
            control: flow.control,
            _permit: flow._permit,
            document: Document {
                version: 1,
                server_id: flow.config.id,
                url: flow.config.url.unwrap_or_default(),
                identity: flow.identity,
                credentials,
            },
        })
    }

    pub async fn commit(&self, commit: Commit) -> Result<(), String> {
        let _guard = commit.binding.io.lock().await;
        if commit.binding.epoch.load(Ordering::Acquire) != commit.epoch
            || commit.binding.flow_epoch.load(Ordering::Acquire) != commit.flow_epoch
        {
            return Err("MCP 配置或登录状态已变化，请重新登录".into());
        }
        commit
            .control
            .state
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "授权已取消，令牌没有保存")?;
        // Invalidate old transports even if writing fails; they must never overwrite a new login.
        commit.binding.epoch.fetch_add(1, Ordering::AcqRel);
        write_document(&commit.binding.path, &commit.document)
            .await
            .map_err(|e| e.to_string())?;
        self.changes.send_modify(|revision| *revision += 1);
        Ok(())
    }

    pub async fn forget(&self, config: &McpServerConfig) -> Result<(), String> {
        self.cancel_controls(|control| control.server_id == config.id);
        let binding = self.binding(config);
        let _guard = binding.io.lock().await;
        binding.epoch.fetch_add(1, Ordering::AcqRel);
        binding.flow_epoch.fetch_add(1, Ordering::AcqRel);
        self.pending
            .lock()
            .unwrap()
            .retain(|_, flow| flow.config.id != config.id);
        remove_file(&binding.path)
            .await
            .map_err(|e| e.to_string())?;
        self.changes.send_modify(|revision| *revision += 1);
        Ok(())
    }

    pub async fn client(
        &self,
        config: &McpServerConfig,
        client: reqwest::Client,
    ) -> Result<AuthClient<reqwest::Client>, String> {
        let binding = self.binding(config);
        let store = Store {
            epoch: binding.epoch.load(Ordering::Acquire),
            binding: binding.clone(),
        };
        let document = store.document().await.map_err(|e| e.to_string())?;
        let mut manager = new_manager(&binding.url).await?;
        manager.set_credential_store(store);
        if manager
            .initialize_from_store()
            .await
            .map_err(|e| e.to_string())?
            && let Some(document) = document
        {
            // The SDK restores a public client id; preserve confidential DCR/client secrets too.
            manager
                .configure_client(document.identity.to_sdk())
                .map_err(|e| e.to_string())?;
        }
        Ok(AuthClient::new(client, manager))
    }
}

async fn new_manager(url: &str) -> Result<AuthorizationManager, String> {
    let url = url.to_string();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || runtime.block_on(AuthorizationManager::new(url)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

fn validate_redirect(uri: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(uri).map_err(|_| "回调地址无效")?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !(url.scheme() == "https" && url.host_str().is_some()
            || url.scheme() == "http" && loopback
            || url.scheme() == "fastvibe" && url.host_str() == Some("oauth"))
    {
        return Err("回调地址需要本机 HTTP、HTTPS 或 FastVibe 回调地址".into());
    }
    Ok(())
}

fn validate_callback(
    redirect: &str,
    authorization: &str,
    callback: &str,
    issuer: Option<&str>,
    issuer_required: bool,
) -> Result<(), String> {
    let expected = reqwest::Url::parse(redirect).map_err(|_| "回调地址无效")?;
    let mut actual = reqwest::Url::parse(callback).map_err(|_| "回调地址无效")?;
    let mut query = BTreeMap::<String, String>::new();
    for (key, value) in actual.query_pairs() {
        if query.insert(key.to_string(), value.to_string()).is_some() {
            return Err("回调参数不能重复".into());
        }
    }
    actual.set_query(None);
    if actual != expected {
        return Err("回调地址与本次登录不一致".into());
    }
    let received_issuer = query.get("iss").map(String::as_str);
    if received_issuer.is_some() && received_issuer != issuer
        || issuer_required && received_issuer.is_none()
    {
        return Err("授权回调的 issuer 不一致".into());
    }
    if query.contains_key("error") {
        return Err("授权被拒绝或取消".into());
    }
    let auth = reqwest::Url::parse(authorization).map_err(|_| "授权地址无效")?;
    let state = auth
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .ok_or("授权地址缺少 state")?;
    if query.get("state") != Some(&state) || query.get("code").is_none_or(|code| code.is_empty()) {
        return Err("回调 state 或授权码无效".into());
    }
    Ok(())
}

async fn remove_file(path: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

async fn write_document(path: &Path, document: &Document) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("credential directory missing"))?;
    tokio::fs::create_dir_all(parent).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(document)?;
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temp).await?;
    use tokio::io::AsyncWriteExt;
    let result = async {
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        tokio::fs::rename(&temp, path).await
    }
    .await;
    if result.is_err() {
        drop(file);
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}
