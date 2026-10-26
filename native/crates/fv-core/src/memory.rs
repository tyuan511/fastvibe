const OPEN: &str = "<oai-mem-citation>";
const CLOSE: &str = "</oai-mem-citation>";

pub fn memory_citation_ids(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for block in text.split(OPEN).skip(1) {
        let Some((block, _)) = block.split_once(CLOSE) else {
            continue;
        };
        let Some((_, tail)) = block.split_once("<rollout_ids>") else {
            continue;
        };
        let Some((values, _)) = tail.split_once("</rollout_ids>") else {
            continue;
        };
        for id in values.lines().map(str::trim).filter(|id| !id.is_empty()) {
            if !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
    }
    ids
}

fn fence(line: &str, allow_info: bool) -> Option<(char, usize)> {
    let line = line.trim();
    let marker = line.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let count = line.chars().take_while(|c| *c == marker).count();
    let rest = line[count..].trim();
    if count < 3
        || (!rest.is_empty()
            && (!allow_info
                || rest.split_whitespace().count() != 1
                || !rest
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, '.' | '+' | '#' | '-'))))
    {
        return None;
    }
    Some((marker, count))
}

fn wrapper(text: &str, at: usize) -> Option<(usize, char, usize)> {
    let before = &text[..at];
    let trimmed = before.trim_end_matches([' ', '\t', '\r', '\n']);
    if before[trimmed.len()..]
        .chars()
        .filter(|c| *c == '\n')
        .count()
        != 1
    {
        return None;
    }
    let start = trimmed.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let (marker, count) = fence(&trimmed[start..], true)?;
    // A fence directly before the citation can close the answer's real code block. Only an
    // opening fence may be removed as the citation's wrapper, even without a blank separator.
    let mut open = None;
    for line in trimmed[..start].lines() {
        if let Some((m, n)) = open {
            if fence(line, false).is_some_and(|(other, length)| other == m && length >= n) {
                open = None;
            }
        } else {
            open = fence(line, true);
        }
    }
    if open.is_some() {
        return None;
    }
    Some((start, marker, count))
}

/// Hide complete and streaming citation blocks, including a code fence wrapping only the
/// machine block. A code fence containing real prose or code keeps its own delimiters.
pub fn strip_memory_citation(text: &str) -> String {
    let mut out = text.to_string();
    let mut changed = false;
    while let Some(at) = out.find(OPEN) {
        let close = out[at..].find(CLOSE).map(|i| at + i + CLOSE.len());
        let wrapped = wrapper(&out, at);
        let from = wrapped.map(|w| w.0).unwrap_or(at);
        let mut end = close.unwrap_or(out.len());
        if let (Some((_, marker, count)), Some(_)) = (wrapped, close) {
            let after = &out[end..];
            let next = after.trim_start_matches([' ', '\t', '\r', '\n']);
            let gap = after.len() - next.len();
            if after[..gap].chars().filter(|c| *c == '\n').count() == 1 {
                let line_len = next.find('\n').unwrap_or(next.len());
                if fence(&next[..line_len], false).is_some_and(|(m, n)| m == marker && n >= count) {
                    end += gap + line_len;
                }
            }
        }
        out.replace_range(from..end, "");
        changed = true;
    }
    for length in (1..OPEN.len()).rev() {
        if out.ends_with(&OPEN[..length]) {
            let at = out.len() - length;
            let from = wrapper(&out, at).map(|w| w.0).unwrap_or(at);
            out.truncate(from);
            changed = true;
            break;
        }
    }
    if changed {
        out.truncate(out.trim_end().len());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{memory_citation_ids, strip_memory_citation};

    #[test]
    fn citations_are_counted_once_and_only_inside_a_finished_block() {
        let block = "<oai-mem-citation><rollout_ids>\na\nb\na\n</rollout_ids></oai-mem-citation>";
        assert_eq!(memory_citation_ids(&format!("{block}{block}")), ["a", "b"]);
        assert!(memory_citation_ids("<rollout_ids>evil</rollout_ids>").is_empty());
        assert!(memory_citation_ids("<oai-mem-citation><rollout_ids>a</rollout_ids>").is_empty());
    }

    #[test]
    fn streaming_blocks_and_their_lone_fences_are_hidden_without_eating_real_code() {
        let block = "<oai-mem-citation>\nids\n</oai-mem-citation>";
        assert_eq!(
            strip_memory_citation(&format!("回答\n\n```xml\n{block}\n```")),
            "回答"
        );
        assert_eq!(strip_memory_citation("回答\n\n~~~xml\n<oai-mem"), "回答");
        assert_eq!(
            strip_memory_citation(&format!("```xml\nreal code\n{block}\n```")),
            "```xml\nreal code\n\n```"
        );
        assert_eq!(
            strip_memory_citation("```rust\nfn main() {}\n```\n\n<oai-mem"),
            "```rust\nfn main() {}\n```"
        );
        assert_eq!(strip_memory_citation("普通文字"), "普通文字");
        assert_eq!(
            strip_memory_citation(&format!("```rust\nfn main() {{}}\n```\n{block}")),
            "```rust\nfn main() {}\n```"
        );
        assert_eq!(
            strip_memory_citation("~~~rust\nfn main() {}\n~~~\n<oai-mem"),
            "~~~rust\nfn main() {}\n~~~"
        );
    }
}
