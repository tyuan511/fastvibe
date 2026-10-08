import 'client.dart';

class _Entry {
  _Entry(this.future, this.expires, this.pending);

  Future<List<Object?>> future;
  int expires;
  bool pending;
}

const int _maxAgeMs = 60000;

final Map<RemoteClient, _Entry> _entries = <RemoteClient, _Entry>{};

/// Reuse the host-wide model catalog across chats and share concurrent reads.
///
/// A failure is not cached: the next caller retries instead of being handed the same
/// error for a minute.
Future<List<Object?>> readModelCatalog(RemoteClient client, {int? now}) {
  final at = now ?? DateTime.now().millisecondsSinceEpoch;
  final previous = _entries[client];
  if (previous != null && (previous.pending || previous.expires > at)) return previous.future;
  final entry = _Entry(Future<List<Object?>>.value(const <Object?>[]), 0, true);
  _entries[client] = entry;
  entry.future = client.call('engine:get-models').then((value) {
    entry.pending = false;
    entry.expires = DateTime.now().millisecondsSinceEpoch + _maxAgeMs;
    return value is List ? value.cast<Object?>() : <Object?>[];
  }).catchError((Object error, StackTrace stack) {
    if (identical(_entries[client], entry)) _entries.remove(client);
    return Future<List<Object?>>.error(error, stack);
  });
  return entry.future;
}

void invalidateModelCatalog(RemoteClient? client) {
  if (client == null) {
    _entries.clear();
    return;
  }
  _entries.remove(client);
}
