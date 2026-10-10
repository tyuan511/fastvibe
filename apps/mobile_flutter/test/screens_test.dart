import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:fastvibe_mobile/chat/composer.dart';
import 'package:fastvibe_mobile/chat/images.dart';
import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/chat/process_group.dart';
import 'package:fastvibe_mobile/chat/prompt_card.dart';
import 'package:fastvibe_mobile/chat/queue.dart';
import 'package:fastvibe_mobile/chat/queue_panel.dart';
import 'package:fastvibe_mobile/chat/tool_card.dart';
import 'package:fastvibe_mobile/chat/turn_meta.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/screens/add_device.dart';
import 'package:fastvibe_mobile/screens/devices.dart';
import 'package:fastvibe_mobile/screens/scan.dart';
import 'package:fastvibe_mobile/screens/settings.dart';
import 'package:fastvibe_mobile/screens/transcript.dart';
import 'package:fastvibe_mobile/session/connection.dart';
import 'package:fastvibe_mobile/main.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/feedback.dart';
import 'package:fastvibe_mobile/ui/kit.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

/// Renders every screen and the chat's own widgets.
///
/// This is the layer `flutter analyze` cannot see. The failure it exists to catch is a
/// render-time throw — a widget that asserts on a missing ancestor, a component used
/// outside the group it needs, a `null` reached through a path a type did not express.
/// Those unmount the whole tree and produce a white window, and no amount of static
/// analysis finds them.
///
/// Nothing here connects to a machine: the connection is in its idle state, which is
/// exactly the first-run path that has to work rather than throw.
void main() {
  setUpAll(() async {
    // `SharedPreferences` is a platform channel; without a mock every read throws
    // `MissingPluginException` and the failure surfaces as a late error on whichever
    // test happened to be running. The app's own storage layer is exercised against the
    // in-memory store the mock installs.
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await LiquidGlassWidgets.initialize(warmUpMode: GlassWarmUpMode.never);
    await I18n.instance.setPreference(LanguagePreference.zh);
  });

  Future<void> pump(
    WidgetTester tester,
    Widget child, {
    Palette? palette,
  }) async {
    final active = palette ?? light;
    await tester.pumpWidget(
      LiquidGlassWidgets.wrap(
        brightnessResolver: Theme.maybeBrightnessOf,
        child: ListenableBuilder(
          listenable: i18n,
          builder: (context, _) => MaterialApp(
            theme: buildTheme(active),
            home: LanguageScope(
              language: i18n.language,
              child: PaletteScope(
                palette: active,
                child: ToastHost(child: child),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 350));
  }

  testWidgets('a page already open follows a language switch', (tester) async {
    // The bug this pins: the root repaints on a language change but go_router keeps
    // each page by its key, so a page that was already open went on drawing the
    // language it was opened in until it was reopened.
    await pump(tester, const DevicesScreen());
    final before = t('devices.workspaces');
    expect(find.text(before), findsWidgets);

    await i18n.setPreference(LanguagePreference.en);
    await tester.pump();

    expect(find.text(t('devices.workspaces')), findsWidgets);
    expect(find.text(before), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the device list renders before anything is saved', (
    tester,
  ) async {
    await pump(tester, const DevicesScreen());
    expect(tester.takeException(), isNull);
  });

  testWidgets('the add-device form renders with an empty address', (
    tester,
  ) async {
    await pump(tester, const AddDeviceScreen());
    expect(tester.takeException(), isNull);
    expect(find.text(t('nav.addDevice')), findsWidgets);
  });

  testWidgets('settings renders every section', (tester) async {
    await pump(tester, const SettingsScreen());
    expect(tester.takeException(), isNull);
    expect(find.text(t('settings.appearance')), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text(t('settings.general')),
      180,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text(t('settings.general')), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text(t('settings.about')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text(t('settings.about')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the scanner asks for a camera rather than throwing', (
    tester,
  ) async {
    await pump(tester, const ScanScreen());
    expect(find.byType(MobileScanner), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a process card keeps tool calls compact', (tester) async {
    final steps = <ProcessStep>[
      const ThinkingStep('weighing the options'),
      ToolStep(
        ToolBlock(
          id: 't1',
          name: 'read',
          args: <String, Object?>{'path': '/tmp/a.txt'},
          result: 'hello',
        ),
      ),
      ToolStep(
        ToolBlock(
          id: 't2',
          name: 'bash',
          args: <String, Object?>{'command': 'ls'},
          status: 'error',
          result: 'boom',
        ),
      ),
    ];
    await pump(
      tester,
      Scaffold(
        body: ProcessGroup(steps: steps, palette: light),
      ),
    );
    expect(tester.takeException(), isNull);
    // Mobile keeps the tool row compact; arguments and output are never shown.
    expect(find.text('a.txt'), findsOneWidget);
    expect(find.text('hello'), findsNothing);
    await tester.tap(find.text('a.txt'));
    await tester.pump();
    expect(find.text('hello'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('every tool family draws a row without throwing', (tester) async {
    final names = <String>[
      'read',
      'edit',
      'write',
      'delete',
      'grep',
      'web_search',
      'ls',
      'bash',
      'skill_view',
      'subagent',
      'todo',
      'question',
      'mcp__server__tool',
      'codemode',
      'browser_click',
      'mystery_tool',
      'dag_add_tasks',
      'dag_report',
    ];
    await pump(
      tester,
      Scaffold(
        body: ListView(
          children: <Widget>[
            for (final name in names)
              ToolCard(
                tool: ToolBlock(
                  id: name,
                  name: name,
                  args: <String, Object?>{'path': '/tmp/x', 'query': 'q'},
                ),
                palette: light,
              ),
          ],
        ),
      ),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('the transcript draws a reply, a user row and a footer', (
    tester,
  ) async {
    final messages = <ChatMessage>[
      ChatMessage(
        id: 'a2',
        role: 'assistant',
        text: 'the answer',
        lastId: 'a2',
      ),
      ChatMessage(id: 'u1', role: 'user', text: 'a question'),
      ChatMessage(id: 'a1', role: 'assistant', text: 'earlier'),
    ];
    await pump(
      tester,
      Scaffold(
        body: TranscriptView(
          messages: messages,
          footers: completedTurnFooters(<ChatMessage>[
            ChatMessage(id: 'u1', role: 'user', createdAt: 1000),
            ChatMessage(
              id: 'a2',
              role: 'assistant',
              text: 'the answer',
              createdAt: 1100,
              completedAt: 2000,
            ),
          ], false),
          running: false,
          waiting: false,
          workingSince: null,
          now: DateTime.now().millisecondsSinceEpoch,
          onLongPress: (_) {},
          onOlder: () {},
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.textContaining('a question'), findsOneWidget);
  });

  testWidgets('the working capsule renders while a run is in flight', (
    tester,
  ) async {
    await pump(tester, Scaffold(body: WorkingPill(since: 1000, now: 61000)));
    expect(tester.takeException(), isNull);
    expect(find.text(t('chat.working')), findsOneWidget);
    expect(find.text('01:00'), findsOneWidget);
  });

  testWidgets('the queue panel shows a paused queue with the way to resume', (
    tester,
  ) async {
    final queue = QueueState(
      conversationId: 'c1',
      revision: 3,
      items: <QueueItem>[
        const QueueItem(id: 'a', text: 'one', behavior: 'followUp'),
        const QueueItem(id: 'b', text: 'two', behavior: 'steer'),
        const QueueItem(
          id: 'c',
          text: 'three',
          behavior: 'followUp',
          claimed: true,
        ),
      ],
      pause: 'stopped',
    );
    await pump(
      tester,
      Scaffold(
        body: QueuePanel(
          queue: queue,
          disabled: false,
          onCancel: (_) {},
          onResume: () {},
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.text(t('queue.resume')), findsOneWidget);
    expect(find.text(t('queue.claimed')), findsOneWidget);
    expect(find.text(t('queue.steer')), findsOneWidget);
  });

  testWidgets('an empty queue draws nothing at all', (tester) async {
    await pump(
      tester,
      Scaffold(
        body: QueuePanel(
          queue: emptyQueue('c1'),
          disabled: false,
          onCancel: (_) {},
          onResume: () {},
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.byType(QueuePanel), findsOneWidget);
  });

  testWidgets('each blocking prompt shape renders and builds its own payload', (
    tester,
  ) async {
    final cases = <(String, BlockingPrompt)>[
      (
        'confirm',
        const BlockingPrompt(
          id: 'p1',
          method: 'confirm',
          title: 'Overwrite?',
          message: 'rm -rf build',
        ),
      ),
      (
        'select',
        const BlockingPrompt(
          id: 'p2',
          method: 'select',
          title: 'Which one?',
          options: <String>['a', 'b'],
        ),
      ),
      (
        'input',
        const BlockingPrompt(id: 'p3', method: 'input', title: 'Name?'),
      ),
      (
        'editor',
        const BlockingPrompt(
          id: 'p4',
          method: 'editor',
          title: 'Write it',
          message: 'prefill',
        ),
      ),
      (
        'questions',
        const BlockingPrompt(
          id: 'p5',
          method: 'questions',
          title: 'A few things',
          questions: <PromptQuestion>[
            PromptQuestion(
              question: 'First?',
              header: 'H1',
              options: <String>['x', 'y'],
            ),
            PromptQuestion(question: 'Second?'),
          ],
        ),
      ),
    ];
    for (final (method, prompt) in cases) {
      Map<String, Object?>? sent;
      await pump(
        tester,
        Scaffold(
          body: PromptCard(
            prompt: prompt,
            busy: false,
            onRespond: (payload) => sent = payload,
          ),
        ),
      );
      expect(
        tester.takeException(),
        isNull,
        reason: '$method threw while rendering',
      );

      switch (method) {
        case 'confirm':
          await tester.tap(find.text(t('prompt.yes')));
          expect(sent, <String, Object?>{'id': 'p1', 'confirmed': true});
        case 'select':
          await tester.tap(find.text('a'));
          expect(sent, <String, Object?>{'id': 'p2', 'value': 'a'});
        case 'questions':
          await tester.tap(find.text('x'));
          await tester.pump();
          expect(sent, isNull);
      }
    }
  });

  testWidgets(
    'the composer renders disabled on a fresh install with no model',
    (tester) async {
      await pump(
        tester,
        Scaffold(
          body: Composer(
            conversationId: 'c1',
            running: false,
            disabled: true,
            draft: TextEditingController(),
            images: const <ComposerImage>[],
            onImagesChange: (_) {},
            onDraftChange: (_) {},
            onSend: () async {},
            onAbort: () {},
            onContinue: () {},
            canContinue: false,
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      // The first-run path: no model, so the placeholder asks for one instead of failing.
      expect(find.text(t('composer.placeholderLoading')), findsOneWidget);
    },
  );

  // The app ships light *and* dark; every screen is drawn in both. A hardcoded colour
  // or a missing token shows up as an unreadable row rather than as an error, so the
  // only way to catch it is to render the dark theme too.
  for (final (name, palette) in <(String, Palette)>[
    ('light', light),
    ('dark', dark),
  ]) {
    testWidgets('every screen renders in the $name theme', (tester) async {
      await pump(tester, const DevicesScreen(), palette: palette);
      expect(tester.takeException(), isNull, reason: 'devices/$name');
      await pump(tester, const AddDeviceScreen(), palette: palette);
      expect(tester.takeException(), isNull, reason: 'add/$name');
      await pump(tester, const SettingsScreen(), palette: palette);
      expect(tester.takeException(), isNull, reason: 'settings/$name');
      await pump(
        tester,
        Scaffold(
          body: TranscriptView(
            messages: <ChatMessage>[
              ChatMessage(
                id: 'a2',
                role: 'assistant',
                text: 'answer',
                lastId: 'a2',
              ),
              ChatMessage(id: 'u1', role: 'user', text: 'question'),
            ],
            footers: const <String, TurnMeta>{},
            running: true,
            waiting: false,
            workingSince: 1000,
            now: 2000,
            onLongPress: (_) {},
            onOlder: () {},
          ),
        ),
        palette: palette,
      );
      expect(tester.takeException(), isNull, reason: 'transcript/$name');
    });
  }

  testWidgets('the connection starts idle and lists nothing', (tester) async {
    expect(Connection.instance.status, ConnectionStatus.idle);
    expect(Connection.instance.conversations, isEmpty);
  });
}
