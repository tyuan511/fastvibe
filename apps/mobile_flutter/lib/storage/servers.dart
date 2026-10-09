import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/foundation.dart';
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
    this.favorite = false,
  });

  factory SavedServer.fromJson(Map<String, Object?> json) => SavedServer(
    id: json['id']! as String,
    alias: json['alias']! as String,
    origin: json['origin']! as String,
    host: json['host']! as String,
    kind: AddressKind.values.byName(json['kind']! as String),
    createdAt: (json['createdAt']! as num).toInt(),
    lastConnectedAt: (json['lastConnectedAt'] as num?)?.toInt(),
    favorite: json['favorite'] == true,
  );

  final String id;
  final String alias;
  final String origin;
  final String host;
  final AddressKind kind;
  final int createdAt;
  final int? lastConnectedAt;
  final bool favorite;

  int get sortKey => lastConnectedAt ?? createdAt;

  /// A computer on the signed-in account: reached over WebRTC through the account, with the
  /// account's token, not by address and device token.
  bool get isOfficial => kind == AddressKind.official;

  /// The account's id for this computer, for an [isOfficial] server.
  String? get officialDeviceId => isOfficial ? Uri.tryParse(origin)?.host : null;

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'alias': alias,
    'origin': origin,
    'host': host,
    'kind': kind.name,
    'createdAt': createdAt,
    if (lastConnectedAt != null) 'lastConnectedAt': lastConnectedAt,
    'favorite': favorite,
  };

  SavedServer copyWith({String? alias, int? lastConnectedAt, bool? favorite}) =>
      SavedServer(
        id: id,
        alias: alias ?? this.alias,
        origin: origin,
        host: host,
        kind: kind,
        createdAt: createdAt,
        lastConnectedAt: lastConnectedAt ?? this.lastConnectedAt,
        favorite: favorite ?? this.favorite,
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

Future<void> writeToken(String id, String token) =>
    _secure.write(key: tokenKey(id), value: token);

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
class ServerStore extends ChangeNotifier {
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
        favorite: existing.favorite,
      );
      servers[index] = saved;
    } else {
      saved = server;
      servers.insert(0, saved);
    }
    await _write(servers);
    return saved;
  });

  /// Make the saved official computers match the account's list: add the new, rename the
  /// changed, drop the ones no longer on the account. Everything else in the list is left
  /// alone. Pass an empty list when signed out to drop them all.
  Future<List<SavedServer>> syncOfficial(List<SavedServer> devices) => _enqueue(() async {
    final servers = await _read();
    final keep = servers.where((item) => !item.isOfficial).toList();
    final byOrigin = <String, SavedServer>{
      for (final item in servers.where((item) => item.isOfficial)) item.origin: item,
    };
    final next = <SavedServer>[...keep];
    for (final device in devices) {
      final existing = byOrigin[device.origin];
      next.add(
        existing == null
            ? device
            : SavedServer(
                id: existing.id,
                alias: device.alias,
                origin: device.origin,
                host: device.host,
                kind: AddressKind.official,
                createdAt: existing.createdAt,
                lastConnectedAt: existing.lastConnectedAt,
                favorite: existing.favorite,
              ),
      );
    }
    // Nothing changed is not a write, so a refresh that finds the same list does not wake
    // every screen that listens.
    final same = servers.length == next.length &&
        servers.every((item) => next.any((other) => jsonEncode(other.toJson()) == jsonEncode(item.toJson())));
    if (same) return _sorted(servers);
    for (final gone in byOrigin.values.where((item) => !devices.any((d) => d.origin == item.origin))) {
      await deleteToken(gone.id);
    }
    await _write(next);
    return _sorted(next);
  });

  Future<List<SavedServer>> patch(
    String id, {
    String? alias,
    int? lastConnectedAt,
    bool? favorite,
  }) => _enqueue(() async {
    final servers = await _read();
    final next = servers
        .map(
          (item) => item.id == id
              ? item.copyWith(
                  alias: alias,
                  lastConnectedAt: lastConnectedAt,
                  favorite: favorite,
                )
              : item,
        )
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
      final servers = parsed
          .where(SavedServer.isValid)
          .map(
            (item) =>
                SavedServer.fromJson((item as Map).cast<String, Object?>()),
          )
          .toList();
      return _sorted(servers);
    } catch (_) {
      return <SavedServer>[];
    }
  }

  Future<void> _write(List<SavedServer> servers) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _listKey,
      jsonEncode(servers.map((item) => item.toJson()).toList()),
    );
    notifyListeners();
  }

  List<SavedServer> _sorted(List<SavedServer> servers) {
    final sorted = <SavedServer>[...servers]
      ..sort((a, b) {
        if (a.favorite != b.favorite) return a.favorite ? -1 : 1;
        return b.sortKey.compareTo(a.sortKey);
      });
    return sorted;
  }
}

/// `srv-<base36 timestamp>-<8 random chars>`, matching the Expo client's ids.
String newServerId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  final random = math.Random();
  final suffix = List<String>.generate(
    8,
    (_) => alphabet[random.nextInt(alphabet.length)],
  ).join();
  return 'srv-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}-$suffix';
}
