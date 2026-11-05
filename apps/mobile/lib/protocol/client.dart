import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/runtime.dart';
import '../i18n/core.dart';
import 'diagnostics.dart';

const Duration connectTimeout = Duration(seconds: 40);
const Duration healthInterval = Duration(seconds: 15);
const Duration healthTimeout = Duration(seconds: 15);

class TransportError extends Error {
  TransportError(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => 'TransportError($code): $message';
}

class ConnectionError extends Error {
  ConnectionError(this.code, this.message, [this.detail]);
  final String code;
  final String message;
  final DisconnectDetail? detail;
  @override
  String toString() => 'ConnectionError($code): $message';
}

class DisconnectDetail {
  const DisconnectDetail(this.kind, {this.code, this.reason});
  final String kind;
  final int? code;
  final String? reason;
}

class EventCursor {
  const EventCursor(this.epoch, this.seq);
  final String epoch;
  final int seq;
  Map<String, Object?> toJson() => {'epoch': epoch, 'seq': seq};
}

class EventMeta {
  const EventMeta(this.scope, this.epoch, this.seq);
  final String scope;
  final String epoch;
  final int seq;
}

class SubscriptionResult {
  const SubscriptionResult({required this.resumed, this.cursor});
  final bool resumed;
  final EventCursor? cursor;
}

typedef PushHandler = void Function(
  String channel,
  Object? payload,
  EventMeta? meta,
);
typedef DisconnectHandler = void Function(DisconnectDetail detail);

class _Pending {
  _Pending(this.completer);
  final Completer<Map<String, Object?>> completer;
  Timer? timer;
}

/// Adapts the shared Rust runtime to the restored Flutter screens. Rust owns
/// transport/framing/correlation; this facade retains the server's full RPC result.
class RemoteClient {
  RemoteClient({
    String version = '0.0.0',
    CoreRuntime? runtime,
    this.ownsRuntime = true,
    Future<String?> Function()? readIdentity,
    Future<void> Function(String)? saveIdentity,
  }) : _core = runtime ?? NativeCoreRuntime(),
       _readIdentity = readIdentity ?? (() => _secure.read(key: _identityKey)),
       _saveIdentity =
           saveIdentity ??
           ((key) => _secure.write(key: _identityKey, value: key)) {
    _updates = _core.updates.listen(
      _update,
      onError: (Object error) {
        if (_acceptTransportUpdates && !_closed) {
          _drop(DisconnectDetail('core-error', reason: '$error'));
        }
      },
    );
  }

  static const _secure = FlutterSecureStorage();
  static const _identityKey = 'fv.iroh.identity.v1';
  final CoreRuntime _core;
  final bool ownsRuntime;
  bool _acceptTransportUpdates = false;
  int? _transportGeneration;
  final _admissionUpdates = <Map<String, Object?>>[];
  final Future<String?> Function() _readIdentity;
  final Future<void> Function(String) _saveIdentity;
  late final StreamSubscription<Map<String, Object?>> _updates;
  final _pending = <int, _Pending>{};
  // A response can be polled before the command acknowledgement has reached the
  // Dart continuation that installs its waiter. Bound and retain only that gap.
  final _earlyResults = <int, Map<String, Object?>>{};
  final _resyncScopes = <String>{};
  final _subscriptionScopes = <String>{};
  int _admitting = 0;
  int _generation = 0;
  Future<void>? _shutdown;
  Future<void> get shutdown => _shutdown ?? Future<void>.value();
  bool _closed = false;
  bool _ready = false;
  bool _active = false;
  bool _probing = false;
  int _lastReceived = 0;
  int? _rtt;
  String _epoch = '';
  Map<String, Object?> _features = {};
  PushHandler? _push;
  DisconnectHandler? _disconnect;
  Completer<void>? _connecting;
  Timer? _health;
  DateTime? _expires;

  bool get ready => _ready;
  int get pendingCalls => _pending.length + _admitting;
  int? get rttMs => _rtt;
  String get epoch => _epoch;
  DateTime? get credentialExpiresAt => _expires;
  bool get supportsPromptSubmit => _features['promptSubmit'] == true;
  bool get supportsConversationResume =>
      _features['conversationResume'] == true;
  bool get supportsHistoryPaging => _features['historyPaging'] == true;
  bool get supportsTranscriptPreview => _features['transcriptPreview'] == true;
  // Until the core exposes selected path, renew conservatively rather than leave
  // an expired credential behind after a direct path falls back to the relay.
  Future<bool> usesRelay() async => true;
  void onPush(PushHandler? handler) => _push = handler;
  void onDisconnect(DisconnectHandler? handler) => _disconnect = handler;

  Future<Object?> _command(
    String action, [
    Map<String, Object?> parameters = const {},
  ]) async {
    if (_closed) throw TransportError('closed', t('conn.closed'));
    return coreResult(await _core.command(action, parameters));
  }

  /// Register this install and its persisted QUIC identity before dialing a fresh
  /// account-owned endpoint. No platform implements its own socket or handshake.
  Future<void> connectDevice({
    required String origin,
    required String token,
    required String deviceId,
    required String installId,
    required String clientName,
    required String platform,
    String? lanEndpointId,
    List<String> directAddresses = const [],
    bool Function()? isLanEndpointCurrent,
  }) async {
    final generation = _generation;
    void current() {
      if (_closed || generation != _generation) {
        throw TransportError('closed', t('conn.closed'));
      }
    }

    final clock = Stopwatch()..start();
    var phase = 'connect.identity';
    void recordPhase(String outcome) {
      recordConnectionDiagnostic(
        Diagnostic.metric(
          phase,
          elapsedMs: clock.elapsedMilliseconds,
          outcome: outcome,
        ),
      );
    }

    void nextPhase(String next) {
      recordPhase('ok');
      phase = next;
      clock.reset();
    }

    try {
      await _command('setToken', {'origin': origin, 'token': token});
      current();
      final saved = await _readIdentity();
      current();
      final identity = await _command(
        saved == null ? 'identity' : 'setIdentity',
        saved == null ? const {} : {'secretKey': saved},
      );
      current();
      if (identity is! Map ||
          identity['endpointId'] is! String ||
          identity['secretKey'] is! String) {
        throw const CoreFailure('Rust core returned an invalid identity');
      }
      if (saved == null) {
        await _saveIdentity(identity['secretKey'] as String);
        current();
      }
      nextPhase('connect.register-device');
      final registered = await _command('registerDevice', {
        'installId': installId,
        'name': clientName,
        'platform': platform,
      });
      current();
      if (registered is! Map || registered['deviceId'] is! String) {
        throw const CoreFailure('Device registration returned no id');
      }
      final localId = registered['deviceId'] as String;
      final endpoint = identity['endpointId'] as String;
      nextPhase('connect.register-endpoint');
      await _command('registerEndpoint', {
        'deviceId': localId,
        'endpointId': endpoint,
      });
      current();
      nextPhase('connect.devices');
      // Refresh on every attempt: an automatic reconnect must not reuse a stale
      // target object when the desktop has replaced its transport identity.
      final devices = await _command('devices');
      current();
      final matches = devices is List
          ? devices.whereType<Map>().where((d) => d['id'] == deviceId)
          : const <Map>[];
      if (matches.isEmpty) {
        throw ConnectionError('gone', t('official.loadFailed'));
      }
      final target = matches.first;
      final remote = target['irohEndpointId'] ?? target['iroh_endpoint_id'];
      if (remote is! String || remote.isEmpty) {
        throw ConnectionError('unreachable', t('conn.unreachable'));
      }
      nextPhase('connect.relay-token');
      final direct =
          remote == lanEndpointId && (isLanEndpointCurrent?.call() ?? true)
          ? List<String>.of(directAddresses)
          : <String>[];
      Map? relay;
      if (direct.isNotEmpty) {
        // Core tries these addresses first and acquires a full relay lease only
        // if direct dialing fails, within the same transport deadline.
        _expires = null;
        recordPhase('local');
      } else {
        final lease = await _command('relayToken', {
          'deviceId': localId,
          'endpointId': endpoint,
        });
        current();
        if (lease is! Map) throw const CoreFailure('Relay lease is invalid');
        relay = lease;
        _expires = DateTime.tryParse(
          '${relay['expiresAt'] ?? relay['expires_at'] ?? ''}',
        );
        recordPhase('ok');
      }
      phase = 'connect.transport';
      clock.reset();
      final connecting = Completer<void>();
      _connecting = connecting;
      // Attach the error handler before sending connect: an immediate error/ready
      // update can be emitted alongside the command acknowledgement.
      final wait = connecting.future.timeout(connectTimeout);
      _acceptTransportUpdates = true;
      await Future.wait<Object?>([
        _command('connect', {
          'remoteId': remote,
          'relay': ?relay,
          if (direct.isNotEmpty) ...{
            'directAddresses': direct,
            'preferDirect': true,
          },
        }).then<void>((result) {
          if (_closed) return;
          _transportGeneration = result is Map
              ? result['generation'] as int?
              : null;
          final updates = List<Map<String, Object?>>.of(_admissionUpdates);
          _admissionUpdates.clear();
          for (final update in updates) {
            _update(update);
          }
        }),
        wait,
      ], eagerError: true);
      current();
      recordPhase('ok');
    } catch (error) {
      recordPhase('error');
      if (!_closed) {
        _drop(
          DisconnectDetail('connect-failed', reason: '$error'),
          notify: false,
        );
      }
      rethrow;
    } finally {
      clock.stop();
    }
  }

  void _update(Map<String, Object?> update) {
    if (_closed || !_acceptTransportUpdates) return;
    final generation = update['generation'];
    if (generation is int) {
      if (_transportGeneration == null) {
        // Fake runtimes may synchronously publish welcome during admission.
        if (_admissionUpdates.length < 64) _admissionUpdates.add(update);
        return;
      }
      if (generation != _transportGeneration) return;
    }
    if (update['overflowed'] == true) {
      _drop(
        const DisconnectDetail(
          'resync',
          reason: 'Rust event buffer overflowed',
        ),
      );
      return;
    }
    final state = update['state'];
    if (state is Map) {
      if (state['features'] is Map) {
        _features = (state['features'] as Map).cast<String, Object?>();
      }
      if (state['connection'] == 'ready') {
        _ready = true;
        final cursors = state['wireCursors'];
        if (cursors is Map && cursors.isNotEmpty) {
          final value = cursors.values.first;
          if (value is Map && value['epoch'] is String) {
            _epoch = value['epoch'] as String;
          }
        }
        final connecting = _connecting;
        _connecting = null;
        if (connecting != null && !connecting.isCompleted) {
          connecting.complete();
        }
        _scheduleHealth();
      }
    }
    final events = update['events'];
    if (events is List) {
      for (final event in events.whereType<Map>()) {
        if (_closed) return;
        _handle(event.cast<String, Object?>());
      }
    }
    if (!_closed &&
        state is Map &&
        (state['connection'] == 'error' ||
            state['connection'] == 'disconnected') &&
        (_ready || _connecting != null)) {
      _drop(DisconnectDetail('core-error', reason: state['error'] as String?));
    }
  }

  void _handle(Map<String, Object?> event) {
    _lastReceived = DateTime.now().millisecondsSinceEpoch;
    final kind = event['kind'] ?? event['type'];
    if (kind == 'relay_lease') {
      final expiresAt = event['expiresAt'];
      if (expiresAt is String) {
        final expires = DateTime.tryParse(expiresAt);
        if (expires != null) _expires = expires;
      }
    } else if (kind == 'welcome') {
      if (event['features'] is Map) {
        _features = (event['features'] as Map).cast<String, Object?>();
      }
      _ready = true;
      final connecting = _connecting;
      _connecting = null;
      if (connecting != null && !connecting.isCompleted) connecting.complete();
      _scheduleHealth();
    } else if (kind == 'rpcResult') {
      final id = event['requestId'];
      if (id is! int) return;
      final pending = _pending.remove(id);
      if (pending == null) {
        if (_admitting > 0 && _earlyResults.length < 128) {
          _earlyResults[id] = event;
        }
        return;
      }
      pending.timer?.cancel();
      pending.completer.complete(event);
    } else if (kind == 'event' && event['channel'] is String) {
      final meta = _eventMeta(event);
      if (meta != null) _epoch = meta.epoch;
      _push?.call(event['channel'] as String, event['payload'], meta);
    } else if (kind == 'resync') {
      final scope = event['scope'];
      if (scope is String && _subscriptionScopes.contains(scope)) {
        _resyncScopes.add(scope);
      } else {
        _drop(const DisconnectDetail('resync'));
      }
    } else if (kind == 'connection_error' || kind == 'remote_close') {
      _drop(
        DisconnectDetail(
          'socket-close',
          code: event['code'] is int ? event['code'] as int : null,
          reason: (event['message'] ?? event['reason']) as String?,
        ),
      );
    }
  }

  Future<Map<String, Object?>> _request(
    String action,
    Map<String, Object?> parameters, {
    int? timeoutMs = 30000,
  }) async {
    if (!_ready || _closed) {
      throw TransportError('closed', t('conn.notConnected'));
    }
    final generation = _generation;
    _admitting++;
    try {
      final admission = await _command(action, parameters);
      if (_closed || generation != _generation) {
        throw TransportError('dropped', t('conn.dropped'));
      }
      if (admission is! Map || admission['requestId'] is! int) {
        throw const CoreFailure('Rust core returned no RPC id');
      }
      final id = admission['requestId'] as int;
      final pending = _Pending(Completer<Map<String, Object?>>());
      final early = _earlyResults.remove(id);
      if (early != null) return early;
      _pending[id] = pending;
      if (timeoutMs != null) {
        pending.timer = Timer(Duration(milliseconds: timeoutMs), () {
          if (_pending.remove(id) != pending) return;
          unawaited(
            _command('cancel', {
              'targetRequestId': id,
              'reason': 'timeout',
            }).catchError((Object _) => null),
          );
          pending.completer.completeError(
            TransportError('timeout', t('conn.requestTimeout')),
          );
        });
      }
      return await pending.completer.future;
    } finally {
      _admitting--;
      if (_admitting == 0) _earlyResults.clear();
    }
  }

  Future<Object?> call(String method, [Object? payload, int? timeoutMs]) async {
    final started = DateTime.now().millisecondsSinceEpoch;
    final event = await _request(
      'call',
      {'method': method, 'payload': payload},
      timeoutMs:
          timeoutMs ??
          (const {
                'engine:continue',
                'engine:compact',
                'engine:prompt',
                'engine:prompt-conversation',
              }.contains(method)
              ? null
              : 30000),
    );
    recordConnectionDiagnostic(
      Diagnostic.metric(
        'rpc',
        name: method,
        elapsedMs: DateTime.now().millisecondsSinceEpoch - started,
        outcome: event['ok'] == true ? 'ok' : 'error',
      ),
    );
    if (event['ok'] != true) {
      final error = event['error'];
      if (error is Map && error['code'] == 'mobile.timeout') {
        throw TransportError('timeout', '${error['message']}');
      }
      throw CoreFailure(
        error is Map && error['message'] is String
            ? error['message'] as String
            : t('conn.requestFailed'),
        code: error is Map && error['code'] is String
            ? error['code'] as String
            : 'remote.error',
        details: error,
      );
    }
    return event['result'];
  }

  void subscribe(List<String> scopes) {
    unawaited(
      _request('subscribe', {'scopes': scopes})
          .then<void>((event) {
            if (event['ok'] != true) throw StateError(t('conn.requestFailed'));
          })
          .catchError((Object error) {
            _drop(DisconnectDetail('resync', reason: '$error'));
          }),
    );
  }

  Future<SubscriptionResult> subscribeConversation(
    String scope, [
    EventCursor? cursor,
  ]) async {
    if (!_subscriptionScopes.add(scope)) {
      throw StateError(t('conn.requestFailed'));
    }
    _resyncScopes.remove(scope);
    try {
      final result = await _request('subscribe', {
        'scopes': [scope],
        if (cursor != null) 'since': {scope: cursor.toJson()},
      });
      if (result['ok'] != true) throw StateError(t('conn.requestFailed'));
      final body = result['result'];
      final cursors = body is Map ? body['cursors'] : null;
      final next = cursors is Map ? _cursor(cursors[scope]) : null;
      if (next != null) _epoch = next.epoch;
      final resync = _resyncScopes.remove(scope);
      return SubscriptionResult(
        resumed: cursor != null && next?.epoch == cursor.epoch && !resync,
        cursor: next,
      );
    } finally {
      _subscriptionScopes.remove(scope);
      _resyncScopes.remove(scope);
    }
  }

  void unsubscribe(List<String> scopes) {
    unawaited(
      _command('unsubscribe', {
        'scopes': scopes,
      }).catchError((Object _) => null),
    );
  }

  void setActive(bool active) {
    _active = active;
    _health?.cancel();
    _health = null;
    if (active && _ready) checkHealth(fast: true);
  }

  void _scheduleHealth() {
    if (!_active || !_ready || _closed || _health != null) return;
    _health = Timer(healthInterval, () {
      _health = null;
      if (DateTime.now().millisecondsSinceEpoch - _lastReceived >=
          healthInterval.inMilliseconds) {
        checkHealth();
      } else {
        _scheduleHealth();
      }
    });
  }

  void checkHealth({bool fast = false}) {
    if (!_ready || !_active || _closed || _probing) return;
    _probing = true;
    final start = DateTime.now().millisecondsSinceEpoch;
    unawaited(
      call('settings:get', null, fast ? 5000 : healthTimeout.inMilliseconds)
          .then<void>((_) {
            _rtt = DateTime.now().millisecondsSinceEpoch - start;
          })
          .catchError((Object error) {
            if (!_closed) {
              _drop(DisconnectDetail('heartbeat-timeout', reason: '$error'));
            }
          })
          .whenComplete(() {
            _probing = false;
            _scheduleHealth();
          }),
    );
  }

  void close() => _drop(const DisconnectDetail('client-close'));

  void _drop(DisconnectDetail detail, {bool notify = true}) {
    if (_closed) return;
    _closed = true;
    _ready = false;
    _generation++;
    _health?.cancel();
    _health = null;
    final connecting = _connecting;
    _connecting = null;
    if (connecting != null && !connecting.isCompleted) {
      connecting.completeError(
        ConnectionError(
          'unreachable',
          detail.reason ?? t('conn.unreachable'),
          detail,
        ),
      );
    }
    for (final pending in _pending.values) {
      pending.timer?.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(
          TransportError(
            detail.kind == 'client-close' ? 'closed' : 'dropped',
            t('conn.dropped'),
          ),
        );
      }
    }
    _pending.clear();
    _earlyResults.clear();
    _admissionUpdates.clear();
    _shutdown = _updates.cancel().then((_) async {
      if (ownsRuntime) {
        await _core.dispose();
      } else {
        coreResult(await _core.command('disconnect'));
      }
    });
    unawaited(_shutdown!.catchError((Object _) {}));
    // A dial that has not received welcome is still owned by connectDevice().
    // Let its caller surface the failure before deciding whether to reconnect;
    // the disconnect callback would retire that caller's client first.
    if (notify && connecting == null) _disconnect?.call(detail);
  }
}

EventCursor? _cursor(Object? value) {
  if (value is! Map || value['epoch'] is! String || value['seq'] is! int) {
    return null;
  }
  return EventCursor(value['epoch'] as String, value['seq'] as int);
}

EventMeta? _eventMeta(Map<String, Object?> value) {
  final cursor = _cursor(value);
  return cursor != null && value['scope'] is String
      ? EventMeta(value['scope'] as String, cursor.epoch, cursor.seq)
      : null;
}
