use crate::*;
use base64::Engine;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountUser {
    pub id: String,
    pub login: String,
    #[serde(alias = "avatar_url", skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(alias = "email_address", skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub origin: String,
    pub status: String,
    pub user: Option<AccountUser>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileDevice {
    #[serde(alias = "device_id")]
    pub id: String,
    #[serde(alias = "device_name")]
    pub name: String,
    pub platform: String,
    #[serde(alias = "iroh_endpoint_id", skip_serializing_if = "Option::is_none")]
    pub iroh_endpoint_id: Option<String>,
    /// Explicit signaling liveness. `None` means the service did not report it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
    /// Service-provided last-seen timestamp, preserved without interpreting its unit.
    #[serde(
        alias = "last_seen_at",
        alias = "last_seen",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileRelayUsage {
    #[serde(alias = "period_start")]
    pub period_start: String,
    #[serde(alias = "resets_at")]
    pub resets_at: String,
    #[serde(alias = "used_bytes")]
    pub used_bytes: u64,
    #[serde(alias = "quota_bytes")]
    pub quota_bytes: u64,
    #[serde(alias = "remaining_bytes")]
    pub remaining_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileRelayConfig {
    #[serde(alias = "relay_id")]
    pub relay_id: String,
    pub url: String,
    #[serde(alias = "quic_port")]
    pub quic_port: u16,
    pub token: String,
    #[serde(alias = "expires_at")]
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<MobileRelayUsage>,
}

pub struct AccountClient {
    pub origin: String,
    pub token: Option<String>,
    pub user: Option<AccountUser>,
    client: reqwest::Client,
}

impl AccountClient {
    pub fn new(
        origin: impl Into<String>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        // The C ABI has no JVM context; use verified bundled roots rather than Android's JNI verifier.
        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self {
            origin: origin.into().trim_end_matches('/').into(),
            token: None,
            user: None,
            client: reqwest::Client::builder()
                .tls_backend_preconfigured(tls)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(15))
                .build()?,
        })
    }

    pub fn authorize_url(
        &self,
        redirect_uri: &str,
        state: &str,
        verifier: &str,
        device_name: &str,
        platform: &str,
    ) -> String {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url =
            url::Url::parse(&format!("{}/authorize", self.origin)).expect("valid account origin");
        for (key, value) in [
            ("client_id", "fastvibe-mobile"),
            ("redirect_uri", redirect_uri),
            ("state", state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("device_name", device_name),
            ("platform", platform),
        ] {
            url.query_pairs_mut().append_pair(key, value);
        }
        url.into()
    }

    pub async fn exchange(
        &mut self,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<AccountState, Box<dyn std::error::Error + Send + Sync>> {
        let response = self
            .client
            .post(format!("{}/api/oauth/token", self.origin))
            .json(&serde_json::json!({
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                "client_id": "fastvibe-mobile",
                "redirect_uri": redirect_uri,
            }))
            .send()
            .await?;
        let status = response.status();
        let body: serde_json::Value = response.json().await?;
        if !status.is_success() {
            return Err(format!("token exchange failed: {status}").into());
        }
        let token = body
            .get("access_token")
            .and_then(|value| value.as_str())
            .ok_or("missing access token")?
            .to_owned();
        let user: AccountUser =
            serde_json::from_value(body.get("user").cloned().ok_or("missing user")?)?;
        self.token = Some(token.clone());
        self.user = Some(user.clone());
        Ok(AccountState {
            origin: self.origin.clone(),
            status: "signed-in".into(),
            user: Some(user),
            error: None,
            access_token: Some(token),
        })
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<reqwest::Response, Box<dyn std::error::Error + Send + Sync>> {
        let token = self.token.as_deref().ok_or("account is signed out")?;
        let mut request = self
            .client
            .request(method, format!("{}{}", self.origin, path))
            .bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        Ok(request.send().await?)
    }

    pub async fn register_device(
        &self,
        install_id: &str,
        name: &str,
        platform: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let response = self
            .request(
                reqwest::Method::PUT,
                "/api/devices/me",
                Some(register_device_body(install_id, name, platform)),
            )
            .await?;
        let status = response.status();
        let body: serde_json::Value = response.json().await?;
        if !status.is_success() {
            return Err(format!("device registration failed: {status}").into());
        }
        body.get("device")
            .and_then(|value| value.get("id").or_else(|| value.get("device_id")))
            .or_else(|| body.get("id").or_else(|| body.get("device_id")))
            .and_then(|value| value.as_str())
            .ok_or("missing device id".into())
            .map(str::to_owned)
    }

    pub async fn register_endpoint(
        &self,
        device_id: &str,
        endpoint_id: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let response = self
            .request(
                reqwest::Method::PUT,
                &format!(
                    "/api/devices/{}/iroh",
                    url::form_urlencoded::byte_serialize(device_id.as_bytes()).collect::<String>()
                ),
                Some(register_endpoint_body(endpoint_id)),
            )
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("iroh endpoint registration failed: {status}").into());
        }
        Ok(())
    }

    pub async fn devices(
        &self,
    ) -> Result<Vec<MobileDevice>, Box<dyn std::error::Error + Send + Sync>> {
        let response = self
            .request(reqwest::Method::GET, "/api/devices", None)
            .await?;
        let status = response.status();
        let body: serde_json::Value = response.json().await?;
        if !status.is_success() {
            return Err(format!("device list request failed: {status}").into());
        }
        Ok(serde_json::from_value(
            body.get("devices")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([])),
        )?)
    }

    pub async fn relay(
        &self,
        device_id: &str,
        endpoint_id: &str,
    ) -> Result<MobileRelayConfig, Box<dyn std::error::Error + Send + Sync>> {
        let response = self
            .request(
                reqwest::Method::POST,
                "/api/relay/iroh/token",
                Some(relay_body(device_id, endpoint_id)),
            )
            .await?;
        let status = response.status();
        let body: serde_json::Value = response.json().await?;
        if !status.is_success() {
            return Err(format!("relay token request failed: {status}").into());
        }
        Ok(serde_json::from_value(body)?)
    }
}

pub fn register_device_body(install_id: &str, name: &str, platform: &str) -> serde_json::Value {
    serde_json::json!({
        "install_id": install_id,
        "name": name,
        "platform": platform,
    })
}

pub fn register_endpoint_body(endpoint_id: &str) -> serde_json::Value {
    serde_json::json!({"endpoint_id": endpoint_id})
}

pub fn relay_body(device_id: &str, endpoint_id: &str) -> serde_json::Value {
    serde_json::json!({
        "device_id": device_id,
        "endpoint_id": endpoint_id,
    })
}

pub fn random_verifier() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn random_state() -> String {
    let mut bytes = [0u8; 24];
    rand::rng().fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub const URL_SAFE_NO_PAD: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommand {
    pub action: String,
    pub conversation_id: Option<String>,
    pub text: Option<String>,
    pub history_limit: Option<u32>,
}

#[cfg(feature = "iroh-transport")]
use crate::iroh_transport::{IrohClient, IrohRead};

#[cfg(feature = "iroh-transport")]
impl IrohClient {
    pub async fn call(
        &mut self,
        request_id: u64,
        method: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        self.send_json(&AppMessage::Call {
            request_id,
            method: method.into(),
            payload: Some(payload),
            idempotency_key: None,
        })
        .await?;
        loop {
            match self.read_next().await? {
                IrohRead::Message(AppServerMessage::Result {
                    request_id: id,
                    ok,
                    result,
                    error,
                }) if id == request_id => {
                    if ok {
                        return Ok(result.unwrap_or(serde_json::Value::Null));
                    }
                    return Err(error
                        .unwrap_or_else(|| serde_json::json!({"message": "remote call failed"}))
                        .to_string()
                        .into());
                }
                IrohRead::Message(_) => {}
                IrohRead::LegacyAuth => {}
                IrohRead::Ping => self.send_control(PONG).await?,
                IrohRead::Pong => {}
                IrohRead::Close { code, reason } => {
                    return Err(format!("remote closed ({code}): {reason}").into());
                }
            }
        }
    }

    pub async fn subscribe_conversation(
        &mut self,
        conversation_id: &str,
        cursor: Option<WireCursor>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let scope = format!("conversation:{conversation_id}");
        self.send_json(&AppMessage::Subscribe {
            request_id: Some(1),
            scopes: vec![scope.clone()],
            since: cursor.map(|cursor| HashMap::from([(scope, cursor)])),
        })
        .await
    }

    pub async fn read_json(
        &mut self,
    ) -> Result<AppServerMessage, Box<dyn std::error::Error + Send + Sync>> {
        loop {
            match self.read_next().await? {
                IrohRead::Message(message) => return Ok(message),
                IrohRead::LegacyAuth => {}
                IrohRead::Ping => self.send_control(PONG).await?,
                IrohRead::Pong => {}
                IrohRead::Close { code, reason } => {
                    return Err(format!("remote closed ({code}): {reason}").into());
                }
            }
        }
    }
}

pub fn new_login_request(
    origin: &str,
    redirect_uri: &str,
    device_name: &str,
    platform: &str,
) -> Result<(AccountClient, String, String, String), Box<dyn std::error::Error + Send + Sync>> {
    let client = AccountClient::new(origin)?;
    let verifier = random_verifier();
    let state = random_state();
    let url = client.authorize_url(redirect_uri, &state, &verifier, device_name, platform);
    Ok((client, verifier, state, url))
}
