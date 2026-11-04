import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:nsd/nsd.dart' as nsd;

import '../storage/servers.dart';

const lanServiceType = '_fastvibe-iroh._udp';

class LanEndpoint {
  LanEndpoint(this.deviceId, this.endpointId, List<String> addresses)
    : directAddresses = List.unmodifiable(addresses),
      age = Stopwatch()..start();
  final String deviceId;
  final String endpointId;
  final List<String> directAddresses;
  final Stopwatch age;
}

/// Native Bonjour/Android NSD only. Records never add devices or grant access.
class LanDiscovery extends ChangeNotifier {
  LanDiscovery({
    Future<nsd.Discovery> Function()? start,
    Future<void> Function(nsd.Discovery)? stop,
    this.freshness = const Duration(seconds: 60),
  }) : _start =
           start ??
           (() => nsd.startDiscovery(
             lanServiceType,
             ipLookupType: nsd.IpLookupType.any,
           )),
       _stop = stop ?? nsd.stopDiscovery;

  static final instance = LanDiscovery();
  final Future<nsd.Discovery> Function() _start;
  final Future<void> Function(nsd.Discovery) _stop;
  final Duration freshness;
  final _records = <String, LanEndpoint>{};
  nsd.Discovery? _discovery;
  nsd.ServiceListener? _listener;
  String? _account;
  bool _foreground = true;
  bool _online = true;
  bool _disposed = false;
  int _generation = 0;
  Timer? _expiry;
  Future<void> _stopping = Future.value();

  LanEndpoint? endpointFor(SavedServer server) {
    if (_account == null || !_foreground || !_online || !server.isOfficial) {
      return null;
    }
    for (final record in _records.values) {
      if (record.age.elapsed < freshness &&
          record.deviceId == server.officialDeviceId &&
          record.endpointId == server.endpointId) {
        return record;
      }
    }
    return null;
  }

  void setAccount(String? account) {
    if (_account == account) return;
    _account = account;
    rescan();
  }

  void setForeground(bool foreground) {
    if (_foreground == foreground) return;
    _foreground = foreground;
    rescan();
  }

  void networkChanged({required bool online}) {
    _online = online;
    rescan();
  }

  void rescan() {
    if (_disposed) return;
    final generation = ++_generation;
    _expiry?.cancel();
    _records.clear();
    final old = _discovery;
    final listener = _listener;
    _discovery = null;
    _listener = null;
    if (old != null) {
      if (listener != null) old.removeServiceListener(listener);
      _stopping = _stopping.then((_) => _safeStop(old));
    }
    notifyListeners();
    if (_account != null && _foreground && _online) {
      unawaited(_browse(generation));
    }
  }

  Future<void> _safeStop(nsd.Discovery discovery) async {
    try {
      await _stop(discovery);
    } catch (_) {
      /* Discovery is optional. */
    }
  }

  Future<void> _browse(int generation) async {
    await _stopping;
    if (_disposed || generation != _generation) return;
    try {
      final discovery = await _start();
      if (_disposed || generation != _generation) {
        await _safeStop(discovery);
        return;
      }
      void receive(nsd.Service service, nsd.ServiceStatus status) {
        if (_disposed || generation != _generation) return;
        final key = '${service.name}\u0000${service.type}';
        _records.remove(key);
        if (status == nsd.ServiceStatus.found) {
          final endpoint = parseLanEndpoint(service);
          if (endpoint != null) _records[key] = endpoint;
        }
        notifyListeners();
      }

      _discovery = discovery;
      _listener = receive;
      discovery.addServiceListener(receive);
      for (final service in discovery.services) {
        receive(service, nsd.ServiceStatus.found);
      }
      // DNS-SD does not expose TTLs. Bound all hints and re-resolve periodically.
      _expiry = Timer(freshness, rescan);
    } catch (_) {
      if (!_disposed && generation == _generation) {
        _records.clear();
        notifyListeners();
        _expiry = Timer(freshness, rescan);
      }
    }
  }

  @override
  void dispose() {
    _account = null;
    rescan();
    _disposed = true;
    super.dispose();
  }
}

LanEndpoint? parseLanEndpoint(nsd.Service service) {
  try {
    if (service.type?.replaceFirst(RegExp(r'\.$'), '') != lanServiceType) {
      return null;
    }
    final txt = service.txt;
    if (txt == null) return null;
    for (final entry in txt.entries) {
      if (utf8.encode(entry.key).length + 1 + (entry.value?.length ?? 0) >
          255) {
        return null;
      }
    }
    String value(String key) => utf8.decode(txt[key] ?? const []);
    final device = value('device_id');
    final endpoint = value('endpoint_id');
    if (value('v') != '1' ||
        device.isEmpty ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(endpoint)) {
      return null;
    }
    final addresses = <String>[];
    if (txt.containsKey('addrs')) {
      final raw = value('addrs').split(',');
      if (raw.length > 8) return null;
      for (final address in raw) {
        if (!isSocketAddress(address)) return null;
        if (!addresses.contains(address)) addresses.add(address);
      }
    } else {
      final port = service.port;
      if (port == null || port < 1 || port > 65535) return null;
      final hosts =
          service.addresses?.map((a) => a.address).toList() ?? <String>[];
      if (service.host != null) hosts.add(service.host!);
      for (final host in hosts) {
        final address = host.contains(':') ? '[$host]:$port' : '$host:$port';
        if (isSocketAddress(address) && !addresses.contains(address)) {
          addresses.add(address);
        }
        if (addresses.length == 8) break;
      }
    }
    if (addresses.isEmpty) return null;
    return LanEndpoint(device, endpoint, addresses);
  } catch (_) {
    return null;
  }
}

bool isSocketAddress(String value) {
  final match = RegExp(r'^(?:\[([^\]]+)\]|([^:]+)):(\d+)$').firstMatch(value);
  if (match == null) return false;
  final host = match[1] ?? match[2]!;
  final ip = InternetAddress.tryParse(host);
  final port = int.tryParse(match[3]!);
  return ip != null &&
      !ip.isLoopback &&
      !ip.isMulticast &&
      !ip.isLinkLocal &&
      host != '0.0.0.0' &&
      host != '::' &&
      port != null &&
      port > 0 &&
      port <= 65535;
}
