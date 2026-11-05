import 'dart:async';

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/core/runtime.dart';
import 'package:fastvibe_mobile/protocol/client.dart';
import 'package:fastvibe_mobile/protocol/diagnostics.dart';

class FakeCore implements CoreRuntime {
  final stream = StreamController<Map<String, Object?>>.broadcast(sync: true);
  final commands = <Map<String, Object?>>[];
  int next = 1;
  bool disposed = false;
  Map<String, Object?>? relayLease;
  void Function(String action)? beforeCommand;
  bool autoWelcome = true;
  String? fallbackExpiresAt;
  String remoteEndpoint = 'fresh-endpoint';
  int? generation;
  Completer<void>? disconnectGate;
  Future<void> Function(int id, String action, Map<String, Object?> parameters)?
  request;
  @override
  Stream<Map<String, Object?>> get updates => stream.stream;
  void emit(Map<String, Object?> event) => stream.add({
    'events': [event],
  });
  @override
  Future<Map<String, Object?>> command(
    String action, [
    Map<String, Object?> parameters = const {},
  ]) async {
    commands.add({'action': action, ...parameters});
    beforeCommand?.call(action);
    Object? result;
    switch (action) {
      case 'identity':
      case 'setIdentity':
        result = {
          'endpointId': 'local-endpoint',
          'secretKey': 'persisted-secret',
        };
      case 'registerDevice':
        result = {'deviceId': 'local-device'};
      case 'devices':
        result = [
          {
            'id': 'desktop',
            'irohEndpointId': remoteEndpoint,
            'platform': 'darwin',
          },
        ];
      case 'relayToken':
        result =
            relayLease ??
            {
              'url': 'https://relay.example',
              'token': 'lease',
              'expiresAt': DateTime.now()
                  .add(const Duration(minutes: 10))
                  .toIso8601String(),
            };
      case 'disconnect':
        await disconnectGate?.future;
      case 'connect':
        result = {if (generation != null) 'generation': generation};
        if (autoWelcome) {
          if (fallbackExpiresAt != null) {
            stream.add({
              if (generation != null) 'generation': generation,
              'events': [
                {'type': 'relay_lease', 'expiresAt': fallbackExpiresAt},
              ],
            });
          }
          if (generation != null) {
            stream.add({
              'generation': generation,
              'events': [
                {'type': 'welcome'},
              ],
            });
          } else {
            emit({
              'type': 'welcome',
              'features': {'historyPaging': true, 'conversationResume': true},
            });
          }
        }
      case 'call':
      case 'subscribe':
        final id = next++;
        result = {'requestId': id};
        await request?.call(id, action, parameters);
    }
    return {'ok': true, 'result': result};
  }

  @override
  Future<void> dispose() async {
    disposed = true;
    await stream.close();
  }
}

Future<RemoteClient> connect(
  FakeCore core, {
  bool ownsRuntime = true,
  String? lanEndpointId,
  List<String> directAddresses = const [],
  bool Function()? isLanEndpointCurrent,
}) async {
  final client = RemoteClient(
    runtime: core,
    ownsRuntime: ownsRuntime,
    readIdentity: () async => null,
    saveIdentity: (_) async {},
  );
  try {
    await client.connectDevice(
      origin: 'https://account.example',
      token: 'account-token',
      deviceId: 'desktop',
      installId: 'install',
      clientName: 'Phone',
      platform: 'android',
      lanEndpointId: lanEndpointId,
      directAddresses: directAddresses,
      isLanEndpointCurrent: isLanEndpointCurrent,
    );
    return client;
  } catch (_) {
    await client.shutdown;
    rethrow;
  }
}

const connectPhases = [
  'connect.identity',
  'connect.register-device',
  'connect.register-endpoint',
  'connect.devices',
  'connect.relay-token',
  'connect.transport',
];

// Collect at each command boundary so the assertion checks completion order,
// even when multiple samples share the same wall-clock timestamp.
class PhaseSamples {
  PhaseSamples() {
    collect();
    samples.clear();
  }

  final counts = <String, int>{};
  final samples = <Map<String, dynamic>>[];

  void collect() {
    final timings =
        (jsonDecode(connectionDiagnostics('test')) as Map)['timings'] as Map;
    for (final phase in connectPhases) {
      final recent = ((timings[phase] as Map?)?['samples'] as List?) ?? [];
      samples.addAll(
        recent.skip(counts[phase] ?? 0).cast<Map<String, dynamic>>(),
      );
      counts[phase] = recent.length;
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('LAN relay fallback adopts lease before welcome completes', () async {
    final expires = DateTime.utc(2030, 1, 2);
    final core = FakeCore()
      ..generation = 4
      ..fallbackExpiresAt = expires.toIso8601String();
    final client = await connect(
      core,
      lanEndpointId: 'fresh-endpoint',
      directAddresses: ['192.168.1.10:1234'],
    );
    expect(core.commands.any((c) => c['action'] == 'relayToken'), isFalse);
    expect(client.credentialExpiresAt, expires);
    core.stream.add({
      'generation': 2,
      'events': [
        {'type': 'relay_lease', 'expiresAt': '2040-01-01T00:00:00Z'},
      ],
    });
    expect(client.credentialExpiresAt, expires);
    core.emit({'type': 'relay_lease', 'expiresAt': 'invalid'});
    expect(client.credentialExpiresAt, expires);
    client.close();
    await client.shutdown;
  });

  test(
    'LAN hints require the endpoint from fresh authenticated devices',
    () async {
      for (final endpoint in ['fresh-endpoint', 'stale-endpoint']) {
        final core = FakeCore()
          ..relayLease = {
            'relays': [
              {'url': 'https://one'},
              {'url': 'https://two'},
            ],
          };
        final client = await connect(
          core,
          lanEndpointId: endpoint,
          directAddresses: ['192.168.1.2:4444', '[fd00::2]:5555'],
        );
        final command = core.commands.singleWhere(
          (c) => c['action'] == 'connect',
        );
        expect(
          command['directAddresses'],
          endpoint == 'fresh-endpoint'
              ? ['192.168.1.2:4444', '[fd00::2]:5555']
              : isNull,
        );
        final local = endpoint == 'fresh-endpoint';
        expect(command['preferDirect'], local ? isTrue : isNull);
        expect(command.containsKey('relay'), !local);
        if (!local) expect(command['relay'], core.relayLease);
        expect(
          core.commands.where((c) => c['action'] == 'relayToken').length,
          local ? 0 : 1,
        );
        if (local) expect(client.credentialExpiresAt, isNull);
        client.close();
        await client.shutdown;
      }
    },
  );

  test(
    'LAN hint invalidated while account requests run is not admitted',
    () async {
      for (final boundary in [
        'registerDevice',
        'registerEndpoint',
        'devices',
      ]) {
        var fresh = true;
        final core = FakeCore()
          ..beforeCommand = (action) {
            if (action == boundary) fresh = false;
          };
        final client = await connect(
          core,
          lanEndpointId: 'fresh-endpoint',
          directAddresses: ['192.168.1.2:4444'],
          isLanEndpointCurrent: () => fresh,
        );
        final command = core.commands.singleWhere(
          (c) => c['action'] == 'connect',
        );
        expect(command, isNot(contains('directAddresses')));
        expect(command, isNot(contains('preferDirect')));
        expect(command['relay'], isA<Map>());
        expect(
          core.commands.where((c) => c['action'] == 'relayToken'),
          hasLength(1),
        );
        client.close();
        await client.shutdown;
      }
    },
  );

  test('LAN skips relay admission and records a local phase', () async {
    final samples = PhaseSamples();
    final core = FakeCore()
      ..beforeCommand = (action) {
        samples.collect();
        if (action == 'relayToken') {
          throw const CoreFailure('relay must not be requested');
        }
      };
    final client = await connect(
      core,
      lanEndpointId: 'fresh-endpoint',
      directAddresses: ['192.168.1.2:4444'],
    );
    samples.collect();
    expect(core.commands.any((c) => c['action'] == 'relayToken'), isFalse);
    expect(core.commands.last, {
      'action': 'connect',
      'remoteId': 'fresh-endpoint',
      'directAddresses': ['192.168.1.2:4444'],
      'preferDirect': true,
    });
    expect(client.credentialExpiresAt, isNull);
    expect(samples.samples.map((s) => s['metric']), connectPhases);
    expect(
      samples.samples.singleWhere(
        (s) => s['metric'] == 'connect.relay-token',
      )['outcome'],
      'local',
    );
    client.close();
    await client.shutdown;
  });

  test(
    'missing or empty LAN hints require a relay lease and propagate failure',
    () async {
      for (final withEndpoint in [false, true]) {
        final core = FakeCore()
          ..beforeCommand = (action) {
            if (action == 'relayToken') {
              throw const CoreFailure('relay unavailable');
            }
          };
        await expectLater(
          connect(core, lanEndpointId: withEndpoint ? 'fresh-endpoint' : null),
          throwsA(isA<CoreFailure>()),
        );
        expect(
          core.commands.where((c) => c['action'] == 'relayToken'),
          hasLength(1),
        );
        expect(core.commands.any((c) => c['action'] == 'connect'), isFalse);
      }
    },
  );

  test(
    'borrowed runtime survives close and closed facade sends no commands',
    () async {
      final core = FakeCore()..disconnectGate = Completer<void>();
      final old = await connect(core, ownsRuntime: false);
      old.close();
      old.unsubscribe(['*']);
      await Future<void>.delayed(Duration.zero);
      expect(core.disposed, isFalse);
      expect(core.commands.last['action'], 'disconnect');
      final count = core.commands.length;
      await expectLater(
        old.call('settings:get'),
        throwsA(isA<TransportError>()),
      );
      expect(core.commands.length, count);
      core.disconnectGate!.complete();
      await old.shutdown;
      final next = await connect(core, ownsRuntime: false);
      expect(next.ready, isTrue);
      next.close();
      await next.shutdown;
      await core.dispose();
    },
  );

  test(
    'old generations and pre-admission events cannot ready or close new client',
    () async {
      final core = FakeCore()..generation = 2;
      final first = await connect(core, ownsRuntime: false);
      first.close();
      await first.shutdown;
      core.generation = 4;
      core.autoWelcome = false;
      final admitted = Completer<void>();
      core.beforeCommand = (action) {
        if (action == 'setToken') {
          core.stream.add({
            'generation': 2,
            'state': {'connection': 'ready'},
            'events': [
              {'type': 'remote_close'},
            ],
          });
        }
        if (action == 'connect') admitted.complete();
      };
      final dialing = connect(core, ownsRuntime: false);
      await admitted.future;
      await Future<void>.delayed(Duration.zero);
      var completed = false;
      unawaited(
        dialing.then((_) {
          completed = true;
        }),
      );
      core.stream.add({
        'generation': 2,
        'events': [
          {'type': 'welcome'},
          {'type': 'remote_close'},
        ],
      });
      await Future<void>.delayed(Duration.zero);
      expect(completed, isFalse);
      core.stream.add({
        'generation': 4,
        'events': [
          {'type': 'welcome'},
        ],
      });
      final next = await dialing;
      expect(next.ready, isTrue);
      core.stream.add({
        'generation': 2,
        'overflowed': true,
        'events': [
          {'type': 'remote_close'},
        ],
      });
      expect(next.ready, isTrue);
      next.close();
      await next.shutdown;
      await core.dispose();
    },
  );

  test(
    'connect metrics follow phases and transport waits for welcome',
    () async {
      final samples = PhaseSamples();
      final core = FakeCore()..autoWelcome = false;
      final dialing = Completer<void>();
      core.beforeCommand = (action) {
        samples.collect();
        if (action == 'connect') dialing.complete();
      };
      final connection = connect(core);
      await dialing.future;
      await Future<void>.delayed(Duration.zero);
      samples.collect();
      expect(samples.samples.map((s) => s['metric']), connectPhases.take(5));
      core.emit({'type': 'welcome'});
      final client = await connection;
      samples.collect();
      expect(samples.samples.map((s) => s['metric']), connectPhases);
      for (final sample in samples.samples) {
        expect(sample['outcome'], 'ok');
        expect(sample['elapsedMs'], isNonNegative);
        expect(sample.keys.toSet(), {
          'event',
          'at',
          'metric',
          'elapsedMs',
          'outcome',
        });
      }
      client.close();
      await client.shutdown;
    },
  );

  for (final failure in {
    'setToken': 0,
    'identity': 0,
    'registerDevice': 1,
    'registerEndpoint': 2,
    'devices': 3,
    'relayToken': 4,
    'connect': 5,
  }.entries) {
    test(
      'connect metric exposes ${failure.key} failure without error data',
      () async {
        final samples = PhaseSamples();
        final core = FakeCore();
        core.beforeCommand = (action) {
          samples.collect();
          if (action == failure.key) {
            throw const CoreFailure(
              'secret-token https://private.example payload',
            );
          }
        };
        await expectLater(connect(core), throwsA(isA<CoreFailure>()));
        samples.collect();
        expect(
          samples.samples.map((s) => s['metric']),
          connectPhases.take(failure.value + 1),
        );
        expect(samples.samples.map((s) => s['outcome']), [
          ...List.filled(failure.value, 'ok'),
          'error',
        ]);
        for (final sample in samples.samples) {
          expect(sample['elapsedMs'], isNonNegative);
          expect(sample.keys.toSet(), {
            'event',
            'at',
            'metric',
            'elapsedMs',
            'outcome',
          });
        }
        expect(jsonEncode(samples.samples), isNot(contains('secret-token')));
        expect(jsonEncode(samples.samples), isNot(contains('private.example')));
        expect(core.disposed, isTrue);
      },
    );
  }

  test(
    'connect forwards every relay and its credential without choosing a node',
    () async {
      final core = FakeCore();
      final relays = [
        {
          'relayId': 'bad-first',
          'url': 'https://unreachable.example/',
          'quicPort': 7842,
          'token': 'first-token',
        },
        {
          'relayId': 'healthy',
          'url': 'https://healthy.example/',
          'quicPort': 8842,
          'token': 'second-token',
        },
      ];
      core.relayLease = {
        'relays': relays,
        'expiresAt': DateTime.now()
            .add(const Duration(minutes: 10))
            .toIso8601String(),
      };
      final client = await connect(core);
      final command = core.commands.singleWhere(
        (command) => command['action'] == 'connect',
      );
      expect((command['relay'] as Map)['relays'], equals(relays));
      expect(client.ready, isTrue);
      expect(client.credentialExpiresAt, isNotNull);
      client.close();
      await client.shutdown;
    },
  );

  test('registration, endpoint refresh and lease all use Rust commands; welcome alone completes connect', () async {
    final core = FakeCore();
    final client = await connect(core);
    expect(client.ready, isTrue);
    expect(client.supportsHistoryPaging, isTrue);
    expect(core.commands.map((c) => c['action']), [
      'setToken',
      'identity',
      'registerDevice',
      'registerEndpoint',
      'devices',
      'relayToken',
      'connect',
    ]);
    expect(core.commands.last['remoteId'], 'fresh-endpoint');
    expect(
      core.commands.firstWhere((c) => c['action'] == 'relayToken')['deviceId'],
      'local-device',
    );
    client.close();
    await client.shutdown;
    expect(core.disposed, isTrue);
  });

  test('an RPC result arriving before its admission preserves complete snapshot data', () async {
    final core = FakeCore();
    final client = await connect(core);
    final snapshot = {
      'conversationId': 'c',
      'messages': [
        {
          'id': 'm',
          'parts': [
            {'kind': 'text', 'text': 'full output'},
          ],
        },
      ],
      'seq': 42,
    };
    core.request = (id, action, parameters) async {
      core.emit({
        'kind': 'rpcResult',
        'requestId': id,
        'ok': true,
        'result': snapshot,
      });
      await Future<void>.delayed(Duration.zero);
    };
    expect(
      await client.call('engine:get-snapshot', {'conversationId': 'c'}),
      snapshot,
    );
    client.close();
    await client.shutdown;
  });

  test(
    'concurrent RPCs resolve by Rust request id, independent of reply order',
    () async {
      final core = FakeCore();
      final client = await connect(core);
      final ids = <int>[];
      core.request = (id, _, _) async {
        ids.add(id);
      };
      final first = client.call('first');
      final second = client.call('second');
      await Future<void>.delayed(Duration.zero);
      core.emit({
        'kind': 'rpcResult',
        'requestId': ids[1],
        'ok': true,
        'result': 'second',
      });
      core.emit({
        'kind': 'rpcResult',
        'requestId': ids[0],
        'ok': true,
        'result': 'first',
      });
      expect(await first, 'first');
      expect(await second, 'second');
      client.close();
      await client.shutdown;
    },
  );

  test('server error retains its original code and message', () async {
    final core = FakeCore();
    final client = await connect(core);
    core.request = (id, _, _) async => core.emit({
      'kind': 'rpcResult',
      'requestId': id,
      'ok': false,
      'error': {'code': 'quota', 'message': 'original error'},
    });
    await expectLater(
      client.call('write'),
      throwsA(
        isA<CoreFailure>()
            .having((e) => e.code, 'code', 'quota')
            .having((e) => e.message, 'message', 'original error'),
      ),
    );
    client.close();
    await client.shutdown;
  });

  test('subscription resync arrives before its acknowledgement and disables resume', () async {
    final core = FakeCore();
    final client = await connect(core);
    core.request = (id, action, _) async {
      core.emit({'kind': 'resync', 'scope': 'conversation:c'});
      core.emit({
        'kind': 'rpcResult',
        'requestId': id,
        'ok': true,
        'result': {
          'cursors': {
            'conversation:c': {'epoch': 'epoch', 'seq': 9},
          },
        },
      });
    };
    final result = await client.subscribeConversation(
      'conversation:c',
      const EventCursor('epoch', 3),
    );
    expect(result.resumed, isFalse);
    expect(result.cursor?.seq, 9);
    expect(client.ready, isTrue);
    client.close();
    await client.shutdown;
  });

  test('raw engine events keep scope and cursor metadata', () async {
    final core = FakeCore();
    final client = await connect(core);
    Object? payload;
    EventMeta? meta;
    client.onPush((_, p, m) {
      payload = p;
      meta = m;
    });
    core.emit({
      'kind': 'event',
      'channel': 'engine:event',
      'payload': {'type': 'text_delta', 'text': 'hello'},
      'scope': 'conversation:c',
      'epoch': 'e',
      'seq': 7,
    });
    expect(payload, {'type': 'text_delta', 'text': 'hello'});
    expect(meta?.seq, 7);
    client.close();
    await client.shutdown;
  });

  test('overflow invalidates the connection and refuses to continue a partial stream', () async {
    final core = FakeCore();
    final client = await connect(core);
    DisconnectDetail? detail;
    client.onDisconnect((d) => detail = d);
    core.stream.add({'overflowed': true});
    expect(client.ready, isFalse);
    expect(detail?.kind, 'resync');
    await client.shutdown;
  });

  test(
    'fatal during lifecycle health probe settles outstanding calls',
    () async {
      final core = FakeCore();
      final client = await connect(core);
      final call = client.call('engine:submit-prompt', {'text': 'only once'});
      final rejected = expectLater(call, throwsA(isA<TransportError>()));
      client.setActive(true);
      await Future<void>.delayed(Duration.zero);
      expect(
        core.commands.where((c) => c['method'] == 'settings:get'),
        hasLength(1),
      );
      core.stream.addError(const CoreFailure('fatal poll'));
      await rejected;
      await client.shutdown;
      expect(client.ready, isFalse);
      expect(client.pendingCalls, 0);
      expect(core.disposed, isTrue);
    },
  );

  test(
    'a failed first dial rejects connect without retiring its caller',
    () async {
      final core = FakeCore()..autoWelcome = false;
      final client = RemoteClient(
        runtime: core,
        readIdentity: () async => null,
        saveIdentity: (_) async {},
      );
      var disconnects = 0;
      client.onDisconnect((_) => disconnects++);
      final connecting = client.connectDevice(
        origin: 'https://account.example',
        token: 'account-token',
        deviceId: 'desktop',
        installId: 'install',
        clientName: 'Phone',
        platform: 'android',
      );
      final rejected = expectLater(
        connecting,
        throwsA(
          isA<ConnectionError>().having(
            (e) => e.message,
            'message',
            'iroh connection timed out after 15s',
          ),
        ),
      );
      while (!core.commands.any((c) => c['action'] == 'connect')) {
        await Future<void>.delayed(Duration.zero);
      }
      core.emit({
        'type': 'connection_error',
        'message': 'iroh connection timed out after 15s',
      });
      await rejected;
      await client.shutdown;
      expect(disconnects, 0);
      expect(client.ready, isFalse);
    },
  );

  test('disconnect rejects outstanding calls without replaying them', () async {
    final core = FakeCore();
    final client = await connect(core);
    final future = client.call('engine:submit-prompt', {'text': 'only once'});
    final expectation = expectLater(future, throwsA(isA<TransportError>()));
    await Future<void>.delayed(Duration.zero);
    core.emit({'type': 'connection_error', 'message': 'lost'});
    await expectation;
    expect(
      core.commands.where((c) => c['method'] == 'engine:submit-prompt').length,
      1,
    );
    await client.shutdown;
  });
}
