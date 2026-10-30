//! 会话标题: a new conversation is named from its first prompt by a short side request to the
//! conversation's own model.
//!
//! Ported from the Electron app's built-in `session-title` extension, including the three rules
//! that are easy to get wrong:
//!
//! - **One shot per conversation.** The server already writes a fallback (the prompt's first
//!   line) when the first turn ends. A generated title replaces *that*, and nothing else: a name
//!   the user typed while the request was in flight wins, and a later message never renames a
//!   chat the first one already spoke for.
//! - **A short first message is already a title.** Asking a model to shorten it spends a round
//!   trip to change nothing, so those go straight to the fallback.
//! - **A reply that is a sentence is not a title.** Only a naturally finished answer of at most
//!   [`MAX_TITLE`] characters is used; clipping prose names the chat after the model's preamble.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt as _;
use fv_agent::{Model, ModelEvent, ModelRequest};
use fv_core::{AssistantMessage, ContentBlock, Message, StopReason};

/// A title longer than this is the model answering instead of naming.
pub const MAX_TITLE: usize = 24;
/// A first message this short is already a good title; the fallback is exactly it.
pub const SHORT_TITLE: usize = 16;
/// What the model sees of the prompt: a first message can be a whole specification.
const PROMPT_CHARS: usize = 500;
const TIMEOUT: Duration = Duration::from_secs(20);
/// A title is one short line, and thinking is billed inside the same budget.
const MAX_TOKENS: u32 = 128;
/// An answer that came back as prose is worth asking again for. A failed request is not: the
/// provider layer already repeats the ones worth repeating.
const ATTEMPTS: usize = 2;

const INSTRUCTIONS: &str = "You name chat sessions. Reply with a title only.\n\
Rules:\n\
- at most 16 characters (CJK counts as 1)\n\
- no quotes, trailing punctuation, or emoji\n\
- same language as the user\n\
- no leading labels like Title: or 标题：\n\
- output the title alone: no preamble, no reasoning, no explanation";

/// `/skill:<name> …` back out of a prompt that carries the skill's whole `SKILL.md`.
///
/// The marker form is what the Electron engine writes out; this server hands a skill's body to
/// the model as context instead, so the prompt is normally the draft form and this is the
/// identity. Both spellings are folded anyway, because a title must never be a `SKILL.md`.
pub fn fold_skill(text: &str) -> String {
    let trimmed = text.trim_start();
    let Some(rest) = trimmed.strip_prefix("<skill") else {
        return text.to_string();
    };
    let Some(tag_end) = rest.find('>') else {
        return text.to_string();
    };
    let after = &rest[tag_end + 1..];
    let Some(body_end) = after.find("</skill>") else {
        return text.to_string();
    };
    let name = rest
        .split_once("name=\"")
        .and_then(|(_, tail)| tail.split_once('"'))
        .map(|(name, _)| name)
        .unwrap_or_default();
    let words = after[body_end + "</skill>".len()..].trim();
    if name.is_empty() {
        return words.to_string();
    }
    if words.is_empty() {
        format!("/skill:{name}")
    } else {
        format!("/skill:{name} {words}")
    }
}

/// The prompt a title is asked from, or `None` when the message says nothing about the chat.
///
/// A bare `/compact` or `/skill:office` is a command with no words of its own; naming a chat
/// after one is worse than leaving the fallback (which is the command, and at least honest).
pub fn prompt_text(raw: &str) -> Option<String> {
    let text = fold_skill(raw.trim());
    if text.is_empty() || is_command(&text) {
        return None;
    }
    // `/skill:office 帮我写个周报` is about the words after the command, not the command.
    let words = text
        .split_once(char::is_whitespace)
        .filter(|(head, _)| head.starts_with('/'))
        .map(|(_, rest)| rest.trim())
        .unwrap_or(text.as_str());
    let prompt = if words.is_empty() { &text } else { words };
    Some(clip(prompt, PROMPT_CHARS))
}

/// Whether the message is already short enough to be its own title.
pub fn is_short(prompt: &str) -> bool {
    prompt.chars().count() <= SHORT_TITLE && !prompt.contains('\n')
}

fn is_command(text: &str) -> bool {
    let mut words = text.split_whitespace();
    matches!((words.next(), words.next()), (Some(first), None) if first.starts_with('/'))
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The model's answer as a title, or `None` when it is not one.
///
/// The reply has to have finished naturally: `length` means the model was still rambling when it
/// was cut off, and `error`/`aborted` mean there is no answer at all.
pub fn usable_title(reply: &AssistantMessage) -> Option<String> {
    if reply.stop != StopReason::Stop {
        return None;
    }
    clean(&reply.text())
}

/// One reply's text as a title: its first non-empty line, without quotes, a label or a closing
/// full stop. `None` when nothing usable is left, or when what is left is a sentence.
pub fn clean(raw: &str) -> Option<String> {
    let mut text = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .to_string();
    text = strip_wrapping_quotes(text);
    text = strip_label(&text).unwrap_or(text);
    let text = text.trim_end_matches(&TRAILING[..]).trim().to_string();
    if text.is_empty() || text.chars().count() > MAX_TITLE {
        return None;
    }
    Some(text)
}

const TRAILING: [char; 16] = [
    ' ', '\t', '.', '。', '!', '！', '?', '？', ',', '，', ';', '；', ':', '：', '、', '\u{3000}',
];

const WRAPPERS: &[(char, char)] = &[
    ('"', '"'),
    ('\'', '\''),
    ('“', '”'),
    ('‘', '’'),
    ('「', '」'),
    ('『', '』'),
];

fn strip_wrapping_quotes(mut text: String) -> String {
    loop {
        let chars: Vec<char> = text.chars().collect();
        let Some(_pair) = WRAPPERS
            .iter()
            .find(|(open, close)| {
                chars.len() >= 2 && chars[0] == *open && chars[chars.len() - 1] == *close
            })
            .copied()
        else {
            return text;
        };
        text = chars[1..chars.len() - 1]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
    }
}

/// `Title: …` / `标题：…`, which a model adds despite being told not to.
fn strip_label(text: &str) -> Option<String> {
    let lowered = text.to_lowercase();
    let rest = ["title", "标题"]
        .iter()
        .find_map(|label| lowered.strip_prefix(label))?;
    let after = rest.trim_start_matches([' ', '\t']);
    let sep = after.chars().next()?;
    if sep != ':' && sep != '：' {
        return None;
    }
    // Everything before the separator is the label; the title is what follows it.
    let skip = text.chars().count() - after.chars().count() + 1;
    Some(
        text.chars()
            .skip(skip)
            .collect::<String>()
            .trim()
            .to_string(),
    )
}

/// Ask `model` to name the conversation from `prompt`, within [`TIMEOUT`].
///
/// A side request, never part of a run: every failure is `None`, and the caller then keeps the
/// fallback the server already wrote.
pub async fn generate(model: Arc<dyn Model>, prompt: &str) -> Option<String> {
    let request = ModelRequest {
        system: INSTRUCTIONS.to_string(),
        messages: vec![Message::User {
            text: format!("<message>\n{prompt}\n</message>\n\nTitle:"),
        }],
        tools: Vec::new(),
        max_output_tokens: Some(MAX_TOKENS),
    };
    for _ in 0..ATTEMPTS {
        let reply = tokio::time::timeout(TIMEOUT, ask(model.clone(), request.clone()))
            .await
            .ok()
            .flatten()?;
        if let Some(title) = usable_title(&reply) {
            return Some(title);
        }
        // A stop or an error is not something another attempt changes.
        if matches!(reply.stop, StopReason::Aborted | StopReason::Error { .. }) {
            return None;
        }
    }
    None
}

/// The complete reply, or `None` when the stream failed. Deltas exist only so a client can draw
/// the answer; the `Done` message is authoritative.
async fn ask(model: Arc<dyn Model>, request: ModelRequest) -> Option<AssistantMessage> {
    let mut stream = model.stream(request);
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        match event {
            Ok(ModelEvent::Text(delta)) => text.push_str(&delta),
            Ok(ModelEvent::Done(message)) => {
                return Some(if message.text().is_empty() {
                    AssistantMessage {
                        content: vec![ContentBlock::Text { text }],
                        ..message
                    }
                } else {
                    message
                });
            }
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    None
}

/// Whether a generated title may replace what the catalog holds now.
///
/// The catalog held `fallback` when the request went out, and anything else means somebody acted
/// on the conversation in the meantime — a rename in this window or another one is the user's
/// own answer to the same question, and it wins.
pub fn should_apply(current: &str, fallback: &str, title: &str) -> bool {
    current == fallback && current != title
}

#[cfg(test)]
mod tests {
    use super::*;
    use fv_agent::testing::{Reply, ScriptedModel};

    #[test]
    fn a_skill_prompt_is_read_as_the_words_the_person_typed() {
        let expanded = "<skill name=\"office\" location=\"/x/SKILL.md\">\nVERY LONG BODY\n</skill>\n帮我写个周报";
        assert_eq!(prompt_text(expanded).as_deref(), Some("帮我写个周报"));
        assert_eq!(
            prompt_text("/skill:office 帮我写个周报").as_deref(),
            Some("帮我写个周报")
        );
        assert_eq!(prompt_text("plain words").as_deref(), Some("plain words"));
        // A bare command has no words of its own.
        assert_eq!(prompt_text("/skill:office"), None);
        assert_eq!(prompt_text("/compact"), None);
        assert_eq!(prompt_text("   "), None);
        // The whole SKILL.md must never become the material.
        assert!(!fold_skill(expanded).contains("VERY LONG BODY"));
    }

    #[test]
    fn a_short_first_message_is_already_a_title() {
        assert!(is_short("修一下标题"));
        assert!(is_short(&"字".repeat(SHORT_TITLE)));
        assert!(!is_short(&"字".repeat(SHORT_TITLE + 1)));
        assert!(!is_short("短\n但有两行"));
    }

    #[test]
    fn the_answer_becomes_one_clean_line_or_nothing() {
        assert_eq!(clean("修复标题生成").as_deref(), Some("修复标题生成"));
        assert_eq!(clean("\"修复标题生成\"").as_deref(), Some("修复标题生成"));
        assert_eq!(clean("「修复标题生成」").as_deref(), Some("修复标题生成"));
        assert_eq!(
            clean("Title: 修复标题生成").as_deref(),
            Some("修复标题生成")
        );
        assert_eq!(
            clean("标题：修复标题生成。").as_deref(),
            Some("修复标题生成")
        );
        assert_eq!(
            clean("Fix the title\n\nBecause the plugin …").as_deref(),
            Some("Fix the title")
        );
        // A sentence is the model answering, not naming.
        assert_eq!(
            clean("The user wants me to fix the title of the chat"),
            None
        );
        assert_eq!(clean("   "), None);
    }

    #[test]
    fn only_a_finished_answer_is_a_title() {
        let reply = |stop, text: &str| AssistantMessage {
            duration_ms: None,
            content: vec![ContentBlock::Text { text: text.into() }],
            stop,
            usage: Default::default(),
            model: None,
        };
        assert_eq!(
            usable_title(&reply(StopReason::Stop, "修复标题")).as_deref(),
            Some("修复标题")
        );
        assert_eq!(usable_title(&reply(StopReason::Length, "修复标题")), None);
        assert_eq!(
            usable_title(&reply(
                StopReason::Error {
                    message: "boom".into()
                },
                "修复标题"
            )),
            None
        );
    }

    #[tokio::test]
    async fn the_request_asks_for_one_short_line_and_returns_the_title() {
        let model = Arc::new(ScriptedModel::new([Reply::new()
            .text("修复标题生成")
            .done()]));
        let title = generate(model.clone(), "标题生成不对，按 electron 版做一下").await;
        assert_eq!(title.as_deref(), Some("修复标题生成"));
        let asked = model.requests();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].max_output_tokens, Some(MAX_TOKENS));
        assert!(asked[0].tools.is_empty());
        assert!(asked[0].system.contains("You name chat sessions"));
        let Message::User { text } = &asked[0].messages[0] else {
            panic!("the prompt is one user message");
        };
        assert!(text.contains("标题生成不对，按 electron 版做一下"));
        assert!(text.ends_with("Title:"));
    }

    #[tokio::test]
    async fn a_sentence_costs_one_more_attempt_and_then_the_fallback_stays() {
        let model = Arc::new(ScriptedModel::new([
            Reply::new().text("The user is asking about titles").done(),
            Reply::new()
                .text("Still explaining myself at length")
                .done(),
        ]));
        assert_eq!(generate(model.clone(), "prompt").await, None);
        assert_eq!(model.requests().len(), ATTEMPTS);
    }

    #[tokio::test]
    async fn a_failed_request_is_not_repeated() {
        let model = Arc::new(ScriptedModel::new([
            Reply::new().then_fail("upstream said no")
        ]));
        assert_eq!(generate(model.clone(), "prompt").await, None);
        assert_eq!(model.requests().len(), 1);
    }
}
