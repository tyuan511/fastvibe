import 'dart:async';
import 'dart:io';

/// What [RemoteClient] needs of the thing it talks over: whole text frames in and out, and a
/// close that carries a code. A WebSocket is one ([WebSocketFrameSocket]); a WebRTC data
/// channel is the other (`rtc_connection.dart`), so a connection that reaches the desktop
/// through the account and one that reaches it by address share the handshake, the health
/// checks and the reconnect path instead of each growing its own.
abstract class FrameSocket {
  /// The socket can carry a frame right now.
  bool get isOpen;

  void add(String data);

  /// Frames arrive as a `String` (text) or a `List<int>` (binary).
  StreamSubscription<Object?> listen(
    void Function(Object? data) onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  });

  /// Why it ended, once it has.
  int? get closeCode;
  String? get closeReason;

  void close();
}

class WebSocketFrameSocket implements FrameSocket {
  WebSocketFrameSocket(this._socket);

  final WebSocket _socket;

  @override
  bool get isOpen => _socket.readyState == WebSocket.open;

  @override
  void add(String data) => _socket.add(data);

  @override
  StreamSubscription<Object?> listen(
    void Function(Object? data) onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => _socket.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);

  @override
  int? get closeCode => _socket.closeCode;

  @override
  String? get closeReason => _socket.closeReason;

  @override
  void close() {
    if (_socket.readyState == WebSocket.open || _socket.readyState == WebSocket.connecting) {
      _socket.close();
    }
  }
}
