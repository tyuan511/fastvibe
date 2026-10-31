//! Bounded, proxy-aware model discovery. Failure text never contains response bodies or credentials.

use crate::{Protocol, engine_base_url};
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedModel {
    pub id: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchModelsError {
    category: &'static str,
    status: Option<u16>,
    message: &'static str,
}
impl FetchModelsError {
    pub fn category(&self) -> &'static str {
        self.category
    }
    pub fn status(&self) -> Option<u16> {
        self.status
    }
    fn new(category: &'static str, message: &'static str) -> Self {
        Self {
            category,
            status: None,
            message,
        }
    }
}
impl std::fmt::Display for FetchModelsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(status) = self.status {
            write!(f, " ({status})")?;
        }
        Ok(())
    }
}
impl std::error::Error for FetchModelsError {}

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_PAGES: usize = 20;
const TIMEOUT: Duration = Duration::from_secs(20);

/// Compatibility entry point; server callers use the explicit proxy variant.
pub async fn fetch_models(
    protocol: Protocol,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<FetchedModel>, String> {
    fetch_models_with_proxy(protocol, base_url, api_key, None)
        .await
        .map_err(|e| e.to_string())
}

pub async fn fetch_models_with_proxy(
    protocol: Protocol,
    base_url: &str,
    api_key: &str,
    proxy_url: Option<&str>,
) -> Result<Vec<FetchedModel>, FetchModelsError> {
    let base_url = base_url.trim();
    if base_url.is_empty() {
        return Err(FetchModelsError::new("invalidUrl", "the base URL is empty"));
    }
    let parsed = reqwest::Url::parse(base_url)
        .map_err(|_| FetchModelsError::new("invalidUrl", "the base URL is invalid"))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(FetchModelsError::new(
            "invalidUrl",
            "the base URL must be HTTP(S), without credentials, query or fragment",
        ));
    }
    let base = engine_base_url(protocol, base_url);
    let mut builder = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = proxy_url.filter(|v| !v.is_empty()) {
        builder =
            builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| {
                FetchModelsError::new("proxy", "the proxy configuration is invalid")
            })?);
    }
    let client = builder.build().map_err(|_| {
        FetchModelsError::new("network", "could not create the provider connection")
    })?;
    let work = async {
        let mut models = Vec::new();
        let mut cursor = String::new();
        let mut seen = std::collections::HashSet::new();
        let mut remaining = MAX_BYTES;
        for _ in 0..MAX_PAGES {
            let mut url = reqwest::Url::parse(&format!("{base}models"))
                .map_err(|_| FetchModelsError::new("invalidUrl", "the base URL is invalid"))?;
            match protocol {
                Protocol::Google => {
                    url.query_pairs_mut().append_pair("pageSize", "1000");
                    if !cursor.is_empty() {
                        url.query_pairs_mut().append_pair("pageToken", &cursor);
                    }
                }
                Protocol::Anthropic => {
                    url.query_pairs_mut().append_pair("limit", "1000");
                    if !cursor.is_empty() {
                        url.query_pairs_mut().append_pair("after_id", &cursor);
                    }
                }
                _ => {}
            }
            let mut request = client.get(url).header("accept", "application/json");
            request = match protocol {
                Protocol::Anthropic => request
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01"),
                Protocol::Google => request
                    .header("x-goog-api-key", api_key)
                    .bearer_auth(api_key),
                _ => request.bearer_auth(api_key),
            };
            let response = request.send().await.map_err(network_error)?;
            let status = response.status();
            if !status.is_success() {
                let (category, message) = match status.as_u16() {
                    401 | 403 => ("authentication", "the API key is invalid or has no access"),
                    429 => ("rateLimit", "the provider is rate limited; try again later"),
                    _ => ("http", "the provider could not list models"),
                };
                return Err(FetchModelsError {
                    category,
                    status: Some(status.as_u16()),
                    message,
                });
            }
            if response
                .content_length()
                .is_some_and(|n| n > remaining as u64)
            {
                return Err(too_large());
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(network_error)?;
                if chunk.len() > remaining {
                    return Err(too_large());
                }
                remaining -= chunk.len();
                bytes.extend_from_slice(&chunk);
            }
            let json: Value = serde_json::from_slice(&bytes).map_err(|_| {
                FetchModelsError::new(
                    "invalidResponse",
                    "the provider's list of models was not JSON",
                )
            })?;
            models.extend(parse(protocol, &json));
            cursor = match protocol {
                Protocol::Google => json
                    .get("nextPageToken")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                Protocol::Anthropic if json.get("has_more") == Some(&Value::Bool(true)) => json
                    .get("last_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                _ => String::new(),
            };
            if cursor.is_empty() {
                models.sort_by(|a, b| a.id.cmp(&b.id));
                models.dedup_by(|a, b| a.id == b.id);
                if models.is_empty() {
                    return Err(FetchModelsError::new(
                        "empty",
                        "the provider listed no models",
                    ));
                }
                return Ok(models);
            }
            if !seen.insert(cursor.clone()) {
                return Err(FetchModelsError::new(
                    "invalidResponse",
                    "the provider repeated a model-list page",
                ));
            }
        }
        Err(FetchModelsError::new(
            "tooLarge",
            "the provider model list has too many pages",
        ))
    };
    tokio::time::timeout(TIMEOUT, work).await.map_err(|_| {
        FetchModelsError::new("timeout", "the provider did not answer within 20 seconds")
    })?
}
fn too_large() -> FetchModelsError {
    FetchModelsError::new("tooLarge", "the provider model list is too large")
}
fn network_error(error: reqwest::Error) -> FetchModelsError {
    if error.is_timeout() {
        FetchModelsError::new("timeout", "the provider did not answer within 20 seconds")
    } else {
        FetchModelsError::new(
            "network",
            "could not reach the provider; check its address and proxy",
        )
    }
}
fn parse(protocol: Protocol, json: &Value) -> Vec<FetchedModel> {
    let list = json
        .get("data")
        .or_else(|| json.get("models"))
        .or(Some(json))
        .and_then(Value::as_array);
    list.into_iter()
        .flatten()
        .filter(|m| {
            protocol != Protocol::Google
                || m.get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                    .is_none_or(|methods| methods.iter().any(|x| x == "generateContent"))
        })
        .filter_map(|m| {
            let id = m
                .get("id")
                .or_else(|| m.get("model"))
                .or_else(|| m.get("name"))
                .and_then(Value::as_str)
                .or_else(|| m.as_str())?
                .trim();
            let id = if protocol == Protocol::Google {
                id.strip_prefix("models/").unwrap_or(id)
            } else {
                id
            };
            if id.is_empty() {
                return None;
            }
            let name = m
                .get("display_name")
                .or_else(|| m.get("displayName"))
                .or_else(|| m.get("name"))
                .and_then(Value::as_str)
                .filter(|n| *n != id)
                .map(str::to_string);
            Some(FetchedModel {
                id: id.to_string(),
                name,
            })
        })
        .collect()
}
