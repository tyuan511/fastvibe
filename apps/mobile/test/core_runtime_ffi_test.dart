import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/core/runtime.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final hostSupported = Platform.isMacOS || Platform.isLinux;
  late Directory directory;
  late String library;

  setUpAll(() async {
    if (!hostSupported) return;
    directory = await Directory.systemTemp.createTemp('fv-flutter-ffi-');
    library = '${directory.path}/libcore.${Platform.isMacOS ? 'dylib' : 'so'}';
    final source = File('${directory.path}/core.c');
    await source.writeAsString(r'''
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
static int polls = 0;
static int command_polls = 0;
static int fail_poll = 0;
static int generation = 0;
static int poll_generation = 0;
void *fv_mobile_core_create(void) { fail_poll = 0; generation = 0; poll_generation = 0; return malloc(1); }
void fv_mobile_core_destroy(void *handle) { free(handle); }
void fv_mobile_core_free_string(char *value) { free(value); }
char *fv_mobile_core_command_json(void *handle, const char *input) {
  (void)handle;
  if (strstr(input, "fatalPoll")) fail_poll = 1;
  if (strstr(input, "advanceGeneration")) generation++;
  if (strstr(input, "releaseGeneration")) poll_generation = generation;
  if (strstr(input, "slow")) usleep(200000);
  if (strstr(input, "poll")) command_polls++;
  char value[512];
  snprintf(value,sizeof(value),"{\"ok\":true,\"result\":{\"polls\":%d,\"commandPolls\":%d,\"generation\":%d},\"state\":{\"connection\":\"disconnected\",\"connectionGeneration\":%d}}",polls,command_polls,generation,generation);
  return strdup(value);
}
char *fv_mobile_core_poll_json(void *handle) {
  (void)handle;
  polls++;
  if (fail_poll) return NULL;
  char value[256];
  snprintf(value,sizeof(value),"{\"events\":%s,\"overflowed\":false,\"generation\":%d}", generation > 0 ? "[{\"type\":\"welcome\"}]" : "[]", poll_generation);
  return strdup(value);
}
''');
    final compile = await Process.run('cc', [
      '-shared',
      '-fPIC',
      source.path,
      '-o',
      library,
    ]);
    expect(compile.exitCode, 0, reason: '${compile.stderr}');
  });
  tearDownAll(() async {
    if (hostSupported) await directory.delete(recursive: true);
  });

  test('FFI polling uses the lightweight C ABI, never command poll/snapshot serialization', () async {
    final runtime = NativeCoreRuntime(libraryPath: library);
    final updates = <Map<String, Object?>>[];
    final subscription = runtime.updates.listen(updates.add);
    await runtime.command('start');
    await Future<void>.delayed(const Duration(milliseconds: 160));
    final statistics = coreResult(await runtime.command('stats')) as Map;
    expect(statistics['polls'], greaterThan(1));
    expect(statistics['commandPolls'], 0);
    expect(updates.first['state'], isNot(contains('snapshot')));
    await subscription.cancel();
    await runtime.dispose();
    await expectLater(runtime.command('again'), throwsA(isA<CoreFailure>()));
  }, skip: !hostSupported);

  test(
    'worker drops stale poll generations before applying welcome to state',
    () async {
      final runtime = NativeCoreRuntime(libraryPath: library);
      final updates = <Map<String, Object?>>[];
      final subscription = runtime.updates.listen(updates.add);
      await runtime.command('start');
      await Future<void>.delayed(const Duration(milliseconds: 80));
      updates.clear();
      final admission =
          coreResult(await runtime.command('advanceGeneration')) as Map;
      expect(admission['generation'], 1);
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(updates, isEmpty);
      await runtime.command('releaseGeneration');
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(updates, isNotEmpty);
      expect(updates.every((u) => u['generation'] == 1), isTrue);
      expect((updates.last['state'] as Map)['connectionGeneration'], 1);
      expect((updates.last['state'] as Map)['connection'], 'ready');
      await subscription.cancel();
      await runtime.dispose();
    },
    skip: !hostSupported,
  );

  test('a blocking native command runs off the Flutter isolate', () async {
    final runtime = NativeCoreRuntime(libraryPath: library);
    await runtime.command('start');
    // Probe event-loop liveness with port round trips, not timers: an expired
    // Timer.periodic can stay undelivered on a loaded CI runner until the awaited
    // command response has already resumed this test and cancelled the ticker,
    // while port messages are delivered by exactly the mechanism that resumes the
    // await below. If the blocking call ever moved onto this isolate, the sends
    // would queue behind the 200 ms command and none would be handled by now.
    final loops = ReceivePort();
    var handled = 0;
    final subscription = loops.listen((_) {
      handled++;
      if (handled < 5) loops.sendPort.send(null);
    });
    final pending = runtime.command('slow');
    loops.sendPort.send(null);
    await pending;
    expect(handled, greaterThanOrEqualTo(1));
    await subscription.cancel();
    loops.close();
    await runtime.dispose();
  }, skip: !hostSupported);

  test(
    'an isolate startup failure rejects promptly and can be disposed',
    () async {
      final runtime = NativeCoreRuntime(
        libraryPath: '/does-not-exist/libfastvibe_mobile_core.so',
      );
      expect(runtime.failed, isFalse);
      final errors = <Object>[];
      final listener = runtime.updates.listen((_) {}, onError: errors.add);
      await expectLater(
        runtime.command('identity').timeout(const Duration(seconds: 2)),
        throwsA(isA<CoreFailure>()),
      );
      expect(runtime.failed, isTrue);
      await listener.cancel();
      await runtime.dispose();
    },
  );

  test(
    'fatal polling rejects later commands and disposal finishes promptly',
    () async {
      final runtime = NativeCoreRuntime(libraryPath: library);
      final failed = Completer<Object>();
      final subscription = runtime.updates.listen(
        (_) {},
        onError: (Object error) {
          if (!failed.isCompleted) failed.complete(error);
        },
      );
      await runtime.command('fatalPoll');
      expect(
        await failed.future.timeout(const Duration(seconds: 2)),
        isA<CoreFailure>(),
      );
      expect(runtime.failed, isTrue);
      await expectLater(
        runtime.command('again').timeout(const Duration(seconds: 2)),
        throwsA(isA<CoreFailure>()),
      );
      await runtime.dispose().timeout(const Duration(seconds: 2));
      await subscription.cancel();
    },
    skip: !hostSupported,
  );

  final liveLibrary = Platform.environment['FASTVIBE_MOBILE_CORE_LIBRARY'];
  test(
    'real Rust C ABI retains identity and produces a runtime projection',
    () async {
      final runtime = NativeCoreRuntime();
      final identity = coreResult(await runtime.command('identity')) as Map;
      expect(identity['endpointId'], matches(RegExp(r'^[a-f0-9]{64}$')));
      final restored = coreResult(
        await runtime.command('setIdentity', {
          'secretKey': identity['secretKey'],
        }),
      ) as Map;
      expect(restored['endpointId'], identity['endpointId']);
      final applied = await runtime.command('apply', {
        'value': {
          'conversationId': 'c',
          'messages': [
            {
              'id': 'm',
              'role': 'assistant',
              'text': 'kept output',
              'createdAt': 1,
            },
          ],
          'running': false,
          'queue': {'items': []},
          'pendingUi': [],
          'turnEvents': [],
          'overflowed': false,
          'seq': 1,
        },
      });
      expect(applied['ok'], isTrue, reason: '${applied['error']}');
      final snapshot = (applied['state'] as Map)['snapshot'] as Map;
      expect(snapshot['seq'], 1);
      expect((snapshot['messages'] as List).single['text'], 'kept output');
      await runtime.dispose();
      await expectLater(
        runtime.command('identity'),
        throwsA(isA<CoreFailure>()),
      );
    },
    skip: liveLibrary == null || !File(liveLibrary).existsSync(),
  );
}
