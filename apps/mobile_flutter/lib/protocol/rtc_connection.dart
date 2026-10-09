import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

import '../i18n/core.dart';
import 'client.dart';
import 'frame_socket.dart';
import 'rtc_frames.dart';

/// The one data channel label the desktop expects; anything else it closes.
const String rtcChannelLabel = 'fastvibe';

/// Largest frame accepted from the desktop. A transcript page is the big one.
const int _maxFrameBytes = 24 * 1024 * 1024;

const Duration _signalTimeout = Duration(seconds: 12);
const Duration _channelTimeout = Duration(seconds: 25);
const Duration _httpTimeout = Duration(seconds: 15);

/// Stop handing fragments to the channel above this much queued inside it, and carry on
/// once it drains. A data channel accepts megabytes at once and reports the cost nowhere.
const int _highWaterBytes = 256 * 1024;
const int _lowWaterBytes = 64 * 1024;

/// A signaling message from the cloud (`docs/cloud-service.md`, 信令协议).
typedef _Message = Map<String, Object?>;

/// Reaches a computer on the same FastVibe account over WebRTC.
///
/// The cloud's signaling introduces this phone to the desktop — it only connects two sessions
/// of one account, and the DTLS fingerprints travel over that authenticated channel, so
/// nothing else needs a password. ICE then picks the best path itself: the LAN, a route across
/// NATs, or FastVibe's TURN relay when neither works. The result is a [FrameSocket], so
/// [RemoteClient] runs its ordinary handshake over it.
class RtcDialer {
  RtcDialer({
    required this.origin,
    required this.token,
    required this.deviceId,
    required this.clientName,
    required this.platform,
    http.Client? client,
  }) : _http = client ?? http.Client();

  /// The site, e.g. `https://app.fastvibe.dev`.
  final String origin;

  /// The account's device token. Sent to [origin] and nowhere else.
  final String token;
  final String deviceId;

  /// What this phone is called in the desktop's list of connected phones.
  final String clientName;
  final String platform;
  final http.Client _http;

  /// Open a connection, resolving once the data channel is open.
  Future<RtcFrameSocket> dial() async {
    final attempt = _Attempt(this);
    try {
      return await attempt.run();
    } catch (_) {
      await attempt.dispose();
      rethrow;
    }
  }

  Future<List<Map<String, Object?>>> _iceServers() async {
    try {
      final response = await _http
          .get(
            Uri.parse('$origin/api/rtc/ice'),
            headers: <String, String>{'accept': 'application/json', 'authorization': 'Bearer $token'},
          )
          .timeout(_httpTimeout);
      if (response.statusCode == 401) throw ConnectionError('unauthorized', t('conn.expired'));
      if (response.statusCode != 200) return const <Map<String, Object?>>[];
      final body = jsonDecode(response.body);
      final servers = body is Map ? body['ice_servers'] : null;
      if (servers is! List) return const <Map<String, Object?>>[];
      return <Map<String, Object?>>[
        for (final entry in servers)
          if (entry is Map && entry['urls'] is List)
            <String, Object?>{
              'urls': (entry['urls'] as List).whereType<String>().toList(),
              if (entry['username'] is String) 'username': entry['username'],
              if (entry['credential'] is String) 'credential': entry['credential'],
            },
      ];
    } on ConnectionError {
      rethrow;
    } catch (_) {
      // Without ICE servers the phone can still reach a computer on the same network,
      // which beats failing outright because the list could not be fetched.
      return const <Map<String, Object?>>[];
    }
  }
}

class _Attempt {
  _Attempt(this._dialer);

  final RtcDialer _dialer;
  WebSocket? _signal;
  RTCPeerConnection? _pc;
  RTCDataChannel? _channel;
  String? _cid;
  final Completer<_Message> _connected = Completer<_Message>();
  final Completer<void> _hello = Completer<void>();
  final Completer<RtcFrameSocket> _opened = Completer<RtcFrameSocket>();
  final List<RTCIceCandidate> _early = <RTCIceCandidate>[];
  bool _haveRemote = false;
  bool _disposed = false;
  bool _handedOver = false;

  Future<RtcFrameSocket> run() async {
    final ice = await _dialer._iceServers();
    await _openSignaling();
    _signal!.add(jsonEncode(<String, Object?>{
      'type': 'hello',
      'role': 'client',
      'name': _dialer.clientName,
      'platform': _dialer.platform,
    }));
    await _hello.future.timeout(_signalTimeout, onTimeout: () {
      throw ConnectionError('timeout', t('conn.rtcTimeout'));
    });

    _signal!.add(jsonEncode(<String, Object?>{'type': 'connect', 'device_id': _dialer.deviceId}));
    final connected = await _connected.future.timeout(_signalTimeout, onTimeout: () {
      throw ConnectionError('timeout', t('conn.rtcTimeout'));
    });
    _cid = connected['cid'] as String?;
    if (_cid == null) throw ConnectionError('unreachable', t('conn.rtcFailed'));

    final pc = await createPeerConnection(<String, Object?>{
      'iceServers': ice,
      'sdpSemantics': 'unified-plan',
    });
    _pc = pc;
    pc.onIceCandidate = (candidate) {
      final text = candidate.candidate;
      if (text == null || text.isEmpty) return;
      _sendSignal(<String, Object?>{'type': 'candidate', 'candidate': text, 'mid': candidate.sdpMid ?? '0'});
    };
    pc.onConnectionState = (state) {
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed && !_opened.isCompleted) {
        _opened.completeError(ConnectionError('unreachable', t('conn.rtcFailed')));
      }
    };

    final channel = await pc.createDataChannel(
      rtcChannelLabel,
      RTCDataChannelInit()
        ..ordered = true
        ..binaryType = 'binary',
    );
    _channel = channel;
    channel.onDataChannelState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen && !_opened.isCompleted) {
        _handedOver = true;
        final socket = RtcFrameSocket._(pc, channel);
        _opened.complete(socket);
        // From here signaling plays no part. Releasing the call frees this phone's slot
        // on the service; the desktop ignores a hangup once its channel is up.
        _sendHangup();
        unawaited(_closeSignaling());
      } else if (state == RTCDataChannelState.RTCDataChannelClosed && !_opened.isCompleted) {
        _opened.completeError(ConnectionError('closed-early', t('conn.closedEarly')));
      }
    };

    final offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _sendSignal(<String, Object?>{'type': 'offer', 'sdp': offer.sdp});

    return _opened.future.timeout(_channelTimeout, onTimeout: () {
      throw ConnectionError('timeout', t('conn.rtcTimeout'));
    });
  }

  Future<void> _openSignaling() async {
    final uri = Uri.parse('${_dialer.origin}/api/rtc/signal').replace(
      scheme: _dialer.origin.startsWith('https://') ? 'wss' : 'ws',
    );
    try {
      _signal = await WebSocket.connect(
        uri.toString(),
        headers: <String, Object>{'authorization': 'Bearer ${_dialer.token}'},
      ).timeout(_signalTimeout);
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
    _signal!.listen(
      _onSignal,
      onDone: () {
        if (_handedOver) return;
        final error = ConnectionError('closed-early', t('conn.closedEarly'));
        if (!_hello.isCompleted) _hello.completeError(error);
        if (!_connected.isCompleted) _connected.completeError(error);
        if (!_opened.isCompleted) _opened.completeError(error);
      },
      onError: (Object _) {},
      cancelOnError: false,
    );
  }

  void _onSignal(Object? raw) {
    if (_disposed || raw is! String) return;
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    final message = decoded.cast<String, Object?>();
    switch (message['type']) {
      case 'hello':
        if (!_hello.isCompleted) _hello.complete();
      case 'connected':
        if (!_connected.isCompleted) _connected.complete(message);
      case 'error':
        final error = _signalError(message['code']);
        if (!_hello.isCompleted) _hello.completeError(error);
        if (!_connected.isCompleted) _connected.completeError(error);
        if (!_opened.isCompleted) _opened.completeError(error);
      case 'hangup':
        if (!_handedOver && !_opened.isCompleted) {
          _opened.completeError(ConnectionError('closed-early', t('conn.closedEarly')));
        }
      case 'signal':
        if (message['cid'] == _cid) unawaited(_applySignal(message['data']));
    }
  }

  ConnectionError _signalError(Object? code) {
    switch (code) {
      case 'device_offline':
        return ConnectionError('offline', t('conn.deviceOffline'));
      case 'device_not_found':
        return ConnectionError('gone', t('conn.deviceGone'));
      default:
        return ConnectionError('unreachable', t('conn.rtcFailed'));
    }
  }

  Future<void> _applySignal(Object? data) async {
    final pc = _pc;
    if (pc == null || data is! Map) return;
    try {
      switch (data['type']) {
        case 'answer':
          final sdp = data['sdp'];
          if (sdp is! String) return;
          await pc.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
          _haveRemote = true;
          for (final candidate in _early) {
            await pc.addCandidate(candidate);
          }
          _early.clear();
        case 'candidate':
          final text = data['candidate'];
          if (text is! String || text.isEmpty) return;
          final mid = data['mid'];
          final candidate = RTCIceCandidate(text, mid is String ? mid : '0', 0);
          // Candidates can outrun the answer; they cannot be applied before it.
          if (_haveRemote) {
            await pc.addCandidate(candidate);
          } else {
            _early.add(candidate);
          }
      }
    } catch (_) {
      // A candidate the stack rejects is that candidate's problem only.
    }
  }

  void _sendSignal(Map<String, Object?> data) {
    final cid = _cid;
    final signal = _signal;
    if (cid == null || signal == null || _disposed) return;
    try {
      signal.add(jsonEncode(<String, Object?>{'type': 'signal', 'cid': cid, 'data': data}));
    } catch (_) {
      // The signaling socket closed; the attempt fails on its own.
    }
  }

  void _sendHangup() {
    final cid = _cid;
    final signal = _signal;
    if (cid == null || signal == null) return;
    try {
      signal.add(jsonEncode(<String, Object?>{'type': 'hangup', 'cid': cid}));
    } catch (_) {
      // already closed
    }
  }

  Future<void> _closeSignaling() async {
    final signal = _signal;
    _signal = null;
    try {
      await signal?.close();
    } catch (_) {
      // gone
    }
  }

  /// Tear down what a failed attempt left behind. A connection that was handed over is the
  /// caller's now and is left alone.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    if (!_handedOver) {
      _sendHangup();
      try {
        await _channel?.close();
      } catch (_) {}
      try {
        await _pc?.close();
      } catch (_) {}
    }
    await _closeSignaling();
  }
}

/// A data channel as the [FrameSocket] [RemoteClient] speaks over: whole frames in and out
/// (fragmented per `rtc_frames.dart`), with the keepalive the desktop's heartbeat expects.
class RtcFrameSocket implements FrameSocket {
  RtcFrameSocket._(this._pc, this._channel) {
    _channel.bufferedAmountLowThreshold = _lowWaterBytes;
    _channel.onBufferedAmountLow = (_) => _pump();
    _channel.onMessage = _receive;
    _channel.onDataChannelState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelClosed) _finish(1006, '');
    };
    _pc.onConnectionState = (state) {
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _finish(1006, '');
      }
    };
  }

  final RTCPeerConnection _pc;
  final RTCDataChannel _channel;
  final FrameAssembler _assembler = FrameAssembler(_maxFrameBytes);
  final List<Uint8List> _queue = <Uint8List>[];
  final StreamController<Object?> _frames = StreamController<Object?>(sync: true);
  bool _closed = false;
  bool _pumping = false;
  int? _code;
  String? _reason;

  @override
  bool get isOpen => !_closed && _channel.state == RTCDataChannelState.RTCDataChannelOpen;

  @override
  int? get closeCode => _code;

  @override
  String? get closeReason => _reason;

  @override
  void add(String data) {
    if (_closed) throw StateError('data channel is closed');
    _queue.addAll(splitFrame(utf8.encode(data), binary: false));
    unawaited(_pump());
  }

  @override
  StreamSubscription<Object?> listen(
    void Function(Object? data) onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => _frames.stream.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);

  @override
  void close() {
    if (_closed) return;
    try {
      _channel.send(RTCDataChannelMessage.fromBinary(closeMessage(1000)));
    } catch (_) {}
    _finish(1000, '');
  }

  /// Which kind of path ICE chose: `direct` (LAN or across NATs) or `relay` (through
  /// FastVibe's relay, which counts against the account's monthly allowance). Null until known.
  Future<String?> selectedPath() async {
    try {
      final stats = await _pc.getStats();
      final byId = <String, StatsReport>{for (final report in stats) report.id: report};
      for (final report in stats) {
        if (report.type != 'candidate-pair') continue;
        final values = report.values;
        if (values['nominated'] != true && values['state'] != 'succeeded') continue;
        final kinds = <String?>[
          byId[values['localCandidateId']]?.values['candidateType'] as String?,
          byId[values['remoteCandidateId']]?.values['candidateType'] as String?,
        ];
        if (kinds.every((kind) => kind == null)) continue;
        return kinds.contains('relay') ? 'relay' : 'direct';
      }
    } catch (_) {}
    return null;
  }

  Future<void> _pump() async {
    if (_pumping) return;
    _pumping = true;
    try {
      while (_queue.isNotEmpty && !_closed) {
        final buffered = _channel.bufferedAmount ?? await _channel.getBufferedAmount();
        if (buffered >= _highWaterBytes) break;
        final next = _queue.removeAt(0);
        await _channel.send(RTCDataChannelMessage.fromBinary(next));
      }
    } catch (_) {
      _finish(1006, 'send failed');
    } finally {
      _pumping = false;
    }
  }

  void _receive(RTCDataChannelMessage message) {
    if (_closed) return;
    // Everything is binary, text frames included; a text message is not part of the format.
    if (!message.isBinary) {
      _violation('text message');
      return;
    }
    final Incoming incoming;
    try {
      incoming = _assembler.push(message.binary);
    } on FrameError catch (error) {
      _violation(error.message);
      return;
    }
    switch (incoming) {
      case IncomingFrame(:final data, :final binary):
        _frames.add(binary ? data : utf8.decode(data, allowMalformed: true));
      case IncomingPing():
        // Controls jump the queue: a pong stuck behind a large upload would read as a dead
        // phone to the desktop's heartbeat.
        try {
          _channel.send(RTCDataChannelMessage.fromBinary(controlMessage(fragPong)));
        } catch (_) {}
      case IncomingPong():
        break;
      case IncomingClose(:final code, :final reason):
        _finish(code, reason);
      case IncomingPartial():
        break;
    }
  }

  void _violation(String reason) {
    try {
      _channel.send(RTCDataChannelMessage.fromBinary(closeMessage(1002, reason)));
    } catch (_) {}
    _finish(1002, reason);
  }

  void _finish(int code, String reason) {
    if (_closed) return;
    _closed = true;
    _code = code;
    _reason = reason;
    _queue.clear();
    unawaited(() async {
      try {
        await _channel.close();
      } catch (_) {}
      try {
        await _pc.close();
      } catch (_) {}
    }());
    unawaited(_frames.close());
  }
}
