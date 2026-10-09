import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../i18n/core.dart';
import 'address.dart';
import 'diagnostics.dart';
import 'frame_socket.dart';

const Duration connectTimeout = Duration(seconds: 20);
const Duration healthInterval = Duration(seconds: 15);
const Duration healthTimeout = Duration(seconds: 15);

/// A request whose outcome is unknown: it may or may not have reached Main.
///
/// Callers branch on [code], never on the message — the message is translated, and the
/// send path must treat a lost acknowledgement as "maybe sent" in every language.
class TransportError extends Error {
  TransportError(this.code, this.message);

  final String code; // timeout | dropped | closed
  final String message;

  @override
  String toString() => 'TransportError($code): $message';
}

class ConnectionError extends Error {
  ConnectionError(this.code, this.message, [this.detail]);

  /// timeout | unreachable | unauthorized | closed-early
  final String code;
  final String message;
  final DisconnectDetail? detail;

  @override
  String toString() => 'ConnectionError($code): $message';
}

/// The reason a live connection ended. `code` 4001 means the device token is gone.
class DisconnectDetail {
  const DisconnectDetail(this.kind, {this.code, this.reason});

  /// socket-close | socket-error | heartbeat-timeout | send-failed | client-close | resync
  final String kind;
  final int? code;
  final String? reason;
}

class EventCursor {
  const EventCursor(this.epoch, this.seq);

  final String epoch;
  final int seq;

  Map<String, Object?> toJson() => <String, Object?>{'epoch': epoch, 'seq': seq};
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

typedef PushHandler = void Function(String channel, Object? payload, EventMeta? meta);
typedef DisconnectHandler = void Function(DisconnectDetail detail);

class _Pending {
  _Pending(this.completer, this.timer, this.started, this.metric);

  final Completer<Object?> completer;
  final Timer? timer;
  final int started;
  final String metric;
}

class _PendingSubscription {
  _PendingSubscription(this.requestId, this.completer, this.timer, this.resumed);

  final int requestId;
  final Completer<SubscriptionResult> completer;
  Timer timer;
  bool resumed;
}

/// One remote FastVibe: password once, then a device token on the socket.
///
/// The first frame is the legacy `{ type: "auth" }` the server still requires.
/// Everything after that is App Protocol v1, the same envelope the web client uses.
class RemoteClient {
  RemoteClient({String version = '0.0.0'}) : _version = version; // ignore: prefer_initializing_formals

  final String _version;
  FrameSocket? _ws;
  int _generation = 0;
  int _nextId = 1;
  final Map<int, _Pending> _pending = <int, _Pending>{};
  final Map<String, _PendingSubscription> _subscriptions = <String, _PendingSubscription>{};
  PushHandler? _push;
  DisconnectHandler? _disconnect;
  bool _ready = false;
  bool _active = false;
  int _lastReceived = 0;
  Timer? _healthTimer;
  Timer? _probeTimer;
  bool _probeFast = false;
  int _probeStarted = 0;
  void Function()? _probeExpire;
  Completer<void>? _connectCompleter;
  int? _rtt;
  String _epoch = '';
  Map<String, Object?> _features = <String, Object?>{};

  bool get supportsPromptSubmit => _features['promptSubmit'] == true;

  bool get supportsConversationResume => _features['conversationResume'] == true;

  bool get supportsHistoryPaging => _features['historyPaging'] == true;

  String get epoch => _epoch;

  bool get ready => _ready;

  int? get rttMs => _rtt;

  /// Only a foreground client probes. Timers frozen in the background cannot condemn
  /// it on return.
  void setActive(bool active) {
    _active = active;
    _clearHealthTimers();
    if (active && _ready) checkHealth(fast: true);
  }

  /// Single-flight, read-only protocol ping. Also used after a request timeout or
  /// network change.
  void checkHealth({bool fast = false}) {
    if (!_active || !_ready) return;
    final deadline = fast
        ? _min(healthTimeout.inMilliseconds, _max(4000, (_rtt ?? 500) * 6 + 1000))
        : healthTimeout.inMilliseconds;
    if (_probeTimer != null) {
      if (fast && !_probeFast && _probeExpire != null) {
        _probeTimer!.cancel();
        _probeFast = true;
        final remaining = _max(1, deadline - (DateTime.now().millisecondsSinceEpoch - _probeStarted));
        _probeTimer = Timer(Duration(milliseconds: remaining), _probeExpire!);
      }
      return;
    }
    _healthTimer?.cancel();
    _healthTimer = null;
    final generation = _generation;
    final started = DateTime.now().millisecondsSinceEpoch;
    _probeStarted = started;
    _probeFast = fast;
    var received = _lastReceived;
    void expire() {
      _probeTimer = null;
      if (generation != _generation || !_active) return;
      // Large replies can queue a pong. If useful frames are still arriving, let
      // them finish, but bound this allowance: inbound data alone cannot prove
      // the uplink still works after a timed-out command.
      final now = DateTime.now().millisecondsSinceEpoch;
      if (_lastReceived > received && now - started < healthTimeout.inMilliseconds * 3) {
        received = _lastReceived;
        _probeTimer = Timer(healthTimeout, expire);
      } else {
        _drop(notify: true, detail: const DisconnectDetail('heartbeat-timeout'));
      }
    }

    _probeExpire = expire;
    _probeTimer = Timer(Duration(milliseconds: deadline), expire);
    _send(<String, Object?>{'kind': 'ping'});
  }

  void _scheduleHealth() {
    if (!_active || !_ready || _healthTimer != null || _probeTimer != null) return;
    _healthTimer = Timer(healthInterval, () {
      _healthTimer = null;
      if (DateTime.now().millisecondsSinceEpoch - _lastReceived < healthInterval.inMilliseconds) {
        _scheduleHealth();
      } else {
        checkHealth();
      }
    });
  }

  void _clearHealthTimers() {
    _healthTimer?.cancel();
    _probeTimer?.cancel();
    _healthTimer = null;
    _probeTimer = null;
    _probeExpire = null;
  }

  void onPush(PushHandler? handler) => _push = handler;

  void onDisconnect(DisconnectHandler? handler) => _disconnect = handler;

  /// Exchanges the password for a device token. `POST /api/login`.
  Future<String> login(String origin, String password, String label) async {
    http.Response response;
    try {
      response = await http
          .post(
            Uri.parse('$origin/api/login'),
            headers: const <String, String>{'content-type': 'application/json'},
            body: jsonEncode(<String, Object?>{'password': password, 'label': label}),
          )
          .timeout(connectTimeout);
    } on TimeoutException {
      throw ConnectionError('timeout', t('conn.timeout'));
    } catch (_) {
      throw Error.throwWithStackTrace(
        StateError(_unreachable(origin)),
        StackTrace.current,
      );
    }
    Map<String, Object?> body = <String, Object?>{};
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, Object?>) body = decoded;
    } catch (_) {
      // A non-JSON body is answered by the status code below.
    }
    final token = body['token'];
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        token is! String ||
        token.isEmpty) {
      final message = body['error'];
      throw StateError(
        message is String && message.isNotEmpty
            ? message
            : response.statusCode == 401
                ? t('conn.wrongPassword')
                : t('conn.loginFailed'),
      );
    }
    return token;
  }

  /// Opens the socket and completes the handshake: `auth`, then `hello` → `welcome`.
  Future<void> connect(ServerAddress address, String token) => _connectWith(
    () async => WebSocketFrameSocket(await WebSocket.connect(address.wsUrl)),
    unreachable: _unreachable(address.origin),
    token: token,
  );

  /// The same handshake over a socket the caller opened — the official connection, whose
  /// data channel was authenticated by the account before it ever carried a frame. No token is
  /// sent; the desktop answers `auth` on its own once it has attached the channel.
  Future<void> connectOpened(Future<FrameSocket> Function() open) =>
      _connectWith(open, unreachable: t('conn.unreachable'));

  Future<void> _connectWith(
    Future<FrameSocket> Function() open, {
    required String unreachable,
    String? token,
  }) {
    _drop(notify: false);
    _features = <String, Object?>{};
    _epoch = '';
    final started = DateTime.now().millisecondsSinceEpoch;
    var phaseStarted = started;
    final generation = _generation;
    final completer = Completer<void>();
    _connectCompleter = completer;
    var authed = false;
    var settled = false;

    bool stale() => generation != _generation;

    void fail(Object error) {
      if (settled || stale()) return;
      settled = true;
      _connectTimer?.cancel();
      _connectTimer = null;
      _connectCompleter = null;
      _drop(notify: false);
      if (!completer.isCompleted) completer.completeError(error);
    }

    _connectTimer = Timer(connectTimeout, () {
      fail(ConnectionError('timeout', t('conn.timeout')));
    });

    open().then((socket) {
      if (stale()) {
        socket.close();
        return;
      }
      _ws = socket;
      recordConnectionDiagnostic(Diagnostic.metric('socket', elapsedMs: DateTime.now().millisecondsSinceEpoch - started));
      phaseStarted = DateTime.now().millisecondsSinceEpoch;
      try {
        if (token != null) socket.add(jsonEncode(<String, Object?>{'type': 'auth', 'token': token}));
        // Frames on this socket are ordered. The host authenticates before it
        // handles hello; pipeline both without an extra WAN round trip.
        socket.add(jsonEncode(<String, Object?>{
          'kind': 'hello',
          'hello': <String, Object?>{
            'protocol': 'fastvibe.app',
            'protocolVersion': 1,
            'client': <String, Object?>{'kind': 'mobile', 'version': _version},
            'features': <String, Object?>{'eventBatch': true, 'conversationResume': true},
          },
        }));
      } catch (_) {
        fail(ConnectionError('unreachable', unreachable));
      }

      socket.listen(
        (data) {
          if (stale()) return;
          final message = _parseFrame(data);
          if (message == null) return;
          _lastReceived = DateTime.now().millisecondsSinceEpoch;
          if (!authed) {
            if (message['type'] != 'auth') return;
            if (message['ok'] != true) {
              fail(ConnectionError('unauthorized', t('conn.expired')));
              return;
            }
            authed = true;
            recordConnectionDiagnostic(
              Diagnostic.metric('auth', elapsedMs: DateTime.now().millisecondsSinceEpoch - phaseStarted),
            );
            return;
          }
          if (!settled) {
            if (message['kind'] == 'welcome') {
              final features = message['features'];
              _features = features is Map<String, Object?> ? features : <String, Object?>{};
              final epoch = message['epoch'];
              _epoch = epoch is String ? epoch : '';
              recordConnectionDiagnostic(
                Diagnostic.metric('welcome', elapsedMs: DateTime.now().millisecondsSinceEpoch - phaseStarted),
              );
              settled = true;
              _connectTimer?.cancel();
              _connectTimer = null;
              _connectCompleter = null;
              _ready = true;
              _scheduleHealth();
              if (!completer.isCompleted) completer.complete();
            }
            return;
          }
          _handleReadyFrame(message);
        },
        onError: (Object _) {
          if (stale()) return;
          if (!settled) {
            fail(ConnectionError('unreachable', unreachable));
          } else {
            _drop(notify: true, detail: const DisconnectDetail('socket-error'));
          }
        },
        onDone: () {
          if (stale()) return;
          final code = _ws?.closeCode;
          final reason = _ws?.closeReason;
          if (!settled) {
            fail(ConnectionError(
              'closed-early',
              t('conn.closedEarly'),
              DisconnectDetail('socket-close', code: code, reason: reason),
            ));
          } else {
            _drop(
              notify: true,
              detail: DisconnectDetail('socket-close', code: code, reason: reason),
            );
          }
        },
        cancelOnError: false,
      );
    }).catchError((Object _) {
      fail(ConnectionError('unreachable', unreachable));
    });

    return completer.future;
  }

  Timer? _connectTimer;

  void _handleReadyFrame(Map<String, Object?> message) {
    if (message['kind'] == 'pong') {
      if (_probeTimer != null) {
        final elapsedMs = DateTime.now().millisecondsSinceEpoch - _probeStarted;
        _rtt = _rtt == null ? elapsedMs : (_rtt! * 0.75 + elapsedMs * 0.25).round();
        recordConnectionDiagnostic(Diagnostic.metric('rtt', elapsedMs: elapsedMs));
      }
      _probeTimer?.cancel();
      _probeTimer = null;
      _scheduleHealth();
      return;
    }
    if (message['kind'] == 'resync') {
      final scope = message['scope'];
      final pending = scope is String ? _subscriptions[scope] : null;
      if (pending != null) {
        pending.resumed = false;
        return;
      }
      _drop(notify: true, detail: const DisconnectDetail('resync'));
      return;
    }
    if (message['kind'] == 'subscribed') {
      final cursors = message['cursors'];
      if (cursors is Map) {
        for (final entry in cursors.entries) {
          final scope = entry.key;
          if (scope is! String) continue;
          final pending = _subscriptions[scope];
          if (pending == null || pending.requestId != message['requestId']) continue;
          final cursor = _cursor(entry.value);
          if (cursor == null) continue;
          pending.timer.cancel();
          _subscriptions.remove(scope);
          if (!pending.completer.isCompleted) {
            pending.completer.complete(SubscriptionResult(resumed: pending.resumed, cursor: cursor));
          }
        }
      }
      return;
    }
    if (message['kind'] == 'result') {
      final requestId = message['requestId'];
      if (requestId is! int) return;
      final pending = _pending[requestId];
      if (pending == null) return;
      pending.timer?.cancel();
      _pending.remove(requestId);
      recordConnectionDiagnostic(Diagnostic.metric(
        pending.metric,
        elapsedMs: DateTime.now().millisecondsSinceEpoch - pending.started,
        outcome: message['ok'] == true ? 'ok' : 'error',
      ));
      if (message['ok'] == true) {
        if (!pending.completer.isCompleted) pending.completer.complete(message['result']);
      } else {
        final error = message['error'];
        final text = error is Map && error['message'] is String ? error['message'] as String : t('conn.requestFailed');
        if (!pending.completer.isCompleted) pending.completer.completeError(StateError(text));
      }
      return;
    }
    if (message['kind'] == 'event') {
      final channel = message['channel'];
      if (channel is! String) return;
      _push?.call(channel, message['payload'], _eventMeta(message));
      return;
    }
    if (message['kind'] == 'events') {
      final events = message['events'];
      if (events is! List) return;
      for (final event in events) {
        if (event is! Map) continue;
        final map = event.cast<String, Object?>();
        final channel = map['channel'];
        if (channel is! String) continue;
        _push?.call(channel, map['payload'], _eventMeta(map));
      }
    }
  }

  /// Ordinary calls have a 30s deadline. A continuation answers only when its run
  /// settles, so it has no default deadline; socket closure and health probes still
  /// reject it. An explicit `timeoutMs` overrides the method's default budget.
  Future<Object?> call(String method, [Object? payload, int? timeoutMs]) {
    final ws = _ws;
    if (ws == null || !ws.isOpen) {
      return Future<Object?>.error(StateError(t('conn.notConnected')));
    }
    final requestId = _nextId++;
    final started = DateTime.now().millisecondsSinceEpoch;
    final metric = method == 'engine:get-snapshot'
        ? 'snapshot'
        : method == 'engine:get-messages-page'
            ? 'history'
            : const <String>['engine:submit-prompt', 'engine:prompt', 'engine:queue-add'].contains(method)
                ? 'submission'
                : 'rpc';
    final completer = Completer<Object?>();
    final budget = timeoutMs ?? (method == 'engine:continue' ? null : 30000);
    final timer = budget == null ? null : Timer(Duration(milliseconds: budget), () {
      _pending.remove(requestId);
      recordConnectionDiagnostic(Diagnostic.metric(metric,
          elapsedMs: DateTime.now().millisecondsSinceEpoch - started, outcome: 'timeout'));
      _send(<String, Object?>{'kind': 'cancel', 'targetRequestId': requestId});
      if (!completer.isCompleted) {
        completer.completeError(TransportError('timeout', t('conn.requestTimeout')));
      }
      // Do not replay a call Main may have accepted. Probe the connection instead.
      checkHealth();
    });
    _pending[requestId] = _Pending(completer, timer, started, metric);
    try {
      ws.add(jsonEncode(<String, Object?>{'kind': 'call', 'requestId': requestId, 'method': method, 'payload': payload}));
    } catch (_) {
      timer?.cancel();
      _pending.remove(requestId);
      // The socket can close between the readyState check and add(). The request may
      // already have crossed the wire, so callers must treat this as an unknown
      // outcome rather than a safe refusal.
      if (!completer.isCompleted) {
        completer.completeError(TransportError('dropped', t('conn.dropped')));
      }
      _drop(notify: true, detail: const DisconnectDetail('send-failed'));
    }
    return completer.future;
  }

  void subscribe(List<String> scopes) {
    _send(<String, Object?>{'kind': 'subscribe', 'scopes': scopes});
  }

  /// A subscription acknowledgement is an ordering fence after all replay frames.
  Future<SubscriptionResult> subscribeConversation(String scope, [EventCursor? cursor]) {
    if (!_ready || !(_ws?.isOpen ?? false)) {
      return Future<SubscriptionResult>.error(TransportError('closed', t('conn.closed')));
    }
    if (!supportsConversationResume) {
      subscribe(<String>[scope]);
      return Future<SubscriptionResult>.value(const SubscriptionResult(resumed: false));
    }
    if (_subscriptions.containsKey(scope)) {
      return Future<SubscriptionResult>.error(StateError(t('conn.requestFailed')));
    }
    final requestId = _nextId++;
    final completer = Completer<SubscriptionResult>();
    final timer = Timer(const Duration(seconds: 30), () {
      _subscriptions.remove(scope);
      if (!completer.isCompleted) {
        completer.completeError(TransportError('timeout', t('conn.requestTimeout')));
      }
      checkHealth(fast: true);
    });
    _subscriptions[scope] = _PendingSubscription(
      requestId,
      completer,
      timer,
      cursor != null && cursor.epoch == _epoch,
    );
    _send(<String, Object?>{
      'kind': 'subscribe',
      'requestId': requestId,
      'scopes': <String>[scope],
      if (cursor != null) 'since': <String, Object?>{scope: cursor.toJson()},
    });
    return completer.future;
  }

  void unsubscribe(List<String> scopes) {
    for (final scope in scopes) {
      final pending = _subscriptions.remove(scope);
      if (pending == null) continue;
      pending.timer.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(TransportError('closed', t('conn.closed')));
      }
    }
    _send(<String, Object?>{'kind': 'unsubscribe', 'scopes': scopes});
  }

  void close() => _drop(notify: true);

  void _send(Object? frame) {
    final ws = _ws;
    if (ws == null || !ws.isOpen) return;
    try {
      ws.add(jsonEncode(frame));
    } catch (_) {
      _drop(notify: true, detail: const DisconnectDetail('send-failed'));
    }
  }

  void _drop({required bool notify, DisconnectDetail detail = const DisconnectDetail('client-close')}) {
    _generation += 1;
    _ready = false;
    _clearHealthTimers();
    _connectTimer?.cancel();
    _connectTimer = null;
    final connect = _connectCompleter;
    _connectCompleter = null;
    if (connect != null && !connect.isCompleted) {
      connect.completeError(TransportError('closed', t('conn.closed')));
    }
    _failPending(detail.kind == 'client-close' ? 'closed' : 'dropped');
    final ws = _ws;
    _ws = null;
    if (ws != null) {
      try {
        ws.close();
      } catch (_) {
        // A failed native socket may already have been disposed.
      }
      if (notify) _disconnect?.call(detail);
    }
  }

  void _failPending(String code) {
    final message = t(code == 'dropped' ? 'conn.dropped' : 'conn.closed');
    for (final pending in _pending.values) {
      pending.timer?.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(TransportError(code, message));
      }
    }
    _pending.clear();
    for (final pending in _subscriptions.values) {
      pending.timer.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(TransportError(code, message));
      }
    }
    _subscriptions.clear();
  }
}

EventCursor? _cursor(Object? value) {
  if (value is! Map) return null;
  final epoch = value['epoch'];
  final seq = value['seq'];
  if (epoch is! String || epoch.isEmpty) return null;
  if (seq is! int || seq < 0) return null;
  return EventCursor(epoch, seq);
}

EventMeta? _eventMeta(Map<String, Object?> value) {
  final scope = value['scope'];
  final cursor = _cursor(value);
  if (scope is! String || cursor == null) return null;
  return EventMeta(scope, cursor.epoch, cursor.seq);
}

Map<String, Object?>? _parseFrame(Object? data) {
  try {
    final text = data is String ? data : utf8.decode((data as List<int>), allowMalformed: true);
    final parsed = jsonDecode(text);
    if (parsed is! Map) return null;
    return parsed.cast<String, Object?>();
  } catch (_) {
    return null;
  }
}

String _unreachable(String origin) =>
    origin.startsWith('http://') ? t('conn.unreachableLan') : t('conn.unreachable');

int _min(int a, int b) => a < b ? a : b;

int _max(int a, int b) => a > b ? a : b;
