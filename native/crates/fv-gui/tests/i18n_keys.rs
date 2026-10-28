//! Every key the interface asks for must actually resolve.
//!
//! rust-i18n answers a miss with the key itself, so a missing entry is not a crash and not
//! English copy — it is a settings row that reads `settings.auto_review_approvals` on screen,
//! which is how this was first noticed. Nothing about that is loud: the app builds, runs, and
//! draws the identifier of a string in place of the string.
//!
//! Two ways a key goes missing, and this catches both:
//!
//! - A locale file without the top-level `_version: 2`. The loader then treats the *file name*
//!   as the locale (`goal.yml` becomes locale `goal`), so every key in that file is present but
//!   unreachable — the file looks perfectly written and the whole of it is dead.
//! - A key typed in the source and never added to any file, or added with only one language
//!   (`fallback = "zh"` hides an absent `en` behind Chinese rather than reporting it).
//!
//! The resolution check runs against the compiled table through [`fv_gui::translation`], not
//! against a second copy of the loader, so it cannot drift from what the app actually reads.

use std::path::{Path, PathBuf};

fn manifest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn locale_files() -> Vec<PathBuf> {
    let dir = manifest_dir().join("locales");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("locales/ must exist next to src/") {
        let path = entry.expect("readable locale entry").path();
        if path.extension().is_some_and(|e| e == "yml") {
            out.push(path);
        }
    }
    out.sort();
    assert!(!out.is_empty(), "no locale files in {}", dir.display());
    out
}

/// The key and the languages it declares, read from the files' one shape: a key at column 0,
/// then `zh:` / `en:` indented. A nested or block-scalar locale file would be a change to make
/// here as well.
fn parse_locale(path: &Path) -> Vec<(String, Vec<String>)> {
    let text = std::fs::read_to_string(path).expect("locale file is readable");
    let mut entries: Vec<(String, Vec<String>)> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((name, _)) = line.split_once(':') else {
            continue;
        };
        if !line.starts_with(' ') {
            if !name.trim().is_empty() && name.trim() != "_version" {
                entries.push((name.trim().to_string(), Vec::new()));
            }
            continue;
        }
        let Some((_, langs)) = entries.last_mut() else {
            continue;
        };
        let body = line.trim();
        for lang in ["zh", "en"] {
            let Some(value) = body.strip_prefix(&format!("{lang}:")) else {
                continue;
            };
            if !value.trim().trim_matches('"').trim_matches('\'').is_empty() {
                langs.push(lang.to_string());
            }
        }
    }
    entries
}

/// The keys the source asks for by literal: `tr!(english, "a.b")`, `trs!(english, "a.b")`,
/// `t!("a.b")`. This scans text rather than tokens — no proc-macro dependency here — so the two
/// rules that matter are spelled out: the macro name is the whole identifier run before `!(`
/// (`format!(` ends in `t!(` and is not a translation call), and the string taken is the first
/// one inside the call, before its closing paren.
fn used_keys() -> Vec<(String, String)> {
    const MACROS: [&str; 4] = ["tr", "trs", "t", "tl"];
    let mut found = Vec::new();
    for path in rust_files(&manifest_dir().join("src")) {
        let text = std::fs::read_to_string(&path).expect("source file is readable");
        let bytes = text.as_bytes();
        for (index, _) in text.match_indices("!(") {
            let name_start = index
                - bytes[..index]
                    .iter()
                    .rev()
                    .take_while(|c| c.is_ascii_alphanumeric() || **c == b'_')
                    .count();
            let name = &text[name_start..index];
            if !MACROS.contains(&name) {
                continue;
            }
            // The macro's own doc comment shows `tr!(english, "module.key")` as an example, and
            // an example is not a call the interface makes. `//` before the call on its line is
            // the only shape that reaches here; block comments would need a real lexer.
            let line_start = text[..index].rfind('\n').map(|i| i + 1).unwrap_or(0);
            if text[line_start..index].contains("//") {
                continue;
            }
            // A path call — `some::t!(` — is not this crate's macro.
            if name_start > 0 && bytes[name_start - 1] == b':' {
                continue;
            }
            let rest = &text[index + 2..];
            let Some(quote) = rest.find('"') else {
                continue;
            };
            if rest[..quote].contains(')') {
                continue;
            }
            let after_open = &rest[quote + 1..];
            let Some(close) = after_open.find('"') else {
                continue;
            };
            let key = &after_open[..close];
            if is_translation_key(key) {
                found.push((
                    key.to_string(),
                    format!("{}:{}", path.display(), line_of(&text, index)),
                ));
            }
        }
    }
    found.sort();
    found
}

/// A translation key is a dotted lowercase identifier. Anything else — a `format!` pattern that
/// happens to be the first string in a call, an interpolated `{name}` — makes no claim about the
/// table.
fn is_translation_key(key: &str) -> bool {
    key.contains('.')
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_')
}

fn line_of(text: &str, byte: usize) -> usize {
    text[..byte].lines().count()
}

fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("readable source directory") {
            let path = entry.expect("readable entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

#[test]
fn every_locale_file_declares_version_two() {
    // Without it the file is read as one locale named after the file, and every key in it —
    // including correct ones — stops resolving while the file itself looks fine.
    for path in locale_files() {
        let text = std::fs::read_to_string(&path).expect("locale file is readable");
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?");
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("?");
        assert!(
            text.lines().any(|line| line == "_version: 2"),
            "{name} has no top-level `_version: 2`, so rust-i18n reads the whole file as \
             locale {stem:?} and none of its keys resolve"
        );
    }
}

#[test]
fn every_key_the_source_asks_for_resolves_in_both_languages() {
    let used = used_keys();
    assert!(
        used.len() > 400,
        "the scanner found only {} keys; it has stopped matching how the copy is written",
        used.len()
    );
    let mut problems = Vec::new();
    for (key, at) in &used {
        for locale in ["zh", "en"] {
            match fv_gui::translation(locale, key).as_deref() {
                None => problems.push(format!("{key} [{locale}] is missing — {at}")),
                Some(text) if text == *key => problems.push(format!(
                    "{key} [{locale}] resolves to the key itself — {at}"
                )),
                Some(_) => {}
            }
        }
    }
    assert!(
        problems.is_empty(),
        "{} key(s) the interface asks for do not resolve:\n{}",
        problems.len(),
        problems.join("\n")
    );
}

#[test]
fn every_defined_key_carries_both_languages() {
    // `fallback = "zh"` means an absent `en` is not a miss: the English interface silently shows
    // Chinese. So the languages are checked in the files, not only through the table.
    let mut problems = Vec::new();
    for path in locale_files() {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?");
        for (key, langs) in parse_locale(&path) {
            for lang in ["zh", "en"] {
                if !langs.iter().any(|have| have == lang) {
                    problems.push(format!("{name}: {key} has no {lang}"));
                }
            }
        }
    }
    assert!(
        problems.is_empty(),
        "{} locale entries are missing a language:\n{}",
        problems.len(),
        problems.join("\n")
    );
}
