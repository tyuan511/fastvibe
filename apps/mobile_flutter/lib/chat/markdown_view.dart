import 'package:flutter/material.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';

/// Reading typography stays on the content plane. The glass is around the conversation,
/// never behind a paragraph, code fence or table.
class MarkdownView extends StatelessWidget {
  const MarkdownView({
    super.key,
    required this.text,
    required this.palette,
    this.streaming = false,
    this.compact = false,
  });
  final String text;
  final Palette palette;
  final bool streaming;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final size = compact ? 15.0 : 16.0;
    TextStyle heading(double fontSize) => TextStyle(
      color: palette.text,
      fontSize: fontSize,
      height: 1.35,
      letterSpacing: -0.4,
      fontWeight: FontWeight.w700,
    );
    return GptMarkdownTheme(
      gptThemeData: GptMarkdownThemeData(
        brightness: palette.dark ? Brightness.dark : Brightness.light,
        h1: heading(25),
        h2: heading(22),
        h3: heading(19),
        h4: heading(17),
        h5: heading(16),
        h6: heading(15),
        autoAddDividerLineAfterH1: false,
      ),
      child: GptMarkdown(
        text,
        isStreaming: streaming,
        useDollarSignsForLatex: true,
        style: TextStyle(
          color: palette.text,
          fontSize: size,
          height: 1.65,
          letterSpacing: 0.1,
        ),
        styleSheet: GptMarkdownStyleSheet(
          blockSpacing: compact ? 8 : 14,
          heading: const HeadingStyle(
            padding: EdgeInsets.only(top: 12, bottom: 4),
            showDivider: false,
          ),
          inlineCode: InlineCodeStyle(
            backgroundColor: palette.field,
            color: palette.accent,
            borderRadius: const Radius.circular(5),
            fontSizeFactor: 0.88,
          ),
          list: ListStyle(
            bulletSize: 4,
            bulletColor: palette.accent,
            indent: 4,
            gapAfterMarker: 10,
            markerTextStyle: TextStyle(
              color: palette.muted,
              fontWeight: FontWeight.w600,
            ),
          ),
          codeBlock: CodeBlockStyle(
            backgroundColor: palette.card,
            borderColor: palette.border,
            borderWidth: 0.7,
            borderRadius: const Radius.circular(18),
            fontSize: 13,
            textColor: palette.text,
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            headerPadding: const EdgeInsets.fromLTRB(16, 8, 8, 4),
            languageStyle: TextStyle(
              color: palette.muted,
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.5,
            ),
            copyLabel: t('common.copy'),
            copiedLabel: t('common.copied'),
          ),
          link: LinkStyle(
            color: palette.accent,
            decoration: TextDecoration.underline,
          ),
          table: TableStyle(
            borderColor: palette.border,
            borderWidth: 0.5,
            borderRadius: const Radius.circular(14),
            cellPadding: const EdgeInsets.symmetric(
              horizontal: 14,
              vertical: 11,
            ),
            headerBackground: palette.field,
            rowStripeColor: palette.card.withValues(alpha: 0.7),
            overflow: TableOverflow.scroll,
            headerTextStyle: TextStyle(
              color: palette.text,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
          blockQuote: BlockQuoteStyle(
            backgroundColor: palette.accentSoft.withValues(alpha: 0.4),
            barColor: palette.accent.withValues(alpha: 0.65),
            barWidth: 3,
            barRadius: const Radius.circular(2),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            margin: const EdgeInsets.symmetric(vertical: 6),
            textStyle: TextStyle(color: palette.muted, height: 1.6),
          ),
          hr: HrStyle(color: palette.border, thickness: 0.7),
        ),
        onLinkTap: (url, title) {
          final uri = Uri.tryParse(url);
          if (uri == null || !['https', 'http', 'mailto'].contains(uri.scheme)) {
            return;
          }
          launchUrl(uri, mode: LaunchMode.externalApplication);
        },
      ),
    );
  }
}
