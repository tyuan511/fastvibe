//! The model-facing attachment block a prompt carries.
//!
//! A prompt with files attached is sent with a trailing reference list, the same tag the
//! Electron app writes (`<fastvibe-attachments>`), so a transcript written by either build
//! reads the same way:
//!
//! ```text
//! 看看这个报错
//!
//! <fastvibe-attachments>
//! - /tmp/fastvibe-attachments/pasted-image-1793357650522377000.png
//! </fastvibe-attachments>
//! ```
//!
//! That list is how the model is told which files it may open; it is not what the person
//! wrote. Every surface that shows a prompt therefore reads it through
//! [`strip_attachment_block`] and draws the files as chips beside the words — otherwise the
//! bubble grows a block of absolute paths the moment a transcript is re-read.

/// The tag around the file list.
pub const ATTACHMENT_TAG: &str = "fastvibe-attachments";
/// The tag around long pasted text (an older spelling the Electron composer still writes).
pub const PASTED_TEXT_TAG: &str = "fastvibe-pasted-text";

fn open(tag: &str) -> String {
    format!("<{tag}>")
}

fn close(tag: &str) -> String {
    format!("</{tag}>")
}

/// The prompt without the model-facing block it ends with.
///
/// Anchored to the end, the way the Electron app's `stripAttachmentBlock` is: a prompt that
/// merely quotes the tag mid-text keeps every word of it.
pub fn strip_attachment_block(text: &str) -> &str {
    let mut end = text.len();
    loop {
        let head = text[..end].trim_end();
        let tag = if head.ends_with(&close(ATTACHMENT_TAG)) {
            ATTACHMENT_TAG
        } else if head.ends_with(&close(PASTED_TEXT_TAG)) {
            PASTED_TEXT_TAG
        } else {
            break;
        };
        let Some(at) = head.rfind(&open(tag)) else {
            break;
        };
        // A block at the beginning is metadata too; otherwise an attachment-only prompt keeps
        // its manifest even though there are no user words around it.
        if at != 0 && !head[..at].ends_with("\n\n") {
            break;
        }
        end = at;
    }
    text[..end].trim_end()
}

/// The absolute paths the prompt's trailing block lists, in the order it lists them.
pub fn attachment_paths(text: &str) -> Vec<String> {
    let tail = &text[strip_attachment_block(text).len()..];
    let open = open(ATTACHMENT_TAG);
    let close = close(ATTACHMENT_TAG);
    let Some(start) = tail.find(&open) else {
        return Vec::new();
    };
    let Some(end) = tail[start..].find(&close).map(|i| start + i) else {
        return Vec::new();
    };
    tail[start + open.len()..end]
        .lines()
        .filter_map(|line| line.trim().strip_prefix("- "))
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(path: &str) -> String {
        format!("\n\n<{ATTACHMENT_TAG}>\n- {path}\n</{ATTACHMENT_TAG}>")
    }

    #[test]
    fn the_trailing_block_is_not_part_of_what_the_person_wrote() {
        let text = format!("看看这个{}", block("/tmp/a.png"));
        assert_eq!(strip_attachment_block(&text), "看看这个");
        assert_eq!(attachment_paths(&text), vec!["/tmp/a.png".to_string()]);
    }

    #[test]
    fn several_files_keep_their_order_and_a_paste_block_after_them_is_stripped_too() {
        let text = format!(
            "read these{}{}",
            block("/tmp/a.png"),
            format!(
                "\n\n<{PASTED_TEXT_TAG}>\n[{{\"name\":\"x\",\"content\":\"y\"}}]\n</{PASTED_TEXT_TAG}>"
            )
        );
        assert_eq!(strip_attachment_block(&text), "read these");
        assert_eq!(attachment_paths(&text), vec!["/tmp/a.png".to_string()]);
        let two = format!(
            "go{}",
            block("/tmp/a.png").replace("/tmp/a.png", "/tmp/a.png\n- /tmp/b.md")
        );
        assert_eq!(attachment_paths(&two), vec!["/tmp/a.png", "/tmp/b.md"]);
    }

    #[test]
    fn a_prompt_that_merely_quotes_the_tag_keeps_its_words() {
        let text = "how do I write <fastvibe-attachments> in markdown?";
        assert_eq!(strip_attachment_block(text), text);
        assert!(attachment_paths(text).is_empty());
        // Mid-text, without a blank line in front of it, is prose.
        let quoted = format!("look: <{ATTACHMENT_TAG}>\n- /tmp/x\n</{ATTACHMENT_TAG}>");
        assert_eq!(strip_attachment_block(&quoted), quoted);
    }

    #[test]
    fn an_attachment_only_prompt_has_no_words_left() {
        let text = block("/tmp/a.png");
        assert_eq!(strip_attachment_block(&text.trim_start_matches('\n')), "");
        assert_eq!(attachment_paths(&text), vec!["/tmp/a.png".to_string()]);
    }
}
