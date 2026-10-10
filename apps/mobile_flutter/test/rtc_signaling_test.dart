import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fastvibe_mobile/protocol/client.dart';
import 'package:fastvibe_mobile/protocol/rtc_signaling.dart';
import 'package:flutter_test/flutter_test.dart';

/// The phone's signaling against a stand-in for the cloud's `/api/rtc/signal`: what a call
/// sends, and when the socket of one call carries the next.
void main() {
  late FakeCloud cloud;
  final defaultLinger = signalLinger;
  final defaultReuseTimeout = signalReuseTimeout;

  setUp(() async {
    cloud = await FakeCloud.start();
  });

  tearDown(() async {
    dropKeptSignaling();
    signalLinger = defaultLinger;
    signalReuseTimeout = defaultReuseTimeout;
    await cloud.close();
  });

  Future<SignalingCall> place({
    void Function(Object? data)? onSignal,
    void Function(ConnectionError error)? onEnd,
  }) => SignalingCall.place(
    origin: cloud.origin,
    token: 'fvs_good',
    deviceId: 'dev-1',
    clientName: 'Test phone',
    platform: 'ios',
    onSignal: onSignal ?? (_) {},
    onEnd: onEnd ?? (_) {},
  );

  test('a call says hello and connect together, and is named by the service', () async {
    final call = await place();
    expect(call.cid, 'cid-1');
    expect(cloud.sockets, hasLength(1));
    expect(cloud.received.map((m) => m['type']), <String>['hello', 'connect']);
    expect(cloud.headers.single, 'Bearer fvs_good');
    call.release();
  });

  test('signals reach the desktop under the call\'s id, and its answers come back', () async {
    final got = <Object?>[];
    final call = await place(onSignal: got.add);
    call.signal(<String, Object?>{'type': 'offer', 'sdp': 'v=0'});
    await cloud.until(() => cloud.received.any((m) => m['type'] == 'signal'));
    final sent = cloud.received.firstWhere((m) => m['type'] == 'signal');
    expect(sent['cid'], call.cid);
    expect((sent['data'] as Map)['sdp'], 'v=0');

    cloud.send(<String, Object?>{'type': 'signal', 'cid': call.cid, 'data': <String, Object?>{'type': 'answer', 'sdp': 'a'}});
    cloud.send(<String, Object?>{'type': 'signal', 'cid': 'someone-else', 'data': <String, Object?>{'type': 'answer', 'sdp': 'b'}});
    await cloud.until(() => got.isNotEmpty);
    await pumpEventQueue();
    expect(got, hasLength(1));
    expect((got.single as Map)['sdp'], 'a');
    call.release();
  });

  test('the next call uses the socket of the last one, without a second hello', () async {
    final first = await place();
    first.release();
    await cloud.until(() => cloud.received.any((m) => m['type'] == 'hangup'));

    final second = await place();
    expect(second.cid, 'cid-2');
    expect(cloud.sockets, hasLength(1), reason: 'no new socket was opened');
    expect(cloud.received.where((m) => m['type'] == 'hello'), hasLength(1));
    expect(cloud.received.where((m) => m['type'] == 'connect'), hasLength(2));
    second.release();
  });

  test('what is still said about the last call does not end the next one', () async {
    final first = await place();
    first.release();
    ConnectionError? ended;
    final second = await place(onEnd: (error) => ended = error);
    // The service answering a hangup that crossed the desktop's, and the desktop's own.
    cloud.send(<String, Object?>{'type': 'error', 'code': 'unknown_call', 'cid': first.cid});
    cloud.send(<String, Object?>{'type': 'hangup', 'cid': first.cid});
    await pumpEventQueue();
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(ended, isNull);

    cloud.send(<String, Object?>{'type': 'hangup', 'cid': second.cid});
    await cloud.until(() => ended != null);
    expect(ended!.code, 'closed-early');
  });

  test('a computer that is offline is asked again on the same socket', () async {
    cloud.offline = true;
    await expectLater(place(), throwsA(isA<ConnectionError>().having((e) => e.code, 'code', 'offline')));
    await expectLater(place(), throwsA(isA<ConnectionError>().having((e) => e.code, 'code', 'offline')));
    cloud.offline = false;
    final call = await place();
    expect(cloud.sockets, hasLength(1));
    expect(cloud.received.where((m) => m['type'] == 'hello'), hasLength(1));
    call.release();
  });

  test('a kept socket that has gone quiet is replaced quickly instead of waited on', () async {
    signalReuseTimeout = const Duration(milliseconds: 80);
    final first = await place();
    first.release();
    await cloud.until(() => cloud.received.any((m) => m['type'] == 'hangup'));
    cloud.deaf.add(cloud.sockets.single);

    final started = DateTime.now();
    final second = await place();
    expect(DateTime.now().difference(started), lessThan(const Duration(seconds: 2)));
    expect(cloud.sockets, hasLength(2), reason: 'a fresh socket carried the call');
    expect(cloud.received.where((m) => m['type'] == 'hello'), hasLength(2));
    second.release();
  });

  test('a kept socket the service closed is not used', () async {
    final first = await place();
    first.release();
    await cloud.until(() => cloud.received.any((m) => m['type'] == 'hangup'));
    await cloud.sockets.single.close();
    await Future<void>.delayed(const Duration(milliseconds: 30));

    final second = await place();
    expect(cloud.sockets, hasLength(2));
    second.release();
  });

  test('the socket is not kept for long, nor across a network change', () async {
    signalLinger = const Duration(milliseconds: 40);
    final first = await place();
    first.release();
    await cloud.until(() => cloud.closed == 1);

    signalLinger = const Duration(seconds: 20);
    final second = await place();
    expect(cloud.sockets, hasLength(2));
    second.release();
    dropKeptSignaling();
    await cloud.until(() => cloud.closed == 2);
  });

  test('a refused token is unauthorized, and the socket closing mid-call ends the call', () async {
    cloud.refuse = 401;
    await expectLater(place(), throwsA(isA<ConnectionError>().having((e) => e.code, 'code', 'unauthorized')));
    cloud.refuse = null;

    ConnectionError? ended;
    await place(onEnd: (error) => ended = error);
    await cloud.sockets.last.close();
    await cloud.until(() => ended != null);
    expect(ended!.code, 'closed-early');
  });
}

class FakeCloud {
  FakeCloud._(this._server);

  final HttpServer _server;
  final List<WebSocket> sockets = <WebSocket>[];
  final List<Map<String, Object?>> received = <Map<String, Object?>>[];
  final List<String?> headers = <String?>[];

  /// Sockets whose messages are swallowed: the far end of a dead path.
  final Set<WebSocket> deaf = <WebSocket>{};
  bool offline = false;
  int? refuse;
  int closed = 0;
  int _calls = 0;

  String get origin => 'http://127.0.0.1:${_server.port}';

  static Future<FakeCloud> start() async {
    final cloud = FakeCloud._(await HttpServer.bind(InternetAddress.loopbackIPv4, 0));
    cloud._server.listen((request) async {
      if (cloud.refuse != null) {
        request.response.statusCode = cloud.refuse!;
        await request.response.close();
        return;
      }
      cloud.headers.add(request.headers.value('authorization'));
      final socket = await WebSocketTransformer.upgrade(request);
      cloud.sockets.add(socket);
      socket.listen(
        (Object? raw) {
          if (cloud.deaf.contains(socket)) return;
          final message = (jsonDecode(raw as String) as Map).cast<String, Object?>();
          cloud.received.add(message);
          switch (message['type']) {
            case 'hello':
              socket.add(jsonEncode(<String, Object?>{'type': 'hello', 'role': 'client'}));
            case 'connect':
              if (cloud.offline) {
                socket.add(jsonEncode(<String, Object?>{'type': 'error', 'code': 'device_offline', 'cid': ''}));
              } else {
                cloud._calls += 1;
                socket.add(jsonEncode(<String, Object?>{'type': 'connected', 'cid': 'cid-${cloud._calls}'}));
              }
          }
        },
        onDone: () => cloud.closed += 1,
      );
    });
    return cloud;
  }

  /// Say something on the newest socket.
  void send(Map<String, Object?> message) => sockets.last.add(jsonEncode(message));

  Future<void> until(bool Function() condition) async {
    final deadline = DateTime.now().add(const Duration(seconds: 3));
    while (!condition()) {
      if (DateTime.now().isAfter(deadline)) fail('timed out waiting');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  Future<void> close() async {
    for (final socket in sockets) {
      unawaited(socket.close().then((_) {}, onError: (_) {}));
    }
    await _server.close(force: true);
  }
}
