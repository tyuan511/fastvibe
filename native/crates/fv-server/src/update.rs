use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::AppUpdateInfo;

const RELEASES_URL: &str = "https://api.github.com/repos/tyuan511/fastvibe/releases/latest";

pub async fn check(state: &crate::state::ServerState) -> Result<AppUpdateInfo, ErrorObject> {
    let settings = crate::settings::read(state)?;
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("FastVibe-update-check");
    if !settings.proxy_url.is_empty() {
        builder = builder.proxy(
            reqwest::Proxy::all(&settings.proxy_url)
                .map_err(|_| ErrorObject::new(code::INVALID_PARAMS, "invalid proxy URL"))?,
        );
    }
    let response = builder
        .build()
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e.to_string()))?
        .get(RELEASES_URL)
        .send()
        .await
        .map_err(|_| ErrorObject::new(code::INTERNAL_ERROR, "update check failed"))?
        .error_for_status()
        .map_err(|_| ErrorObject::new(code::INTERNAL_ERROR, "update check failed"))?;
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| ErrorObject::new(code::INTERNAL_ERROR, "update metadata was invalid"))?;
    let latest = value
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .map(|tag| tag.trim_start_matches('v').to_string());
    let release_url = value
        .get("html_url")
        .and_then(serde_json::Value::as_str)
        .filter(|url| fv_core::safe_web_url(url).is_some())
        .map(str::to_string);
    let notes = value
        .get("body")
        .and_then(serde_json::Value::as_str)
        .map(|body| body.chars().take(4_000).collect());
    Ok(AppUpdateInfo {
        current_version: crate::SERVER_VERSION.into(),
        latest_version: latest,
        release_url,
        notes,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn release_url_is_only_accepted_from_http() {
        assert!(fv_core::safe_web_url("https://github.com/tyuan511/fastvibe/releases").is_some());
        assert!(fv_core::safe_web_url("file:///tmp/release").is_none());
    }
}
