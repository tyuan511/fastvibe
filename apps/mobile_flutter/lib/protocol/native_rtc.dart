/// Rust native RTC family. This intentionally has no legacy fragmentation negotiation.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

import 'frame_socket.dart';
import 'rtc_signaling.dart';

const nativeRtcProtocol = 'fv-protocol-v1';
const nativeRtcChannel = 'fastvibe-native';
const nativeRtcMaxLine = 24 * 1024 * 1024;

/// Pure decoder shared by the actual channel adapter and golden wire tests.
class NativeRtcDecoder {
  final BytesBuilder _line = BytesBuilder(copy: false);
  List<String> push(Uint8List bytes) {
    if (bytes.isEmpty || bytes.length > 16384) {
      throw const FormatException('Invalid native RTC fragment');
    }
    if (bytes[0] != 0) {
      if (bytes.length != 1 || bytes[0] > 3) {
        throw const FormatException('Invalid native RTC control');
      }
      return <String>[];
    }
    final lines = <String>[];
    var start = 1;
    for (var index = 1; index < bytes.length; index++) {
      if (bytes[index] == 10) {
        _line.add(Uint8List.sublistView(bytes, start, index));
        if (_line.length > nativeRtcMaxLine) {
          throw const FormatException('Native RTC frame exceeds limit');
        }
        lines.add(utf8.decode(_line.takeBytes()));
        start = index + 1;
      }
    }
    _line.add(Uint8List.sublistView(bytes, start));
    if (_line.length > nativeRtcMaxLine) {
      throw const FormatException('Native RTC frame exceeds limit');
    }
    return lines;
  }
}

List<Uint8List> nativeRtcEncode(String text) {
  final data = utf8.encode('$text\n');
  if (data.length > nativeRtcMaxLine) {
    throw const FormatException('Native RTC frame exceeds limit');
  }
  final frames = <Uint8List>[];
  for (var offset = 0; offset < data.length; offset += 16383) {
    final end = (offset + 16383).clamp(0, data.length);
    final frame = Uint8List(end - offset + 1);
    frame.setRange(1, frame.length, data, offset);
    frames.add(frame);
  }
  return frames;
}

class NativeRtcDialer {
  NativeRtcDialer({
    required this.origin,
    required this.token,
    required this.deviceId,
    required this.clientName,
    required this.platform,
  });
  final String origin, token, deviceId, clientName, platform;
  Future<FrameSocket> dial() async {
    final response = await http
        .get(
          Uri.parse('$origin/api/rtc/ice'),
          headers: <String, String>{'authorization': 'Bearer $token'},
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) {
      throw StateError('Native ICE request refused (${response.statusCode})');
    }
    final body = jsonDecode(response.body);
    if (body is! Map || body['ice_servers'] is! List) {
      throw const FormatException('Invalid ICE servers');
    }
    final peer = await createPeerConnection(<String, Object?>{
      'iceServers': body['ice_servers'],
      'sdpSemantics': 'unified-plan',
    });
    SignalingCall? call;
    final outbox = <Map<String, Object?>>[];
    final early = <RTCIceCandidate>[];
    var haveRemote = false;
    var ready = false;
    final opened = Completer<FrameSocket>();
    unawaited(opened.future.then((_) {}, onError: (Object _) {}));
    void send(Map<String, Object?> data) {
      if (call == null) {
        outbox.add(data);
      } else {
        call.signal(data);
      }
    }

    final channel = await peer.createDataChannel(
      nativeRtcChannel,
      RTCDataChannelInit()
        ..ordered = true
        ..protocol = nativeRtcProtocol
        ..binaryType = 'binary',
    );
    final socket = NativeRtcSocket(peer, channel);
    channel.onDataChannelState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen &&
          !opened.isCompleted) {
        ready = true;
        opened.complete(socket);
        call?.release();
      }
      if (state == RTCDataChannelState.RTCDataChannelClosed) {
        socket.close();
        if (!opened.isCompleted) {
          opened.completeError(StateError('Native RTC channel closed'));
        }
      }
    };
    peer.onIceCandidate = (candidate) {
      final text = candidate.candidate;
      if (text != null && text.isNotEmpty) {
        send(<String, Object?>{
          'type': 'candidate',
          'candidate': text,
          'mid': candidate.sdpMid ?? '0',
        });
      }
    };
    peer.onConnectionState = (state) {
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        socket.close();
        if (!opened.isCompleted) {
          opened.completeError(StateError('Native RTC connection failed'));
        }
      }
    };
    Future<void> signal(Map<String, Object?> data) async {
      try {
        if (data['type'] == 'answer') {
          if (data['protocol'] != nativeRtcProtocol || data['sdp'] is! String) {
            throw const FormatException('Wrong native RTC family');
          }
          await peer.setRemoteDescription(
            RTCSessionDescription(data['sdp'] as String, 'answer'),
          );
          haveRemote = true;
          for (final candidate in early) {
            await peer.addCandidate(candidate);
          }
          early.clear();
        } else if (data['type'] == 'candidate' && data['candidate'] is String) {
          final candidate = RTCIceCandidate(
            data['candidate'] as String,
            data['mid'] as String? ?? '0',
            0,
          );
          if (haveRemote) {
            await peer.addCandidate(candidate);
          } else {
            early.add(candidate);
          }
        }
      } catch (error) {
        if (!opened.isCompleted) opened.completeError(error);
      }
    }

    try {
      call = await SignalingCall.place(
        origin: origin,
        token: token,
        deviceId: deviceId,
        clientName: clientName,
        platform: platform,
        onSignal: (data) {
          if (data is Map) unawaited(signal(data.cast<String, Object?>()));
        },
        onEnd: (error) {
          if (!ready && !opened.isCompleted) opened.completeError(error);
        },
      );
      for (final data in outbox) {
        call.signal(data);
      }
      outbox.clear();
      final offer = await peer.createOffer(<String, Object?>{
        'mandatory': <String, Object?>{
          'OfferToReceiveAudio': false,
          'OfferToReceiveVideo': false,
        },
      });
      send(<String, Object?>{
        'type': 'offer',
        'sdp': offer.sdp,
        'protocol': nativeRtcProtocol,
      });
      await peer.setLocalDescription(offer);
      return await opened.future.timeout(const Duration(seconds: 25));
    } catch (_) {
      call?.release();
      socket.close();
      rethrow;
    }
  }
}

class NativeRtcSocket implements FrameSocket {
  NativeRtcSocket(this.peer, this.channel) {
    channel.onMessage = (message) {
      try {
        if (!message.isBinary) {
          throw const FormatException('Native RTC requires binary');
        }
        final bytes = message.binary;
        for (final line in _decoder.push(bytes)) {
          _incoming.add(line);
        }
        if (bytes[0] == 1) {
          unawaited(
            channel.send(
              RTCDataChannelMessage.fromBinary(Uint8List.fromList(<int>[2])),
            ),
          );
        }
        if (bytes[0] == 2) _lastPong = DateTime.now();
        if (bytes[0] == 3) close();
      } catch (error) {
        _incoming.addError(error);
        close();
      }
    };
    _heartbeat = Timer.periodic(const Duration(seconds: 15), (_) {
      if (DateTime.now().difference(_lastPong) > const Duration(seconds: 45)) {
        close();
        return;
      }
      unawaited(
        channel
            .send(
              RTCDataChannelMessage.fromBinary(Uint8List.fromList(<int>[1])),
            )
            .catchError((Object error) {
              close();
            }),
      );
    });
  }
  final RTCPeerConnection peer;
  final RTCDataChannel channel;
  final NativeRtcDecoder _decoder = NativeRtcDecoder();
  final StreamController<Object?> _incoming = StreamController<Object?>();
  Future<void> _sending = Future<void>.value();
  bool _closed = false;
  int _queued = 0;
  Timer? _heartbeat;
  DateTime _lastPong = DateTime.now();
  @override
  bool get isOpen =>
      !_closed && channel.state == RTCDataChannelState.RTCDataChannelOpen;
  @override
  int? get closeCode => _closed ? 1000 : null;
  @override
  String? get closeReason => null;
  @override
  set onSuspect(void Function()? handler) {}
  @override
  void add(String data) {
    if (!isOpen) throw StateError('Native RTC channel closed');
    final frames = nativeRtcEncode(data);
    final bytes = frames.fold<int>(0, (total, frame) => total + frame.length);
    if (_queued + bytes > 32 * 1024 * 1024) {
      close();
      throw StateError('Native RTC queue limit');
    }
    _queued += bytes;
    _sending = _sending
        .then((_) async {
          final deadline = DateTime.now().add(const Duration(seconds: 15));
          for (final frame in frames) {
            while (!_closed && await channel.getBufferedAmount() > 256 * 1024) {
              if (DateTime.now().isAfter(deadline)) {
                throw TimeoutException('Native RTC send stalled');
              }
              await Future<void>.delayed(const Duration(milliseconds: 10));
            }
            if (_closed) return;
            await channel.send(RTCDataChannelMessage.fromBinary(frame));
          }
        })
        .catchError((Object error) {
          _incoming.addError(error);
          close();
        })
        .whenComplete(() => _queued -= bytes);
  }

  @override
  StreamSubscription<Object?> listen(
    void Function(Object?) onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => _incoming.stream.listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );
  @override
  void close() {
    if (_closed) return;
    _closed = true;
    _heartbeat?.cancel();
    unawaited(channel.close());
    unawaited(peer.close());
    unawaited(_incoming.close());
  }
}
