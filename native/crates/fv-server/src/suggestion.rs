//! 回复推荐: after a reply ends, guess what the user will send next and offer it as the
//! composer's placeholder.
//!
//! Everything here is pure — what the model is shown, and what to make of its answer — so the
//! decisions that say whether a suggestion is worth showing are pinned by tests. Asking the model
//! and publishing the result is `suggest::suggest`, which the server runs after a turn.
//!
//! Two rules from the Electron app that are not obvious:
//!
//! - **Only a reply that ended its turn in prose qualifies.** One that stopped on a tool call,
//!   failed or was cut off is not a place the user answers from, and a reply with no text gives
//!   the model nothing to predict against.
//! - **A suggestion is one line.** The request is cancelled the moment the first line is finished,
//!   so a model that goes on to explain itself costs nothing more. That is also why the output
//!   ceiling can stay small — see `suggest::MAX_TOKENS`.

/// A suggestion longer than this is the model answering the question, not guessing the next one.
pub const MAX_CHARS: usize = 120;
/// What the model sees of each side. The tail is what the next message answers.
const USER_CHARS: usize = 600;
const ASSISTANT_CHARS: usize = 1800;

pub const SYSTEM: &str = "You predict the next message a user will send in a conversation with an AI assistant. \
Write it from the user's point of view, as one short, natural message (a task, a follow-up question, or a confirmation). \
Write in the same language as the user's last message. \
Reply with the message only: no quotes, no label, no explanation. \
Only suggest a message that gives the assistant something to do or decide: an instruction, a question, a choice, or a go-ahead for work it proposed. \
Never suggest what the user does on their own machine or tells nobody, such as running, testing or trying it locally, checking the result, waiting, thinking it over, or holding off on a step, nor thanks or sign-offs: the assistant cannot act on those. \
If there is no obvious next message, reply with exactly NONE.";

/// The last exchange, as the model is shown it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Material {
    pub user: String,
    pub assistant: String,
}

fn tail(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars()
        .rev()
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// The last exchange taken out of the drawn turns, or nothing when there is nothing worth
/// guessing from.
///
/// Read from what the transcript already holds rather than from engine state, so the same answer
/// is reached after a restart and by a client that reconnected.
pub fn material_from(turns: &[fv_protocol::types::Turn]) -> Option<Material> {
    use fv_protocol::types::Item;
    let turn = turns.last()?;
    // The reply has to be the turn's last item and has to be prose: text followed by a tool call
    // means the model is still working, and a turn that ended in an error item is not a place to
    // answer from.
    let Item::AgentMessage {
        text: assistant, ..
    } = turn.items.last()?
    else {
        return None;
    };
    if assistant.trim().is_empty() {
        return None;
    }
    let user = turn.items.iter().find_map(|item| match item {
        Item::UserMessage { text, .. } => Some(text.as_str()),
        _ => None,
    })?;
    // A prompt that forced a skill carries the whole SKILL.md; the guess is about what the person
    // asks next, so read it from their own words alone.
    let user = skill_words(user);
    if user.trim().is_empty() {
        return None;
    }
    Some(Material {
        user: tail(&user, USER_CHARS),
        assistant: tail(assistant, ASSISTANT_CHARS),
    })
}

/// A prompt that expanded a skill, as the words the user themself typed.
///
/// The engine writes `/skill:<name> 正文` out as the whole `SKILL.md` inside a marker. Either
/// spelling is read here, so the same turn gives the same guess before and after a restart.
fn skill_words(text: &str) -> String {
    const OPEN: &str = "<skill";
    const CLOSE: &str = "</skill>";
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix(OPEN) {
        // Skip the opening tag, then the skill body up to its closing tag.
        if let Some(tag_end) = rest.find('>') {
            let after = &rest[tag_end + 1..];
            if let Some(body_end) = after.find(CLOSE) {
                return after[body_end + CLOSE.len()..].trim().to_string();
            }
        }
        return String::new();
    }
    // A draft form: `/skill:name the words`. The name is one token, the words follow.
    if let Some(rest) = trimmed.strip_prefix("/skill:") {
        return match rest.find(char::is_whitespace) {
            Some(end) => rest[end..].trim().to_string(),
            None => String::new(),
        };
    }
    text.to_string()
}

pub fn prompt(material: &Material) -> String {
    format!(
        "<user_message>\n{}\n</user_message>\n\n<assistant_reply>\n{}\n</assistant_reply>\n\nThe next message the user is most likely to send:",
        material.user, material.assistant
    )
}

const WRAPPERS: &[(char, char)] = &[
    ('"', '"'),
    ('\'', '\''),
    ('`', '`'),
    ('“', '”'),
    ('‘', '’'),
    ('「', '」'),
    ('『', '』'),
];

const LABELS: &[&str] = &["next message", "user", "suggestion", "下一条消息", "推荐"];

/// The model's answer as a suggestion, or `None` when it is not one: empty, `NONE`, or too long to
/// be a message someone would send.
///
/// Only the first line counts — a model that adds an explanation underneath has still put the
/// guess first.
pub fn clean(raw: &str) -> Option<String> {
    let mut text = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .to_string();
    // A bullet or a number in front of the guess is formatting, not the guess.
    text = strip_prefix_any(&text, &["- ", "* ", "• "]).unwrap_or(text);
    if let Some((head, rest)) = split_numbered(&text) {
        let _ = head;
        text = rest;
    }
    for label in LABELS {
        if let Some(rest) = strip_label(&text, label) {
            text = rest;
            break;
        }
    }
    loop {
        let mut again = false;
        for (open, close) in WRAPPERS {
            let chars: Vec<char> = text.chars().collect();
            if chars.len() >= 2 && chars[0] == *open && chars[chars.len() - 1] == *close {
                text = chars[1..chars.len() - 1]
                    .iter()
                    .collect::<String>()
                    .trim()
                    .to_string();
                again = true;
            }
        }
        if !again {
            break;
        }
    }
    if text.is_empty() || text.trim_end_matches('.').eq_ignore_ascii_case("none") {
        return None;
    }
    if text.chars().count() > MAX_CHARS {
        return None;
    }
    Some(text)
}

fn strip_prefix_any(text: &str, prefixes: &[&str]) -> Option<String> {
    prefixes.iter().find_map(|prefix| {
        text.strip_prefix(prefix)
            .map(|rest| rest.trim().to_string())
    })
}

/// `1. `, `2) ` — a list marker a model puts in front of a one-line answer.
fn split_numbered(text: &str) -> Option<(&str, String)> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = &text[digits.len()..];
    let rest = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')'))?;
    let rest = rest.strip_prefix(' ')?;
    Some((&text[..digits.len()], rest.trim().to_string()))
}

/// `Suggestion: …` / `下一条消息：…`
fn strip_label(text: &str, label: &str) -> Option<String> {
    let lowered = text.to_lowercase();
    let rest = lowered.strip_prefix(&label.to_lowercase())?;
    let sep = rest.chars().next()?;
    if sep != ':' && sep != '：' {
        return None;
    }
    let offset = label.chars().count() + 1;
    Some(
        text.chars()
            .skip(offset)
            .collect::<String>()
            .trim()
            .to_string(),
    )
}

/// The first line of `text` once it is *finished* — a newline follows some content.
///
/// A suggestion is one line, so the request can stop paying the moment this returns something.
pub fn completed_first_line(text: &str) -> Option<String> {
    // A first line is complete once a newline follows it: `lines()` drops a trailing empty line, so
    // the split has to be on the newline itself rather than on what `lines()` yields.
    let (first, rest) = text.split_once('\n')?;
    let first = first.trim();
    let _ = rest;
    (!first.is_empty()).then(|| first.to_string())
}

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Ask the conversation's own model what the user is likely to say next.
///
/// A side request, never part of a run: it is fire-and-forget, its failures are swallowed (the
/// composer then keeps its ordinary placeholder), and it uses the model the conversation is
/// already on — a guess routed through a different provider than the one the user just proved
/// works fails on its own.
///
/// The output ceiling is left to the model's own configuration. A *small* ceiling is the wrong
/// lever: `max_tokens` only bounds an answer, so a short guess costs the same under a generous
/// one, while a tight ceiling cuts a model that reasons first down to nothing (thinking is billed
/// inside the same budget) and there is then no suggestion at all. The saving comes from stopping
/// the stream the moment the first line is finished.
pub async fn suggest(
    model: std::sync::Arc<dyn fv_agent::Model>,
    turns: &[fv_protocol::types::Turn],
) -> Option<String> {
    let material = material_from(turns)?;
    let request = fv_agent::ModelRequest {
        max_output_tokens: None,
        system: SYSTEM.to_string(),
        messages: vec![fv_core::Message::User {
            text: prompt(&material),
        }],
        tools: Vec::new(),
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    let run = read_first_line(model.as_ref(), request, &cancel);
    match tokio::time::timeout(TIMEOUT, run).await {
        Ok(Ok(text)) => clean(&text),
        _ => None,
    }
}

/// Read the stream, and stop paying for it the moment the first line is finished.
///
/// A suggestion is one line: a model that goes on to explain itself, or to think aloud past the
/// line, costs nothing more than the line it already wrote.
async fn read_first_line(
    model: &dyn fv_agent::Model,
    request: fv_agent::ModelRequest,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<String, ()> {
    use futures_util::StreamExt as _;
    use fv_agent::ModelEvent;
    let mut stream = model.stream(request);
    let mut text = String::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(()),
            next = stream.next() => next,
        };
        match next {
            // The stream ending (or failing) is not an error worth reporting: the caller just
            // leaves the placeholder alone.
            None | Some(Err(_)) => {
                cancel.cancel();
                return Ok(text);
            }
            Some(Ok(ModelEvent::Text(delta))) => {
                text.push_str(&delta);
                if completed_first_line(&text).is_some() {
                    // Dropping the stream cancels the request; the line is what we came for.
                    cancel.cancel();
                    return Ok(text);
                }
            }
            // The complete message is the truth when the stream ends normally.
            Some(Ok(ModelEvent::Done(message))) => {
                let full = message.text();
                return Ok(if full.is_empty() { text } else { full });
            }
            // Thinking and tool-call traffic are not part of a one-line guess.
            Some(Ok(_)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fv_protocol::types::{Item, Turn};

    fn turn(items: Vec<Item>) -> Turn {
        Turn::new("t0".into(), items)
    }

    fn user(text: &str) -> Item {
        Item::UserMessage {
            id: "u".into(),
            text: text.into(),
        }
    }

    fn reply(text: &str) -> Item {
        Item::AgentMessage {
            id: "a".into(),
            text: text.into(),
        }
    }

    #[test]
    fn only_a_turn_that_ended_in_prose_qualifies() {
        assert_eq!(material_from(&[]), None);
        // An error item after the reply: the run failed, so there is nothing to answer.
        assert_eq!(
            material_from(&[turn(vec![
                user("do it"),
                reply("done"),
                Item::Error {
                    id: "e".into(),
                    message: "boom".into()
                },
            ])]),
            None
        );
        // A tool call after the reply: the model is still working.
        assert_eq!(
            material_from(&[turn(vec![
                user("do it"),
                reply("let me check"),
                Item::ToolCall {
                    id: "c".into(),
                    name: "exec_command".into(),
                    arguments: serde_json::json!({}),
                    output: None,
                    is_error: false,
                },
            ])]),
            None
        );
        // Empty reply text.
        assert_eq!(
            material_from(&[turn(vec![user("do it"), reply("  ")])]),
            None
        );
        let material = material_from(&[turn(vec![user("do it"), reply("done")])]).unwrap();
        assert_eq!(material.user, "do it");
        assert_eq!(material.assistant, "done");
    }

    #[test]
    fn a_skill_prompt_is_read_as_the_words_the_person_typed() {
        let expanded = "<skill name=\"office\" location=\"/x/SKILL.md\">\nVERY LONG BODY\n</skill>\n帮我写个周报";
        assert_eq!(skill_words(expanded), "帮我写个周报");
        assert_eq!(skill_words("/skill:office 帮我写个周报"), "帮我写个周报");
        assert_eq!(skill_words("plain words"), "plain words");
        // A bare command has no words of its own, so there is nothing to guess from.
        assert_eq!(skill_words("/skill:office"), "");
        let material = material_from(&[turn(vec![user(expanded), reply("好的")])]).unwrap();
        assert_eq!(
            material.user, "帮我写个周报",
            "the SKILL.md is not what the guess is about"
        );
    }

    #[test]
    fn a_suggestion_is_one_line_unwrapped_and_bounded() {
        assert_eq!(
            clean("Add a test for it").as_deref(),
            Some("Add a test for it")
        );
        assert_eq!(
            clean("\"Add a test\"\n\nBecause …").as_deref(),
            Some("Add a test")
        );
        assert_eq!(clean("「加个测试」").as_deref(), Some("加个测试"));
        assert_eq!(clean("- 加个测试").as_deref(), Some("加个测试"));
        assert_eq!(clean("2. 加个测试").as_deref(), Some("加个测试"));
        assert_eq!(clean("Suggestion: 加个测试").as_deref(), Some("加个测试"));
        assert_eq!(clean("下一条消息：加个测试").as_deref(), Some("加个测试"));
        assert_eq!(clean("NONE"), None);
        assert_eq!(clean("none."), None);
        assert_eq!(clean("   "), None);
        // Longer than a message someone would send: the model is answering, not guessing.
        assert_eq!(clean(&"x".repeat(MAX_CHARS + 1)), None);
        // The tail is what the next message answers, so the cut keeps the end.
        let long = "a".repeat(USER_CHARS + 50) + "THE END";
        assert!(tail(&long, USER_CHARS).ends_with("THE END"));
    }

    #[test]
    fn the_first_line_is_read_only_once_it_is_finished() {
        assert_eq!(completed_first_line("Add a t"), None);
        assert_eq!(
            completed_first_line("Add a test\n"),
            Some("Add a test".into())
        );
        assert_eq!(completed_first_line("\n\n"), None);
    }
}
