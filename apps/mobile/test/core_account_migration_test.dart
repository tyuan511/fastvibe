import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:fastvibe_mobile/account/account.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const secure = FlutterSecureStorage();
  const identityKey = 'fv.iroh.identity.v1';
  const migrationKey = 'fastvibe.nativeAccountMigrated.v1';
  const old = AccountUser(id: 'old', login: 'old');
  const native = AccountUser(id: 'native', login: 'native');

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });

  Future<void> seedOld() async {
    await secure.write(key: 'fv.account.token', value: 'old-token');
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(
      'fastvibe.account.v1',
      jsonEncode({'origin': defaultAccountOrigin, 'user': old.toJson()}),
    );
  }

  test('native account and identity transfer once and preserve the existing Flutter identity', () async {
    await seedOld();
    await secure.write(key: identityKey, value: 'newer-flutter-identity');
    var reads = 0;
    final storage = SecureAccountStorage(
      readNativeState: () async {
        reads++;
        return {
          'present': true,
          'origin': defaultAccountOrigin,
          'token': 'native-token',
          'user': native.toJson(),
          'identity': 'native-identity',
        };
      },
    );
    expect((await storage.read())?.token, 'native-token');
    expect(await secure.read(key: identityKey), 'newer-flutter-identity');
    expect((await storage.read())?.user.login, 'native');
    expect(reads, 1);
  });

  test(
    'an explicit native logout cannot resurrect the old Flutter token',
    () async {
      await seedOld();
      final storage = SecureAccountStorage(
        readNativeState: () async => {'present': true},
      );
      expect(await storage.read(), isNull);
      expect(await secure.read(key: 'fv.account.token'), isNull);
      expect(
        (await SharedPreferences.getInstance()).getBool(migrationKey),
        isTrue,
      );
    },
  );

  test('a native record without user metadata loads the profile only from its issuer', () async {
    final storage = SecureAccountStorage(
      readNativeState: () async => {
        'present': true,
        'origin': defaultAccountOrigin,
        'token': 'native-token',
        'identity': 'native-identity',
      },
      loadNativeUser: (origin, token) async {
        expect(origin, defaultAccountOrigin);
        expect(token, 'native-token');
        return native;
      },
    );
    expect((await storage.read())?.user.id, 'native');
    expect(await secure.read(key: identityKey), 'native-identity');
  });

  test(
    'a different origin never receives the token or overwrites existing state',
    () async {
      await seedOld();
      var lookedUp = false;
      final storage = SecureAccountStorage(
        readNativeState: () async => {
          'present': true,
          'origin': 'https://other.example',
          'token': 'native-token',
        },
        loadNativeUser: (_, _) async {
          lookedUp = true;
          return native;
        },
      );
      expect(await storage.read(), isNull);
      expect(lookedUp, isFalse);
      expect(await secure.read(key: 'fv.account.token'), 'old-token');
      expect(
        (await SharedPreferences.getInstance()).getBool(migrationKey),
        isNot(true),
      );
    },
  );

  test('native read failure and offline profile lookup retain disk data for a retry', () async {
    await seedOld();
    final failedRead = SecureAccountStorage(
      readNativeState: () async => throw PlatformException(code: 'unreadable'),
    );
    expect(await failedRead.read(), isNull);
    final offline = SecureAccountStorage(
      readNativeState: () async => {
        'present': true,
        'origin': defaultAccountOrigin,
        'token': 'native-token',
      },
      loadNativeUser: (_, _) async => null,
    );
    expect(await offline.read(), isNull);
    expect(await secure.read(key: 'fv.account.token'), 'old-token');
    expect(
      (await SharedPreferences.getInstance()).getBool(migrationKey),
      isNot(true),
    );
  });

  test(
    'Flutter logout keeps old native state from being migrated again',
    () async {
      final storage = SecureAccountStorage(
        readNativeState: () async => {
          'present': true,
          'origin': defaultAccountOrigin,
          'token': 'native-token',
          'user': native.toJson(),
        },
      );
      expect(await storage.read(), isNotNull);
      await storage.clear();
      expect(await storage.read(), isNull);
    },
  );
}
