import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:fastvibe_mobile/chat/markdown_chunks.dart';
import 'package:fastvibe_mobile/chat/markdown_view.dart';
import 'package:fastvibe_mobile/chat/turn_meta.dart';
import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/main.dart';
import 'package:fastvibe_mobile/screens/transcript.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/dock.dart';
import 'package:fastvibe_mobile/ui/glass_screen.dart';
import 'package:fastvibe_mobile/ui/kit.dart';

import 'support/reading_sample.dart';

void main() {
  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    await LiquidGlassWidgets.initialize(warmUpMode: GlassWarmUpMode.never);
  });
  Future<void> pump(WidgetTester tester, Widget child, Palette palette) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      LiquidGlassWidgets.wrap(
        theme: GlassThemeData.simple(quality: GlassQuality.minimal),
        brightnessResolver: Theme.maybeBrightnessOf,
        child: MaterialApp(
          theme: buildTheme(palette),
          builder: (_, child) => PaletteScope(palette: palette, child: child!),
          home: child,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));
  }

  /// What the Markdown renderer was handed, joined — the honest way to ask what the list
  /// actually built, since only the rows on screen are built at all.
  String renderedMarkdown(WidgetTester tester) => tester
      .widgetList<GptMarkdown>(find.byType(GptMarkdown))
      .map((widget) => widget.data)
      .join();

  for (final p in [light, dark]) {
    testWidgets(
      'rich Markdown remains readable and horizontally scrolls code/tables (${p.dark})',
      (tester) async {
        await i18n.setPreference(LanguagePreference.en);
        await pump(
          tester,
          Scaffold(
            body: SingleChildScrollView(
              padding: const EdgeInsets.all(22),
              child: MarkdownView(text: readingSample, palette: p),
            ),
          ),
          p,
        );
        expect(tester.takeException(), isNull);
        final markdown = tester.widget<GptMarkdown>(find.byType(GptMarkdown));
        expect(markdown.styleSheet?.table?.overflow, TableOverflow.scroll);
        expect(markdown.styleSheet?.codeBlock?.copyLabel, 'Copy');
        expect(markdown.styleSheet?.inlineCode?.borderWidth, 0);
        await tester.drag(
          find.byType(SingleChildScrollView).first,
          const Offset(0, -500),
        );
        await tester.pump();
        expect(tester.takeException(), isNull);
      },
    );
  }

  // A model that loops on its own output used to hand the renderer the whole reply: the
  // list re-parsed it on every streamed frame and laid every paragraph out inside one row,
  // which froze the phone (unscrollable, then ANR) on the conversation this was reported
  // from — 376 KB in a single assistant message. The reply is now cut into rows at Markdown
  // block boundaries, and the list builds only the ones on screen.
  for (final p in [light, dark]) {
    testWidgets(
      'a reply longer than a chunk is laid out row by row, and none of it is hidden (${p.dark})',
      (tester) async {
        await i18n.setPreference(LanguagePreference.zh);
        // Twelve paragraphs of a few hundred characters: long enough to be cut in two,
        // short enough that the older chunk is one drag away.
        final text = List<String>.generate(
          12,
          (index) => 'Paragraph $index. ${'x' * 600}',
        ).join('\n\n');
        expect(text.length, greaterThan(kMarkdownChunkChars));
        await pump(
          tester,
          TranscriptView(
            messages: <ChatMessage>[
              ChatMessage(
                id: 'long',
                role: 'assistant',
                text: text,
                parts: <MessagePart>[TextPart(text)],
              ),
            ],
            footers: const <String, TurnMeta>{},
            running: false,
            waiting: false,
            workingSince: null,
            now: 0,
            onLongPress: (_) {},
            onOlder: () {},
          ),
          p,
        );
        expect(tester.takeException(), isNull);
        expect(renderedMarkdown(tester).length, lessThan(text.length));
        expect(renderedMarkdown(tester), contains('Paragraph 11.'));
        expect(renderedMarkdown(tester), isNot(contains('Paragraph 0.')));
        // Scrolling back reaches the beginning: nothing was dropped to make it fit.
        for (var scroll = 0;
            scroll < 20 && !renderedMarkdown(tester).contains('Paragraph 0.');
            scroll++) {
          await tester.drag(find.byType(ListView), const Offset(0, 1200));
          await tester.pump();
        }
        expect(renderedMarkdown(tester), contains('Paragraph 0.'));
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'the Markdown theme is handed back by identity across rebuilds',
    (tester) async {
      await i18n.setPreference(LanguagePreference.zh);
      await pump(
        tester,
        Scaffold(body: MarkdownView(text: 'A **reply**.', palette: light)),
        light,
      );
      final first = tester
          .widget<GptMarkdownTheme>(find.byType(GptMarkdownTheme))
          .gptThemeData;
      await pump(
        tester,
        Scaffold(
          body: MarkdownView(text: 'A **reply** with more.', palette: light),
        ),
        light,
      );
      final second = tester
          .widget<GptMarkdownTheme>(find.byType(GptMarkdownTheme))
          .gptThemeData;
      // A fresh instance would notify every descendant, and the package answers that by
      // dropping its parse caches — a full re-parse of the reply on every streamed frame.
      expect(identical(first, second), isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('the bottom toolbar holds the filter and the compose button', (
    tester,
  ) async {
    await i18n.setPreference(LanguagePreference.en);
    var selected = -1;
    var created = false;
    await pump(
      tester,
      GlassScreen(
        title: 'Workspace',
        body: const SizedBox.expand(),
        bottomBar: ConversationDock(
          selected: 0,
          onSelect: (v) => selected = v,
          onCreate: () => created = true,
        ),
      ),
      light,
    );
    expect(
      tester.getTopLeft(find.byType(ConversationDock)).dy,
      greaterThan(600),
    );
    await tester.tap(find.text(t('server.filterWaiting')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(selected, 2);
    await tester.tap(find.bySemanticsLabel(t('common.newChat')));
    await tester.pump();
    expect(created, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a pasted data URL renders as an image without an HTTP request', (
    tester,
  ) async {
    final image = await rootBundle.load('assets/icon.png');
    final uri = Uri.dataFromBytes(
      image.buffer.asUint8List(),
      mimeType: 'image/png',
    );
    final message = ChatMessage(
      id: 'image',
      role: 'user',
      attachments: [
        ChatAttachment(
          id: 'image',
          kind: 'image',
          name: 'Image',
          mimeType: 'image/png',
          dataUrl: uri.toString(),
        ),
      ],
    );
    await pump(
      tester,
      Scaffold(
        body: MessageRow(
          message: message,
          palette: light,
          meta: null,
          turnStart: false,
          live: false,
          onLongPress: (_) {},
        ),
      ),
      light,
    );
    expect(tester.takeException(), isNull);
    expect(tester.widget<Image>(find.byType(Image)).image, isA<MemoryImage>());
  });
}
