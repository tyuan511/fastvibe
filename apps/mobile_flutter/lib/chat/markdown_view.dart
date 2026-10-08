import 'package:flutter/material.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:url_launcher/url_launcher.dart';

import '../theme/theme.dart';

/// A reply's prose.
///
/// Markdown, not plain text: the model writes headings, lists, tables and fences, and a
/// chat that shows the asterisks is a chat nobody reads. Code fences get their own panel
/// with a copy button; `$…$` and `$$…$$` are typeset.
class MarkdownView extends StatelessWidget {
  const MarkdownView({super.key, required this.text, required this.palette});

  final String text;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    return GptMarkdown(
      text,
      style: TextStyle(
        color: palette.text,
        fontSize: 15,
        height: 24 / 15,
      ),
      styleSheet: GptMarkdownStyleSheet(
        inlineCode: InlineCodeStyle(
          backgroundColor: palette.field,
          color: palette.text,
          fontFamily: 'monospace',
          fontSizeFactor: 0.88,
        ),
        codeBlock: CodeBlockStyle(
          backgroundColor: palette.field,
          borderColor: palette.border,
          textColor: palette.text,
          languageStyle: TextStyle(color: palette.muted, fontSize: 12),
          copyLabel: '复制',
          copiedLabel: '已复制',
        ),
        link: LinkStyle(color: palette.accent, decoration: TextDecoration.underline),
        table: TableStyle(
          borderColor: palette.border,
          borderWidth: 0.5,
          headerBackground: palette.field,
          headerTextStyle: TextStyle(color: palette.text, fontWeight: FontWeight.w700),
        ),
        blockQuote: BlockQuoteStyle(
          backgroundColor: palette.field,
          barColor: palette.accent,
          textStyle: TextStyle(color: palette.muted),
        ),
        hr: HrStyle(color: palette.border, thickness: 0.5),
      ),
      onLinkTap: (url, title) {
        final uri = Uri.tryParse(url);
        if (uri == null) return;
        launchUrl(uri);
      },
    );
  }
}
