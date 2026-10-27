//! Provider-hosted search metadata is never a local function call or tool result.
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchStatus {
    InProgress,
    Searching,
    Completed,
    Failed,
    Interrupted,
}
impl SearchStatus {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSource {
    pub url: String,
    pub title: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlCitation {
    pub start_index: usize,
    pub end_index: usize,
    pub url: String,
    pub title: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchCall {
    pub id: String,
    pub status: SearchStatus,
    pub action: Value,
    pub sources: Vec<WebSource>,
}
pub fn safe_web_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}
fn label(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .flat_map(|c| {
            if matches!(c, '[' | ']' | '\\' | '`') {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}
pub fn citation_markdown(text: &str, citations: &[UrlCitation]) -> String {
    let mut positions = text.char_indices().map(|(i, _)| i).collect::<Vec<_>>();
    positions.push(text.len());
    let mut ordered = citations.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|c| (c.start_index, c.end_index));
    let mut out = String::new();
    let mut cursor = 0;
    let mut fallback = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for c in ordered {
        let Some(url) = safe_web_url(&c.url) else {
            continue;
        };
        if c.start_index >= c.end_index
            || c.end_index >= positions.len()
            || positions[c.start_index] < cursor
        {
            if seen.insert(url.clone()) {
                fallback.push((c.title.clone(), url));
            }
            continue;
        }
        let (start, end) = (positions[c.start_index], positions[c.end_index]);
        let selected = &text[start..end];
        let title = if selected.contains('\u{e200}') || selected.trim().is_empty() {
            &c.title
        } else {
            selected
        };
        out.push_str(&text[cursor..start]);
        out.push_str(&format!("[{}](<{url}>)", label(title)));
        cursor = end;
        seen.insert(url);
    }
    out.push_str(&text[cursor..]);
    if !fallback.is_empty() {
        out.push_str("\n\n来源：");
        out.push_str(
            &fallback
                .into_iter()
                .map(|(title, url)| {
                    format!(
                        "[{}](<{url}>)",
                        label(if title.is_empty() { "来源" } else { &title })
                    )
                })
                .collect::<Vec<_>>()
                .join(" · "),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_offsets_markers_overlap_and_invalid_urls_remain_safe() {
        let text = "😀中文 cites1 end";
        let c = UrlCitation {
            start_index: 4,
            end_index: 15,
            url: "https://example.com/a_(b)".into(),
            title: "来源 [一]".into(),
        };
        let c = UrlCitation {
            end_index: text.chars().count() - 4,
            ..c
        };
        let rendered = citation_markdown(text, std::slice::from_ref(&c));
        assert!(rendered.contains("😀中文 "));
        assert!(rendered.contains("https://example.com/a_(b)"));
        assert!(!rendered.contains('\u{e200}'));
        let invalid = UrlCitation {
            url: "javascript:alert(1)".into(),
            ..c.clone()
        };
        assert_eq!(citation_markdown(text, &[invalid]), text);
        let bad = UrlCitation {
            start_index: 1000,
            end_index: 2000,
            ..c
        };
        assert!(citation_markdown(text, &[bad]).contains("来源："));
        assert!(safe_web_url("https://user:password@example.com").is_none());
    }
    #[test]
    fn citation_positions_use_unicode_scalars_and_never_split_utf8() {
        let c = UrlCitation {
            start_index: 1,
            end_index: 3,
            url: "https://example.com".into(),
            title: "Chinese".into(),
        };
        assert_eq!(
            citation_markdown("😀中文 end", &[c]),
            "😀[中文](<https://example.com/>) end"
        );
    }
}
