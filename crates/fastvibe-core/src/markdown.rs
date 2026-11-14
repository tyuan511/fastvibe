use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkdownLine {
    Heading { level: u8, text: String },
    Paragraph(String),
    Code(String),
    Quote(String),
    ListItem(String),
    Rule,
}

pub fn render_markdown(source: &str) -> Vec<MarkdownLine> {
    let mut lines = Vec::new();
    let mut buffer = String::new();
    let mut code = false;
    let mut quote = false;
    let mut list = false;
    let mut heading: Option<u8> = None;
    let flush = |lines: &mut Vec<MarkdownLine>,
                 buffer: &mut String,
                 heading: &mut Option<u8>,
                 quote: bool,
                 list: bool| {
        let text = buffer.trim().to_owned();
        if text.is_empty() {
            return;
        }
        if let Some(level) = heading.take() {
            lines.push(MarkdownLine::Heading { level, text });
        } else if quote {
            lines.push(MarkdownLine::Quote(text));
        } else if list {
            lines.push(MarkdownLine::ListItem(text));
        } else {
            lines.push(MarkdownLine::Paragraph(text));
        }
        buffer.clear();
    };
    for event in Parser::new(source) {
        let is_code_text = matches!(&event, Event::Text(_));
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                })
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(&mut lines, &mut buffer, &mut heading, quote, list)
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => {
                flush(&mut lines, &mut buffer, &mut heading, quote, list)
            }
            Event::Start(Tag::BlockQuote(_)) => quote = true,
            Event::End(TagEnd::BlockQuote(_)) => {
                flush(&mut lines, &mut buffer, &mut heading, quote, list);
                quote = false;
            }
            Event::Start(Tag::List(_)) => list = true,
            Event::End(TagEnd::List(_)) => {
                flush(&mut lines, &mut buffer, &mut heading, quote, list);
                list = false;
            }
            Event::Start(Tag::Item) => {}
            Event::End(TagEnd::Item) => flush(&mut lines, &mut buffer, &mut heading, quote, list),
            Event::Start(Tag::CodeBlock(_)) => code = true,
            Event::End(TagEnd::CodeBlock) => {
                if !buffer.is_empty() {
                    lines.push(MarkdownLine::Code(buffer.trim_end().to_owned()));
                    buffer.clear();
                }
                code = false;
            }
            Event::Rule => {
                flush(&mut lines, &mut buffer, &mut heading, quote, list);
                lines.push(MarkdownLine::Rule);
            }
            Event::Text(text) | Event::Code(text) => {
                if !buffer.is_empty() && !buffer.ends_with('\n') {
                    buffer.push(' ');
                }
                buffer.push_str(&text);
            }
            Event::SoftBreak | Event::HardBreak => buffer.push('\n'),
            Event::Html(text) | Event::InlineHtml(text) => buffer.push_str(&text),
            _ => {}
        }
        if code && is_code_text {
            buffer.push('\n');
        }
    }
    flush(&mut lines, &mut buffer, &mut heading, quote, list);
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_common_chat_blocks() {
        assert_eq!(
            render_markdown("# Title\n\n- one\n- two\n\n```\nlet x = 1;\n```"),
            vec![
                MarkdownLine::Heading {
                    level: 1,
                    text: "Title".into()
                },
                MarkdownLine::ListItem("one".into()),
                MarkdownLine::ListItem("two".into()),
                MarkdownLine::Code("let x = 1;".into()),
            ]
        );
    }
}
