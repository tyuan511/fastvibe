import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:fastvibe_mobile/main.dart' as app;
import 'package:fastvibe_mobile/chat/composer.dart';
import 'package:fastvibe_mobile/chat/markdown_view.dart';
import 'package:fastvibe_mobile/ui/kit.dart';
import 'package:fastvibe_mobile/ui/dock.dart';
import 'package:fastvibe_mobile/chat/images.dart';
import 'package:fastvibe_mobile/chat/model_picker.dart';
import 'package:fastvibe_mobile/chat/queue_panel.dart';
import 'package:fastvibe_mobile/chat/run_transcript.dart';
import 'package:fastvibe_mobile/chat/transcript_search.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/protocol/address.dart';
import 'package:fastvibe_mobile/router.dart';
import 'package:fastvibe_mobile/screens/chat.dart';
import 'package:fastvibe_mobile/session/connection.dart';
import 'package:fastvibe_mobile/storage/servers.dart';
import 'package:fastvibe_mobile/ui/preferences.dart';
import 'package:fastvibe_mobile/ui/sheet.dart';

import '../test/support/protocol_server.dart';
import '../test/support/reading_sample.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'native device, chat, durable queue, recovery, sheets and themes',
    (tester) async {
      final server = ProtocolServer();
      await server.start();
      addTearDown(() async {
        Connection.instance.disconnect();
        await server.close();
      });
      await Preferences.instance.setNotifications(false);
      await Preferences.instance.setReduceGlass(false);
      await Preferences.instance.setTheme(ThemePreference.light);
      await i18n.setPreference(LanguagePreference.zh);
      // Remove only this test's fixtures from a previous interrupted simulator run.
      await ServerStore.instance.remove('integration');
      await ServerStore.instance.remove('integration-second');
      final saved = await ServerStore.instance.upsert(
        SavedServer(
          id: 'integration',
          alias: 'Studio Mac',
          origin: server.origin,
          host: '127.0.0.1',
          kind: AddressKind.lan,
          createdAt: 1000,
        ),
      );
      await writeToken(saved.id, 'test-token');
      await app.startApp(checkUpdates: false);
      if (Platform.isAndroid) {
        await binding.convertFlutterSurfaceToImage();
        await tester.pump();
      }

      Future<void> until(
        bool Function() condition, {
        String reason = 'UI did not become ready',
      }) async {
        for (var i = 0; i < 200; i++) {
          await tester.pump(const Duration(milliseconds: 100));
          if (condition()) return;
        }
        fail(reason);
      }

      Future<void> shot(String name) async {
        // Advance several frames: a route's first layout starts its glass materialization.
        for (var i = 0; i < 8; i++) {
          await tester.pump(const Duration(milliseconds: 150));
        }
        expect(tester.takeException(), isNull);
        await binding.takeScreenshot('${Platform.operatingSystem}-$name');
        debugPrint('Verified: $name');
      }

      await until(() => find.text('Studio Mac').evaluate().isNotEmpty);
      await shot('devices-light');
      await tester.tap(find.text('Studio Mac'));
      await until(() => find.text('Mobile workspace').evaluate().isNotEmpty);
      await shot('conversations-light');
      expect(
        tester.getTopLeft(find.byType(ConversationDock)).dy,
        greaterThan(400),
      );
      await tester.tap(find.text(t('server.filterWaiting')).first);
      await until(
        () => find.text(t('server.noMatchTitle')).evaluate().isNotEmpty,
      );
      await tester.tap(find.text(t('server.filterAll')).first);
      await until(() => find.text('Mobile workspace').evaluate().isNotEmpty);
      await tester.tap(find.text('Mobile workspace'));
      await until(
        () =>
            find.byType(Composer).evaluate().isNotEmpty &&
            tester.widget<Composer>(find.byType(Composer)).disabled == false,
        reason: 'Snapshot must bind the queue and enable the composer',
      );
      await shot('chat-light');
      final imageData = await rootBundle.load('assets/icon.png');
      final photo = await prepareImageBytes(imageData.buffer.asUint8List());
      expect(photo.mimeType, 'image/jpeg');
      expect(photo.width, lessThanOrEqualTo(maxImageLongSide));
      expect(photo.data.length, lessThan(maxImageBase64Length));
      await Clipboard.setData(
        const ClipboardData(text: 'No image in this test clipboard'),
      );
      expect(
        await pasteImage(),
        isNull,
        reason: 'Native clipboard bridge must handle text-only clips',
      );
      final input = find.descendant(
        of: find.byType(Composer),
        matching: find.byType(TextField),
      );
      await tester.enterText(input, 'A native test prompt');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.bySemanticsLabel(t('composer.send')));
      await until(
        () => server.calls.any((c) => c['method'] == 'engine:submit-prompt'),
      );
      expect(
        server.calls.lastWhere(
          (c) => c['method'] == 'engine:submit-prompt',
        )['payload']['enqueue'],
        isFalse,
      );
      await until(() => tester.widget<Composer>(find.byType(Composer)).running);
      await tester.enterText(input, 'Send this after the current turn');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.bySemanticsLabel(t('composer.send')));
      await until(() => find.byType(QueuePanel).evaluate().isNotEmpty);
      expect(server.items.single['text'], 'Send this after the current turn');
      await shot('chat-queued-keyboard');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump(const Duration(milliseconds: 400));

      final oldClient = Connection.instance.client;
      await server.drop();
      await until(
        () =>
            Connection.instance.client != null &&
            Connection.instance.client != oldClient &&
            !tester.widget<Composer>(find.byType(Composer)).disabled,
        reason: 'Reconnect must restore the same chat and durable queue',
      );
      expect(find.byType(QueuePanel), findsOneWidget);
      expect(
        server.calls.where((c) => c['method'] == 'engine:submit-prompt').length,
        2,
        reason: 'Reconnection must not retry prompts',
      );

      final context = tester.element(find.byType(ChatScreen));
      unawaited(
        showModelPicker(
          context,
          serverId: saved.id,
          currentProvider: null,
          currentModelId: null,
          onPick: (_, _) {},
        ),
      );
      await until(() => find.text(t('models.title')).evaluate().isNotEmpty);
      await shot('models-glass');
      appRouter.pop();
      await tester.pump(const Duration(milliseconds: 600));

      unawaited(
        showAppSheet<void>(
          context: context,
          expanded: true,
          builder: (_) =>
              const RunTranscript(conversationId: 'c1', runId: 'run-1'),
        ),
      );
      await until(
        () => find.textContaining('Subagent checkpoint').evaluate().isNotEmpty,
      );
      await shot('subagent-execution');
      appRouter.pop();
      await tester.pump(const Duration(milliseconds: 600));

      await until(
        () => find
            .bySemanticsLabel(t('server.chatActions'))
            .evaluate()
            .isNotEmpty,
        reason: 'Chat navigation must return after closing a sheet',
      );
      await tester.tap(find.bySemanticsLabel(t('server.chatActions')));
      await until(() => find.text(t('chat.search')).evaluate().isNotEmpty);
      await tester.pump(const Duration(milliseconds: 800));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text(t('chat.search')));
      await until(() => find.byType(TranscriptSearch).evaluate().isNotEmpty);
      await tester.enterText(
        find.descendant(
          of: find.byType(TranscriptSearch),
          matching: find.byType(TextField),
        ),
        'workspace',
      );
      await until(
        () => find
            .textContaining('The workspace is ready.')
            .evaluate()
            .isNotEmpty,
      );
      await shot('search-glass');
      appRouter.pop();
      await tester.pump(const Duration(milliseconds: 500));

      await tester.enterText(input, 'Keep this draft');
      appRouter.pop();
      await until(() => find.text('Mobile workspace').evaluate().isNotEmpty);
      await tester.tap(find.text('Mobile workspace'));
      await until(
        () =>
            find.byType(Composer).evaluate().isNotEmpty &&
            tester.widget<Composer>(find.byType(Composer)).draft.text ==
                'Keep this draft',
      );

      Future<void> previewMarkdown(String mode) async {
        final previewContext = tester.element(find.byType(ChatScreen));
        unawaited(
          showAppSheet<void>(
            context: previewContext,
            expanded: true,
            builder: (context) => Column(
              children: [
                const AppSheetHeader(title: 'Reading preview'),
                Expanded(
                  child: SingleChildScrollView(
                    key: const ValueKey('reading-preview'),
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                    child: MarkdownView(
                      text: readingSample,
                      palette: paletteOf(context),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
        await until(() => find.text('Reading preview').evaluate().isNotEmpty);
        await shot('markdown-$mode');
        await tester.drag(
          find.byKey(const ValueKey('reading-preview')),
          const Offset(0, -450),
        );
        await shot('markdown-$mode-code');
        appRouter.pop();
        await tester.pump(const Duration(milliseconds: 500));
      }

      await previewMarkdown('light');
      await Preferences.instance.setTheme(ThemePreference.dark);
      await shot('chat-dark');
      await previewMarkdown('dark');
      appRouter.go('/settings');
      await until(
        () => find.text(t('settings.reduceGlass')).evaluate().isNotEmpty,
      );
      await shot('settings-dark');
      await Preferences.instance.setReduceGlass(true);
      await shot('settings-reduced-glass');
      await Preferences.instance.setReduceGlass(false);
      await i18n.setPreference(LanguagePreference.en);
      await shot('settings-en');

      appRouter.go('/');
      await until(() => find.text('Studio Mac').evaluate().isNotEmpty);
      final second = ProtocolServer();
      await second.start();
      addTearDown(() async {
        await second.close();
        await ServerStore.instance.remove('integration');
        await ServerStore.instance.remove('integration-second');
      });
      final other = await ServerStore.instance.upsert(
        SavedServer(
          id: 'integration-second',
          alias: 'Second Mac',
          origin: second.origin,
          host: '127.0.0.1',
          kind: AddressKind.lan,
          createdAt: 1000,
        ),
      );
      await writeToken(other.id, 'test-token');
      await openNotificationTarget(other.id, 'c1');
      await until(() => find.byType(ChatScreen).evaluate().isNotEmpty);
      expect(Connection.instance.server?.id, other.id);
      expect(
        server.calls.any((c) => c['method'] == 'conversations:open'),
        isFalse,
      );
      await shot('notification-chat');
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(milliseconds: 500));
    },
  );
}
