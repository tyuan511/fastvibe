//! Asking a provider which models it has, so that setting one up is a pick from its own list
//! rather than typing ids from memory.

use std::time::Duration;

use serde_json::Value;

use crate::{Protocol, engine_base_url};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedModel {
    pub id: String,
    pub name: Option<String>,
}

const TIMEOUT: Duration = Duration::from_secs(20);

/// List the models at `base_url` (as the user typed it) for a provider speaking `protocol`.
pub async fn fetch_models(
    protocol: Protocol,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<FetchedModel>, String> {
    if base_url.trim().is_empty() {
        return Err("the base URL is empty".into());
    }
    let base = engine_base_url(protocol, base_url);
    let url = match protocol {
        Protocol::Google => format!("{base}models?pageSize=1000"),
        Protocol::Anthropic => format!("{base}models?limit=1000"),
        Protocol::OpenAiChat | Protocol::OpenAiResponses => format!("{base}models"),
    };
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(&url).header("accept", "application/json");
    request = match protocol {
        Protocol::OpenAiChat | Protocol::OpenAiResponses => request.bearer_auth(api_key),
        Protocol::Anthropic => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        // Google's own endpoint wants its header; a relay in front of it often wants a bearer.
        Protocol::Google => request
            .header("x-goog-api-key", api_key)
            .bearer_auth(api_key),
    };
    let response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            "the provider did not answer within 20 seconds".to_string()
        } else {
            format!("could not reach the provider: {e}")
        }
    })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("could not read the provider's answer: {e}"))?;
    if !status.is_success() {
        let shown: String = body.trim().chars().take(300).collect();
        return Err(format!("{status}: {shown}"));
    }
    let json: Value = serde_json::from_str(&body)
        .map_err(|_| "the provider's list of models was not JSON".to_string())?;
    let mut models = parse(protocol, &json);
    if models.is_empty() {
        return Err("the provider listed no models".into());
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

fn parse(protocol: Protocol, json: &Value) -> Vec<FetchedModel> {
    if protocol == Protocol::Google {
        return json
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|m| {
                // Embedding and other models cannot chat; when the field is absent, keep it.
                m.get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                    .is_none_or(|methods| methods.iter().any(|x| x == "generateContent"))
            })
            .filter_map(|m| {
                let name = m.get("name")?.as_str()?;
                Some(FetchedModel {
                    id: name.strip_prefix("models/").unwrap_or(name).to_string(),
                    name: m
                        .get("displayName")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            })
            .collect();
    }
    // OpenAI and Anthropic answer `{"data": [...]}`; some relays send `{"models": [...]}` or a bare array.
    let list = json
        .get("data")
        .or_else(|| json.get("models"))
        .or(Some(json))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    list.iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(Value::as_str).or_else(|| m.as_str())?;
            let name = m
                .get("display_name")
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
