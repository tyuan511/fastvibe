import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gpt_markdown/custom_widgets/code_field.dart' show CodeField;

import 'package:fastvibe_mobile/chat/markdown_view.dart';
import 'package:fastvibe_mobile/chat/mermaid_block.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/kit.dart' show PaletteScope;

Widget _surface(Palette palette, Widget child) => MaterialApp(
  theme: ThemeData(
    brightness: palette.dark ? Brightness.dark : Brightness.light,
    scaffoldBackgroundColor: palette.background,
    fontFamily: 'Roboto',
  ),
  home: LanguageScope(
    language: i18n.language,
    child: PaletteScope(
      palette: palette,
      child: DefaultTextStyle(
        style: TextStyle(
          color: palette.text,
          fontFamily: 'Roboto',
          decoration: TextDecoration.none,
        ),
        child: Scaffold(body: child),
      ),
    ),
  ),
);

Future<void> _pumpMarkdown(WidgetTester tester, String text) async {
  await tester.pumpWidget(
    _surface(light, SingleChildScrollView(child: MarkdownView(text: text, palette: light))),
  );
  // The WebView platform is absent in tests, so the render attempt settles into
  // the source fallback — the same state an exotic device without a WebView gets.
  await tester.pumpAndSettle();
}

void main() {
  setUp(() async {
    await i18n.setPreference(LanguagePreference.zh);
  });

  testWidgets('a closed mermaid fence becomes a diagram card', (tester) async {
    await _pumpMarkdown(
      tester,
      '前后都有段落。\n\n```mermaid\nflowchart TD\n  a[开始] --> b[结束]\n```\n\n后文。',
    );
    expect(find.byType(MermaidBlock), findsOneWidget);
    expect(find.text('Mermaid'), findsOneWidget);
    expect(find.text('复制'), findsOneWidget);
    // A valid diagram renders natively — the painted scene replaces the source,
    // and the fallback note stays away.
    expect(find.byType(CustomPaint), findsWidgets);
    expect(find.text('图表语法有误，已显示源码。'), findsNothing);
    expect(find.text('前后都有段落。'), findsOneWidget);
    expect(find.text('后文。'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an mmd fence routes the same way', (tester) async {
    await _pumpMarkdown(
      tester,
      '```mmd\nsequenceDiagram\n  A->>B: hi\n```',
    );
    expect(find.byType(MermaidBlock), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an open fence keeps its source without a render attempt', (
    tester,
  ) async {
    await _pumpMarkdown(
      tester,
      '```mermaid\nflowchart TD\n  a --> b',
    );
    expect(find.byType(MermaidBlock), findsOneWidget);
    expect(find.textContaining('flowchart TD'), findsOneWidget);
    expect(find.text('图表语法有误，已显示源码。'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a fence this port cannot parse falls back to the source', (
    tester,
  ) async {
    await _pumpMarkdown(
      tester,
      '```mermaid\nflowchart TD\n  a -->\n```',
    );
    expect(find.byType(MermaidBlock), findsOneWidget);
    expect(find.text('图表语法有误，已显示源码。'), findsOneWidget);
    expect(find.textContaining('flowchart TD'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an oversized fence keeps a truncated source and a note', (
    tester,
  ) async {
    final padding = '%% ${'x' * 8}\n' * 3000;
    final code = 'flowchart TD\n  a --> b\n$padding';
    expect(code.length, greaterThan(maxMermaidChars));
    await _pumpMarkdown(tester, '```mermaid\n$code```');
    expect(find.byType(MermaidBlock), findsOneWidget);
    expect(find.text('图表过大，已显示源码。'), findsOneWidget);
    expect(find.textContaining('flowchart TD'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('other fences keep the package code block', (tester) async {
    await _pumpMarkdown(tester, '```ts\nconst a = 1;\n```');
    expect(find.byType(MermaidBlock), findsNothing);
    expect(find.byType(CodeField), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
