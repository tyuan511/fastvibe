import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/dag_data.dart';
import 'package:fastvibe_mobile/protocol/address.dart';
import 'package:fastvibe_mobile/session/connection.dart';
import 'package:fastvibe_mobile/storage/servers.dart';

import 'support/protocol_server.dart';

Future<void> until(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 3));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('condition timed out');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

Map<String, Object?> graph(int revision, String status) => {
  'conversationId': 'c1',
  'revision': revision,
  'nodes': [
    {'id': 'T-0001', 'title': 'Task', 'status': status},
  ],
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  final connection = Connection.instance;
  late ProtocolServer server;
  late SavedServer saved;
  DagWatcher? watcher;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    connection.disconnect();
    connection.handleNetworkChange([ConnectivityResult.wifi]);
    server = ProtocolServer();
    await server.start();
    saved = SavedServer(
      id: 'dag-test',
      alias: 'Test',
      origin: server.origin,
      host: '127.0.0.1',
      kind: AddressKind.loopback,
      createdAt: 0,
    );
    await writeToken(saved.id, 'test-token');
    server.handlers['dag:list'] = (_) => [graph(10, 'running')];
  });
  tearDown(() async {
    watcher?.dispose();
    watcher = null;
    connection.disconnect();
    await server.close();
  });

  Future<DagWatcher> watch() async {
    await connection.connectSaved(saved);
    final next = watcher = DagWatcher('c1');
    await until(() => next.graph != null);
    return next;
  }

  test(
    'a watcher mounted before connection reads the graph once ready',
    () async {
      final connecting = connection.connectSaved(saved);
      final next = watcher = DagWatcher('c1');
      expect(connection.client, isNull);
      await connecting;
      await until(() => next.graph != null);
      expect(next.graph!.nodes.single.status, 'running');
      expect(
        server.calls.where((call) => call['method'] == 'dag:list').length,
        1,
      );
    },
  );

  test('reconnection restores tasks completed offline, even after a revision reset', () async {
    final next = await watch();
    final oldRemote = connection.client;
    connection.handleNetworkChange([ConnectivityResult.none]);
    await server.drop();
    await until(() => connection.client == null);
    server.epoch = 'restarted-host';
    server.handlers['dag:list'] = (_) => [graph(1, 'completed')];
    connection.handleNetworkChange([ConnectivityResult.wifi]);
    await until(
      () => connection.client != null && connection.client != oldRemote,
    );
    await until(() => next.graph?.nodes.single.status == 'completed');
    expect(next.graph!.revision, 1);
    expect(
      server.calls.where((call) => call['method'] == 'dag:list').length,
      2,
    );
  });

  test('a push beats an in-flight empty list', () async {
    final next = await watch();
    final requested = Completer<void>();
    final reply = Completer<Object?>();
    server.handlers['dag:list'] = (_) {
      requested.complete();
      return reply.future;
    };
    final refresh = next.refresh();
    await requested.future;
    server.emit({'type': 'dag_changed', 'graph': graph(11, 'completed')});
    await until(() => next.graph?.revision == 11);
    reply.complete([]);
    await refresh;
    expect(next.graph!.nodes.single.status, 'completed');
  });

  test('deletion beats an in-flight reply but a later fresh read can restore a graph', () async {
    final next = await watch();
    final requested = Completer<void>();
    final reply = Completer<Object?>();
    server.handlers['dag:list'] = (_) {
      requested.complete();
      return reply.future;
    };
    final refresh = next.refresh();
    await requested.future;
    server.emit({'type': 'dag_changed', 'graph': null});
    await until(() => next.deleted);
    reply.complete([graph(10, 'running')]);
    await refresh;
    expect(next.graph, isNull);
    server.handlers['dag:list'] = (_) => [graph(1, 'completed')];
    await next.refresh();
    expect(next.graph!.nodes.single.status, 'completed');
    expect(next.deleted, isFalse);
  });

  test('disposing the watcher removes its connection listener', () async {
    final next = await watch();
    next.dispose();
    watcher = null;
    final reads = server.calls
        .where((call) => call['method'] == 'dag:list')
        .length;
    await connection.connectSaved(saved);
    expect(
      server.calls.where((call) => call['method'] == 'dag:list').length,
      reads,
    );
  });
}
