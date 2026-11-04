import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

const String _prefix = 'fastvibe.chat-draft.v1:';
final Map<String, MobileDraft?> _memory = <String, MobileDraft?>{};
final Map<String, Future<void>> _writes = <String, Future<void>>{};

/// One chat's unsent text. Kept per machine and per conversation, so switching chats
/// never loses what was typed and a draft written on one machine is not offered on
/// another.
class MobileDraft {
  const MobileDraft({
    required this.serverId,
    required this.conversationId,
    required this.text,
    required this.updatedAt,
  });

  final String serverId;
  final String conversationId;
  final String text;
  final int updatedAt;
}

String _key(String serverId, String conversationId) =>
    '$_prefix${Uri.encodeComponent(serverId)}:${Uri.encodeComponent(conversationId)}';

MobileDraft? _parse(String? value, String serverId, String conversationId) {
  if (value == null) return null;
  try {
    final parsed = jsonDecode(value);
    if (parsed is! Map) return null;
    final text = parsed['text'];
    final updatedAt = parsed['updatedAt'];
    if (text is! String || updatedAt is! num) return null;
    return MobileDraft(
      serverId: serverId,
      conversationId: conversationId,
      text: text,
      updatedAt: updatedAt.toInt(),
    );
  } catch (_) {
    return null;
  }
}

Future<MobileDraft?> readDraft(String serverId, String conversationId) async {
  final storageKey = _key(serverId, conversationId);
  if (_memory.containsKey(storageKey)) return _memory[storageKey];
  try {
    final prefs = await SharedPreferences.getInstance();
    final saved = _parse(prefs.getString(storageKey), serverId, conversationId);
    _memory[storageKey] = saved;
    return saved;
  } catch (_) {
    return null;
  }
}

/// Writes are serialised per key: a fast typist produces one write per keystroke and
/// they must land in order.
Future<void> writeDraft(String serverId, String conversationId, String text) {
  final storageKey = _key(serverId, conversationId);
  final draft = text.isEmpty
      ? null
      : MobileDraft(
          serverId: serverId,
          conversationId: conversationId,
          text: text,
          updatedAt: DateTime.now().millisecondsSinceEpoch,
        );
  // Update the in-memory view synchronously so returning to a chat never waits for the
  // storage bridge. The actual writes for one key are serialized below.
  _memory[storageKey] = draft;
  final previous = _writes[storageKey] ?? Future<void>.value();
  final next = previous.catchError((Object _) {}).then((_) async {
    final prefs = await SharedPreferences.getInstance();
    if (draft != null) {
      await prefs.setString(storageKey, jsonEncode(<String, Object?>{
        'serverId': serverId,
        'conversationId': conversationId,
        'text': draft.text,
        'updatedAt': draft.updatedAt,
      }));
    } else {
      await prefs.remove(storageKey);
    }
  });
  _writes[storageKey] = next;
  next.whenComplete(() {
    if (identical(_writes[storageKey], next)) _writes.remove(storageKey);
  });
  return next.catchError((Object _) {});
}

/// Every non-empty draft this machine holds, most recent first. 新对话 uses it to find
/// an empty chat that already has text typed into it.
Future<List<MobileDraft>> listDrafts(String serverId) async {
  final prefix = '$_prefix${Uri.encodeComponent(serverId)}:';
  try {
    final prefs = await SharedPreferences.getInstance();
    final drafts = <String, MobileDraft>{};
    for (final storageKey in prefs.getKeys()) {
      if (!storageKey.startsWith(prefix)) continue;
      final conversationId = Uri.decodeComponent(storageKey.substring(prefix.length));
      final draft = _parse(prefs.getString(storageKey), serverId, conversationId);
      if (draft != null) drafts[storageKey] = draft;
    }
    for (final entry in _memory.entries) {
      if (!entry.key.startsWith(prefix)) continue;
      if (entry.value != null) {
        drafts[entry.key] = entry.value!;
      } else {
        drafts.remove(entry.key);
      }
    }
    final rows = drafts.values.where((item) => item.text.isNotEmpty).toList();
    rows.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return rows;
  } catch (_) {
    final rows = _memory.entries
        .where((entry) => entry.key.startsWith(prefix) && entry.value != null && entry.value!.text.isNotEmpty)
        .map((entry) => entry.value!)
        .toList();
    rows.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return rows;
  }
}
