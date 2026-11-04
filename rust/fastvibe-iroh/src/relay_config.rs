use std::collections::BTreeSet;

use iroh::{EndpointAddr, EndpointId, RelayConfig};
use iroh_relay::RelayQuicConfig;
use serde_json::Value;

/// New commands carry all nodes. Legacy binaries/callers can keep using the
/// top-level fields; an explicitly invalid list must never silently pick one.
pub fn from_command(command: &Value) -> Result<Vec<RelayConfig>, Box<dyn std::error::Error>> {
    let entries: Vec<&Value> = match command.get("relays") {
        Some(Value::Array(entries)) if !entries.is_empty() => entries.iter().collect(),
        Some(_) => return Err("relays must be a non-empty array".into()),
        None => vec![command],
    };
    let mut seen = BTreeSet::new();
    let mut configs = Vec::with_capacity(entries.len());
    for entry in entries {
        let url = string(entry, &["relayUrl", "url"])?.parse::<iroh::RelayUrl>()?;
        if !seen.insert(url.clone()) {
            return Err("duplicate relay URL".into());
        }
        let token = string(entry, &["relayToken", "token"])?;
        let port = entry.get("quicPort").or_else(|| entry.get("quic_port"));
        let quic = match port {
            None | Some(Value::Null) => None,
            Some(value) => {
                let port = value
                    .as_u64()
                    .filter(|port| (1..=65535).contains(port))
                    .ok_or("invalid relay QUIC port")?;
                Some(RelayQuicConfig::new(port as u16))
            }
        };
        configs.push(RelayConfig::new(url, quic).with_auth_token(token.to_owned()));
    }
    Ok(configs)
}

/// Supply every potential relay to iroh's path discovery. Passing only the first
/// would keep dialing a dead primary even after selecting another local home.
pub fn remote_addr(remote: EndpointId, configs: &[RelayConfig]) -> EndpointAddr {
    configs
        .iter()
        .fold(EndpointAddr::new(remote), |addr, config| {
            addr.with_relay_url(config.url.clone())
        })
}

fn string<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a str, Box<dyn std::error::Error>> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "relay URL and token are required".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retains_all_node_credentials_ports_and_remote_candidates() {
        let configs = from_command(&json!({"relays":[
            {"relayUrl":"https://a.invalid/","relayToken":"a","quicPort":7842},
            {"relayUrl":"https://b.invalid/","relayToken":"b","quicPort":7843}
        ]}))
        .unwrap();
        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].auth_token.as_deref(), Some("a"));
        assert_eq!(configs[1].auth_token.as_deref(), Some("b"));
        assert_eq!(configs[1].quic.as_ref().unwrap().port, 7843);
        let remote = iroh::SecretKey::generate().public();
        assert_eq!(remote_addr(remote, &configs).relay_urls().count(), 2);
    }

    #[test]
    fn accepts_legacy_single_node_and_cloud_field_spelling() {
        let old =
            from_command(&json!({"relayUrl":"http://localhost:1234/","relayToken":"old"})).unwrap();
        assert_eq!(old.len(), 1);
        assert!(old[0].quic.is_none());
        let new = from_command(
            &json!({"relays":[{"url":"https://a.invalid/","token":"a","quic_port":7842}]}),
        )
        .unwrap();
        assert_eq!(new[0].quic.as_ref().unwrap().port, 7842);
    }

    #[test]
    fn rejects_invalid_lists_instead_of_falling_back_to_legacy_primary() {
        for relays in [
            json!([]),
            json!(null),
            json!([{"url":"https://a.invalid/","token":""}]),
            json!([{"url":"https://a.invalid/","token":"a","quic_port":65536}]),
            json!([{"url":"https://a.invalid/","token":"a"},{"url":"https://a.invalid/","token":"b"}]),
        ] {
            assert!(from_command(&json!({"relays":relays,"relayUrl":"https://legacy.invalid/","relayToken":"old"})).is_err());
        }
    }
}
