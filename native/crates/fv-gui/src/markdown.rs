//! How a reply's markdown is drawn, after `.chat-markdown` and `CodeBlock` in the Electron app
//! (`index.css`, `markdown-view.tsx`): tight paragraphs, 1.15 / 1.05 / 1rem headings, a bordered
//! muted code block, the tinted inline code, a bordered table with a muted header row, and
//! syntax colours taken from the theme's own `--code-*` tokens.

use fv_theme::Token;
use gpui_kit::component::highlighter::HighlightTheme;
use gpui_kit::component::text::TextViewStyle;
use gpui_kit::*;

use crate::theme::Palette;

/// The component library's highlight theme with the app's code colours in it: what
/// `--shiki-token-*` maps onto in `index.css`.
fn highlight_theme(p: &Palette) -> std::sync::Arc<HighlightTheme> {
    let base = if p.is_dark() {
        HighlightTheme::default_dark()
    } else {
        HighlightTheme::default_light()
    };
    let Ok(mut v) = serde_json::to_value(&*base) else {
        return base;
    };
    let colour = |t: Token| serde_json::json!({ "color": p.c(t) });
    let keyword = colour(Token::CodeKeyword);
    let string = colour(Token::CodeString);
    let number = colour(Token::CodeNumber);
    let comment = colour(Token::CodeComment);
    let punctuation = colour(Token::MutedForeground);
    let foreground = colour(Token::Foreground);
    if let Some(syntax) = v
        .pointer_mut("/style/syntax")
        .and_then(|s| s.as_object_mut())
    {
        for (keys, value) in [
            (
                &[
                    "keyword",
                    "function",
                    "tag",
                    "type",
                    "constructor",
                    "attribute",
                    "preproc",
                    "enum",
                    "variant",
                    "label",
                ][..],
                &keyword,
            ),
            (
                &[
                    "string",
                    "string.escape",
                    "string.regex",
                    "string.special",
                    "string.special.symbol",
                    "text.literal",
                    "link_uri",
                    "link_text",
                ][..],
                &string,
            ),
            (
                &["number", "boolean", "constant", "variable.special"][..],
                &number,
            ),
            (&["comment", "comment_doc"][..], &comment),
            (
                &[
                    "punctuation",
                    "punctuation.bracket",
                    "punctuation.delimiter",
                    "punctuation.special",
                    "operator",
                ][..],
                &punctuation,
            ),
            (
                &["variable", "property", "primary", "title"][..],
                &foreground,
            ),
        ] {
            for key in keys {
                syntax.insert((*key).to_string(), value.clone());
            }
        }
    }
    serde_json::from_value(v)
        .map(std::sync::Arc::new)
        .unwrap_or(base)
}

pub fn style(p: &Palette) -> TextViewStyle {
    let border = p.c(Token::Border);
    let code_block = StyleRefinement::default()
        .border_1()
        .border_color(border)
        .rounded(px(8.0))
        .bg(p.c(Token::Muted).opacity(0.4))
        .p(px(12.0))
        .text_size(px(13.0));
    let table = StyleRefinement::default()
        .border_1()
        .border_color(border)
        .rounded(px(8.0));
    let table_head = StyleRefinement::default()
        .bg(p.c(Token::Muted).opacity(0.6))
        .font_weight(FontWeight::MEDIUM);
    let table_cell = StyleRefinement::default().px(px(8.0)).py(px(6.0));
    let mut style = TextViewStyle::default()
        .paragraph_gap(rems(0.4))
        .heading_font_size(|level, base| match level {
            1 => px(18.4),
            2 => px(16.8),
            3 => px(16.0),
            _ => base,
        })
        .code_block(code_block)
        .table(table)
        .table_head(table_head)
        .table_cell(table_cell)
        .inline_code(HighlightStyle {
            background_color: Some(p.c(Token::CodeInlineBg)),
            ..Default::default()
        });
    style.heading_base_font_size = px(14.0);
    style.highlight_theme = highlight_theme(p);
    style.is_dark = p.is_dark();
    style
}
