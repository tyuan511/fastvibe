//! In-memory QR for native mobile: only origin and public discovery metadata.
use gpui_kit::gpui::{Image, ImageFormat};
use qrcode::{QrCode, render::svg};
use std::sync::Arc;

pub(super) fn payload(origin: &str, name: &str, id: &str) -> Option<String> {
    let mut url = url::Url::parse(origin).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    url.query_pairs_mut()
        .append_pair("transport", "fv-protocol")
        .append_pair("v", "1")
        .append_pair(
            "protocolVersion",
            &fv_protocol::PROTOCOL_VERSION.to_string(),
        )
        .append_pair("name", name)
        .append_pair("id", id);
    Some(url.into())
}

pub(super) fn image(origin: &str, name: &str, id: &str) -> Option<Arc<Image>> {
    let data = payload(origin, name, id)?;
    let code = QrCode::new(data.as_bytes()).ok()?;
    // QR is machine-readable ink on paper in every theme, with the standard quiet zone.
    let svg = code.render::<svg::Color>().min_dimensions(224, 224).build();
    Some(Arc::new(Image::from_bytes(
        ImageFormat::Svg,
        svg.into_bytes(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn payload_has_native_identity_and_no_credentials() {
        for origin in ["http://192.168.1.2:7777", "http://[2001:db8::1]:7777"] {
            let text = payload(origin, "电脑 & Desk", "test-install").unwrap();
            let url = url::Url::parse(&text).unwrap();
            let pairs = url
                .query_pairs()
                .collect::<std::collections::HashMap<_, _>>();
            assert_eq!(pairs["transport"], "fv-protocol");
            assert_eq!(pairs["name"], "电脑 & Desk");
            assert_eq!(pairs["id"], "test-install");
            assert_eq!(pairs.len(), 5);
            assert!(image(origin, "Desk", "test-install").is_some());
        }
        for bad in [
            "http://user:password@192.168.1.2:7777",
            "http://192.168.1.2/?token=secret",
            "file:///tmp/qr",
        ] {
            assert!(payload(bad, "Desk", "id").is_none());
        }
    }
}
