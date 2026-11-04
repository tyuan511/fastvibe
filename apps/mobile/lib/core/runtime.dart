import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';

import 'package:ffi/ffi.dart';

/// The JSON boundary also lets protocol tests exercise races without a network.
abstract interface class CoreRuntime {
  Stream<Map<String, Object?>> get updates;
  Future<Map<String, Object?>> command(
    String action, [
    Map<String, Object?> parameters = const {},
  ]);
  Future<void> dispose();
}

class CoreFailure implements Exception {
  const CoreFailure(this.message, {this.code = 'mobile.core', this.details});
  final String message;
  final String code;
  final Object? details;
  @override
  String toString() => message;
}

Object? coreResult(Map<String, Object?> envelope) {
  if (envelope['ok'] != true) {
    final error = envelope['error'];
    throw CoreFailure(
      error is Map && error['message'] is String
          ? error['message'] as String
          : 'Rust core command failed',
      code: error is Map && error['code'] is String
          ? error['code'] as String
          : 'mobile.core',
      details: error,
    );
  }
  return envelope['result'];
}

/// One long-lived isolate owns the runtime and every Rust allocation. Synchronous
/// account commands can wait for HTTP without blocking Flutter's UI isolate.
/// Owns the native runtime across transport facades. Replacement is serialized
/// behind retirement so an old disconnect cannot reach a new native handle.
class NativeCoreRuntimeOwner {
  NativeCoreRuntimeOwner({NativeCoreRuntime Function()? factory})
    : _factory = factory ?? NativeCoreRuntime.new {
    _current = _factory();
  }

  final NativeCoreRuntime Function() _factory;
  late NativeCoreRuntime _current;
  Future<void> _preparing = Future<void>.value();
  NativeCoreRuntime get current => _current;

  Future<void> prepare(Future<void> retirement) {
    final preparing = _preparing.then((_) async {
      await retirement;
      final previous = _current;
      if (!previous.failed) return;
      await previous.dispose();
      _current = _factory();
    });
    _preparing = preparing.catchError((Object _) {});
    return preparing;
  }
}

class NativeCoreRuntime implements CoreRuntime {
  NativeCoreRuntime({this.libraryPath});
  final String? libraryPath;
  final _updates = StreamController<Map<String, Object?>>.broadcast(sync: true);
  final _pending = <int, Completer<Map<String, Object?>>>{};
  ReceivePort? _receive;
  SendPort? _commands;
  Isolate? _isolate;
  Future<void>? _starting;
  Completer<void>? _stopped;
  int _nextId = 0;
  bool _disposed = false;
  CoreFailure? _failure;

  /// Fatal isolate/startup failures are terminal; network errors are not.
  bool get failed => _failure != null;

  @override
  Stream<Map<String, Object?>> get updates => _updates.stream;

  Future<void> _start() => _starting ??= _spawn();

  Future<void> _spawn() async {
    final receive = ReceivePort();
    _receive = receive;
    final ready = Completer<void>();
    void fail(String message) {
      if (_failure != null) return;
      final failure = _failure = CoreFailure(message);
      _commands = null;
      if (!ready.isCompleted) ready.completeError(failure);
      _failPending(failure);
      if (!(_stopped?.isCompleted ?? true)) _stopped!.complete();
      if (!_disposed && !_updates.isClosed) _updates.addError(failure);
    }

    receive.listen((Object? value) {
      if (value == null || value is List) {
        if (!_disposed) fail('Rust core isolate exited: $value');
        return;
      }
      if (value is! Map) return;
      if (value['sendPort'] case final SendPort port) {
        _commands = port;
        if (!ready.isCompleted) ready.complete();
      } else if (value['fatal'] case final String message) {
        fail(message);
      } else if (value['stopped'] == true) {
        if (!(_stopped?.isCompleted ?? true)) _stopped!.complete();
      } else if (value['id'] case final int id) {
        final pending = _pending.remove(id);
        if (pending == null) return;
        if (value['error'] case final String message) {
          pending.completeError(CoreFailure(message));
        } else {
          pending.complete((value['response'] as Map).cast<String, Object?>());
        }
      } else if (!_disposed && !_updates.isClosed) {
        _updates.add(value.cast<String, Object?>());
      }
    });
    try {
      _isolate = await Isolate.spawn(
        _coreWorker,
        <String, Object?>{
          'reply': receive.sendPort,
          'libraryPath': libraryPath,
        },
        onError: receive.sendPort,
        onExit: receive.sendPort,
      );
      await ready.future.timeout(const Duration(seconds: 15));
    } catch (error) {
      _failure ??= CoreFailure('Rust core startup failed');
      receive.close();
      _isolate?.kill(priority: Isolate.immediate);
      rethrow;
    }
  }

  @override
  Future<Map<String, Object?>> command(
    String action, [
    Map<String, Object?> parameters = const {},
  ]) async {
    if (_disposed) throw const CoreFailure('Rust core is closed');
    if (_failure case final failure?) throw failure;
    await _start();
    if (_disposed) throw const CoreFailure('Rust core is closed');
    if (_failure case final failure?) throw failure;
    final id = ++_nextId;
    final response = Completer<Map<String, Object?>>();
    _pending[id] = response;
    _commands!.send(<String, Object?>{
      'id': id,
      'command': <String, Object?>{...parameters, 'action': action},
    });
    return response.future;
  }

  void _failPending(Object error) {
    for (final pending in _pending.values) {
      if (!pending.isCompleted) pending.completeError(error);
    }
    _pending.clear();
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _failPending(const CoreFailure('Rust core is closed'));
    // If startup is still resolving, wait for its port before asking the owner to
    // release the opaque handle. Never free a Rust allocation from two isolates.
    try {
      await _starting;
    } catch (_) {
      /* Startup already reported its failure. */
    }
    final commands = _commands;
    if (commands != null) {
      _stopped = Completer<void>();
      commands.send(const <String, Object?>{'stop': true});
      try {
        await _stopped!.future.timeout(const Duration(seconds: 30));
      } on TimeoutException {
        _isolate?.kill(priority: Isolate.immediate);
      }
    }
    _failPending(const CoreFailure('Rust core is closed'));
    _receive?.close();
    await _updates.close();
  }
}

typedef _CreateNative = Pointer<Void> Function();
typedef _CreateDart = Pointer<Void> Function();
typedef _DestroyNative = Void Function(Pointer<Void>);
typedef _DestroyDart = void Function(Pointer<Void>);
typedef _CommandNative = Pointer<Utf8> Function(Pointer<Void>, Pointer<Utf8>);
typedef _CommandDart = Pointer<Utf8> Function(Pointer<Void>, Pointer<Utf8>);
typedef _PollNative = Pointer<Utf8> Function(Pointer<Void>);
typedef _PollDart = Pointer<Utf8> Function(Pointer<Void>);
typedef _FreeNative = Void Function(Pointer<Utf8>);
typedef _FreeDart = void Function(Pointer<Utf8>);

void _coreWorker(Map<String, Object?> arguments) {
  final reply = arguments['reply']! as SendPort;
  Pointer<Void>? handle;
  _DestroyDart? destroy;
  Timer? poll;
  final input = ReceivePort();
  try {
    final path =
        arguments['libraryPath'] as String? ??
        Platform.environment['FASTVIBE_MOBILE_CORE_LIBRARY'];
    final library = path != null
        ? DynamicLibrary.open(path)
        : Platform.isIOS
        ? DynamicLibrary.process()
        : DynamicLibrary.open(
            Platform.isMacOS
                ? 'libfastvibe_mobile_core.dylib'
                : 'libfastvibe_mobile_core.so',
          );
    final create = library.lookupFunction<_CreateNative, _CreateDart>(
      'fv_mobile_core_create',
    );
    destroy = library.lookupFunction<_DestroyNative, _DestroyDart>(
      'fv_mobile_core_destroy',
    );
    final execute = library.lookupFunction<_CommandNative, _CommandDart>(
      'fv_mobile_core_command_json',
    );
    final pollEvents = library.lookupFunction<_PollNative, _PollDart>(
      'fv_mobile_core_poll_json',
    );
    final release = library.lookupFunction<_FreeNative, _FreeDart>(
      'fv_mobile_core_free_string',
    );
    handle = create();
    if (handle == nullptr) {
      throw StateError('Rust core runtime creation failed');
    }
    final runtime = handle;
    Map<String, Object?> run(Map<String, Object?> command) {
      final request = jsonEncode(command).toNativeUtf8();
      Pointer<Utf8>? result;
      try {
        result = execute(runtime, request);
        if (result == nullptr) {
          throw StateError('Rust core returned no response');
        }
        return (jsonDecode(result.toDartString()) as Map)
            .cast<String, Object?>();
      } finally {
        malloc.free(request);
        if (result != null && result != nullptr) release(result);
      }
    }

    String? previousState;
    Map<String, Object?> state = {};
    void captureState(Object? rawState) {
      if (rawState is! Map) return;
      state = {
        for (final key in [
          'connectionGeneration',
          'connection',
          'error',
          'features',
          'sessionId',
          'endpointId',
          'deviceId',
          'wireCursors',
        ])
          key: rawState[key],
      };
    }

    void tick() {
      Pointer<Utf8>? raw;
      try {
        // This ABI only serializes events/overflow, unlike command("poll"),
        // which would build and serialize the complete transcript every 50 ms.
        raw = pollEvents(runtime);
        if (raw == nullptr) {
          throw StateError('Rust core poll returned no response');
        }
        final result = (jsonDecode(raw.toDartString()) as Map)
            .cast<String, Object?>();
        final generation = result['generation'];
        if (generation != null && generation != state['connectionGeneration']) {
          return;
        }
        final events = result['events'] as List? ?? const [];
        for (final event in events.whereType<Map>()) {
          final kind = event['kind'] ?? event['type'];
          if (kind == 'connection') state['connection'] = event['status'];
          if (kind == 'welcome') {
            state['connection'] = 'ready';
            state['features'] = event['features'];
            state['sessionId'] = event['sessionId'];
            state['error'] = null;
          }
          if (kind == 'connection_error' || kind == 'remote_close') {
            state['connection'] = 'error';
            state['error'] = event['message'] ?? event['reason'];
          }
        }
        final stamp = jsonEncode(state);
        if (stamp != previousState ||
            events.isNotEmpty ||
            result['overflowed'] == true) {
          previousState = stamp;
          reply.send(<String, Object?>{
            'generation': generation,
            'state': state,
            'events': events,
            'overflowed': result['overflowed'] == true,
          });
        }
      } catch (error) {
        poll?.cancel();
        input.close();
        destroy!(runtime);
        handle = null;
        reply.send(<String, Object?>{'fatal': '$error'});
      } finally {
        if (raw != null && raw != nullptr) release(raw);
      }
    }

    input.listen((Object? value) {
      if (value is! Map) return;
      if (value['stop'] == true) {
        poll?.cancel();
        try {
          run(const {'action': 'disconnect'});
        } catch (_) {
          /* Destroy still releases the runtime. */
        }
        destroy!(runtime);
        handle = null;
        input.close();
        reply.send(const {'stopped': true});
        return;
      }
      try {
        final response = run((value['command'] as Map).cast<String, Object?>());
        captureState(response['state']);
        reply.send(<String, Object?>{'id': value['id'], 'response': response});
      } catch (error) {
        reply.send(<String, Object?>{'id': value['id'], 'error': '$error'});
      }
      tick();
    });
    reply.send(<String, Object?>{'sendPort': input.sendPort});
    poll = Timer.periodic(const Duration(milliseconds: 50), (_) => tick());
  } catch (error) {
    if (handle != null && handle != nullptr) destroy?.call(handle!);
    poll?.cancel();
    input.close();
    reply.send(<String, Object?>{'fatal': '$error'});
  }
}
