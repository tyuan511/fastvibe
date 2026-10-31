//! RFC 8252 loopback + RFC 7636 S256 login. Only public identity is serializable
//! through fv-protocol; the issuer-bound bearer is private and always redacted.
use std::{fmt, io::Write, path::Path, time::Duration};

use fv_protocol::account::{AccountState, AccountUser};
use oauth2::{CsrfToken, PkceCodeChallenge, PkceCodeVerifier};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::{Error, Result};

pub const DEFAULT_ISSUER: &str = "https://app.fastvibe.dev";
const CLIENT_ID: &str = "fastvibe-desktop";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issuer(Url);
impl Issuer {
    /// HTTPS origins only, except HTTP loopback for local contract tests/development.
    pub fn parse(raw: &str) -> Result<Self> {
        let url = Url::parse(raw).map_err(|_| Error::Issuer)?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(url.scheme() == "https" || url.scheme() == "http" && local)
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Issuer);
        }
        Ok(Self(url))
    }
    pub fn origin(&self) -> String {
        self.0.origin().ascii_serialization()
    }
    pub(crate) fn endpoint(&self, path: &str) -> Url {
        self.0.join(path).expect("only fixed service paths")
    }
}

fn http_client() -> Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| Error::Transport)
}

#[derive(Clone)]
pub struct AccountSession {
    issuer: Issuer,
    token: Zeroizing<String>,
    user: AccountUser,
    client: Client,
}
impl fmt::Debug for AccountSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AccountSession")
            .field("issuer", &self.issuer)
            .field("user", &self.user)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
struct StoredAccount {
    version: u32,
    origin: String,
    token: String,
    user: AccountUser,
}
#[derive(Deserialize)]
struct CloudUser {
    id: String,
    login: String,
    avatar_url: String,
    email: Option<String>,
}
impl From<CloudUser> for AccountUser {
    fn from(u: CloudUser) -> Self {
        Self {
            id: u.id,
            login: u.login,
            avatar_url: u.avatar_url,
            email: u.email,
        }
    }
}
impl AccountSession {
    pub fn issuer(&self) -> &Issuer {
        &self.issuer
    }
    pub fn state(&self) -> AccountState {
        AccountState::SignedIn {
            origin: self.issuer.origin(),
            user: self.user.clone(),
        }
    }
    pub fn user(&self) -> &AccountUser {
        &self.user
    }
    pub(crate) fn authorization(
        &self,
    ) -> Result<tokio_tungstenite::tungstenite::http::HeaderValue> {
        let mut value = format!("Bearer {}", self.token.as_str())
            .parse()
            .map_err(|_| Error::Storage)?;
        tokio_tungstenite::tungstenite::http::HeaderValue::set_sensitive(&mut value, true);
        Ok(value)
    }
    /// No caller-provided URL, client or redirect policy can exfiltrate this token.
    pub(crate) async fn call<T: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &'static str,
        body: Option<&T>,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .client
            .request(method, self.issuer.endpoint(path))
            .bearer_auth(self.token.as_str())
            .header("Accept", "application/json");
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|_| Error::Transport)?;
        match response.status().as_u16() {
            401 | 403 => Err(Error::Unauthorized),
            200..=299 => Ok(response),
            status => Err(Error::Http(status)),
        }
    }
    pub async fn refresh(&mut self) -> Result<()> {
        let response = self.call::<()>(Method::GET, "/api/me", None).await?;
        let user: CloudUser = bounded_json(response).await?;
        if user.id != self.user.id || user.id.is_empty() || user.login.is_empty() {
            return Err(Error::Response);
        }
        self.user = user.into();
        Ok(())
    }
    /// Revokes only this app's device session; local file removal belongs to the caller.
    pub async fn logout(self) -> Result<()> {
        self.call::<()>(Method::POST, "/api/auth/logout", None)
            .await?;
        Ok(())
    }
    /// Native storage only. Never point this at Electron's account.json.
    pub fn save(&self, file: &Path) -> Result<()> {
        let mut stored = StoredAccount {
            version: 1,
            origin: self.issuer.origin(),
            token: self.token.to_string(),
            user: self.user.clone(),
        };
        let serialized = serde_json::to_vec(&stored);
        stored.token.zeroize();
        let bytes = Zeroizing::new(serialized.map_err(|_| Error::Storage)?);
        private_write(file, &bytes)
    }
    pub fn load(file: &Path, issuer: &Issuer) -> Result<Option<Self>> {
        let text = match std::fs::read_to_string(file) {
            Ok(text) => Zeroizing::new(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if text.len() > 64 * 1024 {
            return Err(Error::Storage);
        }
        let stored: StoredAccount = serde_json::from_str(&text).map_err(|_| Error::Storage)?;
        if Issuer::parse(&stored.origin)? != *issuer {
            return Err(Error::IssuerMismatch);
        }
        if stored.version != 1 {
            return Err(Error::Storage);
        }
        Self::new(issuer.clone(), stored.token, stored.user).map(Some)
    }
    fn new(issuer: Issuer, token: String, user: AccountUser) -> Result<Self> {
        if !valid_token(&token) || user.id.is_empty() || user.login.is_empty() {
            return Err(Error::Response);
        }
        Ok(Self {
            issuer,
            token: Zeroizing::new(token),
            user,
            client: http_client()?,
        })
    }
}
fn valid_token(token: &str) -> bool {
    token.len() == 47
        && token.starts_with("fvs_")
        && token[4..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Owns the loopback listener and ephemeral secrets. Dropping it cancels the login.
/// The caller opens `authorize_url()` in the system browser, then awaits `complete()`.
pub struct PendingLogin {
    issuer: Issuer,
    listener: TcpListener,
    redirect: String,
    state: CsrfToken,
    verifier: PkceCodeVerifier,
    authorize: Url,
}
impl PendingLogin {
    pub async fn begin(issuer: Issuer, device_name: &str, platform: &str) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let redirect = format!(
            "http://127.0.0.1:{}/callback",
            listener.local_addr()?.port()
        );
        let state = CsrfToken::new_random();
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let mut authorize = issuer.endpoint("/authorize");
        authorize.query_pairs_mut().extend_pairs([
            ("client_id", CLIENT_ID),
            ("redirect_uri", redirect.as_str()),
            ("state", state.secret()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            (
                "device_name",
                &device_name.chars().take(80).collect::<String>(),
            ),
            ("platform", platform),
        ]);
        Ok(Self {
            issuer,
            listener,
            redirect,
            state,
            verifier,
            authorize,
        })
    }
    pub fn authorize_url(&self) -> &Url {
        &self.authorize
    }
    pub async fn complete(self) -> Result<AccountSession> {
        tokio::time::timeout(Duration::from_secs(300), self.wait())
            .await
            .map_err(|_| Error::Timeout)?
    }
    async fn wait(self) -> Result<AccountSession> {
        loop {
            let (mut socket, _) = self.listener.accept().await?;
            let mut bytes = Vec::new();
            let read = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let mut block = [0; 1024];
                    let n = socket.read(&mut block).await?;
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&block[..n]);
                    if bytes.len() > 8192 || bytes.windows(4).any(|b| b == b"\r\n\r\n") {
                        break;
                    }
                }
                Ok::<_, std::io::Error>(())
            })
            .await;
            if !matches!(read, Ok(Ok(()))) {
                continue;
            }
            let code = self.callback_code(&bytes);
            if matches!(code, Err(Error::Callback)) {
                let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            let result = match code {
                Ok(code) => self.exchange(code).await,
                Err(e) => Err(e),
            };
            // No code, token, identity or remote message is reflected into the browser.
            let body = if result.is_ok() {
                "Signed in. Return to FastVibe Native."
            } else {
                "Sign-in failed. Return to FastVibe Native."
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                socket.write_all(response.as_bytes()),
            )
            .await;
            return result;
        }
    }
    fn callback_code(&self, bytes: &[u8]) -> Result<String> {
        if bytes.len() > 8192 {
            return Err(Error::Callback);
        }
        let text = std::str::from_utf8(bytes).map_err(|_| Error::Callback)?;
        let mut line = text
            .lines()
            .next()
            .ok_or(Error::Callback)?
            .split_whitespace();
        if line.next() != Some("GET") {
            return Err(Error::Callback);
        }
        let target = line.next().ok_or(Error::Callback)?;
        if !target.starts_with("/callback?") {
            return Err(Error::Callback);
        }
        let url = Url::parse(&format!(
            "{}{}",
            self.redirect.trim_end_matches("/callback"),
            target
        ))
        .map_err(|_| Error::Callback)?;
        let pairs: Vec<_> = url.query_pairs().collect();
        let states: Vec<_> = pairs.iter().filter(|(key, _)| key == "state").collect();
        if states.len() != 1 || states[0].1 != *self.state.secret() {
            return Err(Error::Callback);
        }
        if pairs.iter().any(|(key, _)| key == "error") {
            return Err(Error::Denied);
        }
        let codes: Vec<_> = pairs.iter().filter(|(key, _)| key == "code").collect();
        if codes.len() != 1 || codes[0].1.is_empty() || codes[0].1.len() > 2048 {
            return Err(Error::Callback);
        }
        Ok(codes[0].1.to_string())
    }
    async fn exchange(&self, code: String) -> Result<AccountSession> {
        #[derive(Deserialize)]
        struct TokenReply {
            access_token: String,
            token_type: String,
            user: CloudUser,
        }
        let response = http_client()?.post(self.issuer.endpoint("/api/oauth/token")).json(&serde_json::json!({
            "grant_type": "authorization_code", "client_id": CLIENT_ID,
            "code": code, "code_verifier": self.verifier.secret(), "redirect_uri": self.redirect,
        })).send().await.map_err(|_| Error::Transport)?;
        if !response.status().is_success() {
            return Err(Error::Http(response.status().as_u16()));
        }
        let reply: TokenReply = bounded_json(response).await?;
        if !reply.token_type.eq_ignore_ascii_case("Bearer") {
            return Err(Error::Response);
        }
        AccountSession::new(self.issuer.clone(), reply.access_token, reply.user.into())
    }
}

pub(crate) async fn bounded_json<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T> {
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Transport)? {
        if bytes.len() + chunk.len() > 64 * 1024 {
            return Err(Error::Response);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Response)
}

pub(crate) fn private_write(file: &Path, bytes: &[u8]) -> Result<()> {
    let parent = file.parent().ok_or(Error::Storage)?;
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(file).map_err(|e| Error::Io(e.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issuers_are_origins_and_credentials_are_redacted() {
        for bad in [
            "http://example.com",
            "https://a.test/path",
            "https://user@a.test",
            "https://a.test/?x=1",
            "file:///tmp/a",
        ] {
            assert!(Issuer::parse(bad).is_err());
        }
        let issuer = Issuer::parse("https://app.fastvibe.dev").unwrap();
        let token = format!("fvs_{}", "a".repeat(43));
        let account = AccountSession::new(
            issuer.clone(),
            token.clone(),
            AccountUser {
                id: "u".into(),
                login: "test".into(),
                avatar_url: "".into(),
                email: None,
            },
        )
        .unwrap();
        assert!(!format!("{account:?}").contains(&token));
        assert!(
            !serde_json::to_string(&account.state())
                .unwrap()
                .contains(&token)
        );
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("account.json");
        account.save(&file).unwrap();
        assert!(AccountSession::load(&file, &issuer).unwrap().is_some());
        assert!(matches!(
            AccountSession::load(&file, &Issuer::parse("https://other.test").unwrap()),
            Err(Error::IssuerMismatch)
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[tokio::test]
    async fn callback_requires_unique_matching_state_and_pkce_is_s256() {
        let pending = PendingLogin::begin(
            Issuer::parse("http://127.0.0.1:1234").unwrap(),
            "test",
            "macos",
        )
        .await
        .unwrap();
        let state = pending.state.secret();
        assert!(
            pending
                .callback_code(b"GET /callback?code=a&state=wrong HTTP/1.1\r\n\r\n")
                .is_err()
        );
        assert!(
            pending
                .callback_code(
                    format!("GET /callback?code=a&state={state}&state={state} HTTP/1.1\r\n\r\n")
                        .as_bytes()
                )
                .is_err()
        );
        assert_eq!(
            pending
                .callback_code(
                    format!("GET /callback?code=a&state={state} HTTP/1.1\r\n\r\n").as_bytes()
                )
                .unwrap(),
            "a"
        );
        let params: std::collections::HashMap<_, _> = pending.authorize.query_pairs().collect();
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(
            params["code_challenge"],
            PkceCodeChallenge::from_code_verifier_sha256(&pending.verifier).as_str()
        );
    }
}
