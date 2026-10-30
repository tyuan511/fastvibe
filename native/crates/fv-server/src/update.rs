use fv_protocol::ErrorObject;
use fv_protocol::jsonrpc::code;
use fv_protocol::types::AppUpdateInfo;

pub async fn check(state: &crate::state::ServerState) -> Result<AppUpdateInfo, ErrorObject> {
    let settings = crate::settings::read(state)?;
    let release = fv_update::check(crate::SERVER_VERSION, &settings.proxy_url)
        .await
        .map_err(|e| ErrorObject::new(code::INTERNAL_ERROR, e))?;
    Ok(AppUpdateInfo {
        current_version: crate::SERVER_VERSION.into(),
        latest_version: release.as_ref().map(|r| r.version.clone()),
        release_url: release.as_ref().map(|r| r.url.clone()),
        notes: release.map(|r| r.notes),
    })
}
