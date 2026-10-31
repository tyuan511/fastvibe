//! Native account/official controller. Credentials stay in this server process and its
//! private native account file. All six management methods must be denied remotely.
use crate::ServerState;
use fv_protocol::{
    ErrorObject,
    account::{AccountLoginResponse, AccountState},
    jsonrpc::code,
    official::{OfficialConfigureParams, OfficialState, OfficialStatus},
    types::ClientOrigin,
};
use fv_rtc::{
    account::{AccountSession, DEFAULT_ISSUER, Issuer, PendingLogin},
    official::{OfficialConfig, OfficialConnection, install_id},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, Weak},
};

#[derive(Clone, Serialize, Deserialize)]
struct Config {
    enabled: bool,
    name: String,
}
struct Inner {
    config: Config,
    account: Option<AccountSession>,
    error: Option<String>,
    refreshing: bool,
    login: Option<tokio::task::JoinHandle<()>>,
    generation: u64,
    official: Option<OfficialConnection>,
    accepting: Option<tokio::task::JoinHandle<()>>,
}
pub struct Official {
    state: Weak<ServerState>,
    issuer: Issuer,
    inner: Mutex<Inner>,
}
fn invalid(error: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(code::INVALID_PARAMS, error.to_string())
}
fn registry() -> &'static Mutex<HashMap<PathBuf, Arc<Official>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<Official>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}
impl Official {
    pub fn for_state(state: &Arc<ServerState>) -> Result<Arc<Self>, ErrorObject> {
        let mut registry = registry().lock().unwrap();
        if let Some(controller) = registry.get(&state.data_dir) {
            if controller
                .state
                .upgrade()
                .is_some_and(|old| Arc::ptr_eq(&old, state))
            {
                return Ok(controller.clone());
            }
            controller.stop();
        }
        // There is no RPC/env-provided issuer. Production account credentials only ever
        // reach the actual account service; fastvibe.dev is a different service.
        let issuer = Issuer::parse(DEFAULT_ISSUER).map_err(invalid)?;
        let account = AccountSession::load(&state.data_dir.join("native-account.json"), &issuer)
            .map_err(invalid)?;
        let config = match std::fs::read(state.data_dir.join("native-official.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(invalid)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config {
                enabled: false,
                name: "FastVibe Native".into(),
            },
            Err(e) => return Err(invalid(e)),
        };
        let controller = Arc::new(Self {
            state: Arc::downgrade(state),
            issuer,
            inner: Mutex::new(Inner {
                config,
                account,
                error: None,
                refreshing: false,
                login: None,
                generation: 0,
                official: None,
                accepting: None,
            }),
        });
        registry.insert(state.data_dir.clone(), controller.clone());
        Ok(controller)
    }
    pub fn account_status(&self) -> AccountState {
        let inner = self.inner.lock().unwrap();
        if inner.login.as_ref().is_some_and(|task| !task.is_finished()) {
            AccountState::SigningIn {
                origin: self.issuer.origin(),
            }
        } else if let Some(account) = &inner.account {
            account.state()
        } else {
            AccountState::SignedOut {
                origin: self.issuer.origin(),
                error: inner.error.clone(),
            }
        }
    }
    pub fn status(&self) -> OfficialState {
        let inner = self.inner.lock().unwrap();
        if let Some(official) = &inner.official {
            return official.state.borrow().clone();
        }
        OfficialState {
            enabled: inner.config.enabled,
            name: inner.config.name.clone(),
            status: if !inner.config.enabled {
                OfficialStatus::Off
            } else if inner.account.is_none() {
                OfficialStatus::SignedOut
            } else {
                OfficialStatus::Connecting
            },
            device_id: None,
            peers: vec![],
            error: None,
        }
    }
    pub fn restore(self: &Arc<Self>) -> Result<(), ErrorObject> {
        self.reconcile()?;
        let (account, generation) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.refreshing {
                return Ok(());
            }
            let Some(account) = inner.account.clone() else {
                return Ok(());
            };
            inner.refreshing = true;
            (account, inner.generation)
        };
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut account = account;
            let result = account.refresh().await;
            let Some(controller) = weak.upgrade() else {
                return;
            };
            let mut inner = controller.inner.lock().unwrap();
            inner.refreshing = false;
            if inner.generation != generation {
                return;
            }
            match result {
                Ok(()) => {
                    if let Some(state) = controller.state.upgrade() {
                        let _ = account.save(&state.data_dir.join("native-account.json"));
                    }
                    inner.account = Some(account);
                }
                Err(fv_rtc::Error::Unauthorized) => {
                    stop_transport(&mut inner);
                    inner.account = None;
                    inner.error = Some("Your account session expired. Sign in again.".into());
                    if let Some(state) = controller.state.upgrade() {
                        let _ = std::fs::remove_file(state.data_dir.join("native-account.json"));
                    }
                }
                Err(_) => {} // offline keeps the saved identity and credential
            }
        });
        Ok(())
    }
    pub async fn login(self: &Arc<Self>) -> Result<AccountLoginResponse, ErrorObject> {
        // Binding is async, but capture a generation first so a concurrent cancel/logout
        // cannot later be overtaken by this begin operation.
        let (generation, name) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.login.as_ref().is_some_and(|task| !task.is_finished()) {
                return Err(invalid("sign-in is already in progress"));
            }
            inner.generation += 1;
            inner.error = None;
            (inner.generation, inner.config.name.clone())
        };
        let pending = PendingLogin::begin(self.issuer.clone(), &name, std::env::consts::OS)
            .await
            .map_err(invalid)?;
        let response = AccountLoginResponse {
            authorize_url: pending.authorize_url().to_string(),
        };
        let weak = Arc::downgrade(self);
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation {
            return Err(invalid("sign-in was cancelled"));
        }
        inner.login = Some(tokio::spawn(async move {
            let result = pending.complete().await;
            let Some(controller) = weak.upgrade() else {
                return;
            };
            let mut inner = controller.inner.lock().unwrap();
            if inner.generation != generation {
                return;
            }
            inner.login = None;
            match result {
                Ok(account) => {
                    let Some(state) = controller.state.upgrade() else {
                        return;
                    };
                    if account
                        .save(&state.data_dir.join("native-account.json"))
                        .is_err()
                    {
                        inner.error =
                            Some("Could not save sign-in on this computer. Try again.".into());
                        return;
                    }
                    stop_transport(&mut inner);
                    inner.account = Some(account);
                    inner.error = None;
                }
                Err(error) => {
                    inner.error = Some(error.to_string());
                }
            }
            drop(inner);
            if let Err(error) = controller.reconcile() {
                eprintln!("official: {}", error.message);
            }
        }));
        Ok(response)
    }
    pub async fn cancel_login(&self) -> AccountState {
        let task = {
            let mut inner = self.inner.lock().unwrap();
            // Invalidate the attempt before requesting cancellation so a completion
            // racing with us can never persist its account after this point.
            inner.generation += 1;
            let task = inner.login.take();
            if let Some(task) = &task {
                task.abort();
            }
            task
        };
        // abort() only schedules cancellation. Joining is the destruction barrier for
        // PendingLogin, its loopback listener, and any accepted callback socket.
        // Never await with the controller mutex held: the task may be completing.
        if let Some(task) = task {
            let _ = task.await;
        }
        self.account_status()
    }
    pub async fn logout(&self) -> Result<AccountState, ErrorObject> {
        self.cancel_login().await;
        let account = {
            let mut inner = self.inner.lock().unwrap();
            stop_transport(&mut inner);
            // Remove local credential before the network request; failed revocation does
            // not make this installation signed in again.
            if let Some(state) = self.state.upgrade() {
                match std::fs::remove_file(state.data_dir.join("native-account.json")) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(invalid(e)),
                }
            }
            inner.account.take()
        };
        if let Some(account) = account {
            let _ = account.logout().await;
        }
        Ok(self.account_status())
    }
    pub fn configure(
        self: &Arc<Self>,
        params: OfficialConfigureParams,
    ) -> Result<OfficialState, ErrorObject> {
        if params.name.trim().is_empty()
            || params.name.chars().count() > 64
            || params.name.chars().any(char::is_control)
        {
            return Err(invalid("computer name must have 1–64 characters"));
        }
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| invalid("server stopped"))?;
        let config = Config {
            enabled: params.enabled,
            name: params.name,
        };
        let bytes = serde_json::to_vec(&config).map_err(invalid)?;
        // Settings contain no credential. Atomic replacement also keeps a crash from
        // leaving an enabled-but-unreadable preference file.
        let mut temp = tempfile::NamedTempFile::new_in(&state.data_dir).map_err(invalid)?;
        use std::io::Write;
        temp.write_all(&bytes).map_err(invalid)?;
        temp.persist(state.data_dir.join("native-official.json"))
            .map_err(invalid)?;
        let mut inner = self.inner.lock().unwrap();
        stop_transport(&mut inner);
        inner.config = config;
        drop(inner);
        self.reconcile()?;
        Ok(self.status())
    }
    fn reconcile(self: &Arc<Self>) -> Result<(), ErrorObject> {
        let Some(state) = self.state.upgrade() else {
            return Ok(());
        };
        let mut inner = self.inner.lock().unwrap();
        if !inner.config.enabled || inner.account.is_none() {
            stop_transport(&mut inner);
            return Ok(());
        }
        if inner.official.is_some() {
            return Ok(());
        }
        let config = OfficialConfig::new(
            install_id(&state.data_dir.join("native-rtc-install-id")).map_err(invalid)?,
            inner.config.name.clone(),
            format!("native-{}", std::env::consts::OS),
        );
        let mut official =
            OfficialConnection::start(inner.account.as_ref().unwrap().clone(), config)
                .map_err(invalid)?;
        // Receiver ownership belongs to the forwarding task; retain the handle so disabling
        // official access cancels every accepted peer, including active protocol sessions.
        let (_, placeholder) = tokio::sync::mpsc::channel(1);
        let mut accepted = std::mem::replace(&mut official.accepted, placeholder);
        let weak = Arc::downgrade(&state);
        inner.accepting = Some(tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = connections.join_next(), if !connections.is_empty() => {},
                    connection = accepted.recv() => {
                        let Some(connection) = connection else { break; };
                        let Some(state) = weak.upgrade() else { break; };
                        let (read, write) = tokio::io::split(connection.stream);
                        connections.spawn(Box::pin(crate::serve_connection(state, ClientOrigin::Official, read, write)) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>);
                    }
                }
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        }));
        inner.official = Some(official);
        Ok(())
    }
    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.generation += 1;
        if let Some(task) = inner.login.take() {
            task.abort();
        }
        stop_transport(&mut inner);
    }
}
fn stop_transport(inner: &mut Inner) {
    inner.official.take();
    if let Some(task) = inner.accepting.take() {
        task.abort();
    }
}

/// Remove the process registry entry after stopping services, so tests and replaced
/// native servers do not retain controllers for data directories that no longer exist.
pub fn shutdown(state: &Arc<ServerState>) {
    let controller = registry().lock().unwrap().remove(&state.data_dir);
    if let Some(controller) = controller {
        controller.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn fixture() -> (tempfile::TempDir, Arc<ServerState>, Arc<Official>) {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(
            ServerState::new(
                dir.path().into(),
                crate::agent_with_builtin_tools(Arc::new(fv_agent::testing::NoModel)),
            )
            .unwrap(),
        );
        let controller = Arc::new(Official {
            state: Arc::downgrade(&state),
            // Test-only fixed loopback issuer; no production environment override exists.
            issuer: Issuer::parse("http://127.0.0.1:9").unwrap(),
            inner: Mutex::new(Inner {
                config: Config {
                    enabled: false,
                    name: "Fixture".into(),
                },
                account: None,
                error: None,
                refreshing: false,
                login: None,
                generation: 0,
                official: None,
                accepting: None,
            }),
        });
        (dir, state, controller)
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_login_drops_listener_and_late_callback_cannot_sign_in() {
        let (dir, _state, controller) = fixture();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            for _ in 0..8 {
                let login = controller.login().await.unwrap();
                let url = url_for_test(&login.authorize_url);
                assert!(matches!(
                    controller.account_status(),
                    AccountState::SigningIn { .. }
                ));
                assert!(controller.login().await.is_err());
                controller.cancel_login().await;
                // No yield/sleep: the API must acknowledge only after socket cleanup.
                assert!(matches!(
                    controller.account_status(),
                    AccountState::SignedOut { error: None, .. }
                ));
                assert!(
                    tokio::net::TcpStream::connect(("127.0.0.1", url.0))
                        .await
                        .is_err()
                );
                assert!(!dir.path().join("native-account.json").exists());
            }
        })
        .await
        .expect("login cancellation must finish promptly");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_closes_an_already_connected_callback_before_acknowledging() {
        let (dir, _state, controller) = fixture();
        let login = controller.login().await.unwrap();
        let (port, state) = url_for_test(&login.authorize_url);
        let mut callback = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        // Leave a valid callback's HTTP headers unfinished. It must not hold cancel
        // until the HTTP read deadline or allow a late token exchange after cancel.
        callback
            .write_all(format!("GET /callback?code=late&state={state} HTTP/1.1\r\n").as_bytes())
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), controller.cancel_login())
            .await
            .unwrap();
        let mut byte = [0];
        let read =
            tokio::time::timeout(std::time::Duration::from_secs(1), callback.read(&mut byte))
                .await
                .unwrap();
        assert!(
            matches!(read, Ok(0)) || read.is_err(),
            "cancelled callback must be closed"
        );
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
        );
        assert!(!dir.path().join("native-account.json").exists());
        assert!(matches!(
            controller.account_status(),
            AccountState::SignedOut { .. }
        ));
    }
    fn url_for_test(authorize: &str) -> (u16, String) {
        // Server already depends on reqwest, whose URL type is the same parser used by login.
        let url = reqwest::Url::parse(authorize).unwrap();
        let pairs: HashMap<_, _> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let redirect = reqwest::Url::parse(&pairs["redirect_uri"]).unwrap();
        (redirect.port().unwrap(), pairs["state"].clone())
    }
    #[tokio::test]
    async fn denied_login_surfaces_public_error_and_never_writes_credential() {
        let (dir, _state, controller) = fixture();
        let login = controller.login().await.unwrap();
        let (port, state) = url_for_test(&login.authorize_url);
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        socket.write_all(format!("GET /callback?error=access_denied&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        socket.read_to_end(&mut bytes).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while matches!(controller.account_status(), AccountState::SigningIn { .. }) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(
            controller.account_status(),
            AccountState::SignedOut { error: Some(_), .. }
        ));
        assert!(!dir.path().join("native-account.json").exists());
        controller.stop();
    }
    #[tokio::test]
    async fn config_persist_failure_preserves_effective_state_and_logout_cancels_login() {
        let (dir, _state, controller) = fixture();
        std::fs::create_dir(dir.path().join("native-official.json")).unwrap();
        assert!(
            controller
                .configure(OfficialConfigureParams {
                    enabled: true,
                    name: "Changed".into()
                })
                .is_err()
        );
        assert!(!controller.status().enabled);
        assert_eq!(controller.status().name, "Fixture");
        controller.login().await.unwrap();
        assert!(matches!(
            controller.logout().await.unwrap(),
            AccountState::SignedOut { .. }
        ));
        assert!(controller.inner.lock().unwrap().login.is_none());
    }
    #[tokio::test]
    async fn public_status_has_no_account_token_and_native_config_roundtrips() {
        let (dir, state, controller) = fixture();
        assert!(matches!(
            controller.account_status(),
            AccountState::SignedOut { .. }
        ));
        controller
            .configure(OfficialConfigureParams {
                enabled: true,
                name: "Native fixture".into(),
            })
            .unwrap();
        assert_eq!(controller.status().status, OfficialStatus::SignedOut);
        let saved: Config = serde_json::from_slice(
            &std::fs::read(dir.path().join("native-official.json")).unwrap(),
        )
        .unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.name, "Native fixture");
        // Production construction performs no account network request for signed-out state.
        let production = Official::for_state(&state).unwrap();
        assert!(matches!(
            production.account_status(),
            AccountState::SignedOut { .. }
        ));
        shutdown(&state);
        assert!(!registry().lock().unwrap().contains_key(&state.data_dir));
    }
}
