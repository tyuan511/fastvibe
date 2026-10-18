import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/plain.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/composer.dart';
import 'package:fastvibe_mobile/chat/transcript_cache.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/main.dart';
import 'package:fastvibe_mobile/protocol/address.dart';
import 'package:fastvibe_mobile/screens/chat.dart';
import 'package:fastvibe_mobile/session/connection.dart';
import 'package:fastvibe_mobile/storage/servers.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/feedback.dart';
import 'package:fastvibe_mobile/ui/kit.dart';

import 'support/protocol_server.dart';

class PreviewCache extends TranscriptCache {
  PreviewCache(this.preview);
  final Future<List<Object?>?> preview;
  final writes = <List<Object?>>[];
  @override
  Future<List<Object?>?> read(String server, String conversation) => preview;
  @override
  Future<void> write(
    String server,
    String conversation,
    List<Object?> messages,
  ) async {
    writes.add(messages);
  }
}

Map<String, Object?> row(String id, String text) => {
  'id': id,
  'role': 'user',
  'text': text,
};

Future<void> until(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 4));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('condition timed out');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

Future<void> pumpUntil(WidgetTester tester, bool Function() condition) async {
  for (var i = 0; i < 60 && !condition(); i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  expect(condition(), isTrue);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  final connection = Connection.instance;
  late ProtocolServer server;
  late SavedServer saved;
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    await i18n.setPreference(LanguagePreference.en);
    connection.disconnect();
    connection.handleNetworkChange([ConnectivityResult.wifi]);
    server = ProtocolServer()..features['transcriptPreview'] = true;
  });

  Future<void> connect(WidgetTester tester) async {
    await tester.runAsync(() async {
      await server.start();
      saved = SavedServer(
        id: 'loading-test',
        alias: 'Test',
        origin: server.origin,
        host: '127.0.0.1',
        kind: AddressKind.loopback,
        createdAt: 0,
      );
      await writeToken(saved.id, 'test-token');
      await connection.connectSaved(saved);
    });
  }

  Future<void> pump(WidgetTester tester, PreviewCache cache) async {
    await tester.pumpWidget(
      plain(
        child: MaterialApp(
          theme: buildTheme(light),
          home: PaletteScope(
            palette: light,
            child: ToastHost(
              child: ChatScreen(conversationId: 'c1', transcriptCache: cache),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  Future<void> clean(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(() async {
      connection.disconnect();
      await server.close();
    });
  }

  testWidgets(
    'cache paints during a slow snapshot, but cannot send or initialize an agent',
    (tester) async {
      final snapshot = Completer<Object?>();
      server.handlers['engine:get-snapshot'] = (_) => snapshot.future;
      final cache = PreviewCache(
        Future.value([row('old', 'cached recent text')]),
      );
      await connect(tester);
      await pump(tester, cache);
      await tester.runAsync(
        () => until(
          () => server.calls.any(
            (call) => call['method'] == 'engine:get-snapshot',
          ),
        ),
      );
      expect(find.text('cached recent text'), findsOneWidget);
      expect(tester.widget<Composer>(find.byType(Composer)).disabled, isTrue);
      // A sync that has only just begun is not worth a banner: it would flash, and grow the
      // footer under the transcript twice. One that runs long gets one.
      expect(find.text(t('chat.syncing')), findsNothing);
      await tester.pump(const Duration(milliseconds: 1600));
      expect(find.text(t('chat.syncing')), findsOneWidget);
      expect(
        server.calls.any((call) => call['method'] == 'engine:get-state'),
        isFalse,
      );
      final request =
          server.calls.firstWhere(
                (call) => call['method'] == 'engine:get-snapshot',
              )['payload']
              as Map;
      expect(request['historyLimit'], 3);
      expect(
        request.containsKey('fromEntryId'),
        isFalse,
        reason: 'a cache is never a tail/replay anchor',
      );
      expect((request['readOptions'] as Map)['preview'], isTrue);
      snapshot.complete({
        'conversationId': 'c1',
        'seq': 20,
        'running': false,
        'queue': server.queue('c1'),
        'messageMode': 'window',
        'history': {'beforeEntryId': null},
        'pendingUi': [],
        'messages': [row('new', 'fresh authoritative text')],
      });
      await pumpUntil(tester, () => cache.writes.isNotEmpty);
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('fresh authoritative text'), findsOneWidget);
      expect(find.text('cached recent text'), findsNothing);
      expect(find.text(t('chat.syncing')), findsNothing);
      expect(tester.widget<Composer>(find.byType(Composer)).disabled, isFalse);
      await clean(tester);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a late cache read cannot overwrite a newer authoritative snapshot',
    (tester) async {
      final delayed = Completer<List<Object?>?>();
      final cache = PreviewCache(delayed.future);
      server.handlers['engine:get-snapshot'] = (_) => {
        'conversationId': 'c1',
        'seq': 20,
        'running': false,
        'queue': server.queue('c1'),
        'pendingUi': [],
        'messages': [row('fresh', 'fresh server message')],
      };
      await connect(tester);
      await pump(tester, cache);
      await pumpUntil(tester, () => cache.writes.isNotEmpty);
      await tester.pump(const Duration(milliseconds: 50));
      delayed.complete([row('old', 'obsolete cache message')]);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('fresh server message'), findsOneWidget);
      expect(find.text('obsolete cache message'), findsNothing);
      await clean(tester);
      expect(tester.takeException(), isNull);
    },
  );
}
