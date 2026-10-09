import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/queue.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/protocol/address.dart';
import 'package:fastvibe_mobile/protocol/client.dart';

import 'support/protocol_server.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // This suite explicitly exercises a real loopback peer, never an external host.
  HttpOverrides.global = null;
  late ProtocolServer server;
  late RemoteClient client;
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await i18n.setPreference(LanguagePreference.en);
    server = ProtocolServer();
    await server.start();
    client = RemoteClient();
  });
  tearDown(() async {
    client.close();
    await server.close();
  });
  Future<void> connect() =>
      client.connect(parseServerAddress(server.origin)!, 'test-token');

  test(
    'login exchanges a password, then negotiates features and a named scope',
    () async {
      final token = await client.login(
        server.origin,
        'test-password',
        'Test phone',
      );
      expect(token, 'test-token');
      await connect();
      expect(client.supportsPromptSubmit, isTrue);
      final subscription = await client.subscribeConversation(
        'conversation:c1',
      );
      expect(subscription.cursor?.epoch, 'test-epoch');
      expect(subscription.resumed, isFalse);
      final snapshot = await client.call('engine:get-snapshot', {
        'conversationId': 'c1',
      }) as Map;
      expect(mergeQueue(emptyQueue('c1'), snapshot['queue']).revision, 0);
      expect(
        server.calls.any((call) => call['method'] == 'conversations:open'),
        isFalse,
      );
    },
  );

  test('invalid device token fails authentication', () async {
    await expectLater(
      client.connect(parseServerAddress(server.origin)!, 'invalid'),
      throwsA(
        isA<ConnectionError>().having((e) => e.code, 'code', 'unauthorized'),
      ),
    );
  });

  test('out of order RPC replies resolve only their own request', () async {
    final first = Completer<Object?>();
    server.handlers['test:first'] = (_) => first.future;
    server.handlers['test:second'] = (_) => 'second';
    await connect();
    final pending = client.call('test:first');
    expect(await client.call('test:second'), 'second');
    first.complete('first');
    expect(await pending, 'first');
  });

  test('continue waits for a healthy run longer than 30 seconds', () async {
    final finished = Completer<Object?>();
    server.handlers['engine:continue'] = (_) => finished.future;
    await connect();
    client.setActive(true);
    final completeRun = Timer(const Duration(seconds: 31), () => finished.complete(null));
    addTearDown(() {
      completeRun.cancel();
      if (!finished.isCompleted) finished.complete(null);
    });
    await expectLater(client.call('engine:continue', {'conversationId': 'c1'}), completes);
    expect(server.calls.where((call) => call['method'] == 'engine:continue').length, 1);
    expect(server.frames.any((frame) => frame['kind'] == 'cancel'), isFalse);
    expect(server.frames.any((frame) => frame['kind'] == 'ping'), isTrue);
  }, timeout: const Timeout(Duration(seconds: 40)));

  test('a dropped socket still rejects a pending continuation', () async {
    final accepted = Completer<void>();
    final finished = Completer<Object?>();
    server.handlers['engine:continue'] = (_) {
      accepted.complete();
      return finished.future;
    };
    await connect();
    final pending = expectLater(
      client.call('engine:continue', {'conversationId': 'c1'}),
      throwsA(isA<TransportError>().having((e) => e.code, 'code', 'dropped')),
    );
    await accepted.future;
    await server.drop();
    await pending;
    finished.complete(null);
  });

  test(
    'atomic submit sends images once; busy send stays in durable queue',
    () async {
      await connect();
      var optimistic = 0;
      await submitMessage(
        client,
        conversationId: 'c1',
        text: 'direct',
        images: [const PromptImage(data: 'image-data')],
        enqueue: false,
        onPrompt: () => optimistic++,
      );
      final queued = await submitMessage(
        client,
        conversationId: 'c1',
        text: 'later',
        enqueue: true,
        onPrompt: () => optimistic++,
      );
      expect(optimistic, 1);
      expect(mergeQueue(emptyQueue('c1'), queued).items.single.text, 'later');
      expect(server.calls.first['payload']['images'][0]['data'], 'image-data');
      expect(
        server.calls.where((c) => c['method'] == 'engine:submit-prompt').length,
        2,
      );
    },
  );

  test(
    'a lost acknowledgement retains optimistic state and is never retried',
    () async {
      final accepted = Completer<void>();
      server.handlers['engine:submit-prompt'] = (_) async {
        accepted.complete();
        await server.drop();
        return null;
      };
      await connect();
      var optimistic = 0;
      final submission = submitMessage(
        client,
        conversationId: 'c1',
        text: 'accepted',
        enqueue: false,
        onPrompt: () => optimistic++,
      );
      await expectLater(submission, throwsA(isA<SubmissionUncertainError>()));
      await accepted.future;
      expect(optimistic, 1);
      expect(server.calls.length, 1);
    },
  );

  test(
    'an RPC timeout cancels and probes without resending the mutation',
    () async {
      final delayed = Completer<Object?>();
      server.handlers['test:slow'] = (_) => delayed.future;
      await connect();
      client.setActive(true);
      await expectLater(
        client.call('test:slow', null, 30),
        throwsA(isA<TransportError>().having((e) => e.code, 'code', 'timeout')),
      );
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(server.calls.where((c) => c['method'] == 'test:slow').length, 1);
      expect(server.frames.any((f) => f['kind'] == 'cancel'), isTrue);
      delayed.complete(null);
    },
  );

  test(
    'reconnect accepts a new epoch and restores an authoritative snapshot',
    () async {
      await connect();
      await server.drop();
      server.epoch = 'new-epoch';
      await client.connect(parseServerAddress(server.origin)!, 'test-token');
      expect(client.epoch, 'new-epoch');
      final subscription = await client.subscribeConversation(
        'conversation:c1',
        const EventCursor('old-epoch', 90),
      );
      expect(subscription.resumed, isFalse);
      expect(
        await client.call('engine:get-snapshot', {'conversationId': 'c1'}),
        isA<Map>(),
      );
    },
  );
}
