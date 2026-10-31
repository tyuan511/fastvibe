/// Native fv-protocol client. This speaks the Rust method names and JSON frames directly;
/// it never translates Electron envelopes or moves a desktop's active conversation.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'frame_socket.dart';
import 'native_schema.dart';

class NativeRpcError implements Exception {
  const NativeRpcError(this.code, this.message);
  final int code;
  final String message;
  @override
  String toString() => 'NativeRpcError($code): $message';
}

class NativeClient {
  FrameSocket? _socket;
  StreamSubscription<Object?>? _subscription;
  final Map<int, Completer<Object?>> _pending = <int, Completer<Object?>>{};
  final Map<int, String> _pendingMethods = <int, String>{};
  final StreamController<Map<String, Object?>> _notifications =
      StreamController<Map<String, Object?>>.broadcast(sync: true);
  final StreamController<Map<String, Object?>> _requests =
      StreamController<Map<String, Object?>>.broadcast(sync: true);
  int _nextId = 1;
  int _generation = 0;
  bool _ready = false;
  void Function(Object error)? onDisconnect;
  bool get ready => _ready;
  Stream<Map<String, Object?>> get notifications => _notifications.stream;
  Stream<Map<String, Object?>> get requests => _requests.stream;

  static Future<String> login(Uri origin, String password, String label) async {
    final response = await http
        .post(
          origin.replace(path: '/api/login', query: null, fragment: null),
          headers: <String, String>{'content-type': 'application/json'},
          body: jsonEncode(<String, Object?>{
            'password': password,
            'label': label,
          }),
        )
        .timeout(const Duration(seconds: 20));
    if (response.statusCode != 200) {
      throw NativeRpcError(response.statusCode, 'Login refused');
    }
    final body = jsonDecode(response.body);
    if (body is! Map ||
        body['token'] is! String ||
        (body['token'] as String).isEmpty) {
      throw const FormatException('Login returned no token');
    }
    return body['token'] as String;
  }

  Future<Map<String, Object?>> connect(
    Uri origin,
    String token, {
    String version = '0.0.0',
  }) async {
    final url = origin.replace(
      scheme: origin.scheme == 'https' ? 'wss' : 'ws',
      path: '/ws',
      query: null,
      fragment: null,
    );
    return connectOpened(() async {
      final socket = await WebSocket.connect(
        url.toString(),
        headers: <String, String>{'authorization': 'Bearer $token'},
        maxPayloadLength: 64 * 1024 * 1024,
      ).timeout(const Duration(seconds: 20));
      socket.pingInterval = const Duration(seconds: 15);
      return WebSocketFrameSocket(socket);
    }, version: version);
  }

  Future<Map<String, Object?>> connectOpened(
    Future<FrameSocket> Function() open, {
    String version = '0.0.0',
  }) async {
    await close();
    final generation = ++_generation;
    final socket = await open();
    if (generation != _generation) {
      socket.close();
      throw StateError('Connection replaced');
    }
    _socket = socket;
    _subscription = socket.listen(
      _receive,
      onError: (Object error) => _drop(error),
      onDone: () => _drop(StateError('Connection closed')),
    );
    try {
      final result = await call('initialize', <String, Object?>{
        'clientInfo': <String, Object?>{
          'name': 'fastvibe-flutter',
          'version': version,
        },
        'protocolVersion': 1,
        'capabilities': <String, Object?>{},
      });
      if (generation != _generation ||
          result is! Map ||
          result['protocolVersion'] != 1) {
        throw const FormatException('Unsupported native protocol');
      }
      _ready = true;
      return result.cast<String, Object?>();
    } catch (_) {
      if (generation == _generation) await close();
      rethrow;
    }
  }

  Future<Object?> call(
    String method,
    Map<String, Object?> params, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    if (!NativeProtocolSchema.hasMethod(method)) {
      throw ArgumentError.value(method, 'method', 'Unknown native method');
    }
    NativeProtocolSchema.validateParams(method, params);
    final socket = _socket;
    if (socket == null || !socket.isOpen) {
      throw StateError('Connection closed');
    }
    final id = _nextId++;
    final completer = Completer<Object?>();
    _pending[id] = completer;
    _pendingMethods[id] = method;
    socket.add(
      jsonEncode(<String, Object?>{
        'id': id,
        'method': method,
        'params': params,
      }),
    );
    try {
      return await completer.future.timeout(
        timeout,
        onTimeout: () {
          cancel(id);
          throw TimeoutException('Native request timed out', timeout);
        },
      );
    } finally {
      _pending.remove(id);
      _pendingMethods.remove(id);
    }
  }

  void cancel(int requestId) {
    _socket?.add(
      jsonEncode(<String, Object?>{
        'method': NativeProtocolNotifications.requestCancel,
        'params': <String, Object?>{'requestId': requestId},
      }),
    );
  }

  void respond(Object id, Object? result) {
    _socket?.add(jsonEncode(<String, Object?>{'id': id, 'result': result}));
  }

  void _receive(Object? raw) {
    try {
      if (raw is! String || raw.length > 64 * 1024 * 1024) {
        throw const FormatException('Invalid native frame');
      }
      final value = jsonDecode(raw);
      if (value is! Map<String, Object?>) {
        throw const FormatException('Invalid native frame');
      }
      final id = value['id'];
      if (value['method'] is String) {
        (id == null ? _notifications : _requests).add(value);
      } else if (id is int) {
        final pending = _pending[id];
        if (pending == null || pending.isCompleted) return;
        final error = value['error'];
        if (error is Map &&
            error['code'] is int &&
            error['message'] is String) {
          pending.completeError(
            NativeRpcError(error['code'] as int, error['message'] as String),
          );
        } else {
          final result = value['result'];
          // Validate before completing the caller so malformed native replies cannot enter
          // the app's state machines as plausible but incomplete maps.
          final pendingMethod = _pendingMethods[id];
          if (pendingMethod != null) {
            NativeProtocolSchema.validateResponse(pendingMethod, result);
          }
          pending.complete(result);
        }
        _pending.remove(id);
        _pendingMethods.remove(id);
      }
    } catch (error) {
      _drop(error);
    }
  }

  void _drop(Object error) {
    final wasReady = _ready;
    _ready = false;
    for (final pending in _pending.values) {
      if (!pending.isCompleted) pending.completeError(error);
    }
    _pending.clear();
    _pendingMethods.clear();
    final socket = _socket;
    _socket = null;
    socket?.close();
    if (wasReady) onDisconnect?.call(error);
  }

  Future<void> close() async {
    _generation++;
    _ready = false;
    _drop(StateError('Connection closed'));
    await _subscription?.cancel();
    _subscription = null;
  }

  Future<void> dispose() async {
    await close();
    await _notifications.close();
    await _requests.close();
  }
}

/// One phone-visible native thread. Resume subscribes and snapshots atomically; seq gates
/// events received while the response is in flight. Reconnect calls resume on the new client.
class NativeThread {
  NativeThread(this.client, this.threadId);
  final NativeClient client;
  final String threadId;
  Map<String, Object?>? snapshot;
  int _seq = 0;
  bool _loading = false;
  int _generation = 0;
  Object? _failed;
  final List<Map<String, Object?>> _held = <Map<String, Object?>>[];
  StreamSubscription<Map<String, Object?>>? _subscription;
  final StreamController<Map<String, Object?>> _events =
      StreamController<Map<String, Object?>>.broadcast(sync: true);
  Stream<Map<String, Object?>> get events => _events.stream;

  Future<Map<String, Object?>> resume() async {
    final generation = ++_generation;
    await _subscription?.cancel();
    if (generation != _generation) throw StateError('Resume replaced');
    _failed = null;
    _loading = true;
    _held.clear();
    _subscription = client.notifications.listen((frame) {
      if (generation != _generation || _failed != null) return;
      final params = frame['params'];
      if (params is! Map ||
          params['threadId'] != threadId ||
          params['seq'] is! int) {
        return;
      }
      if (_loading) {
        if (_held.length >= 2048) {
          _held.clear();
          _failed = StateError('Native resume event overflow');
          return;
        }
        _held.add(frame);
      } else {
        _apply(frame);
      }
    });
    try {
      final reply = await client.call('thread/resume', <String, Object?>{
        'threadId': threadId,
      });
      if (generation != _generation) throw StateError('Resume replaced');
      if (_failed != null) throw _failed!;
      if (reply is! Map<String, Object?> || reply['seq'] is! int) {
        throw const FormatException('Invalid native snapshot');
      }
      snapshot = reply;
      _seq = reply['seq'] as int;
      _loading = false;
      // Ordered transport arrival order is authoritative. A gap requires a new snapshot.
      for (final frame in _held) {
        _apply(frame);
      }
      if (_failed != null) throw _failed!;
      return reply;
    } finally {
      if (generation == _generation) {
        _loading = false;
        _held.clear();
      }
    }
  }

  void _apply(Map<String, Object?> frame) {
    final seq = (frame['params'] as Map)['seq'] as int;
    if (seq <= _seq || _failed != null) return;
    if (seq != _seq + 1) {
      _failed = StateError('Native event sequence gap; resume required');
      _events.addError(_failed!);
      return;
    }
    _seq = seq;
    _events.add(frame);
  }

  Future<Object?> send(String text) => client.call(
    'turn/start',
    <String, Object?>{'threadId': threadId, 'text': text},
  );
  Future<Object?> interrupt() =>
      client.call('turn/interrupt', <String, Object?>{'threadId': threadId});
  Future<Object?> readFile(String path, int offset, int length) =>
      client.call('workspace/readFile', <String, Object?>{
        'threadId': threadId,
        'path': path,
        'offset': offset,
        'length': length,
      });
  Future<void> dispose() async {
    _generation++;
    await _subscription?.cancel();
    if (client.ready) {
      await client.call('thread/unsubscribe', <String, Object?>{
        'threadId': threadId,
      });
    }
    await _events.close();
  }
}
