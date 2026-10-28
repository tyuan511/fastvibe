//! How a reply's markdown is drawn, after `.chat-markdown` and `CodeBlock` in the Electron app
//! (`index.css`, `markdown-view.tsx`): tight paragraphs, 1.15 / 1.05 / 1rem headings, a bordered
//! muted code block, the tinted inline code, a bordered table with a muted header row, and
//! syntax colours taken from the theme's own `--code-*` tokens.

use crate::ui::px;
use fv_theme::Token;
use gpui_kit::base::text::{
    InlineElement, InlineRenderContext, MarkdownExtensions, MarkdownNode, markdown_ast,
};
use gpui_kit::base::{MarkdownPlugin, TextView, TextViewStyle};
use gpui_kit::component::highlighter::HighlightTheme;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme::Palette;

/// The component library's highlight theme with the app's code colours in it: what
/// `--shiki-token-*` maps onto in `index.css`.
pub(crate) fn highlight_theme(p: &Palette) -> std::sync::Arc<HighlightTheme> {
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
    let mut theme = serde_json::from_value(v)
        .map(std::sync::Arc::new)
        .unwrap_or(base);
    // Let Editor paint its own continuous canvas. The gutter falls back to that
    // canvas, masking horizontally scrolling text with the exact same colour.
    // A translucent pane fill would be composited again under the gutter, making
    // it differ even when both regions have the same configured colour.
    let style = &mut std::sync::Arc::make_mut(&mut theme).style;
    // `opacity(1.0)` only multiplies the existing alpha. Glass backgrounds are
    // translucent already, so force alpha explicitly rather than preserving it.
    style.editor_background = Some(Hsla {
        a: 1.0,
        ..p.c(Token::Background)
    });
    style.editor_gutter_background = None;
    style.editor_active_line = Some(Hsla::transparent_black());
    theme
}

pub fn style(p: &Palette) -> TextViewStyle {
    let border = p.c(Token::Border);
    let code_block = StyleRefinement::default()
        .border_1()
        .border_color(border)
        .rounded(px(8.0))
        .bg(p.c(Token::Muted).opacity(0.4))
        .px(px(14.4))
        .py(px(12.0))
        .text_size(px(14.0))
        .line_height(px(20.0));
    let table = StyleRefinement::default()
        .border_1()
        .border_color(border)
        .rounded(px(8.0));
    let table_head = StyleRefinement::default()
        .bg(p.c(Token::Muted).opacity(0.6))
        .text_color(p.c(Token::Foreground))
        .font_weight(FontWeight::MEDIUM);
    let table_cell = StyleRefinement::default()
        .px(px(8.0))
        .py(px(6.0))
        .text_size(px(14.0));
    TextViewStyle::default()
        .with_foreground(p.c(Token::Foreground))
        .with_muted_foreground(p.c(Token::MutedForeground))
        .with_link(p.c(Token::Primary))
        .with_selection(p.c(Token::Primary).opacity(0.25))
        .with_border(border)
        .with_code_background(p.c(Token::Muted))
        // Electron's 0.4em is relative to its 14px body, not the 16px CSS root.
        .with_paragraph_gap(rems(0.4))
        .with_heading(|level| {
            let size = match level {
                1 => 18.4,
                2 => 16.8,
                3 => 16.0,
                _ => 14.0,
            };
            StyleRefinement::default()
                .text_size(px(size))
                .line_height(relative(1.3))
                .font_weight(FontWeight::SEMIBOLD)
                .pt(px(size * 0.8))
                .pb(px(size * 0.4))
        })
        .with_code_block(code_block)
        .with_table(table)
        .with_table_head(table_head)
        .with_table_cell(table_cell)
        .with_inline_code(HighlightStyle {
            background_color: Some(p.c(Token::CodeInlineBg)),
            ..Default::default()
        })
        .with_dark(p.is_dark())
}

#[derive(Clone)]
struct Fence {
    source: String,
    code: String,
    language: String,
}

#[derive(Clone)]
struct List {
    ordered: bool,
    start: u32,
    items: Vec<String>,
}

#[derive(Clone, Copy, Default)]
struct ListDepth {
    ordered: usize,
    unordered: usize,
}

#[derive(Clone)]
struct Table {
    rows: Vec<Vec<String>>,
    weights: Vec<f32>,
    align: Vec<markdown_ast::AlignKind>,
}

// A nested block's first line starts at its marker/text; subsequent source lines still
// carry the containing list's indentation. Remove only that indentation before reparsing.
fn block_source(
    node: &markdown_ast::Node,
    context: &gpui_kit::base::text::MarkdownParseContext<'_>,
) -> String {
    let indent = node
        .position()
        .map_or(0, |p| p.start.column.saturating_sub(1));
    dedent_block(context.node_source(node).unwrap_or_default(), indent)
}

fn dedent_block(source: &str, indent: usize) -> String {
    source
        .lines()
        .enumerate()
        .map(|(i, line)| {
            let spaces = line.bytes().take_while(|b| *b == b' ').count();
            if i == 0 {
                line
            } else {
                &line[indent.min(spaces)..]
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn list_marker(ordered: bool, number: u32, depth: usize) -> String {
    if !ordered {
        return ["•", "◦", "▪"][depth.min(2)].to_string();
    }
    match depth.min(2) {
        1 => {
            let mut n = number.max(1);
            let mut label = String::new();
            while n > 0 {
                n -= 1;
                label.insert(0, (b'a' + (n % 26) as u8) as char);
                n /= 26;
            }
            format!("{label}.")
        }
        2 if (1..4000).contains(&number) => {
            let mut n = number;
            let mut label = String::new();
            for (value, digits) in [
                (1000, "m"),
                (900, "cm"),
                (500, "d"),
                (400, "cd"),
                (100, "c"),
                (90, "xc"),
                (50, "l"),
                (40, "xl"),
                (10, "x"),
                (9, "ix"),
                (5, "v"),
                (4, "iv"),
                (1, "i"),
            ] {
                while n >= value {
                    label.push_str(digits);
                    n -= value;
                }
            }
            format!("{label}.")
        }
        _ => format!("{number}."),
    }
}

#[derive(Clone)]
struct Formula {
    source: String,
    block: bool,
}

/// A dependency-free TeX presentation layer for the native renderer. It keeps the
/// TeX source in the node for accessibility/copying and normalizes the common
/// constructs users expect in chat. Unsupported commands remain visible verbatim.
fn pretty_formula(source: &str) -> String {
    let mut value = source.trim().replace(r"\,", " ").replace(r"\!", "");
    for (from, to) in [
        (r"\alpha", "α"),
        (r"\beta", "β"),
        (r"\gamma", "γ"),
        (r"\delta", "δ"),
        (r"\lambda", "λ"),
        (r"\mu", "μ"),
        (r"\pi", "π"),
        (r"\sigma", "σ"),
        (r"\phi", "φ"),
        (r"\omega", "ω"),
        (r"\infty", "∞"),
        (r"\times", "×"),
        (r"\cdot", "·"),
        (r"\leq", "≤"),
        (r"\geq", "≥"),
        (r"\neq", "≠"),
        (r"\to", "→"),
        (r"\sum", "∑"),
        (r"\prod", "∏"),
        (r"\sqrt", "√"),
    ] {
        value = value.replace(from, to);
    }
    // Braced powers are the most common inline construct; use Unicode superscripts
    // where the exponent is short and leave longer expressions readable.
    for (from, to) in [("^2", "²"), ("^3", "³"), ("^n", "ⁿ"), ("^T", "ᵀ")] {
        value = value.replace(from, to);
    }
    value.replace("\\{", "{").replace("\\}", "}")
}

struct MathInlinePlugin;
impl MarkdownPlugin for MathInlinePlugin {
    fn name(&self) -> &str {
        "chat-math-inline"
    }
    fn parse(
        &self,
        node: &markdown_ast::Node,
        _: &gpui_kit::base::text::MarkdownParseContext<'_>,
    ) -> Option<MarkdownNode> {
        match node {
            markdown_ast::Node::InlineMath(math) => Some(
                MarkdownNode::new(
                    self.name(),
                    Formula {
                        source: math.value.clone(),
                        block: false,
                    },
                )
                .text(pretty_formula(&math.value)),
            ),
            _ => None,
        }
    }
    fn render_inline(
        &self,
        node: &MarkdownNode,
        context: &InlineRenderContext,
        _: &mut Window,
        _: &mut App,
    ) -> Option<InlineElement> {
        let formula = node
            .data::<Formula>()
            .map(|f| {
                debug_assert!(!f.block);
                pretty_formula(&f.source)
            })
            .unwrap_or_else(|| node.as_text().into());
        Some(
            InlineElement::new(
                div()
                    .px(px(2.))
                    .font_family(crate::assets::MONO_FONT)
                    .text_color(Hsla::blue())
                    .text_size(context.font_size())
                    .child(formula),
            )
            .with_baseline(context.font_size() * 0.8),
        )
    }
}
fn math_extensions(p: &Palette) -> MarkdownExtensions {
    let block_palette = p.clone();
    MarkdownExtensions::default()
        .block_parser(|node, _| match node {
            markdown_ast::Node::Math(math) => Some(
                MarkdownNode::new(
                    "chat-math-block",
                    Formula {
                        source: math.value.clone(),
                        block: true,
                    },
                )
                .text(pretty_formula(&math.value)),
            ),
            _ => None,
        })
        .block_renderer("chat-math-block", move |node, _, _| {
            let formula = node
                .data::<Formula>()
                .map(|f| {
                    debug_assert!(f.block);
                    pretty_formula(&f.source)
                })
                .unwrap_or_else(|| node.as_text().into());
            div()
                .w_full()
                .my(px(8.))
                .px(px(14.))
                .py(px(10.))
                .rounded(px(8.))
                .border_1()
                .border_color(block_palette.c(Token::Border))
                .bg(block_palette.c(Token::Muted).opacity(0.35))
                .text_size(px(16.))
                .font_family(crate::assets::MONO_FONT)
                .text_center()
                .child(formula)
        })
        .plugin(MathInlinePlugin)
}

/// Keep native text selection/highlighting, with Electron's full-width code toolbar.
pub fn view(id: SharedString, source: SharedString, p: &Palette) -> TextView {
    view_at(id, source, p, ListDepth::default())
}

fn view_at(id: SharedString, source: SharedString, p: &Palette, depth: ListDepth) -> TextView {
    let palette = p.clone();
    let list_palette = p.clone();
    let table_palette = p.clone();
    TextView::markdown(id, source)
        .markdown_extensions(math_extensions(p))
        .style(style(p))
        .markdown_block_parser(|node, context| {
            if let markdown_ast::Node::List(list) = node {
                // The library already supplies the semantics for task checkboxes.
                if list
                    .children
                    .iter()
                    .any(|n| matches!(n, markdown_ast::Node::ListItem(i) if i.checked.is_some()))
                {
                    return None;
                }
                let items: Vec<String> = list
                    .children
                    .iter()
                    .filter_map(|n| {
                        let markdown_ast::Node::ListItem(item) = n else {
                            return None;
                        };
                        Some(
                            item.children
                                .iter()
                                .map(|child| block_source(child, context))
                                .collect::<Vec<_>>()
                                .join("\n\n"),
                        )
                    })
                    .collect();
                let text = items.join("\n");
                return Some(
                    MarkdownNode::new(
                        "chat-list",
                        List {
                            ordered: list.ordered,
                            start: list.start.unwrap_or(1),
                            items,
                        },
                    )
                    .text(text)
                    .markdown(context.node_source(node).unwrap_or_default().to_string()),
                );
            }
            if let markdown_ast::Node::Table(table) = node {
                let rows: Vec<Vec<String>> = table
                    .children
                    .iter()
                    .filter_map(|n| {
                        let markdown_ast::Node::TableRow(row) = n else {
                            return None;
                        };
                        Some(
                            row.children
                                .iter()
                                .map(|cell| {
                                    cell.children()
                                        .map(|children| {
                                            children
                                                .iter()
                                                .filter_map(|child| context.node_source(child))
                                                .collect::<String>()
                                        })
                                        .unwrap_or_default()
                                        .trim()
                                        .to_string()
                                })
                                .collect(),
                        )
                    })
                    .collect();
                let weights = (0..table.align.len())
                    .map(|col| {
                        rows.iter()
                            .filter_map(|row| row.get(col))
                            .map(|cell| {
                                cell.chars()
                                    .map(|c| if c.is_ascii() { 1 } else { 2 })
                                    .sum::<usize>()
                            })
                            .max()
                            .unwrap_or(1)
                            .clamp(4, 40) as f32
                    })
                    .collect();
                return Some(
                    MarkdownNode::new(
                        "chat-table",
                        Table {
                            rows,
                            weights,
                            align: table.align.clone(),
                        },
                    )
                    .text(node.to_string())
                    .markdown(context.node_source(node).unwrap_or_default().to_string()),
                );
            }
            let markdown_ast::Node::Code(code) = node else {
                return None;
            };
            let source = context.node_source(node)?.to_string();
            Some(
                MarkdownNode::new(
                    "code-fence",
                    Fence {
                        source: source.clone(),
                        code: code.value.clone(),
                        language: code.lang.clone().unwrap_or_else(|| "code".into()),
                    },
                )
                .text(code.value.clone())
                .markdown(source),
            )
        })
        .markdown_block_renderer("code-fence", move |node, _, _| {
            let Some(fence) = node.data::<Fence>() else {
                return div().id("missing-code-fence");
            };
            let p = &palette;
            let code = fence.code.clone();
            let copy = crate::ui::icon_button("copy-code", "copy01", p)
                .w_auto()
                .px(px(6.0))
                .gap(px(4.0))
                .text_size(px(12.0))
                .child("复制")
                .on_click(move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(code.clone()));
                });
            let inner = style(p)
                .with_code_background(Hsla::transparent_black())
                .with_code_block(
                    StyleRefinement::default()
                        .border_0()
                        .rounded(px(0.0))
                        .bg(Hsla::transparent_black())
                        .p(px(0.0))
                        .text_size(px(14.0))
                        .line_height(px(20.0)),
                );
            div()
                .id(SharedString::from(format!(
                    "fence-{}",
                    node.source_range().map_or(0, |r| r.start)
                )))
                .w_full()
                .my(px(8.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .bg(p.c(Token::Muted).opacity(0.4))
                .overflow_hidden()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .px(px(8.0))
                        .py(px(4.0))
                        .border_b_1()
                        .border_color(p.c(Token::Border))
                        .child(
                            div()
                                .text_size(px(12.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(p.c(Token::MutedForeground))
                                .child(SharedString::from(fence.language.clone())),
                        )
                        .child(copy),
                )
                .child(
                    div().px(px(14.4)).py(px(12.0)).child(
                        TextView::markdown("code", SharedString::from(fence.source.clone()))
                            .style(inner)
                            .code_block_actions(|_, _, _| div()),
                    ),
                )
        })
        .markdown_block_renderer("chat-list", move |node, _, _| {
            let mut list = div().flex().flex_col();
            let Some(data) = node.data::<List>() else {
                return list;
            };
            let marker_depth = if data.ordered {
                depth.ordered
            } else {
                depth.unordered
            };
            let mut child_depth = depth;
            if data.ordered {
                child_depth.ordered += 1;
            } else {
                child_depth.unordered += 1;
            }
            for (i, source) in data.items.iter().enumerate() {
                list = list.child(
                    div()
                        .flex()
                        .items_start()
                        .child(
                            div()
                                .w(px(21.0))
                                .flex_none()
                                .pr(px(7.0))
                                .text_right()
                                .text_color(list_palette.c(Token::MutedForeground))
                                .child(SharedString::from(list_marker(
                                    data.ordered,
                                    data.start.saturating_add(i as u32),
                                    marker_depth,
                                ))),
                        )
                        .child(div().flex_1().min_w_0().child(view_at(
                            SharedString::from(format!(
                                "list-{}-{i}",
                                node.source_range().map_or(0, |r| r.start)
                            )),
                            SharedString::from(source.clone()),
                            &list_palette,
                            child_depth,
                        ))),
                );
            }
            list
        })
        .markdown_block_renderer("chat-table", move |node, _, _| {
            let p = &table_palette;
            let id = node.source_range().map_or(0, |r| r.start);
            let mut rows = div().w_full().min_w(px(384.0)).flex().flex_col();
            let Some(table) = node.data::<Table>() else {
                return rows.into_any_element();
            };
            for (r, cells) in table.rows.iter().enumerate() {
                let mut row = div()
                    .w_full()
                    .flex()
                    .when(r + 1 < table.rows.len(), |d| d.border_b_1())
                    .border_color(p.c(Token::Border));
                if r == 0 {
                    row = row
                        .bg(p.c(Token::Muted).opacity(0.6))
                        .font_weight(FontWeight::MEDIUM);
                }
                for (c, weight) in table.weights.iter().enumerate() {
                    let cell = div()
                        .flex_basis(px(0.0))
                        .flex_grow(*weight)
                        .min_w_0()
                        .px(px(8.0))
                        .py(px(6.0))
                        .map(|d| match table.align.get(c) {
                            Some(markdown_ast::AlignKind::Center) => d.text_center(),
                            Some(markdown_ast::AlignKind::Right) => d.text_right(),
                            _ => d,
                        })
                        .child(
                            TextView::markdown(
                                SharedString::from(format!("cell-{id}-{r}-{c}")),
                                SharedString::from(cells.get(c).cloned().unwrap_or_default()),
                            )
                            .style(style(p)),
                        );
                    row = row.child(cell);
                }
                rows = rows.child(row);
            }
            div()
                .id(SharedString::from(format!("table-{id}")))
                .w_full()
                .my(px(8.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .rounded(px(8.0))
                .overflow_hidden()
                .child(div().id("table-scroll").overflow_x_scroll().child(rows))
                .into_any_element()
        })
}

#[cfg(test)]
mod tests {
    use super::{Formula, dedent_block, highlight_theme, list_marker, pretty_formula};

    #[test]
    fn formulas_normalize_common_symbols_without_executing_or_fetching_content() {
        assert_eq!(
            pretty_formula(r"\alpha^2 + \sqrt{x} \leq \infty"),
            "α² + √{x} ≤ ∞"
        );
        assert_eq!(pretty_formula("$HOME/.config"), "$HOME/.config");
        assert_eq!(pretty_formula(r"\unknown{raw}"), r"\unknown{raw}");
    }

    #[test]
    fn formula_nodes_keep_raw_source_for_copy_and_accessibility() {
        let formula = Formula {
            source: r"\frac{a}{b}".into(),
            block: false,
        };
        assert_eq!(pretty_formula(&formula.source), r"\frac{a}{b}");
        assert!(!formula.block);
    }

    #[test]
    fn repainting_the_editor_gutter_does_not_change_the_canvas_colour() {
        // Model the actual paint order without opening a window: Editor paints
        // its canvas, then paints the fixed gutter over that canvas a second time.
        let paint = |source: gpui_kit::Rgba, backdrop: [f32; 3]| {
            [source.r, source.g, source.b]
                .map(|channel| channel * source.a)
                .into_iter()
                .zip(backdrop)
                .map(|(channel, under)| channel + under * (1.0 - source.a))
                .collect::<Vec<_>>()
        };
        for dark in [false, true] {
            for glass in [false, true] {
                let palette = crate::theme::Palette::new(
                    fv_theme::Preferences {
                        glass,
                        ..Default::default()
                    }
                    .resolve(dark, true),
                );
                let theme = highlight_theme(&palette);
                let canvas = theme.style.editor_background.expect("editor canvas");
                let gutter = theme.style.editor_gutter_background.unwrap_or(canvas);
                for backdrop in [[0.1, 0.2, 0.3], [0.9, 0.8, 0.7]] {
                    let body = paint(canvas.into(), backdrop);
                    let line_numbers = paint(gutter.into(), [body[0], body[1], body[2]]);
                    for (body, gutter) in body.into_iter().zip(line_numbers) {
                        assert!(
                            (body - gutter).abs() < 1e-6,
                            "gutter changes canvas colour: dark={dark}, glass={glass}, \
                             body={body}, gutter={gutter}, canvas alpha={}",
                            canvas.a,
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn nested_blocks_preserve_unicode_and_code_indentation() {
        assert_eq!(dedent_block("中文段落\n  继续", 2), "中文段落\n继续");
        assert_eq!(
            dedent_block("```rs\n    fn f() {\n        run();\n    }\n    ```", 4),
            "```rs\nfn f() {\n    run();\n}\n```"
        );
        assert_eq!(
            dedent_block("- 一\n  - 二\n\n  继续", 2),
            "- 一\n- 二\n\n继续"
        );
    }

    #[test]
    fn ordered_markers_handle_starts_and_alphabet_rollover() {
        assert_eq!(list_marker(true, 7, 0), "7.");
        assert_eq!(list_marker(true, 26, 1), "z.");
        assert_eq!(list_marker(true, 27, 1), "aa.");
        assert_eq!(list_marker(true, 49, 2), "xlix.");
        assert_eq!(list_marker(false, 1, 0), "•");
        assert_eq!(list_marker(false, 1, 1), "◦");
    }
}
