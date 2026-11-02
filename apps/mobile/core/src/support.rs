use std::sync::Mutex;

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn string_array(value: &serde_json::Value, field: &str) -> Result<Vec<String>, String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| format!("{field} is required"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| format!("{field} must contain strings"))
        })
        .collect()
}

pub(crate) fn required_string_any<'a>(
    value: &'a serde_json::Value,
    fields: &[&str],
) -> Result<&'a str, String> {
    for field in fields {
        if let Ok(found) = required_string(value, field) {
            return Ok(found);
        }
    }
    Err(format!("{} is required", fields.join(" or ")))
}

pub(crate) fn required_string<'a>(
    value: &'a serde_json::Value,
    field: &str,
) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{field} is required"))
}

#[cfg(feature = "iroh-transport")]
pub(crate) fn secret_key_string(key: &iroh::SecretKey) -> String {
    key.to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(feature = "iroh-transport")]
pub(crate) fn parse_secret_key(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err("secretKey must be 64 hexadecimal characters".into());
    }
    let mut bytes = [0u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let text = std::str::from_utf8(chunk).map_err(|_| "secretKey is not hexadecimal")?;
        bytes[index] = u8::from_str_radix(text, 16).map_err(|_| "secretKey is not hexadecimal")?;
    }
    Ok(bytes)
}

pub(crate) fn next_request_id() -> u64 {
    static NEXT_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
