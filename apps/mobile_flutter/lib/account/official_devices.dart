import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../i18n/core.dart';
import '../protocol/address.dart';
import '../protocol/rtc_connection.dart';
import '../storage/servers.dart';
import 'account.dart';

const String officialScheme = 'fastvibe-official';

String officialOrigin(String deviceId) => '$officialScheme://$deviceId';

/// The computers on the signed-in account, and whether each is online right now.
///
/// They are kept in the same saved list as every other computer (`kind: official`), so the
/// list, the machine screen and notifications treat them alike; what this adds is the list's
/// source of truth — the account, refreshed here — and the live `online` flag, which is only
/// meaningful for a moment and so is not saved.
class OfficialDevices extends ChangeNotifier {
  OfficialDevices({AccountService? account, http.Client? client, ServerStore? store})
    : _account = account ?? AccountService.instance,
      _client = client ?? http.Client(),
      _store = store ?? ServerStore.instance;

  static final OfficialDevices instance = OfficialDevices();

  final AccountService _account;
  final http.Client _client;
  final ServerStore _store;

  final Map<String, bool> _online = <String, bool>{};
  bool loading = false;

  /// Why the list could not be loaded, for a person to read; null when it could.
  String? error;

  /// Whether the account says the computer is reachable. Unknown means not online.
  bool isOnline(SavedServer server) => _online[server.officialDeviceId] ?? false;

  int _generation = 0;

  /// Ask the account for its computers and bring the saved list in line with the answer.
  Future<void> refresh() async {
    final token = _account.token;
    if (token == null) {
      await clear();
      return;
    }
    final generation = ++_generation;
    loading = true;
    error = null;
    notifyListeners();
    try {
      final response = await _client
          .get(
            Uri.parse('${_account.origin}/api/devices'),
            headers: <String, String>{'accept': 'application/json', 'authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 15));
      if (generation != _generation) return;
      if (response.statusCode == 401) {
        await _account.tokenRejected(token);
        return;
      }
      if (response.statusCode != 200) throw StateError('devices ${response.statusCode}');
      final body = jsonDecode(response.body);
      final list = body is Map ? body['devices'] : null;
      if (list is! List) throw StateError('devices: unexpected reply');
      final now = DateTime.now().millisecondsSinceEpoch;
      final devices = <SavedServer>[];
      final online = <String, bool>{};
      for (final entry in list) {
        if (entry is! Map) continue;
        final id = entry['id'];
        final name = entry['name'];
        if (id is! String || name is! String || name.isEmpty) continue;
        final platform = entry['platform'];
        online[id] = entry['online'] == true;
        devices.add(
          SavedServer(
            id: newServerId(),
            alias: name,
            origin: officialOrigin(id),
            host: platform is String && platform.isNotEmpty ? platform : name,
            kind: AddressKind.official,
            createdAt: now,
          ),
        );
      }
      await _store.syncOfficial(devices);
      if (generation != _generation) return;
      // A computer in the list is about to be tapped: have what its connection needs first.
      if (devices.isNotEmpty) RtcDialer.warm(origin: _account.origin, token: token, client: _client);
      _online
        ..clear()
        ..addAll(online);
    } catch (_) {
      if (generation == _generation) error = t('official.loadFailed');
    } finally {
      if (generation == _generation) {
        loading = false;
        notifyListeners();
      }
    }
  }

  /// Signed out: the account's computers go with the account.
  Future<void> clear() async {
    _generation += 1;
    _online.clear();
    loading = false;
    error = null;
    await _store.syncOfficial(const <SavedServer>[]);
    notifyListeners();
  }
}
