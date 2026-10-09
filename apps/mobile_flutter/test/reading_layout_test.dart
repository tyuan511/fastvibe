import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:fastvibe_mobile/chat/markdown_view.dart';
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
        await tester.drag(
          find.byType(SingleChildScrollView).first,
          const Offset(0, -500),
        );
        await tester.pump();
        expect(tester.takeException(), isNull);
      },
    );
  }

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
