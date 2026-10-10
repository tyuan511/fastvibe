import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:fastvibe_mobile/protocol/client.dart';
import 'package:fastvibe_mobile/protocol/frame_socket.dart';

/// A relayed connection as [RemoteClient] sees it: it knows when its credential runs out
/// and which path it is on.
class _RelayedSocket implements ExpiringFrameSocket {
  _RelayedSocket({this.expires, this.relay = true});

  final DateTime? expires;
  final bool relay;
  final StreamController<Object?> _in = StreamController<Object?>(sync: true);
  final List<String> sent = <String>[];
  bool _open = true;

  void receive(String frame) => _in.add(frame);

  @override
  DateTime? get credentialExpiresAt => expires;

  @override
  Future<bool> usesRelay() async => relay;

  @override
  bool get isOpen => _open;

  @override
  void add(String data) => sent.add(data);

  @override
  StreamSubscription<Object?> listen(
    void Function(Object? data) onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => _in.stream.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  set onSuspect(void Function()? handler) {}

  @override
  void close() => _open = false;
}

Future<RemoteClient> _connected(FrameSocket socket, void Function(String) feed) async {
  final client = RemoteClient(version: '1.0.0');
  final connecting = client.connectOpened(() async => socket);
  await Future<void>.delayed(Duration.zero);
  feed('{"type":"auth","ok":true}');
  feed('{"kind":"welcome","features":{},"epoch":"e1"}');
  await connecting;
  return client;
}

void main() {
  test('a relayed connection says when its credential runs out and whether it is on the relay', () async {
    final expires = DateTime.now().add(const Duration(minutes: 4)).toUtc();
    final socket = _RelayedSocket(expires: expires);
    final client = await _connected(socket, socket.receive);
    expect(client.credentialExpiresAt, expires);
    expect(await client.usesRelay(), isTrue);
  });

  test('a relayed connection that ICE moved onto a direct path does not depend on the credential', () async {
    final socket = _RelayedSocket(expires: DateTime.now().add(const Duration(minutes: 4)), relay: false);
    final client = await _connected(socket, socket.receive);
    expect(await client.usesRelay(), isFalse);
  });

  test('a connection with no credential has nothing to renew', () async {
    final socket = _RelayedSocket();
    final client = await _connected(socket, socket.receive);
    expect(client.credentialExpiresAt, isNull);
  });

  test('requests sent and not yet answered are counted, so a replaced connection can be left to finish them', () async {
    final socket = _RelayedSocket(expires: DateTime.now().add(const Duration(minutes: 4)));
    final client = await _connected(socket, socket.receive);
    expect(client.pendingCalls, 0);
    final answered = client.call('engine:get-running');
    expect(client.pendingCalls, 1);
    final id = RegExp(r'"requestId":(\d+)').firstMatch(socket.sent.last)!.group(1);
    socket.receive('{"kind":"result","requestId":$id,"ok":true,"result":[]}');
    await answered;
    expect(client.pendingCalls, 0);
  });
}
