//! The Electron context panel's count, speed and cache-hit conventions.
use fv_protocol::types::{RequestUsage, TokenCounts};

pub fn format_count(value: Option<u64>) -> String {
    match value {
        None => "—".into(),
        Some(v) if v >= 1_000_000 => format!("{:.1}M", v as f64 / 1_000_000.0),
        Some(v) if v >= 1_000 => format!("{:.1}K", v as f64 / 1_000.0),
        Some(v) => v.to_string(),
    }
}

pub fn token_pair(tokens: Option<&TokenCounts>) -> String {
    let Some(tokens) = tokens else {
        return "—".into();
    };
    format!(
        "{} ↑ · {} ↓",
        format_count(Some(tokens.input)),
        format_count(Some(tokens.output))
    )
}

pub fn format_speed(request: Option<&RequestUsage>) -> String {
    match request {
        Some(RequestUsage {
            output_tokens,
            duration_ms: Some(ms),
        }) if *output_tokens > 0 && *ms > 0 => format!(
            "~{:.0} tok/s",
            (*output_tokens as f64 * 1000.0 / *ms as f64).round()
        ),
        _ => "—".into(),
    }
}

pub fn cache_hit(tokens: &TokenCounts) -> Option<u64> {
    let base = tokens.input as u128 + tokens.cache_read as u128;
    (base > 0).then(|| ((tokens.cache_read as f64 / base as f64) * 100.0).round() as u64)
}

pub fn format_cost(cost: Option<f64>) -> String {
    cost.filter(|c| c.is_finite() && *c >= 0.0)
        .map(|c| format!("${c:.3}"))
        .unwrap_or_else(|| "—".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_speed_and_unknowns_follow_the_electron_panel() {
        assert_eq!(format_count(Some(48_210)), "48.2K");
        assert_eq!(format_count(Some(1_200_000)), "1.2M");
        assert_eq!(format_count(Some(0)), "0");
        assert_eq!(format_count(None), "—");
        assert_eq!(token_pair(None), "—");
        assert_eq!(
            format_speed(Some(&RequestUsage {
                output_tokens: 320,
                duration_ms: Some(4000)
            })),
            "~80 tok/s"
        );
        assert_eq!(
            format_speed(Some(&RequestUsage {
                output_tokens: 320,
                duration_ms: None
            })),
            "—"
        );
        assert_eq!(
            format_speed(Some(&RequestUsage {
                output_tokens: 0,
                duration_ms: Some(4000)
            })),
            "—"
        );
        assert_eq!(format_cost(None), "—");
        assert_eq!(format_cost(Some(0.184)), "$0.184");
    }
    #[test]
    fn cache_writes_are_not_hits_and_empty_prompts_are_unknown() {
        assert_eq!(
            cache_hit(&TokenCounts {
                input: 75,
                cache_read: 25,
                cache_write: 900,
                ..Default::default()
            }),
            Some(25)
        );
        assert_eq!(cache_hit(&TokenCounts::default()), None);
    }
}
