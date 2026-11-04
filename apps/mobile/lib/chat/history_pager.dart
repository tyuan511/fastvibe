import 'dart:async';

import '../i18n/core.dart';

class HistoryPage<T extends Object> {
  const HistoryPage({
    required this.messages,
    required this.beforeEntryId,
    required this.nextBeforeEntryId,
    required this.reset,
  });

  final List<T> messages;
  final String beforeEntryId;
  final String? nextBeforeEntryId;
  final bool reset;
}

class HistoryPagerOptions<T extends Object> {
  const HistoryPagerOptions({
    required this.load,
    required this.prepend,
    required this.cursorChanged,
    required this.reset,
    this.cursor,
  });

  final Future<HistoryPage<T>> Function(String cursor) load;

  /// Returns false when the rows could not be placed, which forces a reset.
  final bool Function(List<T> messages, String cursor) prepend;
  final void Function(String? cursor) cursorChanged;
  final Future<void> Function() reset;
  final String? cursor;
}

/// Older history has its own flight; it cannot block live snapshot reconciliation.
class HistoryPager<T extends Object> {
  HistoryPager(this._options) : _cursor = _options.cursor;

  final HistoryPagerOptions<T> _options;
  String? _cursor;
  int _generation = 0;
  bool _closed = false;
  Future<void>? _flight;
  Timer? _retry;
  int _attempt = 0;

  String? get cursor => _cursor;

  void replace(String? cursor) {
    _generation++;
    _flight = null;
    _cursor = cursor;
    _options.cursorChanged(cursor);
    _attempt = 0;
    _retry?.cancel();
    _retry = null;
  }

  Future<void> loadOlder() {
    final cursor = _cursor;
    if (_closed || cursor == null) return Future<void>.value();
    final existing = _flight;
    if (existing != null) return existing;
    final generation = _generation;
    bool current() => !_closed && generation == _generation;
    late Future<void> flight;
    flight = _options.load(cursor).then((page) async {
      if (!current()) return;
      if (page.beforeEntryId != cursor) throw StateError(t('chat.loadFailed'));
      if (page.reset) {
        // Keep the old cursor incomplete until the authoritative reset succeeds.
        // Otherwise a concurrent copy-all could copy this partial window.
        await _options.reset();
        if (current()) replace(null);
        return;
      }
      final next = page.nextBeforeEntryId;
      if (next != null && (next == cursor || page.messages.isEmpty || _idOf(page.messages.first) != next)) {
        throw StateError(t('chat.loadFailed'));
      }
      if (!_options.prepend(page.messages, cursor)) {
        await _options.reset();
        if (current()) replace(null);
        return;
      }
      _cursor = next;
      _options.cursorChanged(_cursor);
      _attempt = 0;
    }).whenComplete(() {
      if (identical(_flight, flight)) _flight = null;
    });
    _flight = flight;
    return flight;
  }

  /// Invisible prefetch; transient failures retry while this view remains attached.
  void prefetch() {
    if (_closed || _cursor == null || _retry != null) return;
    final generation = _generation;
    loadOlder().catchError((Object _) {
      if (_closed || _retry != null || generation != _generation) return;
      final exponent = _attempt > 4 ? 4 : _attempt;
      _attempt++;
      final delay = (1000 * (1 << exponent)).clamp(1000, 15000);
      _retry = Timer(Duration(milliseconds: delay), () {
        _retry = null;
        prefetch();
      });
    });
  }

  /// Copy-all must never silently copy just the visible history window.
  Future<void> loadAll() async {
    while (!_closed && _cursor != null) {
      final before = _cursor;
      final generation = _generation;
      await loadOlder();
      if (generation == _generation && _cursor == before) throw StateError(t('chat.loadFailed'));
    }
    if (_closed) throw StateError(t('chat.loadFailed'));
  }

  void dispose() {
    _closed = true;
    _generation++;
    _retry?.cancel();
    _retry = null;
  }

  static String? _idOf(Object message) {
    try {
      return (message as dynamic).id as String?;
    } catch (_) {
      return null;
    }
  }
}

/// Keep existing row objects and their inverted-list indices when older rows arrive.
List<T>? prependHistory<T extends Object>(List<T> current, List<T> older, String cursor) {
  if (current.isEmpty || HistoryPager._idOf(current.first) != cursor) return null;
  final present = <String>{for (final message in current) HistoryPager._idOf(message) ?? ''};
  final prefix = <T>[];
  for (final message in older) {
    final id = HistoryPager._idOf(message) ?? '';
    if (present.contains(id)) continue;
    prefix.add(message);
    present.add(id);
  }
  return prefix.isNotEmpty ? <T>[...prefix, ...current] : current;
}
