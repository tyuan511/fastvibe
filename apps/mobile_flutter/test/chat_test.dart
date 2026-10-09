import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/chat/queue.dart';
import 'package:fastvibe_mobile/chat/turn_meta.dart';
import 'package:fastvibe_mobile/chat/live_events.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/session/catalog.dart';

/// The runtime invariants the Expo client pins with `test/mobile-*.test.ts`. They are the
/// rules a refactor breaks silently — a queue that lets a late RPC revive a delivered
/// item, a footer that reports a finish time for a run still in flight, a codemode call
/// that becomes a row of its own.
void main() {
  setUpAll(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await I18n.instance.setPreference(LanguagePreference.zh);
  });

  group('queue', () {
    test('a stale revision cannot revive a delivered item', () {
      final current = QueueState(
        conversationId: 'c1',
        revision: 5,
        items: <QueueItem>[const QueueItem(id: 'a', text: 'hello', behavior: 'followUp')],
      );
      final stale = mergeQueue(current, <String, Object?>{
        'conversationId': 'c1',
        'revision': 4,
        'items': <Object?>[],
        'pause': null,
      });
      expect(identical(stale, current), isTrue);
    });

    test('an invalid item voids the whole message rather than emptying the queue', () {
      // Silently dropping part of a queue could make Send bypass it.
      final current = emptyQueue('c1');
      final next = mergeQueue(current, <String, Object?>{
        'conversationId': 'c1',
        'revision': 1,
        'items': <Object?>[
          <String, Object?>{'id': 'a', 'text': 'ok', 'behavior': 'steer', 'conversationId': 'c1'},
          <String, Object?>{'id': 'b', 'text': 'bad', 'behavior': 'nonsense', 'conversationId': 'c1'},
        ],
        'pause': null,
      });
      expect(identical(next, current), isTrue);
    });

    test('a paused empty queue does not catch a fresh prompt', () {
      final paused = QueueState(conversationId: 'c1', revision: 3, items: const <QueueItem>[], pause: 'stopped');
      expect(shouldQueueMessage(false, paused), isFalse);
      expect(shouldQueueMessage(true, paused), isTrue);
    });

    test('a queue with items catches a fresh prompt even when idle', () {
      final queued = QueueState(
        conversationId: 'c1',
        revision: 3,
        items: <QueueItem>[const QueueItem(id: 'a', text: 'x', behavior: 'followUp')],
      );
      expect(shouldQueueMessage(false, queued), isTrue);
    });

    test('a bad pause value is refused', () {
      final current = emptyQueue('c1');
      final next = mergeQueue(current, <String, Object?>{
        'conversationId': 'c1',
        'revision': 1,
        'items': <Object?>[],
        'pause': 'paused',
      });
      expect(identical(next, current), isTrue);
    });
  });

  group('turn footer', () {
    ChatMessage user(String id, int at) => ChatMessage(id: id, role: 'user', createdAt: at);
    ChatMessage assistant(String id, int at, {int? completed}) =>
        ChatMessage(id: id, role: 'assistant', text: 'ok', createdAt: at, completedAt: completed);

    test('a run still in flight gets no footer', () {
      final messages = <ChatMessage>[user('u1', 1000), assistant('a1', 1100)];
      expect(completedTurnFooters(messages, true), isEmpty);
      final settled = completedTurnFooters(messages, false);
      expect(settled['a1']!.endedAt, 1100);
    });

    test('the footer measures the whole turn, first request to last completion', () {
      final messages = <ChatMessage>[
        user('u1', 1000),
        assistant('a1', 1100, completed: 1200),
        assistant('a2', 1300, completed: 2000),
      ];
      // The turn is measured from the first request's start (a1 at 1100) to the last
      // entry's completion (a2 at 2000).
      final footers = completedTurnFooters(messages, false);
      expect(footers['a2']!.elapsedMs, 900);
    });

    test('an untimed completion falls back to the request start', () {
      final messages = <ChatMessage>[user('u1', 1000), assistant('a1', 1100)];
      expect(completedTurnFooters(messages, false)['a1']!.elapsedMs, isNull);
    });

    test('an unchanged turn reuses the previous object', () {
      final messages = <ChatMessage>[user('u1', 1000), assistant('a1', 1100, completed: 1200)];
      final first = completedTurnFooters(messages, false);
      final second = completedTurnFooters(messages, false, first);
      expect(identical(first, second), isTrue);
    });
  });

  group('live events', () {
    test('a nested tool call is not a row of its own', () {
      final messages = <ChatMessage>[ChatMessage(id: 'a1', role: 'assistant')];
      final next = applyLiveEngineEvent(messages, <String, Object?>{
        'type': 'tool_execution_start',
        'parentToolCallId': 'codemode-1',
        'toolName': 'read',
      });
      expect(identical(next, messages), isTrue);
    });

    test('a tool execution event creates a row and then updates it in place', () {
      final started = applyLiveEngineEvent(<ChatMessage>[], <String, Object?>{
        'type': 'tool_execution_start',
        'toolCallId': 't1',
        'toolName': 'read',
        'args': <String, Object?>{'path': '/tmp/a'},
      });
      expect(started.single.tools.single.name, 'read');
      expect(started.single.tools.single.status, 'running');

      final ended = applyLiveEngineEvent(started, <String, Object?>{
        'type': 'tool_execution_end',
        'toolCallId': 't1',
        'result': 'contents',
      });
      expect(ended.single.tools.single.status, 'done');
      expect(ended.single.tools.single.result, 'contents');
      expect(ended.single.tools.length, 1);
    });

    test('a text delta appends to the trailing text part', () {
      final first = applyLiveEngineEvent(<ChatMessage>[], <String, Object?>{
        'type': 'message_update',
        'assistantMessageEvent': <String, Object?>{'type': 'text_delta', 'delta': 'Hel'},
      });
      final second = applyLiveEngineEvent(first, <String, Object?>{
        'type': 'message_update',
        'assistantMessageEvent': <String, Object?>{'type': 'text_delta', 'delta': 'lo'},
      });
      expect(second.single.text, 'Hello');
      expect(partsOf(second.single).length, 1);
    });

    test('a message_start only opens a row when the previous one wrote something', () {
      final blank = <ChatMessage>[ChatMessage(id: 'a1', role: 'assistant')];
      expect(applyMessageStart(blank, <String, Object?>{'message': <String, Object?>{'role': 'assistant'}}).length, 1);
      final written = <ChatMessage>[ChatMessage(id: 'a1', role: 'assistant', text: 'hi')];
      expect(applyMessageStart(written, <String, Object?>{'message': <String, Object?>{'role': 'assistant'}}).length, 2);
    });

    test('a tool result object is read as its text parts, not its JSON', () {
      expect(
        toolResultText(<String, Object?>{
          'content': <Object?>[
            <String, Object?>{'type': 'text', 'text': 'one'},
            <String, Object?>{'type': 'text', 'text': 'two'},
          ],
        }),
        'one\ntwo',
      );
    });
  });

  group('reply merging', () {
    test('streaming evicts obsolete replies without changing the row identity', () {
      final cache = <ChatMessage, ({ChatMessage previous, ChatMessage merged})>{};
      var messages = <ChatMessage>[
        ChatMessage(id: 'a1', role: 'assistant', text: 'Planning'),
        ChatMessage(id: 'a2', role: 'assistant'),
      ];
      for (var i = 0; i < 200; i++) {
        messages = applyLiveEngineEvent(messages, {
          'type': 'message_update',
          'assistantMessageEvent': {'type': 'text_delta', 'delta': 'x' * 64},
        });
        final rows = mergeReplies(messages, cache);
        expect(rows.single.id, 'a1');
        expect(rows.single.text, 'Planning\n\n${'x' * ((i + 1) * 64)}');
        expect(cache.length, 1);
      }
      final last = mergeReplies(messages, cache).single;
      expect(identical(mergeReplies(messages, cache).single, last), isTrue);
      mergeReplies([ChatMessage(id: 'u2', role: 'user')], cache);
      expect(cache, isEmpty);
    });

    test('a merged row keeps the first id and the last id is the footer anchor', () {
      final cache = <ChatMessage, ({ChatMessage previous, ChatMessage merged})>{};
      final rows = mergeReplies(<ChatMessage>[
        ChatMessage(id: 'a1', role: 'assistant', text: 'one'),
        ChatMessage(id: 'a2', role: 'assistant', text: 'two'),
      ], cache);
      expect(rows.length, 1);
      expect(rows.single.id, 'a1');
      expect(rows.single.lastId, 'a2');
      expect(rows.single.text, 'one\n\ntwo');
    });

    test('a compact row is not merged into a reply', () {
      final cache = <ChatMessage, ({ChatMessage previous, ChatMessage merged})>{};
      final rows = mergeReplies(<ChatMessage>[
        ChatMessage(id: 'a1', role: 'assistant', text: 'one'),
        ChatMessage(id: 'c1', role: 'assistant', kind: 'compact', text: 'compacted'),
      ], cache);
      expect(rows.length, 2);
    });

    test('a settled reply keeps its object identity while a later one streams', () {
      // The cache is keyed on the incoming message and only reused while the row it was
      // merged against is the same instance. That is what a streaming run looks like:
      // every row above the trailing one holds the same objects, so a card the reader
      // opened does not close — and the trailing row, the only one that changed, is the
      // only one rebuilt.
      final cache = <ChatMessage, ({ChatMessage previous, ChatMessage merged})>{};
      final user1 = ChatMessage(id: 'u1', role: 'user', text: 'go');
      final a1 = ChatMessage(id: 'a1', role: 'assistant', text: 'one');
      final a2 = ChatMessage(id: 'a2', role: 'assistant', text: 'two');
      final user2 = ChatMessage(id: 'u2', role: 'user', text: 'again');
      final before = mergeReplies(<ChatMessage>[
        user1,
        a1,
        a2,
        user2,
        ChatMessage(id: 'a3', role: 'assistant', text: 'three'),
      ], cache);
      final after = mergeReplies(<ChatMessage>[
        user1,
        a1,
        a2,
        user2,
        ChatMessage(id: 'a3', role: 'assistant', text: 'three four'),
      ], cache);
      // a1 and a2 are one reply row; the second turn's reply is its own.
      expect(before.length, 4);
      expect(before[1].id, 'a1');
      expect(before[1].text, 'one\n\ntwo');
      expect(identical(before[1], after[1]), isTrue);
      expect(identical(before[3], after[3]), isFalse);
      expect(after[3].text, 'three four');
    });

    test('an error from an earlier round trip stays as a part', () {
      final cache = <ChatMessage, ({ChatMessage previous, ChatMessage merged})>{};
      final rows = mergeReplies(<ChatMessage>[
        ChatMessage(id: 'a1', role: 'assistant', text: 'one', error: 'boom'),
        ChatMessage(id: 'a2', role: 'assistant', text: 'two'),
      ], cache);
      expect(rows.single.parts!.whereType<ErrorPart>().single.text, 'boom');
    });
  });

  group('blocks', () {
    test('consecutive thinking and tool parts fold into one process card', () {
      final message = ChatMessage(
        id: 'a1',
        role: 'assistant',
        tools: <ToolBlock>[ToolBlock(id: 't1', name: 'read')],
        parts: <MessagePart>[
          const ThinkingPart('hmm'),
          const ToolPart('t1'),
          const TextPart('the answer'),
        ],
      );
      final blocks = buildBlocks(message);
      expect(blocks.length, 2);
      expect(blocks.first, isA<ProcessBlock>());
      expect((blocks.first as ProcessBlock).steps.length, 2);
      expect(blocks.last, isA<TextBlock>());
    });

    test('prose ends a process card', () {
      final message = ChatMessage(
        id: 'a1',
        role: 'assistant',
        tools: <ToolBlock>[ToolBlock(id: 't1', name: 'read'), ToolBlock(id: 't2', name: 'write')],
        parts: <MessagePart>[
          const ToolPart('t1'),
          const TextPart('in between'),
          const ToolPart('t2'),
        ],
      );
      final blocks = buildBlocks(message);
      expect(blocks.length, 3);
      expect(blocks[0], isA<ProcessBlock>());
      expect(blocks[1], isA<TextBlock>());
      expect(blocks[2], isA<ProcessBlock>());
    });

    test('a part with no matching tool is dropped', () {
      final message = ChatMessage(
        id: 'a1',
        role: 'assistant',
        parts: <MessagePart>[const ToolPart('missing')],
      );
      expect(buildBlocks(message), isEmpty);
    });
  });

  group('catalog', () {
    CatalogConversation chat(String id, {String? preview, String? project, int updated = 0, String? kind}) =>
        CatalogConversation(id: id, title: id, preview: preview, project: project, createdAt: 0, updatedAt: updated, kind: kind);

    test('a chat with no preview shows only while it is running', () {
      final rows = visibleConversations(
        conversations: <CatalogConversation>[chat('a'), chat('b', preview: 'hi')],
        archivedIds: const <String>{},
        running: const <String>{},
      );
      expect(rows.map((row) => row.id), <String>['b']);

      final withRunning = visibleConversations(
        conversations: <CatalogConversation>[chat('a'), chat('b', preview: 'hi')],
        archivedIds: const <String>{},
        running: const <String>{'a'},
      );
      expect(withRunning.length, 2);
    });

    test('archived and side chats are never listed', () {
      final rows = visibleConversations(
        conversations: <CatalogConversation>[
          chat('a', preview: 'x'),
          chat('b', preview: 'x', kind: 'side-chat'),
        ],
        archivedIds: const <String>{'a'},
        running: const <String>{},
      );
      expect(rows, isEmpty);
    });

    test('projects order by most recent use, unknown ones keep the server order', () {
      final ordered = orderProjectsByRecentUse(
        <CatalogProject>[
          const CatalogProject(cwd: '/a', name: 'a'),
          const CatalogProject(cwd: '/b', name: 'b'),
          const CatalogProject(cwd: '/c', name: 'c'),
        ],
        <CatalogConversation>[
          chat('1', project: '/b', updated: 100),
          chat('2', project: '/c', updated: 200),
        ],
      );
      expect(ordered.map((project) => project.cwd), <String>['/c', '/b', '/a']);
    });
  });
}
