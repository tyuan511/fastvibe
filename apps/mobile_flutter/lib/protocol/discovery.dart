/// Finding FastVibe machines on the local network (mDNS / Bonjour).
///
/// The desktop announces `_fastvibe._tcp` while 允许局域网访问 is on (`src/main/server/mdns.ts`).
/// The instance name is the computer's host name, which is what the row shows and what the
/// saved connection is called — nobody has to type `192.168.x.x:7777` on the same Wi-Fi.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:nsd/nsd.dart' as nsd;

const String fastvibeServiceType = '_fastvibe._tcp';

/// One computer found on the network.
@immutable
class NearbyMachine {
  const NearbyMachine({
    required this.name,
    required this.port,
    required this.origins,
  });

  /// The computer's host name, as announced.
  final String name;
  final int port;

  /// Where it may be reached, best guess first. A computer announces an address for every
  /// network interface it has (Wi-Fi, a VPN, a VM bridge…), and only some of them are
  /// reachable from this phone, so the caller probes them in order.
  final List<String> origins;

  @override
  bool operator ==(Object other) =>
      other is NearbyMachine &&
      other.name == name &&
      other.port == port &&
      listEquals(other.origins, origins);

  @override
  int get hashCode => Object.hash(name, port, Object.hashAll(origins));
}

bool _isLinkLocalV4(String address) => address.startsWith('169.254.');

bool _isPrivateV4(String address) =>
    address.startsWith('192.168.') ||
    address.startsWith('10.') ||
    RegExp(r'^172\.(1[6-9]|2\d|3[01])\.').hasMatch(address);

/// `http://addr:port` origins for the addresses a service announced, most likely first.
///
/// Private IPv4 comes first (that is the Wi-Fi), other IPv4 next, a routable IPv6 last.
/// Link-local addresses are dropped: IPv4 `169.254` is a self-assigned fallback and IPv6
/// `fe80::` needs an interface zone only the sender knows. The announced `.local` host
/// name is not used either — Android's resolver does not do mDNS, so a name that works on
/// one phone would fail on the next.
List<String> originsFor(Iterable<InternetAddress> addresses, int port) {
  final v4 = <String>[];
  final v6 = <String>[];
  for (final address in addresses) {
    final text = address.address;
    if (address.type == InternetAddressType.IPv4) {
      if (!_isLinkLocalV4(text) && !address.isLoopback) v4.add(text);
    } else if (address.type == InternetAddressType.IPv6) {
      if (!address.isLinkLocal && !address.isLoopback) v6.add(text);
    }
  }
  v4.sort(
    (a, b) => (_isPrivateV4(a) ? 0 : 1).compareTo(_isPrivateV4(b) ? 0 : 1),
  );
  return <String>[
    for (final a in v4) 'http://$a:$port',
    for (final a in v6) 'http://[$a]:$port',
  ];
}

/// The first origin that answers an HTTP request, or null if none does.
///
/// Any response counts, an error status included: the server is there, and it is the
/// password that decides the rest. Probed together so a dead interface costs one timeout,
/// not one per address.
Future<String?> firstReachable(
  List<String> origins, {
  Duration timeout = const Duration(milliseconds: 1500),
  Future<bool> Function(String origin, Duration timeout)? probe,
}) async {
  if (origins.isEmpty) return null;
  final check = probe ?? _answers;
  final completer = Completer<String?>();
  // Order is the tie-break: an answer is held until every address before it has either
  // answered or failed, so the best-ranked one that works is the one returned.
  final results = List<bool?>.filled(origins.length, null);
  void settle() {
    if (completer.isCompleted) return;
    for (var i = 0; i < results.length; i++) {
      if (results[i] == null) return;
      if (results[i] == true) {
        completer.complete(origins[i]);
        return;
      }
    }
    completer.complete(null);
  }

  for (var i = 0; i < origins.length; i++) {
    final index = i;
    unawaited(
      check(origins[index], timeout).catchError((_) => false).then((ok) {
        results[index] = ok;
        settle();
      }),
    );
  }
  return completer.future;
}

Future<bool> _answers(String origin, Duration timeout) async {
  final client = http.Client();
  try {
    await client.get(Uri.parse(origin)).timeout(timeout);
    return true;
  } on Object {
    return false;
  } finally {
    client.close();
  }
}

/// A live browse for FastVibe machines. Holds nothing when it cannot run (no multicast, no
/// plugin, a denied Local Network prompt): [machines] then stays empty and the manual and
/// QR paths are what is left, which is exactly where the user was before this existed.
class NearbyDiscovery extends ChangeNotifier {
  nsd.Discovery? _discovery;
  bool _disposed = false;
  bool _starting = false;
  List<NearbyMachine> _machines = const <NearbyMachine>[];

  List<NearbyMachine> get machines => _machines;

  /// True from [start] until the platform has the browse running.
  bool get searching => _starting || (_discovery != null && _machines.isEmpty);

  Future<void> start() async {
    if (_discovery != null || _starting) return;
    _starting = true;
    notifyListeners();
    try {
      final discovery = await nsd.startDiscovery(
        fastvibeServiceType,
        ipLookupType: nsd.IpLookupType.any,
      );
      if (_disposed) {
        await nsd.stopDiscovery(discovery);
        return;
      }
      _discovery = discovery..addListener(_refresh);
      _refresh();
    } on Object catch (error) {
      debugPrint('mDNS discovery unavailable: $error');
    } finally {
      _starting = false;
      if (!_disposed) notifyListeners();
    }
  }

  void _refresh() {
    final found = _discovery?.services ?? const <nsd.Service>[];
    final next = <NearbyMachine>[
      for (final service in found)
        if (service.name != null && service.port != null)
          if (originsFor(
                service.addresses ?? const <InternetAddress>[],
                service.port!,
              )
              case final origins when origins.isNotEmpty)
            NearbyMachine(
              name: service.name!,
              port: service.port!,
              origins: origins,
            ),
    ]..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    if (listEquals(next, _machines)) return;
    _machines = next;
    if (!_disposed) notifyListeners();
  }

  Future<void> stop() async {
    final discovery = _discovery;
    _discovery = null;
    if (discovery == null) return;
    discovery.removeListener(_refresh);
    try {
      await nsd.stopDiscovery(discovery);
    } on Object {
      // The platform already tore it down.
    }
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(stop());
    super.dispose();
  }
}
