import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/runtime.dart';
import '../i18n/core.dart';
import '../protocol/address.dart';
import '../storage/servers.dart';
import 'account.dart';

const String officialScheme = 'fastvibe-official';
String officialOrigin(String deviceId) => '$officialScheme://$deviceId';

/// Account-owned desktop devices. Discovery uses the same Rust HTTP client as
/// dialing, so Flutter does not maintain a second transport/account registry.
class OfficialDevices extends ChangeNotifier {
  OfficialDevices({
    AccountService? account,
    ServerStore? store,
    CoreRuntime Function()? createRuntime,
  }) : _account = account ?? AccountService.instance,
       _store = store ?? ServerStore.instance,
       _createRuntime = createRuntime ?? NativeCoreRuntime.new;

  static final OfficialDevices instance = OfficialDevices();
  final AccountService _account;
  final ServerStore _store;
  final CoreRuntime Function() _createRuntime;
  final _online = <String, bool>{};
  bool loading = false;
  String? error;
  int _generation = 0;
  bool isOnline(SavedServer server) =>
      _online[server.officialDeviceId] ?? false;

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
    final runtime = _createRuntime();
    try {
      coreResult(
        await runtime.command('setToken', {
          'origin': _account.origin,
          'token': token,
        }),
      );
      final devices = coreResult(await runtime.command('devices'));
      if (generation != _generation || _account.token != token) return;
      if (devices is! List) throw const CoreFailure('Device list is invalid');
      final now = DateTime.now().millisecondsSinceEpoch;
      final saved = <SavedServer>[];
      final online = <String, bool>{};
      for (final entry in devices.whereType<Map>()) {
        final id = entry['id'];
        final name = entry['name'];
        final platform = entry['platform'];
        if (id is! String ||
            name is! String ||
            !const {'darwin', 'win32', 'linux'}.contains(platform)) {
          continue;
        }
        final endpoint = entry['irohEndpointId'] ?? entry['iroh_endpoint_id'];
        online[id] = entry['online'] == true;
        saved.add(
          SavedServer(
            id: newServerId(),
            alias: name,
            origin: officialOrigin(id),
            host: platform as String,
            kind: AddressKind.official,
            createdAt: now,
            endpointId: endpoint is String ? endpoint : null,
          ),
        );
      }
      // Account changes invalidate the result before its persistence too.
      if (generation != _generation || _account.token != token) return;
      await _store.syncOfficial(saved);
      if (generation != _generation) return;
      _online
        ..clear()
        ..addAll(online);
    } catch (failure) {
      if (generation == _generation) error = t('official.loadFailed');
      if ('$failure'.contains('401')) await _account.tokenRejected(token);
    } finally {
      await runtime.dispose();
      if (generation == _generation) {
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> clear() async {
    _generation++;
    _online.clear();
    loading = false;
    error = null;
    await _store.syncOfficial(const []);
    notifyListeners();
  }
}
