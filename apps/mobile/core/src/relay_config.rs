//! Account relay nodes shared by lease decoding and transport commands.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileRelayNode {
    #[serde(default, alias = "relay_id")]
    pub relay_id: String,
    pub url: String,
    #[serde(default, alias = "quic_port", skip_serializing_if = "Option::is_none")]
    pub quic_port: Option<u16>,
    pub token: String,
}

/// An explicitly supplied node list is authoritative, including invalid/empty lists.
/// Legacy connect commands may contain only URL and token, without discovery metadata.
pub fn parse_relay_nodes(value: &Value) -> Result<Vec<MobileRelayNode>, String> {
    let list = value.get("relays");
    let nodes: Vec<MobileRelayNode> = match list {
        Some(raw) => {
            serde_json::from_value(raw.clone()).map_err(|_| "invalid relay node list".to_owned())?
        }
        None => vec![
            serde_json::from_value(value.clone())
                .map_err(|_| "invalid legacy relay configuration".to_owned())?,
        ],
    };
    if nodes.is_empty() {
        return Err("relay node list must not be empty".into());
    }
    let mut urls = HashSet::new();
    for node in &nodes {
        if node.token.trim().is_empty() {
            return Err("relay token must not be empty".into());
        }
        if list.is_some() && (node.relay_id.trim().is_empty() || node.quic_port.is_none()) {
            return Err("relay nodes require relay id and QUIC discovery port".into());
        }
        if node.quic_port == Some(0) {
            return Err("invalid relay QUIC discovery port".into());
        }
        #[cfg(feature = "mobile-client")]
        let parsed = url::Url::parse(&node.url).map_err(|_| "invalid relay URL".to_owned())?;
        #[cfg(all(not(feature = "mobile-client"), feature = "iroh-transport"))]
        let parsed = node
            .url
            .parse::<iroh::RelayUrl>()
            .map_err(|_| "invalid relay URL".to_owned())?;
        if !matches!(parsed.scheme(), "https" | "http")
            || parsed.host_str().is_none()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("relay URL must be an HTTP(S) origin".into());
        }
        if !urls.insert(parsed.to_string()) {
            return Err("duplicate relay URL".into());
        }
    }
    Ok(nodes)
}

pub fn redact_relay_tokens(error: &str, nodes: &[MobileRelayNode]) -> String {
    nodes.iter().fold(error.to_owned(), |message, node| {
        if node.token.is_empty() {
            message
        } else {
            message.replace(&node.token, "[redacted]")
        }
    })
}
