import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate;
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

import '../i18n/core.dart';
import 'client.dart';
import 'diagnostics.dart';
import 'frame_socket.dart';
import 'rtc_frames.dart';
import 'rtc_signaling.dart';

/// The one data channel label the desktop expects; anything else it closes.
const String rtcChannelLabel = 'fastvibe';

/// Largest frame accepted from the desktop. A transcript page is the big one.
const int _maxFrameBytes = 24 * 1024 * 1024;

const Duration _channelTimeout = Duration(seconds: 25);
const Duration _httpTimeout = Duration(seconds: 15);

/// How many candidates one call sends the desktop, and how many of them may be relays.
///
/// The desktop's ICE library keeps at most ten remote candidates per call and, once full,
/// drops the rest — including the phone's own address learned from its connectivity checks,
/// so the call never connects while the STUN requests are plainly arriving. An Android phone
/// gathers far more than that: every interface, IPv6 temporaries, a TCP twin of each host
/// address, and one relay per TURN URL.
///
/// Host addresses have a share of their own, because they are found first: nothing has to
/// be asked for them, while the public address and the relay each wait on a round trip. A
/// phone with enough interfaces filled the whole budget before either arrived, and then the
/// relay — the one address a desktop on another network has to be told about, since its
/// router lets nothing in from an address it has not sent to — was never sent at all.
///
/// Within the hosts, neither address family may take every place. They arrive in whatever
/// order the system lists its interfaces, and a phone on Wi-Fi and mobile data at once has
/// enough IPv4 ones to fill the share — after which its public IPv6 address, the one that
/// needs no hole punched in any NAT, was never sent.
const int _maxCandidates = 8;
const int _maxHostCandidates = 4;
const int _maxHostsPerFamily = 3;
const int _maxRelayCandidates = 2;

/// The most guessed ports one message from the desktop may add (`candidates`, below).
const int _maxPredictedCandidates = 32;

/// How long a dial waits to learn any address beyond the phone's own before it concludes
/// that this network carries no UDP to the internet, and starts again through the relay
/// over TCP. A public address is one round trip to the STUN server; a computer on the same
/// network is connected long before this.
const Duration _udpProbe = Duration(seconds: 4);

/// Keeps the STUN addresses and a single TURN one — UDP when there is one, which is the only
/// kind the desktop can use at its end. Every TURN address is a relay allocation, and the
/// service allows an account only a few.
List<String> oneRelayPerServer(List<String> urls) {
  bool isTurn(String url) => url.startsWith('turn:') || url.startsWith('turns:');
  bool isUdp(String url) => url.startsWith('turn:') && !url.toLowerCase().contains('transport=tcp');
  final turn = urls.where(isTurn).toList();
  final chosen = turn.isEmpty ? null : turn.firstWhere(isUdp, orElse: () => turn.first);
  return <String>[...urls.where((url) => !isTurn(url)), ?chosen];
}

/// The same list for a network that carries no UDP: the relay reached over TLS on 443 when
/// the service offers that, which is the one port such a network is sure to let out, and
/// over plain TCP otherwise. STUN is left out — it is UDP, and it is what did not answer.
/// Null when the list has no relay to reach that way.
List<String>? relayOverTcp(List<String> urls) {
  bool tls(String url) => url.startsWith('turns:');
  bool tcp(String url) => url.startsWith('turn:') && url.toLowerCase().contains('transport=tcp');
  final secure = urls.where(tls).toList();
  if (secure.isNotEmpty) {
    return <String>[secure.firstWhere((url) => RegExp(r':443(\?|$)').hasMatch(url), orElse: () => secure.first)];
  }
  final plain = urls.where(tcp).toList();
  return plain.isEmpty ? null : <String>[plain.first];
}

/// Whether a candidate line is worth sending the desktop. Only UDP can pair with it (it does
/// not do ICE-TCP), and a link-local address is not reachable from another machine. Nor is
/// a unique-local IPv6 one from anywhere but its own network, where the IPv4 address
/// already serves — and each one sent is a place a public address does not get.
bool wantsCandidate(String line) {
  final parts = line.split(' ');
  if (parts.length < 5) return false;
  if (parts[2].toLowerCase() != 'udp') return false;
  final address = parts[4].toLowerCase();
  if (address.startsWith('fe80:') || address.startsWith('127.') || address == '::1') return false;
  if (address.contains(':') && (address.startsWith('fc') || address.startsWith('fd'))) return false;
  return true;
}

/// Which of one call's candidates are sent to the desktop.
class CandidateBudget {
  final Set<String> _sent = <String>{};
  int _count = 0;
  int _hosts = 0;
  int _hostsV4 = 0;
  int _hostsV6 = 0;
  int _relays = 0;

  /// Whether this candidate is sent: wanted, not a repeat, and within the call's budget.
  bool admit(String line) {
    if (!wantsCandidate(line)) return false;
    if (_count >= _maxCandidates || _sent.contains(line)) return false;
    final host = line.contains(' typ host');
    final relay = line.contains(' typ relay');
    final v6 = line.split(' ')[4].contains(':');
    if (host && _hosts >= _maxHostCandidates) return false;
    if (host && (v6 ? _hostsV6 : _hostsV4) >= _maxHostsPerFamily) return false;
    if (relay && _relays >= _maxRelayCandidates) return false;
    _sent.add(line);
    _count += 1;
    if (host) {
      _hosts += 1;
      if (v6) {
        _hostsV6 += 1;
      } else {
        _hostsV4 += 1;
      }
    }
    if (relay) _relays += 1;
    return true;
  }
}

/// One report from the peer connection's statistics, as far as choosing a path reads it.
class StatsEntry {
  const StatsEntry(this.id, this.type, this.values);

  final String id;
  final String type;
  final Map<dynamic, dynamic> values;
}

/// The path a connection is on: each end's candidate type and the address family.
class SelectedPair {
  const SelectedPair(this.local, this.remote, this.v6);

  final String local;
  final String remote;
  final bool? v6;

  /// `relay` if either end is one, which is the only kind that costs the account anything.
  String get path => local == 'relay' || remote == 'relay' ? 'relay' : 'direct';

  /// `direct srflx/prflx v4` — for the diagnostics log.
  String describe() => '$path $local/$remote${v6 == null ? '' : (v6! ? ' v6' : ' v4')}';
}

/// Reads the pair in use out of the statistics.
///
/// The transport says which pair it selected, and that is the answer. Several pairs can
/// have *succeeded* at once — the relay's and a direct one found a moment later — so the
/// first succeeded pair in the list is only a fallback for a stack that reports no
/// transport, and a nominated one is preferred even then.
SelectedPair? selectedPairFrom(List<StatsEntry> stats) {
  final byId = <String, StatsEntry>{for (final entry in stats) entry.id: entry};
  SelectedPair? read(StatsEntry? pair) {
    if (pair == null) return null;
    final local = byId[pair.values['localCandidateId']]?.values;
    final remote = byId[pair.values['remoteCandidateId']]?.values;
    final localType = local?['candidateType'];
    final remoteType = remote?['candidateType'];
    if (localType is! String && remoteType is! String) return null;
    final address = remote?['address'] ?? remote?['ip'];
    return SelectedPair(
      localType is String ? localType : 'unknown',
      remoteType is String ? remoteType : 'unknown',
      address is String && address.isNotEmpty ? address.contains(':') : null,
    );
  }

  for (final entry in stats) {
    if (entry.type != 'transport') continue;
    final chosen = read(byId[entry.values['selectedCandidatePairId']]);
    if (chosen != null) return chosen;
  }
  final pairs = stats.where((entry) => entry.type == 'candidate-pair').toList();
  for (final wanted in <bool Function(StatsEntry)>[
    (entry) => entry.values['nominated'] == true && entry.values['state'] == 'succeeded',
    (entry) => entry.values['nominated'] == true,
    (entry) => entry.values['state'] == 'succeeded',
  ]) {
    for (final entry in pairs.where(wanted)) {
      final found = read(entry);
      if (found != null) return found;
    }
  }
  return null;
}

/// Stop handing fragments to the channel above this much queued inside it, and carry on
/// once it drains. A data channel accepts megabytes at once and reports the cost nowhere.
const int _highWaterBytes = 256 * 1024;
const int _lowWaterBytes = 64 * 1024;

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
    this.clientId,
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

  /// A stable id for this phone (`stableDeviceId`). The service passes only a name and a
  /// platform to the desktop, so this travels in the offer, which it relays untouched.
  final String? clientId;
  final http.Client _http;

  /// Open a connection, resolving once the data channel is open.
  ///
  /// [renewal] is a connection made to replace a live one whose relay credential is about to
  /// run out: it asks for a credential of its own rather than reusing the list that
  /// connection was made with, and tells the desktop not to treat the old one as a ghost.
  ///
  /// A network that lets no UDP out — some offices, hotels and campuses — gives the first
  /// attempt nothing but the phone's own addresses. It is ended early and made again with
  /// the relay reached over TCP, which such a network does carry.
  Future<RtcFrameSocket> dial({bool renewal = false}) async {
    var attempt = _Attempt(this, renewal: renewal);
    try {
      return await attempt.run();
    } on _UdpBlocked {
      await attempt.dispose();
      recordConnectionDiagnostic(Diagnostic.metric('rtc.tcp-relay', outcome: 'retry'));
      attempt = _Attempt(this, renewal: renewal, overTcp: true);
      try {
        return await attempt.run();
      } catch (_) {
        _iceCache = null;
        await attempt.dispose();
        rethrow;
      }
    } catch (_) {
      // The list may be what was wrong (a credential the relay stopped accepting).
      _iceCache = null;
      await attempt.dispose();
      rethrow;
    }
  }

  /// Fetch the server list ahead of a connection, so the dial itself does not wait for it.
  /// Safe to call often: a list that is still good is kept.
  static void warm({required String origin, required String token, http.Client? client}) {
    unawaited(_loadIce(origin, token, client ?? http.Client()).then((_) {}, onError: (_) {}));
  }

  Future<_IceList> _iceServers({bool fresh = false}) => _loadIce(origin, token, _http, fresh: fresh);

  /// The STUN/TURN servers for this account, kept until shortly before the relay credential
  /// in them runs out (minutes after it is issued). Asking again for every dial was a whole
  /// HTTPS round trip to the service before anything else could start.
  ///
  /// [fresh] skips what is kept. A connection that replaces one about to lose its credential
  /// must not be handed the very list that is about to stop working.
  static Future<_IceList> _loadIce(String origin, String token, http.Client client, {bool fresh = false}) async {
    final started = DateTime.now().millisecondsSinceEpoch;
    final key = '$origin\n$token';
    final cached = _iceCache;
    if (!fresh && cached != null && cached.key == key && started < cached.validUntil) {
      recordConnectionDiagnostic(Diagnostic.metric('rtc.ice', elapsedMs: 0, outcome: 'cached'));
      return cached.list;
    }
    final flight = _iceFlight;
    if (!fresh && flight != null && flight.key == key) return flight.servers;
    final next = _IceFlight(key, _fetchIce(origin, token, client, started));
    _iceFlight = next;
    try {
      return await next.servers;
    } finally {
      if (identical(_iceFlight, next)) _iceFlight = null;
    }
  }

  static Future<_IceList> _fetchIce(String origin, String token, http.Client client, int started) async {
    try {
      final response = await client
          .get(
            Uri.parse('$origin/api/rtc/ice'),
            headers: <String, String>{'accept': 'application/json', 'authorization': 'Bearer $token'},
          )
          .timeout(_httpTimeout);
      if (response.statusCode == 401) throw ConnectionError('unauthorized', t('conn.expired'));
      if (response.statusCode != 200) {
        recordConnectionDiagnostic(Diagnostic.metric('rtc.ice',
            elapsedMs: DateTime.now().millisecondsSinceEpoch - started, outcome: 'http-${response.statusCode}'));
        return _IceList.empty;
      }
      final body = jsonDecode(response.body);
      final servers = body is Map ? body['ice_servers'] : null;
      if (servers is! List) return _IceList.empty;
      final list = <Map<String, Object?>>[
        for (final entry in servers)
          if (entry is Map && entry['urls'] is List)
            <String, Object?>{
              'urls': oneRelayPerServer((entry['urls'] as List).whereType<String>().toList()),
              if (entry['username'] is String) 'username': entry['username'],
              if (entry['credential'] is String) 'credential': entry['credential'],
            },
      ];
      // The same credential, reached over TCP: what a dial falls back to where UDP is blocked.
      final overTcp = <Map<String, Object?>>[
        for (final entry in servers)
          if (entry is Map && entry['urls'] is List && entry['username'] is String && entry['credential'] is String)
            if (relayOverTcp((entry['urls'] as List).whereType<String>().toList()) case final urls?)
              <String, Object?>{'urls': urls, 'username': entry['username'], 'credential': entry['credential']},
      ];
      final now = DateTime.now().millisecondsSinceEpoch;
      var expires = body is Map && body['expires_at'] is String ? DateTime.tryParse(body['expires_at'] as String) : null;
      // The credential's life is minutes, so a phone clock a minute out is the difference
      // between replacing a connection in time and finding it dead. The service's own clock
      // is in the response's Date header: measure the expiry against that.
      if (expires != null) {
        final stamp = response.headers['date'];
        DateTime? serverNow;
        try {
          if (stamp != null) serverNow = HttpDate.parse(stamp);
        } catch (_) {}
        if (serverNow != null) expires = expires.subtract(serverNow.difference(DateTime.now().toUtc()));
      }
      // No expiry means no relay credential in the list (the allowance is used up, or the
      // relay is off); look again soon, since that can change.
      final validUntil = expires == null
          ? now + _iceRecheckMs
          : expires.millisecondsSinceEpoch - _iceMarginMs;
      // Only a list that carries a relay credential can run out; STUN alone never does.
      final hasCredential = list.any((entry) => entry['username'] is String);
      final result = _IceList(list, hasCredential ? expires : null, overTcp);
      if (list.isNotEmpty && validUntil > now) _iceCache = _IceCache('$origin\n$token', result, validUntil);
      recordConnectionDiagnostic(Diagnostic.metric('rtc.ice',
          elapsedMs: now - started, outcome: 'fetched', frameChars: list.length));
      return result;
    } on ConnectionError {
      rethrow;
    } catch (_) {
      recordConnectionDiagnostic(Diagnostic.metric('rtc.ice',
          elapsedMs: DateTime.now().millisecondsSinceEpoch - started, outcome: 'failed'));
      // Without ICE servers the phone can still reach a computer on the same network,
      // which beats failing outright because the list could not be fetched.
      return _IceList.empty;
    }
  }
}

/// A relay credential is good for five minutes, and a relayed connection lasts exactly as
/// long as the one it was made with. Stop reusing a list with two and a half minutes left:
/// a connection made with less would be replaced almost as soon as it was up (the service
/// hands out lists with at least three minutes in them, so this keeps its reuse for the first
/// half of their life).
const int _iceMarginMs = 150 * 1000;
const int _iceRecheckMs = 5 * 60 * 1000;

/// A server list and when the relay credential in it expires (null when it holds none).
class _IceList {
  const _IceList(this.servers, this.relayExpiresAt, [this.overTcp = const <Map<String, Object?>>[]]);

  static const _IceList empty = _IceList(<Map<String, Object?>>[], null);

  final List<Map<String, Object?>> servers;
  final DateTime? relayExpiresAt;

  /// The relay alone, reached over TCP or TLS; empty when the list has none.
  final List<Map<String, Object?>> overTcp;
}

/// The first attempt learned no address but the phone's own: this network carries no UDP.
class _UdpBlocked implements Exception {
  const _UdpBlocked();
}

class _IceCache {
  const _IceCache(this.key, this.list, this.validUntil);

  final String key;
  final _IceList list;
  final int validUntil;
}

class _IceFlight {
  const _IceFlight(this.key, this.servers);

  final String key;
  final Future<_IceList> servers;
}

_IceCache? _iceCache;
_IceFlight? _iceFlight;

class _Attempt {
  _Attempt(this._dialer, {this.renewal = false, this.overTcp = false}) {
    // It can fail before anything is waiting on it (signaling closes while the offer is
    // still being made); the waiter that comes later still gets the error.
    unawaited(_opened.future.then((_) {}, onError: (_) {}));
  }

  final RtcDialer _dialer;
  /// This connection replaces one that is about to lose its relay credential.
  final bool renewal;
  /// Made after an attempt that found UDP blocked: only the relay, reached over TCP.
  final bool overTcp;
  Timer? _udpWatch;
  DateTime? _relayExpiresAt;
  /// The call on the service's signaling, once it has been named.
  SignalingCall? _call;
  Future<SignalingCall>? _calling;
  RTCPeerConnection? _pc;
  RTCDataChannel? _channel;
  final Completer<RtcFrameSocket> _opened = Completer<RtcFrameSocket>();
  final List<RTCIceCandidate> _early = <RTCIceCandidate>[];
  final CandidateBudget _budget = CandidateBudget();
  /// Signals made before the service has named the call, in the order they must arrive.
  final List<Map<String, Object?>> _outbox = <Map<String, Object?>>[];
  final Map<String, int> _localKinds = <String, int>{};
  final Map<String, int> _remoteKinds = <String, int>{};
  /// The desktop's answer agreed to compressed frames (it was offered them below).
  bool _deflate = false;
  bool _haveRemote = false;
  bool _disposed = false;
  bool _handedOver = false;

  Future<RtcFrameSocket> run() async {
    final started = DateTime.now().millisecondsSinceEpoch;
    int since() => DateTime.now().millisecondsSinceEpoch - started;

    // The server list, the signaling socket and the peer connection do not wait for one
    // another: each is a round trip (or several) to a service that can be far away, and
    // run one after the other they were most of the time a connection took to start.
    final iceLoading = _dialer._iceServers(fresh: renewal);
    final calling = SignalingCall.place(
      origin: _dialer.origin,
      token: _dialer.token,
      deviceId: _dialer.deviceId,
      clientName: _dialer.clientName,
      platform: _dialer.platform,
      onSignal: (data) => unawaited(_applySignal(data)),
      onEnd: (error) {
        if (!_handedOver && !_opened.isCompleted) _opened.completeError(error);
      },
    ).then((call) {
      recordConnectionDiagnostic(Diagnostic.metric('rtc.call', elapsedMs: since()));
      return call;
    });
    _calling = calling;
    // Awaited below; until then a failure must not surface as an unhandled error.
    unawaited(calling.then((_) {}, onError: (_) {}));

    final iceList = await iceLoading;
    _relayExpiresAt = iceList.relayExpiresAt;
    final pc = await createPeerConnection(<String, Object?>{
      'iceServers': overTcp ? iceList.overTcp : iceList.servers,
      'sdpSemantics': 'unified-plan',
      // The desktop speaks no ICE-TCP. Not `candidateNetworkPolicy: low_cost`: it drops every
      // network dearer than the cheapest, and the loopback interface is the cheapest of all,
      // so on mobile data the only candidates left were loopback ones and nothing connected.
      // Left at its default for the attempt over TCP, so that nothing about TCP is switched
      // off under the one connection that needs it; the TCP candidates that then turn up
      // are not sent ([wantsCandidate]).
      if (!overTcp) 'tcpCandidatePolicy': 'disabled',
      // Keep gathering as networks come and go. The default gathers once, with whatever the
      // system has listed at that instant, and on a cold start that can be the loopback
      // interface alone — the cellular one turns up a moment later and was never used.
      'continualGatheringPolicy': 'gather_continually',
    });
    _pc = pc;
    pc.onIceCandidate = (candidate) {
      final text = candidate.candidate;
      if (text == null || text.isEmpty) return;
      if (!_budget.admit(text)) return;
      _count(_localKinds, text);
      _sendSignal(<String, Object?>{'type': 'candidate', 'candidate': text, 'mid': candidate.sdpMid ?? '0'});
    };
    pc.onConnectionState = (state) {
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        recordConnectionDiagnostic(Diagnostic.metric('rtc.ice-connected', elapsedMs: since()));
      }
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
        final socket = RtcFrameSocket._(pc, channel, _deflate, _relayExpiresAt);
        _opened.complete(socket);
        recordConnectionDiagnostic(Diagnostic.metric('rtc.open', elapsedMs: since(), outcome: _kinds()));
        // The answer only permitted compression. Follow the path it is actually on:
        // a direct one sends frames as they are, and the relay is the one worth deflating.
        unawaited(socket.followPath());
        // From here signaling plays no part. Releasing the call frees this phone's slot
        // on the service; the desktop ignores a hangup once its channel is up.
        _call?.release();
      } else if (state == RTCDataChannelState.RTCDataChannelClosed && !_opened.isCompleted) {
        _opened.completeError(ConnectionError('closed-early', t('conn.closedEarly')));
      }
    };

    // Data only. The plugin's default offer also asks to receive audio and video, which
    // makes three ICE transports where one is needed, and each of them allocates its own
    // relay on every TURN address: that alone used up the service's per-account allocation
    // quota (error 486), leaving neither end of the call with a relay.
    final offer = await pc.createOffer(<String, Object?>{
      'mandatory': <String, Object?>{'OfferToReceiveAudio': false, 'OfferToReceiveVideo': false},
      'optional': <Object?>[],
    });
    // Queued before the description is applied: applying it is what starts the candidates,
    // and the desktop has to be handed the offer first.
    _sendSignal(<String, Object?>{
      'type': 'offer',
      'sdp': offer.sdp,
      if (_dialer.clientId != null) 'client_id': _dialer.clientId,
      // Tells the desktop not to close this phone's other connection: it is still carrying
      // the session until this one has taken over.
      if (renewal) 'rollover': true,
      // Through the relay a phone on mobile data is hundreds of milliseconds from the
      // desktop, and a transcript is mostly JSON. Only used if the answer agrees.
      'deflate': true,
    });
    await pc.setLocalDescription(offer);
    // Only worth ending early when there is another way to try.
    if (!overTcp && iceList.overTcp.isNotEmpty) {
      _udpWatch = Timer(_udpProbe, () {
        final beyond = (_localKinds['srflx'] ?? 0) + (_localKinds['relay'] ?? 0) + (_localKinds['prflx'] ?? 0);
        if (beyond == 0 && !_opened.isCompleted) _opened.completeError(const _UdpBlocked());
      });
    }

    try {
      _call = await calling;
      _flushSignals();
      return await _opened.future.timeout(_channelTimeout, onTimeout: () {
        throw ConnectionError('timeout', t('conn.rtcTimeout'));
      });
    } on _UdpBlocked {
      recordConnectionDiagnostic(Diagnostic.metric('rtc.udp-blocked', elapsedMs: since(), outcome: _kinds()));
      rethrow;
    } catch (_) {
      // What each end offered says why: a call that had only private addresses to try
      // could never have left the local network.
      recordConnectionDiagnostic(Diagnostic.metric('rtc.failed', elapsedMs: since(), outcome: _kinds()));
      rethrow;
    } finally {
      _udpWatch?.cancel();
    }
  }

  /// `host:2 srflx:1 relay:1 / host:4 srflx:1` — what this phone sent, then what the
  /// desktop did.
  String _kinds() {
    String join(Map<String, int> kinds) =>
        kinds.isEmpty ? 'none' : kinds.entries.map((entry) => '${entry.key}:${entry.value}').join(' ');
    return '${join(_localKinds)} / ${join(_remoteKinds)}';
  }

  static void _count(Map<String, int> kinds, String candidate) {
    final match = RegExp(r' typ (\w+)').firstMatch(candidate);
    final kind = match?.group(1) ?? 'unknown';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }

  Future<void> _applySignal(Object? data) async {
    final pc = _pc;
    if (pc == null || data is! Map) return;
    try {
      switch (data['type']) {
        case 'answer':
          final sdp = data['sdp'];
          if (sdp is! String) return;
          _deflate = data['deflate'] == true;
          await pc.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
          _haveRemote = true;
          for (final candidate in _early) {
            await pc.addCandidate(candidate);
          }
          _early.clear();
        case 'candidate':
          final text = data['candidate'];
          if (text is! String || text.isEmpty) return;
          _count(_remoteKinds, text);
          final mid = data['mid'];
          final candidate = RTCIceCandidate(text, mid is String ? mid : '0', 0);
          // Candidates can outrun the answer; they cannot be applied before it.
          if (_haveRemote) {
            await pc.addCandidate(candidate);
          } else {
            _early.add(candidate);
          }
        case 'candidates':
          // Several at once: the ports a desktop's router is about to give its socket,
          // when that router hands them out in order. Each is one more address to try
          // the desktop at, and the one its router really chose is the direct path.
          final lines = data['candidates'];
          if (lines is! List) return;
          final mid = data['mid'];
          for (final text in lines.whereType<String>().take(_maxPredictedCandidates)) {
            if (text.isEmpty) continue;
            _remoteKinds['predicted'] = (_remoteKinds['predicted'] ?? 0) + 1;
            final candidate = RTCIceCandidate(text, mid is String ? mid : '0', 0);
            if (_haveRemote) {
              await pc.addCandidate(candidate);
            } else {
              _early.add(candidate);
            }
          }
      }
    } catch (_) {
      // A candidate the stack rejects is that candidate's problem only.
    }
  }

  /// Send what was made while the call had no id yet, oldest first.
  void _flushSignals() {
    final waiting = List<Map<String, Object?>>.of(_outbox);
    _outbox.clear();
    waiting.forEach(_sendSignal);
  }

  void _sendSignal(Map<String, Object?> data) {
    if (_disposed) return;
    final call = _call;
    if (call == null) {
      _outbox.add(data);
      return;
    }
    call.signal(data);
  }

  /// Tear down what a failed attempt left behind. A connection that was handed over is the
  /// caller's now and is left alone.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _udpWatch?.cancel();
    if (!_handedOver) {
      try {
        await _channel?.close();
      } catch (_) {}
      try {
        await _pc?.close();
      } catch (_) {}
    }
    final call = _call;
    if (call != null) {
      call.release();
    } else {
      // Still being placed (the offer failed first): let go of it when it lands.
      unawaited(_calling?.then((placed) => placed.release(), onError: (_) {}));
    }
  }
}

/// A data channel as the [FrameSocket] [RemoteClient] speaks over: whole frames in and out
/// (fragmented per `rtc_frames.dart`), with the keepalive the desktop's heartbeat expects.
class RtcFrameSocket implements ExpiringFrameSocket {
  RtcFrameSocket._(this._pc, this._channel, this._deflate, this.credentialExpiresAt) {
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
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected && !_closed) {
        // ICE has stopped hearing from the desktop. It declares failure only much later,
        // and often recovers; meanwhile this is the earliest sign there is of a dead path.
        _suspect?.call();
      }
    };
  }

  final RTCPeerConnection _pc;
  final RTCDataChannel _channel;
  @override
  final DateTime? credentialExpiresAt;
  /// The desktop agreed to read compressed frames. Permission only — see [followPath].
  final bool _deflate;
  /// Set once the selected path is the relay. Until then, and on a direct path, frames
  /// leave as they are: deflating them costs more than the bytes save on a LAN.
  bool _compress = false;
  String? _lastPath;
  Timer? _pathWatch;
  final FrameAssembler _assembler = FrameAssembler(_maxFrameBytes);
  final List<Uint8List> _queue = <Uint8List>[];
  final StreamController<Object?> _frames = StreamController<Object?>(sync: true);
  void Function()? _suspect;
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
  set onSuspect(void Function()? handler) => _suspect = handler;

  @override
  void add(String data) {
    if (_closed) throw StateError('data channel is closed');
    final bytes = utf8.encode(data);
    final packed = _compress ? compressFrame(bytes) : null;
    _queue.addAll(packed != null ? splitFrame(packed, binary: false, deflated: true) : splitFrame(bytes, binary: false));
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

  /// Watch the selected path and compress only while it is the relay.
  ///
  /// ICE nominates after the channel opens, and may move a call onto the relay later, so
  /// this keeps looking until the socket closes. Frames sent before the first answer go
  /// out uncompressed, which is the right default for the LAN and harmless on the relay.
  Future<void> followPath() async {
    if (!_deflate) return;
    await _applyPath();
    _pathWatch ??= Timer.periodic(const Duration(seconds: 3), (_) => unawaited(_applyPath()));
  }

  Future<void> _applyPath() async {
    if (_closed) {
      _pathWatch?.cancel();
      _pathWatch = null;
      return;
    }
    final pair = await selectedPair();
    // What the path is made of, written down when it changes: it is the only record of
    // why a connection was direct or was not.
    final described = pair?.describe() ?? 'unknown';
    if (described != _lastPath) {
      _lastPath = described;
      recordConnectionDiagnostic(Diagnostic.metric('rtc.path', outcome: described));
    }
    _compress = pair?.path == 'relay';
  }

  @override
  Future<bool> usesRelay() async => await selectedPath() == 'relay';

  /// Which kind of path ICE chose: `direct` (LAN or across NATs) or `relay` (through
  /// FastVibe's relay, which counts against the account's monthly allowance). Null until known.
  Future<String?> selectedPath() async => (await selectedPair())?.path;

  /// The pair of addresses the connection is on, or null until one is chosen.
  Future<SelectedPair?> selectedPair() async {
    try {
      final stats = await _pc.getStats();
      return selectedPairFrom(<StatsEntry>[
        for (final report in stats) StatsEntry(report.id, report.type, report.values),
      ]);
    } catch (_) {
      return null;
    }
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
