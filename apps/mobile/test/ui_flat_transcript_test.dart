import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/composer.dart';
import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/chat/tool_card.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/screens/devices.dart';
import 'package:fastvibe_mobile/screens/transcript.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/app_screen.dart';
import 'package:fastvibe_mobile/ui/kit.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    // Optional real fonts make local captures readable; ordinary tests need no
    // machine-specific file or screenshot infrastructure.
    final path = Platform.environment['FASTVIBE_UI_FONT'];
    if (path != null) {
      final font = ByteData.sublistView(File(path).readAsBytesSync());
      for (final family in <String>[
        'Roboto',
        '.SF UI Text',
        '.SF UI Display',
        'monospace',
      ]) {
        await (FontLoader(
          family,
        )..addFont(Future<ByteData>.value(font))).load();
      }
    }
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await i18n.setPreference(LanguagePreference.en);
  });

  for (final palette in <Palette>[light, dark]) {
    testWidgets(
      'signed-out computers page offers account login in ${palette.dark ? 'dark' : 'light'} mode',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final screenshot = GlobalKey();
        await tester.pumpWidget(
          _surface(
            palette,
            RepaintBoundary(key: screenshot, child: const DevicesScreen()),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text(t('official.signInPrompt')), findsOneWidget);
        expect(find.text(t('devices.add')), findsNothing);
        expect(find.text(t('nav.scan')), findsNothing);
        expect(find.byType(BackdropFilter), findsNothing);
        expect(tester.takeException(), isNull);
        await _capture(
          tester,
          screenshot,
          'fv-flutter-devices-${palette.dark ? 'dark' : 'light'}.png',
        );
      },
    );

    testWidgets(
      'flat transcript keeps user text and tools readable in ${palette.dark ? 'dark' : 'light'} mode',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final screenshot = GlobalKey();
        final draft = TextEditingController();
        addTearDown(draft.dispose);
        const prompt =
            'Keep **this text** and https://example.com/source as written.';
        final messages = <ChatMessage>[
          ChatMessage.fromJson(<String, Object?>{
            'id': 'assistant-1',
            'role': 'assistant',
            'text': 'The simple interface is restored.\n\n- One account, all your computers\n- Chats and files stay together\n- Light and dark themes',
            'parts': <Object?>[
              <String, Object?>{'kind': 'tool', 'toolId': 'read-1'},
              <String, Object?>{
                'kind': 'text',
                'text': 'The simple interface is restored.\n\n- One account, all your computers\n- Chats and files stay together\n- Light and dark themes',
              },
            ],
            'tools': <Object?>[
              <String, Object?>{
                'id': 'read-1',
                'name': 'read',
                'status': 'done',
                'args': <String, Object?>{'path': 'lib/theme/theme.dart'},
                'result': 'Flat grouped-list palette.',
              },
            ],
          }),
          ChatMessage.fromJson(<String, Object?>{
            'id': 'user-1',
            'role': 'user',
            'text': prompt,
          }),
        ];
        await tester.pumpWidget(
          _surface(
            palette,
            RepaintBoundary(
              key: screenshot,
              child: AppScreen(
                title: 'Simple mobile interface',
                showBack: false,
                bottomBar: Composer(
                  conversationId: 'preview-conversation',
                  running: false,
                  draft: draft,
                  images: const [],
                  onImagesChange: (_) {},
                  onSend: () async {},
                  onAbort: () {},
                  onContinue: () {},
                  canContinue: false,
                  deferSessionRead: true,
                ),
                body: TranscriptView(
                  messages: messages,
                  footers: const {},
                  running: false,
                  waiting: false,
                  workingSince: null,
                  onLongPress: (_) {},
                  onOlder: () {},
                ),
              ),
            ),
          ),
        );
        await tester.runAsync(
          () => precacheImage(
            const AssetImage('assets/icon.png'),
            tester.element(find.byType(AppScreen)),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text(prompt), findsOneWidget);
        expect(find.text('theme.dart'), findsOneWidget);
        expect(find.byType(Composer), findsOneWidget);
        expect(find.byType(TextField), findsOneWidget);
        expect(find.byType(BackdropFilter), findsNothing);
        expect(tester.takeException(), isNull);
        for (final box in tester.allRenderObjects.whereType<RenderBox>()) {
          if (box.hasSize &&
              box is RenderFlex &&
              box.direction == Axis.horizontal) {
            expect(box.size.width, lessThanOrEqualTo(390));
          }
        }
        await _capture(
          tester,
          screenshot,
          'fv-flutter-preview-${palette.dark ? 'dark' : 'light'}.png',
        );
      },
    );
  }

  testWidgets('thinking row runs its preview to the disclosure arrow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final messages = <ChatMessage>[
      ChatMessage.fromJson(<String, Object?>{
        'id': 'assistant-1',
        'role': 'assistant',
        'text': 'Done.',
        'parts': <Object?>[
          <String, Object?>{
            'kind': 'thinking',
            'text':
                '**Inspecting billing flows across the gateway handler and the internal key ledger to see where the deduction path actually lands.',
          },
          <String, Object?>{'kind': 'text', 'text': 'Done.'},
        ],
      }),
    ];
    await tester.pumpWidget(
      _surface(
        light,
        Scaffold(
          body: TranscriptView(
            messages: messages,
            footers: const {},
            running: false,
            waiting: false,
            workingSince: null,
            onLongPress: (_) {},
            onOlder: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    RenderBox cardOf(RenderBox descendant) {
      RenderBox box = descendant;
      while (box.parent is RenderBox) {
        box = box.parent! as RenderBox;
        if (box is RenderDecoratedBox) return box;
      }
      fail('no decorated card ancestor');
    }

    double chevronGap() {
      final chevron = tester.renderObject<RenderBox>(find.byType(RotatedBox));
      final card = cardOf(chevron);
      final cardRight = card.localToGlobal(Offset.zero).dx + card.size.width;
      final chevronRight =
          chevron.localToGlobal(Offset.zero).dx + chevron.size.width;
      return cardRight - chevronRight;
    }

    // A loose Flexible on the row's label used to strand the arrow mid-row, an
    // unused flex share wide of the card edge. Collapsed, the preview must run
    // all the way to the arrow.
    expect(chevronGap(), lessThanOrEqualTo(12.5), reason: 'collapsed row');
    await tester.tap(find.byType(InkWell).first);
    await tester.pumpAndSettle();
    expect(chevronGap(), lessThanOrEqualTo(12.5), reason: 'expanded row');
    expect(tester.takeException(), isNull);
  });

  testWidgets('todo disclosure preserves completed and unfinished steps', (
    tester,
  ) async {
    final tool = ToolBlock(
      id: 'todo-1',
      name: 'todo',
      status: 'done',
      details: <String, Object?>{
        'todos': <Object?>[
          <String, Object?>{
            'content': 'Restore the flat interface',
            'status': 'completed',
          },
          <String, Object?>{
            'content': 'Connect the Rust core',
            'status': 'in_progress',
          },
        ],
      },
    );
    await tester.pumpWidget(
      _surface(
        light,
        Scaffold(
          body: ToolCard(tool: tool, palette: light),
        ),
      ),
    );
    expect(find.text('Restore the flat interface'), findsNothing);
    await tester.tap(find.byType(InkWell).first);
    await tester.pumpAndSettle();
    expect(find.text('Restore the flat interface'), findsOneWidget);
    expect(find.text('Connect the Rust core'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  test('current agent collaboration tools use the agent presentation', () {
    for (final name in <String>[
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
    ]) {
      expect(familyOf(name), ToolFamily.agent, reason: name);
    }
  });
}

Widget _surface(Palette palette, Widget child) => MaterialApp(
  theme: ThemeData(
    brightness: palette.dark ? Brightness.dark : Brightness.light,
    scaffoldBackgroundColor: palette.background,
    colorScheme: ColorScheme.fromSeed(
      seedColor: palette.accent,
      brightness: palette.dark ? Brightness.dark : Brightness.light,
    ),
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
        child: child,
      ),
    ),
  ),
);

Future<void> _capture(WidgetTester tester, GlobalKey key, String name) async {
  final directory = Platform.environment['FASTVIBE_UI_CAPTURE_DIR'];
  if (directory == null) return;
  await tester.runAsync(() async {
    final boundary =
        key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    Directory(directory).createSync(recursive: true);
    File('$directory/$name').writeAsBytesSync(data!.buffer.asUint8List());
    image.dispose();
  });
}
