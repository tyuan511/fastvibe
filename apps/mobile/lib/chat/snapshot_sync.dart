import 'dart:async';

import '../i18n/core.dart';
import '../protocol/client.dart';

typedef SyncEvent = Map<String, Object?>;

class Snapshot {
  const Snapshot({
    required this.seq,
    this.messages,
    this.queue,
    this.messageMode,
    this.messageAnchorId,
    this.running,
    this.pendingUi,
    this.historyBeforeEntryId,
  });

  final int seq;
  final List<Object?>? messages;
  final Object? queue;

  /// tail | full | window
  final String? messageMode;
  final String? messageAnchorId;
  final bool? running;
  final List<Object?>? pendingUi;
  final String? historyBeforeEntryId;
}

/// Where a resumed conversation left off: the wire cursor plus the engine's own seq
/// watermark. They are deliberately separate — a gateway's upstream engine can restart
/// without resetting this socket's protocol sequence, so neither can stand in for the
/// other.
class SyncCheckpoint {
  const SyncCheckpoint({required this.cursor, required this.floor});

  final EventCursor cursor;
  final int floor;
}

class SnapshotSyncOptions {
  const SnapshotSyncOptions({
    required this.subscribe,
    required this.load,
    required this.onSnapshot,
    required this.onEvent,
    required this.onError,
    this.isCurrent,
    this.onRestored,
  });

  final bool Function()? isCurrent;
  final Future<SubscriptionResult> Function(EventCursor? cursor) subscribe;
  final Future<Snapshot> Function() load;
  final void Function(Snapshot snapshot) onSnapshot;
  final void Function(SyncEvent event) onEvent;
  final void Function(Object error) onError;
  final void Function(bool replayed)? onRestored;
}

class _Held {
  const _Held(this.event, this.meta);

  final SyncEvent event;
  final EventMeta? meta;
}

class _Waiter {
  _Waiter(this.afterSeq);

  final int? afterSeq;
  final resolve = Completer<void>();
}

/// Keeps one conversation's transcript in step with the engine.
///
/// The rules, in the order they matter:
///
/// - **Subscribe, then snapshot, then drop by `seq`.** A cold open pipelines both on the
///   same ordered socket rather than paying an extra round trip.
/// - **Events that arrive while the snapshot is in flight are held, never applied**, and
///   then merged by *server sequence*, not by arrival time: the wildcard subscription can
///   deliver a live frame before a named replay is requested.
/// - **A gap is never certified.** More than 2048 held events means the cursor is
///   abandoned and another authoritative snapshot is read.
class SnapshotSync {
  SnapshotSync(this._options);

  final SnapshotSyncOptions _options;
  int _floor = 0;
  EventCursor? _cursor;
  bool _valid = false;
  bool _restoring = true;
  bool _closed = false;
  List<_Held> _held = <_Held>[];
  bool _overflow = false;
  Future<void>? _loading;
  Timer? _timer;
  bool _dirty = false;
  List<_Waiter> _waiters = <_Waiter>[];

  bool get _active => !_closed && (_options.isCurrent?.call() ?? true);

  Future<void> restore([SyncCheckpoint? seed]) async {
    try {
      if (seed == null) {
        // A cold open doesn't need the journal. Pipeline subscribe and snapshot on the
        // same ordered socket instead of adding another round trip.
        final subscription = _options.subscribe(null);
        final results = await Future.wait<Object?>(<Future<Object?>>[subscription, _read()]);
        if (!_active) return;
        final result = results[0] as SubscriptionResult;
        final cursor = result.cursor;
        if (cursor != null && (_cursor == null || _cursor!.seq < cursor.seq)) _cursor = cursor;
        _options.onRestored?.call(false);
        return;
      }
      final subscription = await _options.subscribe(seed.cursor);
      if (!_active) return;
      _cursor = subscription.cursor;
      if (subscription.resumed && !_overflow) {
        _floor = seed.floor;
        _valid = true;
        _restoring = false;
        _drain();
        _options.onRestored?.call(true);
      } else {
        // A host restart can reset engine seq as well as the protocol epoch.
        _floor = 0;
        await _read();
        if (_active) _options.onRestored?.call(false);
      }
    } finally {
      if (_active) {
        _restoring = false;
        if (_dirty) _schedule();
      }
    }
  }

  void receive(SyncEvent event, EventMeta? meta) {
    if (!_active) return;
    if (_restoring || _loading != null) {
      if (_held.length < 2048) {
        _held.add(_Held(event, meta));
      } else {
        // Fall back to another authoritative snapshot, never certify a gap.
        _overflow = true;
      }
      if (!_valid || _restoring) return;
    }
    _apply(event, meta);
  }

  /// Coalesce boundaries; an in-flight read can have at most one follow-up read.
  Future<void> refresh([int? afterSeq]) {
    if (!_active) return Future<void>.value();
    _dirty = true;
    final waiter = _Waiter(afterSeq);
    _waiters.add(waiter);
    _schedule();
    return waiter.resolve.future;
  }

  SyncCheckpoint? checkpoint() {
    final cursor = _cursor;
    if (_valid && !_restoring && _loading == null && !_dirty && !_overflow && cursor != null) {
      return SyncCheckpoint(cursor: EventCursor(cursor.epoch, cursor.seq), floor: _floor);
    }
    return null;
  }

  void dispose() {
    _closed = true;
    _timer?.cancel();
    _timer = null;
    _held = <_Held>[];
    for (final waiter in _waiters) {
      if (!waiter.resolve.isCompleted) waiter.resolve.complete();
    }
    _waiters = <_Waiter>[];
  }

  void _schedule() {
    if (!_active || _restoring || _loading != null || _timer != null) return;
    _timer = Timer(const Duration(milliseconds: 50), () {
      _timer = null;
      _read().catchError((Object error) {
        if (_active) _options.onError(error);
      });
    });
  }

  Future<void> _read() {
    if (!_active) {
      for (final waiter in _waiters) {
        if (!waiter.resolve.isCompleted) waiter.resolve.complete();
      }
      _waiters = <_Waiter>[];
      return Future<void>.value();
    }
    final existing = _loading;
    if (existing != null) return existing;
    _dirty = false;
    final waiters = List<_Waiter>.from(_waiters);
    _waiters = <_Waiter>[];
    // A new read supersedes events already known at its dispatch; later events are
    // still held and reconciled against the snapshot's atomic engine seq.
    _held = <_Held>[];
    _overflow = false;
    final loading = Future<void>.value().then((_) => _options.load()).then((snapshot) {
      if (!_active) return;
      if (snapshot.seq < 0) throw StateError(t('chat.loadFailed'));
      _options.onSnapshot(snapshot);
      _floor = snapshot.seq;
      _valid = true;
      _restoring = false;
      _drain();
      // A boundary may reach the phone after dispatch but before the host reads its
      // snapshot. Its engine seq proves when that read already includes it. Manual
      // refreshes have no watermark and still require their own read.
      final pending = _waiters;
      _waiters = <_Waiter>[];
      for (final waiter in pending) {
        final afterSeq = waiter.afterSeq;
        if (afterSeq != null && afterSeq >= 0 && afterSeq <= snapshot.seq) {
          if (!waiter.resolve.isCompleted) waiter.resolve.complete();
        } else {
          _waiters.add(waiter);
        }
      }
      _dirty = _overflow || _waiters.isNotEmpty;
      if (_overflow) _valid = false;
      for (final waiter in waiters) {
        if (!waiter.resolve.isCompleted) waiter.resolve.complete();
      }
    }).catchError((Object error, StackTrace stack) {
      for (final waiter in waiters) {
        if (!waiter.resolve.isCompleted) waiter.resolve.completeError(error, stack);
      }
      // Keep already displayed live events, but don't use an uncertain cursor to resume.
      _valid = false;
      throw error;
    }).whenComplete(() {
      if (!_active) {
        for (final waiter in waiters) {
          if (!waiter.resolve.isCompleted) waiter.resolve.complete();
        }
      }
      _loading = null;
      if (_dirty) _schedule();
    });
    _loading = loading;
    return loading;
  }

  void _drain() {
    final held = _held;
    _held = <_Held>[];
    // The wildcard may deliver live frames before a named replay is requested. Merge
    // these two sources by their server sequence, never by arrival time.
    held.sort((a, b) => _seqOf(a).compareTo(_seqOf(b)));
    for (final item in held) {
      _apply(item.event, item.meta, reconcile: true);
    }
  }

  static int _seqOf(_Held item) {
    final metaSeq = item.meta?.seq;
    if (metaSeq != null) return metaSeq;
    final eventSeq = item.event['seq'];
    return eventSeq is int ? eventSeq : 0;
  }

  void _apply(SyncEvent event, EventMeta? meta, {bool reconcile = false}) {
    // A gateway's upstream engine can restart without resetting this socket's protocol
    // sequence. Use the wire cursor for ordinary live deduplication; the engine floor
    // only reconciles a snapshot/replay window.
    final cursor = _cursor;
    if (!reconcile && meta != null && cursor != null && cursor.epoch == meta.epoch && meta.seq <= cursor.seq) {
      return;
    }
    if (meta != null && (cursor == null || cursor.epoch != meta.epoch || meta.seq > cursor.seq)) {
      _cursor = EventCursor(meta.epoch, meta.seq);
    }
    final eventSeq = event['seq'];
    if ((reconcile || meta == null) && eventSeq is int && eventSeq <= _floor) return;
    _options.onEvent(event);
    if (eventSeq is int) _floor = eventSeq;
  }
}
