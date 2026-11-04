import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:fastvibe_mobile/account/account.dart';
import 'package:fastvibe_mobile/account/browser_auth.dart';

const _authorization = 'https://app.fastvibe.dev/authorize?state=current';
Uri _callback(String state, {String code = 'authorization-code'}) =>
    Uri.parse('fastvibe://oauth/callback?state=$state&code=$code');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('listens before opening the external browser, including a synchronous callback', () async {
    final links = StreamController<Uri>.broadcast(sync: true);
    addTearDown(links.close);
    final auth = ExternalBrowserAuthenticator(
      links: () => links.stream,
      launch: (url) async {
        expect(url.toString(), _authorization);
        expect(links.hasListener, isTrue);
        links.add(_callback('current'));
        return true;
      },
    );
    expect(
      await auth.authenticate(_authorization),
      _callback('current').toString(),
    );
    expect(links.hasListener, isFalse);
  });

  test('ignores unrelated, malformed and stale-state callbacks until its exact callback arrives', () async {
    final links = StreamController<Uri>.broadcast(sync: true);
    addTearDown(links.close);
    final auth = ExternalBrowserAuthenticator(
      links: () => links.stream,
      launch: (_) async => true,
    );
    var completed = false;
    final pending = auth.authenticate(_authorization).then((value) {
      completed = true;
      return value;
    });
    for (final value in [
      'https://oauth/callback?state=current&code=foreign-scheme',
      'fastvibe://untrusted/callback?state=current&code=foreign-host',
      'fastvibe://oauth/other?state=current&code=foreign-path',
      'fastvibe://oauth/callback?state=old&code=old-code',
      'fastvibe://oauth/callback?code=missing-state',
    ]) {
      links.add(Uri.parse(value));
    }
    await Future<void>.delayed(Duration.zero);
    expect(completed, isFalse);
    links.add(_callback('current'));
    expect(await pending, _callback('current').toString());
    expect(links.hasListener, isFalse);
  });

  test('cancelling releases the listener and a late callback cannot finish the next attempt', () async {
    final links = StreamController<Uri>.broadcast(sync: true);
    addTearDown(links.close);
    final auth = ExternalBrowserAuthenticator(
      links: () => links.stream,
      launch: (_) async => true,
    );
    final first = auth.authenticate(_authorization);
    final cancelled = expectLater(first, throwsA(isA<BrowserAuthCancelled>()));
    auth.cancel();
    await cancelled;
    expect(links.hasListener, isFalse);

    var completed = false;
    final next = auth
        .authenticate('https://app.fastvibe.dev/authorize?state=next')
        .then((value) {
          completed = true;
          return value;
        });
    links.add(_callback('current'));
    await Future<void>.delayed(Duration.zero);
    expect(completed, isFalse);
    links.add(_callback('next'));
    expect(await next, _callback('next').toString());
    expect(links.hasListener, isFalse);
  });

  test(
    'timeout ends the wait and releases its callback subscription',
    () async {
      final links = StreamController<Uri>.broadcast(sync: true);
      addTearDown(links.close);
      final auth = ExternalBrowserAuthenticator(
        links: () => links.stream,
        launch: (_) async => true,
        timeout: const Duration(milliseconds: 10),
      );
      await expectLater(
        auth.authenticate(_authorization),
        throwsA(isA<TimeoutException>()),
      );
      expect(links.hasListener, isFalse);
      auth.cancel();
    },
  );

  test('a refused or throwing browser launch fails promptly and releases the subscription', () async {
    for (final launch in <Future<bool> Function(Uri)>[
      (_) async => false,
      (_) async => throw StateError('browser unavailable'),
    ]) {
      final links = StreamController<Uri>.broadcast(sync: true);
      final auth = ExternalBrowserAuthenticator(
        links: () => links.stream,
        launch: launch,
      );
      try {
        await expectLater(
          auth.authenticate(_authorization).timeout(const Duration(seconds: 1)),
          throwsA(anyOf(isA<StateError>(), isA<Exception>())),
        );
        expect(links.hasListener, isFalse);
      } finally {
        await links.close();
      }
    }
  });

  test(
    'overlapping authentication is refused without stealing the first callback',
    () async {
      final links = StreamController<Uri>.broadcast(sync: true);
      addTearDown(links.close);
      var launches = 0;
      final auth = ExternalBrowserAuthenticator(
        links: () => links.stream,
        launch: (_) async {
          launches++;
          return true;
        },
      );
      final first = auth.authenticate(_authorization);
      await expectLater(
        Future<String>.sync(
          () => auth.authenticate(
            'https://app.fastvibe.dev/authorize?state=other',
          ),
        ),
        throwsA(isA<StateError>()),
      );
      expect(launches, 1);
      links.add(_callback('current'));
      expect(await first, _callback('current').toString());
    },
  );

  test('a matching OAuth denial is returned so the account can finish as cancelled', () async {
    final links = StreamController<Uri>.broadcast(sync: true);
    addTearDown(links.close);
    final auth = ExternalBrowserAuthenticator(
      links: () => links.stream,
      launch: (_) async => true,
    );
    final pending = auth.authenticate(_authorization);
    final denied = Uri.parse(
      'fastvibe://oauth/callback?state=current&error=access_denied',
    );
    links.add(denied);
    expect(await pending, denied.toString());
    expect(links.hasListener, isFalse);
  });

  test(
    'account cancellation during token exchange cannot persist a late success',
    () async {
      final storage = _MemoryStorage();
      final exchanging = Completer<void>();
      final response = Completer<http.Response>();
      final client = MockClient((request) async {
        expect(request.url.path, '/api/oauth/token');
        exchanging.complete();
        return response.future;
      });
      final account = AccountService(
        storage: storage,
        client: client,
        origin: 'https://app.fastvibe.dev',
        platform: 'android',
        deviceName: () async => 'Test phone',
        authenticate: (url) async =>
            _callback(Uri.parse(url).queryParameters['state']!).toString(),
      );
      addTearDown(account.dispose);
      addTearDown(client.close);
      final login = account.login();
      await exchanging.future;
      expect(account.status, AccountStatus.signingIn);
      account.cancelLogin();
      response.complete(
        http.Response(
          jsonEncode({
            'access_token': 'late-token',
            'user': {'id': 'test', 'login': 'test-user'},
          }),
          200,
        ),
      );
      await login;
      expect(account.status, AccountStatus.signedOut);
      expect(account.token, isNull);
      expect(storage.writes, 0);
      expect(storage.account, isNull);
    },
  );
}

class _MemoryStorage implements AccountStorage {
  StoredAccount? account;
  int writes = 0;

  @override
  Future<StoredAccount?> read() async => account;

  @override
  Future<void> write(StoredAccount account) async {
    writes++;
    this.account = account;
  }

  @override
  Future<void> clear() async => account = null;
}
