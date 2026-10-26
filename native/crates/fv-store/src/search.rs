//! Unicode-safe excerpts for a literal, case-insensitive search.

/// `query` is already lowercased. Clip by original character positions, even when folding
/// expands a character (for example İ → i + combining dot). Extra memory is one folded
/// string plus the small excerpt, rather than a byte-to-character index of the entire text.
pub fn search_snippet(text: &str, query: &str) -> Option<String> {
    if query.is_empty() {
        return None;
    }
    let folded = text.to_lowercase();
    let at = folded.find(query)?;
    let end = at + query.len();
    let (mut offset, mut first, mut last) = (0, 0usize, 0usize);
    for (i, c) in text.chars().enumerate() {
        let next = offset + c.to_lowercase().map(char::len_utf8).sum::<usize>();
        if offset <= at && at < next {
            first = i;
        }
        if next >= end {
            last = i + 1;
            break;
        }
        offset = next;
    }
    let start = first.saturating_sub(24);
    let keep = last + 40 - start;
    let mut chars: Vec<char> = text
        .chars()
        .skip(start)
        .take(keep + 1)
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect();
    let clipped_end = chars.len() > keep;
    chars.truncate(keep);
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(chars);
    if clipped_end {
        out.push('…');
    }
    Some(out)
}
