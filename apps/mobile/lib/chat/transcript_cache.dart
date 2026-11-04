import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:crypto/crypto.dart';
import 'package:path_provider/path_provider.dart';

const int transcriptCacheEntryBytes = 256 * 1024;
const int _budget = 8 * 1024 * 1024;
const int _maxEntries = 20;
const int _ttlMs = 7 * 24 * 60 * 60 * 1000;

/// A disposable display hint, never a sync checkpoint or permission to send.
class TranscriptCache {
  TranscriptCache({
    Future<Directory> Function()? directory,
    int Function()? now,
  }) : _directory = directory ?? getTemporaryDirectory,
       _now = now ?? (() => DateTime.now().millisecondsSinceEpoch);

  static final instance = TranscriptCache();
  final Future<Directory> Function() _directory;
  final int Function() _now;
  final Map<String, ({int at, List<Object?> messages})> _memory = {};
  Future<void> _writes = Future<void>.value();

  String _key(String server, String conversation) => sha256
      .convert(utf8.encode(jsonEncode([server, conversation])))
      .toString();

  Future<List<Object?>?> read(String server, String conversation) async {
    final key = _key(server, conversation);
    final now = _now();
    final cached = _memory.remove(key);
    if (cached != null && now - cached.at < _ttlMs) {
      _memory[key] = cached;
      return cached.messages;
    }
    try {
      final root = (await _directory()).path;
      final result = await _readOffThread(root, key, server, conversation, now);
      if (result == null) return null;
      _remember(key, result.at, result.messages);
      return result.messages;
    } catch (_) {
      return null; // A missing/evicted cache cannot break opening a conversation.
    }
  }

  Future<void> write(
    String server,
    String conversation,
    List<Object?> messages,
  ) {
    final key = _key(server, conversation);
    final now = _now();
    // Copy the window, not the growing in-memory transcript. No live projection is
    // ever shared with the cache writer or persisted as a replay checkpoint.
    final recent = recentTranscript(messages);
    final previous = _memory[key]?.messages;
    if (recent.isEmpty) _memory.remove(key);
    final task = _writes.catchError((Object _) {}).then((_) async {
      try {
        final root = (await _directory()).path;
        final saved = await _writeOffThread(
          root,
          key,
          server,
          conversation,
          now,
          recent,
        );
        if (saved) {
          _remember(key, now, recent);
        } else if (identical(_memory[key]?.messages, previous)) {
          _memory.remove(key);
        }
      } catch (_) {
        // Storage failures affect only the next preview, never authoritative sync.
      }
    });
    _writes = task;
    return task;
  }

  void _remember(String key, int at, List<Object?> messages) {
    _memory.remove(key);
    _memory[key] = (at: at, messages: messages);
    while (_memory.length > _maxEntries) {
      _memory.remove(_memory.keys.first);
    }
  }
}

/// Cache a few complete mapped turns, excluding the unfinished reply placeholder.
List<Object?> recentTranscript(List<Object?> messages) {
  var turns = 0;
  var start = 0;
  for (var i = messages.length - 1; i >= 0; i--) {
    final row = messages[i];
    if (row is Map && row['role'] == 'user' && ++turns == 3) {
      start = i;
      break;
    }
  }
  return messages
      .skip(start)
      .where(
        (row) =>
            row is Map &&
            row['id'] is String &&
            !(row['id'] as String).startsWith('running:'),
      )
      .toList();
}

File _file(String root, String key) =>
    File('$root/transcript-previews-v1/$key.json');

Future<({int at, List<Object?> messages})?> _read(
  String root,
  String key,
  String server,
  String conversation,
  int now,
) async {
  final file = _file(root, key);
  if (await file.length() > transcriptCacheEntryBytes) return null;
  final data = jsonDecode(await file.readAsString());
  if (data is! Map ||
      data['version'] != 1 ||
      data['server'] != server ||
      data['conversation'] != conversation ||
      data['at'] is! int ||
      now - (data['at'] as int) >= _ttlMs ||
      (data['at'] as int) > now ||
      data['messages'] is! List) {
    return null;
  }
  return (
    at: data['at'] as int,
    messages: List<Object?>.from(data['messages'] as List),
  );
}

Future<bool> _write(
  String root,
  String key,
  String server,
  String conversation,
  int now,
  List<Object?> messages,
) async {
  final file = _file(root, key);
  final data = utf8.encode(
    jsonEncode({
      'version': 1,
      'server': server,
      'conversation': conversation,
      'at': now,
      'messages': messages,
    }),
  );
  if (messages.isEmpty || data.length > transcriptCacheEntryBytes) {
    if (await file.exists()) await file.delete();
    return false;
  }
  await file.parent.create(recursive: true);
  final temporary = File('${file.path}.tmp');
  await temporary.writeAsBytes(data, flush: true);
  await temporary.rename(file.path);
  final files = <({File file, int size, DateTime modified})>[];
  await for (final entity in file.parent.list()) {
    if (entity is! File || !entity.path.endsWith('.json')) continue;
    final info = await entity.stat();
    if (now - info.modified.millisecondsSinceEpoch >= _ttlMs) {
      await entity.delete();
    } else {
      files.add((file: entity, size: info.size, modified: info.modified));
    }
  }
  files.sort((a, b) => a.modified.compareTo(b.modified));
  var bytes = files.fold(0, (sum, item) => sum + item.size);
  var count = files.length;
  for (final item in files) {
    if (bytes <= _budget && count <= _maxEntries) break;
    await item.file.delete();
    bytes -= item.size;
    count--;
  }
  return true;
}

// Keep isolate closures outside the cache instance: an instance-method closure can
// capture its serialized write Future, which cannot cross an isolate boundary.
Future<({int at, List<Object?> messages})?> _readOffThread(
  String root,
  String key,
  String server,
  String conversation,
  int now,
) => Isolate.run(() => _read(root, key, server, conversation, now));

Future<bool> _writeOffThread(
  String root,
  String key,
  String server,
  String conversation,
  int now,
  List<Object?> messages,
) => Isolate.run(() => _write(root, key, server, conversation, now, messages));
