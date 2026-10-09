import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/chat/snapshot_sync.dart';
import 'package:fastvibe_mobile/chat/history_pager.dart';
import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/protocol/client.dart';

void main() {
  test(
    'snapshot restores queue, then replays only newer events in server order',
    () async {
      final response = Completer<Snapshot>();
      final applied = <Object>[];
      final sync = SnapshotSync(
        SnapshotSyncOptions(
          subscribe: (_) async => const SubscriptionResult(
            resumed: false,
            cursor: EventCursor('e', 0),
          ),
          load: () => response.future,
          onSnapshot: (snapshot) => applied.add(snapshot.queue!),
          onEvent: (event) => applied.add(event['seq']!),
          onError: (error) => fail('$error'),
        ),
      );
      addTearDown(sync.dispose);
      final restoring = sync.restore();
      await Future<void>.delayed(Duration.zero);
      for (final seq in [12, 10, 11, 12]) {
        sync.receive({'seq': seq}, EventMeta('conversation:c', 'e', seq));
      }
      response.complete(const Snapshot(seq: 10, queue: 'durable queue'));
      await restoring;
      expect(applied, ['durable queue', 11, 12]);
      expect(sync.checkpoint()?.floor, 12);
    },
  );

  test(
    'a live upstream engine restart does not confuse the wire cursor',
    () async {
      final events = <int>[];
      final sync = SnapshotSync(
        SnapshotSyncOptions(
          subscribe: (_) async => const SubscriptionResult(
            resumed: false,
            cursor: EventCursor('e', 90),
          ),
          load: () async => const Snapshot(seq: 60),
          onSnapshot: (_) {},
          onEvent: (event) => events.add(event['seq'] as int),
          onError: (_) {},
        ),
      );
      addTearDown(sync.dispose);
      await sync.restore();
      sync.receive({'seq': 1}, const EventMeta('conversation:c', 'e', 91));
      sync.receive({'seq': 1}, const EventMeta('conversation:c', 'e', 91));
      expect(events, [1]);
    },
  );

  test('boundaries already included by an in-flight snapshot do not issue another RPC', () async {
    final response = Completer<Snapshot>();
    var reads = 0;
    final sync = SnapshotSync(
      SnapshotSyncOptions(
        subscribe: (_) async => const SubscriptionResult(resumed: false),
        load: () {
          reads++;
          return reads == 1
              ? Future.value(const Snapshot(seq: 0))
              : response.future;
        },
        onSnapshot: (_) {},
        onEvent: (_) {},
        onError: (_) {},
      ),
    );
    addTearDown(sync.dispose);
    await sync.restore();
    final refresh = sync.refresh(2);
    await Future<void>.delayed(const Duration(milliseconds: 65));
    final covered = sync.refresh(3);
    response.complete(const Snapshot(seq: 4));
    await Future.wait([refresh, covered]);
    await Future<void>.delayed(const Duration(milliseconds: 65));
    expect(reads, 2);
  });

  test(
    'disposing a chat ignores a late snapshot and releases its waiters',
    () async {
      final response = Completer<Snapshot>();
      var snapshots = 0;
      final sync = SnapshotSync(
        SnapshotSyncOptions(
          subscribe: (_) async => const SubscriptionResult(resumed: false),
          load: () => response.future,
          onSnapshot: (_) => snapshots++,
          onEvent: (_) {},
          onError: (_) {},
        ),
      );
      final restoring = sync.restore();
      final refresh = sync.refresh();
      sync.dispose();
      response.complete(const Snapshot(seq: 10));
      await Future.wait([restoring, refresh]);
      expect(snapshots, 0);
      expect(sync.checkpoint(), isNull);
    },
  );

  test('copy and search drain every older history page without replacing current rows', () async {
    final newest = ChatMessage(id: 'c', role: 'user');
    var messages = [newest];
    final pager = HistoryPager<ChatMessage>(
      HistoryPagerOptions(
        cursor: 'c',
        load: (cursor) async => HistoryPage(
          messages: [ChatMessage(id: cursor == 'c' ? 'b' : 'a', role: 'user')],
          beforeEntryId: cursor,
          nextBeforeEntryId: cursor == 'c' ? 'b' : null,
          reset: false,
        ),
        prepend: (older, cursor) {
          messages = prependHistory(messages, older, cursor)!;
          return true;
        },
        cursorChanged: (_) {},
        reset: () async => fail('unexpected reset'),
      ),
    );
    addTearDown(pager.dispose);
    await pager.loadAll();
    expect(messages.map((m) => m.id), ['a', 'b', 'c']);
    expect(identical(messages.last, newest), isTrue);
    expect(pager.cursor, isNull);
  });

  test('replacing history invalidates the old in-flight page', () async {
    final response = Completer<HistoryPage<ChatMessage>>();
    var prepends = 0;
    final pager = HistoryPager<ChatMessage>(
      HistoryPagerOptions(
        cursor: 'old',
        load: (_) => response.future,
        prepend: (_, _) {
          prepends++;
          return true;
        },
        cursorChanged: (_) {},
        reset: () async {},
      ),
    );
    addTearDown(pager.dispose);
    final loading = pager.loadOlder();
    pager.replace('new');
    response.complete(
      const HistoryPage(
        messages: [],
        beforeEntryId: 'old',
        nextBeforeEntryId: null,
        reset: false,
      ),
    );
    await loading;
    expect(prepends, 0);
    expect(pager.cursor, 'new');
  });
}
