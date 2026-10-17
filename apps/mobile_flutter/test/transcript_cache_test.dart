import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/chat/transcript_cache.dart';

List<Object?> rows(int count) => [
  for (var i = 0; i < count; i++) ...[
    {'id': 'u$i', 'role': 'user', 'text': 'question $i'},
    {'id': 'a$i', 'role': 'assistant', 'text': 'answer $i'},
  ],
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory dir;
  var now = DateTime.now().millisecondsSinceEpoch;
  TranscriptCache cache() =>
      TranscriptCache(directory: () async => dir, now: () => now);
  setUp(() async {
    dir = await Directory.systemTemp.createTemp('fv-transcript-cache-');
    now = DateTime.now().millisecondsSinceEpoch;
  });
  tearDown(() async => dir.delete(recursive: true));

  test(
    'cache persists only recent turns, scoped by both machine and conversation',
    () async {
      final first = cache();
      await first.write('host:a', 'chat:b', rows(10));
      await first.write('host:b', 'chat:a', rows(2));
      final restarted = cache();
      final recent = (await restarted.read('host:a', 'chat:b'))!;
      expect(recent.length, 6);
      expect((recent.first as Map)['id'], 'u7');
      expect((await restarted.read('host:b', 'chat:a'))!.length, 4);
      expect(await restarted.read('host:a', 'chat:a'), isNull);
      expect(await restarted.read('host:a:chat', 'b'), isNull);
      final disk = await dir
          .list(recursive: true)
          .where((f) => f is File)
          .toList();
      for (final file in disk.cast<File>()) {
        final data = jsonDecode(await file.readAsString()) as Map;
        expect(data.containsKey('seq'), isFalse);
        expect(data.containsKey('checkpoint'), isFalse);
        expect(data.containsKey('queue'), isFalse);
      }
    },
  );

  test('concurrent writes are ordered and an empty reset invalidates the old preview', () async {
    final store = cache();
    await Future.wait([
      store.write('host', 'chat', rows(1)),
      store.write('host', 'chat', rows(2)),
      store.write('host', 'chat', rows(3)),
    ]);
    expect((await cache().read('host', 'chat'))!.length, 6);
    await store.write('host', 'chat', []);
    expect(await store.read('host', 'chat'), isNull);
    expect(await cache().read('host', 'chat'), isNull);
  });

  test('oversized entries are evicted instead of persisting huge images or keeping an old preview', () async {
    final store = cache();
    await store.write('host', 'chat', rows(1));
    await store.write('host', 'chat', [
      {'id': 'u', 'role': 'user', 'text': '汉' * transcriptCacheEntryBytes},
    ]);
    expect(await store.read('host', 'chat'), isNull);
    expect(await cache().read('host', 'chat'), isNull);
  });

  test('expired and malformed files are ignored and cannot prevent authoritative loading', () async {
    await cache().write('host', 'chat', rows(1));
    now += const Duration(days: 8).inMilliseconds;
    expect(await cache().read('host', 'chat'), isNull);
    final file =
        (await dir.list(recursive: true).where((e) => e is File).first) as File;
    await file.writeAsString('not json');
    expect(await cache().read('host', 'chat'), isNull);
    final unavailable = TranscriptCache(
      directory: () async => throw const FileSystemException('unavailable'),
    );
    expect(await unavailable.read('host', 'chat'), isNull);
    await expectLater(unavailable.write('host', 'chat', rows(1)), completes);
  });

  test('LRU capacity stays bounded on disk and in a new process', () async {
    final store = cache();
    for (var i = 0; i < 23; i++) {
      await store.write('host', 'chat$i', rows(1));
    }
    expect(await cache().read('host', 'chat0'), isNull);
    expect(await cache().read('host', 'chat22'), isNotNull);
    expect(
      await dir
          .list(recursive: true)
          .where((file) => file.path.endsWith('.json'))
          .length,
      20,
    );
  });

  test('deferred identities survive reply folding and disappear only after full content replaces them', () {
    final first = ChatMessage.fromJson({
      'id': 'a',
      'role': 'assistant',
      'text': 'preview',
      'deferredContent': true,
    });
    final next = ChatMessage.fromJson({
      'id': 'b',
      'role': 'assistant',
      'text': 'second preview',
      'deferredContent': true,
    });
    expect(first.copy().deferredIds, ['a']);
    final merged = combineReplies(first, next);
    expect(merged.id, 'a');
    expect(merged.deferredIds, ['a', 'b']);
    final full = ChatMessage.fromJson({
      'id': 'a',
      'role': 'assistant',
      'text': 'full text',
    });
    expect(combineReplies(full, next).deferredIds, ['b']);
  });
}
