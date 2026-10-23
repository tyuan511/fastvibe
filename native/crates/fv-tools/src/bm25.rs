//! A small BM25 ranking, enough to find a tool among a few hundred by what it is called and
//! says about itself.

use std::collections::HashMap;

const K1: f64 = 1.2;
const B: f64 = 0.75;
const STOP_WORDS: &[&str] = &[
    "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "it", "with", "my", "me",
];

/// Lowercase words; `create_issue`, `createIssue` and `create-issue` all give `create`, `issue`.
pub fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut prev_lower = false;
    for c in text.chars() {
        if c.is_alphanumeric() {
            // A capital after a lowercase letter starts a new word (camelCase).
            if c.is_uppercase() && prev_lower && !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            prev_lower = c.is_lowercase();
            word.extend(c.to_lowercase());
        } else {
            prev_lower = false;
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// Indices of the documents that match the query, best first. A document sharing no word with
/// the query is not returned.
pub fn rank(docs: &[String], query: &str) -> Vec<usize> {
    let docs_tokens: Vec<Vec<String>> = docs.iter().map(|d| tokens(d)).collect();
    let n = docs.len() as f64;
    if docs.is_empty() {
        return Vec::new();
    }
    let avg_len = (docs_tokens.iter().map(Vec::len).sum::<usize>() as f64 / n).max(1.0);

    let mut doc_freq: HashMap<&str, usize> = HashMap::new();
    for toks in &docs_tokens {
        let mut seen: Vec<&str> = toks.iter().map(String::as_str).collect();
        seen.sort_unstable();
        seen.dedup();
        for t in seen {
            *doc_freq.entry(t).or_default() += 1;
        }
    }

    // Words that say nothing about which tool is meant would match everything.
    let mut query_terms: Vec<String> = tokens(query)
        .into_iter()
        .filter(|t| !STOP_WORDS.contains(&t.as_str()))
        .collect();
    query_terms.sort_unstable();
    query_terms.dedup();

    let mut scored: Vec<(usize, f64)> = docs_tokens
        .iter()
        .enumerate()
        .filter_map(|(i, toks)| {
            let len = toks.len() as f64;
            let mut score = 0.0;
            for term in &query_terms {
                let tf = toks.iter().filter(|t| *t == term).count() as f64;
                if tf == 0.0 {
                    continue;
                }
                let df = *doc_freq.get(term.as_str()).unwrap_or(&0) as f64;
                let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                score += idf * (tf * (K1 + 1.0)) / (tf + K1 * (1.0 - B + B * len / avg_len));
            }
            (score > 0.0).then_some((i, score))
        })
        .collect();
    // Best first; equal scores keep the catalogue's order, so results do not shuffle.
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    scored.into_iter().map(|(i, _)| i).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_split_on_case_and_punctuation() {
        assert_eq!(
            tokens("createIssue create_issue create-issue"),
            ["create", "issue", "create", "issue", "create", "issue"]
        );
        assert_eq!(tokens("GitHub PRs"), ["git", "hub", "prs"]);
    }

    #[test]
    fn the_closest_document_comes_first_and_unrelated_ones_are_left_out() {
        let docs = vec![
            "github create_issue Create a new issue in a repository".to_string(),
            "github list_pull_requests List open pull requests".to_string(),
            "calendar create_event Add an event to the calendar".to_string(),
        ];
        // "open" also appears in the pull-request tool, so it follows; the issue tool leads.
        assert_eq!(rank(&docs, "open an issue"), vec![0, 1]);
        assert_eq!(rank(&docs, "pull requests")[0], 1);
        assert_eq!(rank(&docs, "calendar event")[0], 2);
        assert!(rank(&docs, "zebra").is_empty());
        assert!(rank(&[], "anything").is_empty());
    }

    #[test]
    fn a_rarer_word_counts_for_more() {
        let docs = vec![
            "common common rare".to_string(),
            "common common common".to_string(),
            "common other".to_string(),
        ];
        assert_eq!(rank(&docs, "rare common")[0], 0);
    }
}
