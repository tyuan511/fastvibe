//! Skill commands keep their original text on the wire. Badges are annotations over that
//! text, so editing, queueing, retrying and reconnecting cannot silently drop the selection.

use fv_protocol::types::SkillInfo;
use gpui_kit::component::input::{InlineToken, InputContent};

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation<'a> {
    pub name: &'a str,
    pub text: &'a str,
    pub command_end: usize,
}

pub fn invocation(value: &str) -> Option<Invocation<'_>> {
    let rest = value.strip_prefix("/skill:")?;
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let name = &rest[..end];
    if name.is_empty()
        || name.len() > 64
        || name.starts_with('-')
        || name.ends_with('-')
        || name.contains("--")
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return None;
    }
    let command_end = 7 + end;
    // Consume one separator, keeping the author's indentation and line breaks in the body.
    let text = value[command_end..]
        .strip_prefix(' ')
        .unwrap_or(&value[command_end..]);
    Some(Invocation {
        name,
        text,
        command_end,
    })
}

pub fn token(name: &str) -> InlineToken {
    InlineToken::new(format!("skill:{name}"), format!("/skill:{name}"))
        .with_label(format!("技能 {name}"))
}

/// Restore a stored prompt with its badge, without needing the skill to still be installed.
pub fn content(value: String) -> InputContent {
    let mark = invocation(&value).map(|i| (i.command_end, token(i.name)));
    let content = InputContent::new(value);
    match mark {
        Some((end, token)) => content.clone().with_token(0..end, token).unwrap_or(content),
        None => content,
    }
}

/// The palette owns a single leading command, never a path, URL or later slash in prose.
pub fn query(value: &str, caret: usize) -> Option<String> {
    let rest = value.strip_prefix('/')?;
    if caret != value.len() || rest.chars().any(char::is_whitespace) || rest.contains('/') {
        return None;
    }
    Some(rest.to_lowercase())
}

pub fn matching<'a>(skills: &'a [SkillInfo], query: &str) -> Vec<&'a SkillInfo> {
    skills
        .iter()
        .filter(|skill| {
            format!("skill:{} {}", skill.name, skill.description)
                .to_lowercase()
                .contains(query)
        })
        .take(8)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{content, invocation, matching, query};
    use fv_protocol::types::{SkillInfo, SkillScope};

    #[test]
    fn a_badge_keeps_the_exact_prompt_and_restores_without_a_catalog() {
        let raw = "/skill:office  保留缩进\n第二行";
        let found = invocation(raw).unwrap();
        assert_eq!((found.name, found.text), ("office", " 保留缩进\n第二行"));
        let restored = content(raw.into());
        assert_eq!(restored.text().as_ref(), raw);
        assert_eq!(restored.tokens().len(), 1);
        let span = &restored.tokens()[0];
        assert_eq!(&raw[span.range()], "/skill:office");
        assert_eq!(span.token().label().as_ref(), "技能 office");
        assert_eq!(invocation("/skill:office").unwrap().text, "");
        for literal in [
            "see /skill:office",
            "/skill:",
            "/skill:a/b x",
            "/skill:-a x",
            "/skill:a--b",
        ] {
            assert!(invocation(literal).is_none(), "{literal}");
            assert!(content(literal.into()).tokens().is_empty());
        }
    }

    #[test]
    fn the_picker_only_owns_a_leading_command_and_matches_names_and_descriptions() {
        assert_eq!(query("/", 1).as_deref(), Some(""));
        assert_eq!(query("/SKILL:OFF", 10).as_deref(), Some("skill:off"));
        for literal in [
            "/tmp/file",
            "https://x",
            "please /office",
            "/office ",
            "/office\n",
        ] {
            assert_eq!(query(literal, literal.len()), None);
        }
        assert_eq!(query("/office", 3), None);
        let skills = vec![SkillInfo {
            name: "office".into(),
            description: "处理 Word 文档".into(),
            path: "/skill/SKILL.md".into(),
            scope: SkillScope::Project,
            removable: false,
            manual_only: true,
        }];
        for q in ["", "off", "skill:office", "word", "文档"] {
            assert_eq!(matching(&skills, q).len(), 1, "{q}");
        }
        assert!(matching(&skills, "missing").is_empty());
    }
}
