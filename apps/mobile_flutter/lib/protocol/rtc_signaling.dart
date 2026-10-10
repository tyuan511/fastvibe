import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../i18n/core.dart';
import 'client.dart';
import 'diagnostics.dart';

/// A signaling message from the cloud (`docs/cloud-service.md`, 信令协议).
typedef SignalMessage = Map<String, Object?>;

/// How long the service may take to answer a call placed on a fresh socket.
const Duration signalTimeout = Duration(seconds: 12);

/// How long a kept socket may take to answer before it is taken for dead and replaced.
///
/// A kept socket has already said hello, so a live one answers `connect` in one round
/// trip. One that does not is almost always a socket the network moved out from under,
/// and waiting the full [signalTimeout] on it would make keeping sockets slower than not.
Duration signalReuseTimeout = const Duration(milliseconds: 2500);

/// How long a socket is kept after its call, for the next one to use.
///
/// Opening the socket is a TCP and a TLS handshake and an upgrade — three round trips to
/// the service before the call can even be placed — and a phone that is reconnecting
/// places several in a row: the desktop answers `device_offline` while its own signaling
/// comes back, and each retry paid for a new socket. Shorter than the service's own ping
/// interval, so a kept socket needs no keepalive of its own.
Duration signalLinger = const Duration(seconds: 20);

/// One signaling socket. It outlives a call when it can, and is listened to exactly once:
/// whichever call holds it at the moment receives its messages.
class _Link {
  _Link(this.key, this._socket) {
    _socket.listen(
      (Object? raw) {
        if (raw is! String) return;
        final Object? decoded;
        try {
          decoded = jsonDecode(raw);
        } catch (_) {
          return;
        }
        if (decoded is Map) onMessage?.call(decoded.cast<String, Object?>());
      },
      onDone: () {
        closed = true;
        onDone?.call();
      },
      onError: (Object _) {},
      cancelOnError: false,
    );
  }

  /// The site and the account it was opened for; a socket is only ever reused for both.
  final String key;
  final WebSocket _socket;
  void Function(SignalMessage message)? onMessage;
  void Function()? onDone;
  bool closed = false;
  Timer? linger;

  bool get usable => !closed && _socket.readyState == WebSocket.open;

  void send(SignalMessage message) {
    try {
      _socket.add(jsonEncode(message));
    } catch (_) {
      // Closed under us; whoever holds the link hears of it through onDone.
    }
  }

  void detach() {
    onMessage = null;
    onDone = null;
  }

  void close() {
    detach();
    linger?.cancel();
    linger = null;
    closed = true;
    unawaited(_socket.close().then((_) {}, onError: (_) {}));
  }
}

/// The socket kept from the last call, if any. One is enough: calls are placed one at a time.
_Link? _kept;

_Link? _takeKept(String key) {
  final link = _kept;
  _kept = null;
  if (link == null) return null;
  link.linger?.cancel();
  link.linger = null;
  if (link.key == key && link.usable) return link;
  link.close();
  return null;
}

void _keep(_Link link) {
  _kept?.close();
  link.detach();
  _kept = link;
  link.linger = Timer(signalLinger, () {
    if (identical(_kept, link)) _kept = null;
    link.close();
  });
}

/// Close the kept signaling socket, if there is one.
///
/// For whoever knows it can no longer be trusted: the network changed, or the app is
/// leaving the foreground and its timers are about to stop.
void dropKeptSignaling() {
  final link = _kept;
  _kept = null;
  link?.close();
}

/// Raised inside [SignalingCall.place] when a kept socket turned out to be dead.
class _StaleLink implements Exception {
  const _StaleLink();
}

/// One call on the cloud's signaling: the service has named it ([cid]) and relays the
/// offer, the answer and the candidates between this phone and the desktop.
class SignalingCall {
  SignalingCall._(this._link, this.cid, this._onSignal, this._onEnd);

  final _Link _link;

  /// The id the service gave this call; every signal is addressed with it.
  final String cid;
  final void Function(Object? data) _onSignal;
  final void Function(ConnectionError error) _onEnd;
  bool _released = false;

  /// Place a call to [deviceId], on the socket kept from the last call when there is one.
  ///
  /// Resolves once the service has named the call. [onSignal] then receives what the
  /// desktop sends, and [onEnd] is called at most once if the call ends before [release]:
  /// the desktop hung up, the service refused something, or the socket closed.
  static Future<SignalingCall> place({
    required String origin,
    required String token,
    required String deviceId,
    required String clientName,
    required String platform,
    required void Function(Object? data) onSignal,
    required void Function(ConnectionError error) onEnd,
  }) async {
    final started = DateTime.now().millisecondsSinceEpoch;
    final key = '$origin\n$token';
    final connect = <String, Object?>{'type': 'connect', 'device_id': deviceId};
    var outcome = 'fresh';

    final kept = _takeKept(key);
    if (kept != null) {
      try {
        final cid = await _connect(kept, <SignalMessage>[connect], signalReuseTimeout, onStale: const _StaleLink());
        recordConnectionDiagnostic(Diagnostic.metric('rtc.signal',
            elapsedMs: DateTime.now().millisecondsSinceEpoch - started, outcome: 'reused'));
        return SignalingCall._(kept, cid, onSignal, onEnd).._listen();
      } on _StaleLink {
        kept.close();
        outcome = 'replaced';
      } on ConnectionError catch (error) {
        // The service answered, so the socket is fine: only this call was refused.
        if (error.code == 'offline') {
          _keep(kept);
        } else {
          kept.close();
        }
        rethrow;
      }
    }

    final link = _Link(key, await _open(origin, token));
    try {
      // `hello` and `connect` go out together — the service reads them in order, so
      // waiting for the first answer was a round trip spent on nothing.
      final cid = await _connect(
        link,
        <SignalMessage>[
          <String, Object?>{'type': 'hello', 'role': 'client', 'name': clientName, 'platform': platform},
          connect,
        ],
        signalTimeout,
      );
      recordConnectionDiagnostic(Diagnostic.metric('rtc.signal',
          elapsedMs: DateTime.now().millisecondsSinceEpoch - started, outcome: outcome));
      return SignalingCall._(link, cid, onSignal, onEnd).._listen();
    } on ConnectionError catch (error) {
      // A computer that is offline is asked again in a moment, and the socket that just
      // carried the answer is as good as a socket gets.
      if (error.code == 'offline' && link.usable) {
        _keep(link);
      } else {
        link.close();
      }
      rethrow;
    }
  }

  /// Send [messages] and wait for the service to name the call.
  static Future<String> _connect(
    _Link link,
    List<SignalMessage> messages,
    Duration patience, {
    Exception? onStale,
  }) {
    final named = Completer<String>();
    void fail(Object error) {
      if (!named.isCompleted) named.completeError(error);
    }

    link.onMessage = (message) {
      switch (message['type']) {
        case 'connected':
          final cid = message['cid'];
          if (cid is String && cid.isNotEmpty) {
            if (!named.isCompleted) named.complete(cid);
          } else {
            fail(ConnectionError('unreachable', t('conn.rtcFailed')));
          }
        case 'error':
          // An error about a call is about an earlier one — a `hangup` that crossed the
          // desktop's on the way. What answers `connect` names no call.
          if (_cidOf(message) == null) fail(_signalError(message['code']));
      }
    };
    link.onDone = () => fail(onStale ?? ConnectionError('closed-early', t('conn.closedEarly')));
    messages.forEach(link.send);
    final timer = Timer(patience, () => fail(onStale ?? ConnectionError('timeout', t('conn.rtcTimeout'))));
    return named.future.whenComplete(() {
      timer.cancel();
      link.detach();
    });
  }

  void _listen() {
    _link.onMessage = (message) {
      if (_released) return;
      final about = _cidOf(message);
      switch (message['type']) {
        case 'signal':
          if (about == cid) _onSignal(message['data']);
        case 'hangup':
          // The service has already let the call go; hanging up again would only be
          // answered with an error about a call it no longer knows.
          if (about == cid) _end(ConnectionError('closed-early', t('conn.closedEarly')), hangup: false);
        case 'error':
          if (about == null || about == cid) _end(_signalError(message['code']), hangup: true);
      }
    };
    _link.onDone = () => _end(ConnectionError('closed-early', t('conn.closedEarly')), hangup: false);
  }

  void _end(ConnectionError error, {required bool hangup}) {
    if (_released) return;
    _released = true;
    // A retry is the likely next thing, so an open socket is kept for it.
    if (_link.usable) {
      if (hangup) _link.send(<String, Object?>{'type': 'hangup', 'cid': cid});
      _keep(_link);
    } else {
      _link.close();
    }
    _onEnd(error);
  }

  /// Relay [data] (an offer or a candidate) to the desktop.
  void signal(SignalMessage data) {
    if (_released) return;
    _link.send(<String, Object?>{'type': 'signal', 'cid': cid, 'data': data});
  }

  /// Let go of the call: free its slot on the service and keep the socket for the next.
  ///
  /// Once the data channel is open signaling plays no part; the desktop ignores a hangup
  /// by then. Before that, this is how a call is abandoned.
  void release() {
    if (_released) return;
    _released = true;
    if (!_link.usable) {
      _link.close();
      return;
    }
    _link.send(<String, Object?>{'type': 'hangup', 'cid': cid});
    _keep(_link);
  }

  static String? _cidOf(SignalMessage message) {
    final cid = message['cid'];
    return cid is String && cid.isNotEmpty ? cid : null;
  }

  static ConnectionError _signalError(Object? code) {
    switch (code) {
      case 'device_offline':
        return ConnectionError('offline', t('conn.deviceOffline'));
      case 'device_not_found':
        return ConnectionError('gone', t('conn.deviceGone'));
      default:
        return ConnectionError('unreachable', t('conn.rtcFailed'));
    }
  }

  static Future<WebSocket> _open(String origin, String token) async {
    final uri = Uri.parse('$origin/api/rtc/signal').replace(
      scheme: origin.startsWith('https://') ? 'wss' : 'ws',
    );
    try {
      return await WebSocket.connect(
        uri.toString(),
        headers: <String, Object>{'authorization': 'Bearer $token'},
      ).timeout(signalTimeout);
    } on WebSocketException catch (error) {
      // A refused upgrade carries the status in the message; the token is the usual cause.
      if ('$error'.contains('401') || '$error'.contains('403')) {
        throw ConnectionError('unauthorized', t('conn.expired'));
      }
      throw ConnectionError('unreachable', t('conn.unreachable'));
    } on TimeoutException {
      throw ConnectionError('timeout', t('conn.timeout'));
    } catch (_) {
      throw ConnectionError('unreachable', t('conn.unreachable'));
    }
  }
}
