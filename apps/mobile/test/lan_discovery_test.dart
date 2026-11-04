import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:fastvibe_mobile/account/lan_discovery.dart';
import 'package:fastvibe_mobile/account/official_devices.dart';
import 'package:fastvibe_mobile/protocol/address.dart';
import 'package:fastvibe_mobile/storage/servers.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nsd/nsd.dart' as nsd;

final endpointId = 'a' * 64;
SavedServer saved({String device = 'desktop', String? endpoint}) => SavedServer(
  id: 'saved',
  alias: 'Computer',
  origin: officialOrigin(device),
  host: 'darwin',
  kind: AddressKind.official,
  createdAt: 0,
  endpointId: endpoint ?? endpointId,
);
nsd.Service service({
  String device = 'desktop',
  String? endpoint,
  String? addresses = '192.168.1.2:4444,[fd00::2]:5555',
  String version = '1',
}) => nsd.Service(
  name: 'Computer',
  type: lanServiceType,
  host: '192.168.1.3',
  port: 9999,
  txt: {
    for (final entry in {
      'v': version,
      'device_id': device,
      'endpoint_id': endpoint ?? endpointId,
      'addrs': ?addresses,
    }.entries)
      entry.key: Uint8List.fromList(utf8.encode(entry.value)),
  },
);
Future<void> settle() => Future<void>.delayed(Duration.zero);

void main() {
  test('TXT keeps v4/v6 independent ports and uses SRV only without addrs', () {
    expect(parseLanEndpoint(service())!.directAddresses, [
      '192.168.1.2:4444',
      '[fd00::2]:5555',
    ]);
    expect(parseLanEndpoint(service(addresses: null))!.directAddresses, [
      '192.168.1.3:9999',
    ]);
    for (final invalid in [
      '',
      'computer.local:44',
      '127.0.0.1:44',
      '192.168.1.2:0',
      '192.168.1.2:65536',
      List.filled(9, '192.168.1.2:44').join(','),
    ]) {
      expect(
        parseLanEndpoint(service(addresses: invalid)),
        isNull,
        reason: invalid,
      );
    }
    expect(parseLanEndpoint(service(version: '2')), isNull);
    expect(parseLanEndpoint(service(endpoint: 'not-a-key')), isNull);
    expect(parseLanEndpoint(service(device: 'x' * 256)), isNull);
  });

  test('discovery never creates devices; badge requires both account device id and endpoint', () async {
    final native = nsd.Discovery('fake');
    final discovery = LanDiscovery(
      start: () async => native,
      stop: (_) async {},
    );
    addTearDown(discovery.dispose);
    discovery.setAccount('account-a');
    await settle();
    native.add(service());
    expect(discovery.endpointFor(saved()), isNotNull);
    expect(discovery.endpointFor(saved(device: 'stranger')), isNull);
    expect(discovery.endpointFor(saved(endpoint: 'b' * 64)), isNull);
    native.remove(service());
    expect(discovery.endpointFor(saved()), isNull);
    native.add(service(device: 'forged-id'));
    expect(discovery.endpointFor(saved()), isNull);
  });

  test(
    'account switch rejects late discovery completion and late old callbacks',
    () async {
      final pending = Completer<nsd.Discovery>();
      final old = nsd.Discovery('old');
      final current = nsd.Discovery('current');
      final stopped = <String>[];
      var starts = 0;
      final discovery = LanDiscovery(
        start: () => ++starts == 1 ? pending.future : Future.value(current),
        stop: (d) async {
          stopped.add(d.id);
        },
      );
      addTearDown(discovery.dispose);
      discovery.setAccount('a');
      await settle();
      discovery.setAccount('b');
      await settle();
      old.add(service());
      pending.complete(old);
      await settle();
      expect(stopped, contains('old'));
      expect(discovery.endpointFor(saved()), isNull);
      current.add(service());
      expect(discovery.endpointFor(saved()), isNotNull);
      discovery.setAccount(null);
      current.add(service(device: 'late'));
      expect(discovery.endpointFor(saved()), isNull);
    },
  );

  test('network change and background immediately clear hints and rescan only when active', () async {
    final scans = <nsd.Discovery>[];
    final discovery = LanDiscovery(
      start: () async {
        final d = nsd.Discovery('${scans.length}');
        scans.add(d);
        return d;
      },
      stop: (_) async {},
    );
    addTearDown(discovery.dispose);
    discovery.setAccount('a');
    await settle();
    scans.last.add(service());
    expect(discovery.endpointFor(saved()), isNotNull);
    discovery.networkChanged(online: true);
    expect(discovery.endpointFor(saved()), isNull);
    await settle();
    expect(scans.length, 2);
    scans.first.add(service(device: 'late'));
    expect(discovery.endpointFor(saved()), isNull);
    scans.last.add(service());
    discovery.setForeground(false);
    expect(discovery.endpointFor(saved()), isNull);
    await settle();
    expect(scans.length, 2);
    discovery.setForeground(true);
    await settle();
    expect(scans.length, 3);
    discovery.networkChanged(online: false);
    await settle();
    expect(scans.length, 3);
  });

  testWidgets(
    'expiry clears LAN hints and a denied discovery remains optional',
    (tester) async {
      var starts = 0;
      final native = nsd.Discovery('fake');
      final discovery = LanDiscovery(
        freshness: const Duration(seconds: 10),
        start: () async {
          if (++starts > 1) throw StateError('denied');
          return native;
        },
        stop: (_) async {},
      );
      discovery.setAccount('a');
      await tester.pump();
      native.add(service());
      expect(discovery.endpointFor(saved()), isNotNull);
      await tester.pump(const Duration(seconds: 10));
      expect(discovery.endpointFor(saved()), isNull);
      expect(starts, 2);
      discovery.dispose();
      await tester.pump();
    },
  );
}
