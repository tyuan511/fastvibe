import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../protocol/address.dart';

const String _listKey = 'fastvibe.servers.v1';

/// One saved machine. `origin` is the identity: a tunnel and its LAN address stay two
/// devices, and re-adding the same origin updates the row instead of duplicating it.
class SavedServer {
  const SavedServer({
    required this.id,
    required this.alias,
    required this.origin,
    required this.host,
    required this.kind,
    required this.createdAt,
    this.lastConnectedAt,
  });

  factory SavedServer.fromJson(Map<String, Object?> json) => SavedServer(
        id: json['id']! as String,
        alias: json['alias']! as String,
        origin: json['origin']! as String,
        host: json['host']! as String,
        kind: AddressKind.values.byName(json['kind']! as String),
        createdAt: (json['createdAt']! as num).toInt(),
        lastConnectedAt: (json['lastConnectedAt'] as num?)?.toInt(),
      );

  final String id;
  final String alias;
  final String origin;
  final String host;
  final AddressKind kind;
  final int createdAt;
  final int? lastConnectedAt;

  int get sortKey => lastConnectedAt ?? createdAt;

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'alias': alias,
        'origin': origin,
        'host': host,
        'kind': kind.name,
        'createdAt': createdAt,
        if (lastConnectedAt != null) 'lastConnectedAt': lastConnectedAt,
      };

  SavedServer copyWith({
    String? alias,
    int? lastConnectedAt,
  }) =>
      SavedServer(
        id: id,
        alias: alias ?? this.alias,
        origin: origin,
        host: host,
        kind: kind,
        createdAt: createdAt,
        lastConnectedAt: lastConnectedAt ?? this.lastConnectedAt,
      );

  static bool isValid(Object? value) {
    if (value is! Map) return false;
    return value['id'] is String &&
        value['alias'] is String &&
        value['origin'] is String &&
        value['host'] is String &&
        value['kind'] is String &&
        AddressKind.values.any((kind) => kind.name == value['kind']) &&
        value['createdAt'] is num;
  }
}

const FlutterSecureStorage _secure = FlutterSecureStorage();

/// Device token (Keychain / Keystore). The only secret this app holds.
String tokenKey(String id) => 'fv.token.$id';

Future<String?> readToken(String id) => _secure.read(key: tokenKey(id));

Future<void> writeToken(String id, String token) => _secure.write(key: tokenKey(id), value: token);

Future<void> deleteToken(String id) async {
  try {
    await _secure.delete(key: tokenKey(id));
  } catch (_) {
    // A token that cannot be deleted still must not block removing the device.
  }
}

/// One saved machine list, mutated one operation at a time.
///
/// Every mutation reads the file first and writes the whole list back, so two writes
/// racing each other would drop one of them. Serialising them here is what keeps a
/// rename made while a connect is patching `lastConnectedAt` from being lost.
class ServerStore {
  ServerStore._();

  static final ServerStore instance = ServerStore._();

  Future<void> _queue = Future<void>.value();

  Future<T> _enqueue<T>(Future<T> Function() operation) {
    final next = _queue.then((_) => operation(), onError: (_) => operation());
    _queue = next.then((_) {}, onError: (_) {});
    return next;
  }

  Future<List<SavedServer>> load() => _read();

  Future<SavedServer> upsert(SavedServer server) => _enqueue(() async {
        final servers = await _read();
        final index = servers.indexWhere((item) => item.origin == server.origin);
        final SavedServer saved;
        if (index >= 0) {
          final existing = servers[index];
          saved = SavedServer(
            id: existing.id,
            alias: server.alias,
            origin: server.origin,
            host: server.host,
            kind: server.kind,
            createdAt: existing.createdAt,
            lastConnectedAt: server.lastConnectedAt ?? existing.lastConnectedAt,
          );
          servers[index] = saved;
        } else {
          saved = server;
          servers.insert(0, saved);
        }
        await _write(servers);
        return saved;
      });

  Future<List<SavedServer>> patch(String id, {String? alias, int? lastConnectedAt}) => _enqueue(() async {
        final servers = await _read();
        final next = servers
            .map((item) => item.id == id ? item.copyWith(alias: alias, lastConnectedAt: lastConnectedAt) : item)
            .toList();
        await _write(next);
        return _sorted(next);
      });

  Future<List<SavedServer>> remove(String id) => _enqueue(() async {
        final servers = await _read();
        final next = servers.where((item) => item.id != id).toList();
        await _write(next);
        await deleteToken(id);
        return _sorted(next);
      });

  Future<List<SavedServer>> _read() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_listKey);
      if (raw == null) return <SavedServer>[];
      final parsed = jsonDecode(raw);
      if (parsed is! List) return <SavedServer>[];
      final servers = parsed.where(SavedServer.isValid).map((item) => SavedServer.fromJson((item as Map).cast<String, Object?>())).toList();
      return _sorted(servers);
    } catch (_) {
      return <SavedServer>[];
    }
  }

  Future<void> _write(List<SavedServer> servers) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_listKey, jsonEncode(servers.map((item) => item.toJson()).toList()));
  }

  List<SavedServer> _sorted(List<SavedServer> servers) {
    final sorted = <SavedServer>[...servers]..sort((a, b) => b.sortKey.compareTo(a.sortKey));
    return sorted;
  }
}

/// `srv-<base36 timestamp>-<8 random chars>`, matching the Expo client's ids.
String newServerId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  final random = math.Random();
  final suffix = List<String>.generate(8, (_) => alphabet[random.nextInt(alphabet.length)]).join();
  return 'srv-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}-$suffix';
}
