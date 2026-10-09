import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:fastvibe_mobile/account/account.dart';
import 'package:fastvibe_mobile/protocol/client.dart';
import 'package:fastvibe_mobile/protocol/frame_socket.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class MemoryStorage implements AccountStorage {
  StoredAccount? kept;

  @override
  Future<StoredAccount?> read() async => kept;

  @override
  Future<void> write(StoredAccount account) async => kept = account;

  @override
  Future<void> clear() async => kept = null;
}

const String origin = 'https://app.fastvibe.dev';

http.Response json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: <String, String>{'content-type': 'application/json'});

Map<String, Object?> tokenReply({String login = 'octocat'}) => <String, Object?>{
  'access_token': 'fvs_token_1',
  'token_type': 'Bearer',
  'user': <String, Object?>{'id': 'u1', 'login': login, 'avatar_url': 'https://avatars.example/u1', 'email': 'a@b.c'},
};

AccountService service({
  required Future<String> Function(String url) authenticate,
  required MockClient client,
  MemoryStorage? storage,
  String site = origin,
}) => AccountService(
  storage: storage ?? MemoryStorage(),
  client: client,
  authenticate: authenticate,
  origin: site,
  deviceName: () async => "Ada's iPhone",
  platform: 'ios',
);

void main() {
  test('signing in sends the browser to /authorize and trades the code for a token', () async {
    Uri? opened;
    Map<String, Object?>? exchanged;
    final storage = MemoryStorage();
    final account = service(
      storage: storage,
      authenticate: (url) async {
        opened = Uri.parse(url);
        final state = opened!.queryParameters['state'];
        return 'fastvibe://oauth/callback?code=abc123&state=$state';
      },
      client: MockClient((request) async {
        expect(request.url.path, '/api/oauth/token');
        exchanged = jsonDecode(request.body) as Map<String, Object?>;
        return json(tokenReply());
      }),
    );

    await account.login();

    expect(account.signedIn, isTrue);
    expect(account.user?.login, 'octocat');
    expect(account.token, 'fvs_token_1');
    expect(storage.kept?.origin, origin);

    final query = opened!.queryParameters;
    expect(opened!.path, '/authorize');
    expect(query['client_id'], 'fastvibe-mobile');
    expect(query['redirect_uri'], 'fastvibe://oauth/callback');
    expect(query['code_challenge_method'], 'S256');
    expect(query['device_name'], "Ada's iPhone");
    expect(query['platform'], 'ios');

    // The challenge the browser saw is the hash of the verifier only this phone had.
    final verifier = exchanged!['code_verifier']! as String;
    final expected = base64Url.encode(sha256.convert(utf8.encode(verifier)).bytes).replaceAll('=', '');
    expect(query['code_challenge'], expected);
    expect(exchanged!['grant_type'], 'authorization_code');
    expect(exchanged!['code'], 'abc123');
    expect(exchanged!['client_id'], 'fastvibe-mobile');
    expect(exchanged!['redirect_uri'], 'fastvibe://oauth/callback');
  });

  test('a redirect carrying someone else\'s state is refused', () async {
    var tokenRequests = 0;
    final account = service(
      authenticate: (url) async => 'fastvibe://oauth/callback?code=abc&state=not-ours',
      client: MockClient((request) async {
        tokenRequests += 1;
        return json(tokenReply());
      }),
    );
    await account.login();
    expect(account.signedIn, isFalse);
    expect(account.error, isNotNull);
    expect(tokenRequests, 0, reason: 'the code must not be traded for a sign-in this app did not start');
  });

  test('backing out of the browser is not an error', () async {
    final account = service(
      authenticate: (url) async => throw StateError('CANCELED'),
      client: MockClient((request) async => json(tokenReply())),
    );
    await account.login();
    expect(account.status, AccountStatus.signedOut);
    expect(account.error, isNull);

    final denied = service(
      authenticate: (url) async {
        final state = Uri.parse(url).queryParameters['state'];
        return 'fastvibe://oauth/callback?error=access_denied&state=$state';
      },
      client: MockClient((request) async => json(tokenReply())),
    );
    await denied.login();
    expect(denied.status, AccountStatus.signedOut);
    expect(denied.error, isNull);
  });

  test('the service refusing the code says so, in words', () async {
    final account = service(
      authenticate: (url) async {
        final state = Uri.parse(url).queryParameters['state'];
        return 'fastvibe://oauth/callback?code=abc&state=$state';
      },
      client: MockClient((request) async => json(<String, Object?>{'error': <String, Object?>{'code': 'invalid_grant'}}, 400)),
    );
    await account.login();
    expect(account.signedIn, isFalse);
    expect(account.error, isNotNull);
  });

  test('a sign-in from a previous run comes back, but only for the site that issued it', () async {
    final storage = MemoryStorage()
      ..kept = const StoredAccount(origin: origin, token: 'fvs_old', user: AccountUser(id: 'u1', login: 'octocat'));
    final same = service(
      storage: storage,
      authenticate: (url) async => '',
      client: MockClient((request) async => json(<String, Object?>{'id': 'u1', 'login': 'octocat'})),
    );
    await same.init();
    expect(same.signedIn, isTrue);
    expect(same.token, 'fvs_old');

    // A build pointed at another server must not carry the real credential there.
    final other = service(
      storage: storage,
      site: 'http://192.168.1.5:9088',
      authenticate: (url) async => '',
      client: MockClient((request) async => fail('the token must not be sent to another site')),
    );
    await other.init();
    expect(other.signedIn, isFalse);
    expect(other.token, isNull);
  });

  test('a token the service refuses is dropped; one it could not ask about is kept', () async {
    final storage = MemoryStorage()
      ..kept = const StoredAccount(origin: origin, token: 'fvs_old', user: AccountUser(id: 'u1', login: 'octocat'));
    final revoked = service(
      storage: storage,
      authenticate: (url) async => '',
      client: MockClient((request) async => json(<String, Object?>{'error': <String, Object?>{'code': 'unauthorized'}}, 401)),
    );
    await revoked.init();
    await revoked.refresh();
    expect(revoked.signedIn, isFalse);
    expect(storage.kept, isNull);

    storage.kept = const StoredAccount(origin: origin, token: 'fvs_old', user: AccountUser(id: 'u1', login: 'octocat'));
    final offline = service(
      storage: storage,
      authenticate: (url) async => '',
      client: MockClient((request) async => throw const SocketLikeError()),
    );
    await offline.init();
    await offline.refresh();
    expect(offline.signedIn, isTrue);
  });

  test('signing out forgets the token and tells the service', () async {
    final seen = <String>[];
    final storage = MemoryStorage()
      ..kept = const StoredAccount(origin: origin, token: 'fvs_old', user: AccountUser(id: 'u1', login: 'octocat'));
    final account = service(
      storage: storage,
      authenticate: (url) async => '',
      client: MockClient((request) async {
        seen.add('${request.method} ${request.url.path} ${request.headers['authorization']}');
        return http.Response('', 204);
      }),
    );
    await account.init();
    await account.logout();
    await Future<void>.delayed(Duration.zero);
    expect(account.signedIn, isFalse);
    expect(storage.kept, isNull);
    expect(seen, contains('POST /api/auth/logout Bearer fvs_old'));
  });

  group('RemoteClient over an opened socket', () {
    test('connectOpened sends no token and completes on the desktop\'s own auth and welcome', () async {
      final socket = ScriptedSocket();
      final client = RemoteClient(version: '1.0.0');
      final connected = client.connectOpened(() async => socket);
      await Future<void>.delayed(Duration.zero);

      // Pre-authenticated by the account: the first frame out is the hello, not an auth.
      expect(socket.sent.map((frame) => (jsonDecode(frame) as Map)['type']), isNot(contains('auth')));
      expect(socket.sent.map((frame) => (jsonDecode(frame) as Map)['kind']), contains('hello'));

      socket.receive(jsonEncode(<String, Object?>{'type': 'auth', 'ok': true, 'device': <String, Object?>{'id': 'rtc:1', 'label': 'x'}}));
      socket.receive(jsonEncode(<String, Object?>{'kind': 'welcome', 'epoch': 'e1', 'features': <String, Object?>{'conversationResume': true}}));
      await connected;
      expect(client.ready, isTrue);
      expect(client.epoch, 'e1');
      client.close();
    });

    test('a socket that closes before the welcome fails the connect', () async {
      final socket = ScriptedSocket();
      final client = RemoteClient(version: '1.0.0');
      final connected = client.connectOpened(() async => socket);
      await Future<void>.delayed(Duration.zero);
      socket.end(4001);
      await expectLater(connected, throwsA(isA<ConnectionError>()));
    });
  });
}

class SocketLikeError implements Exception {
  const SocketLikeError();
}

/// A [FrameSocket] the test plays the desktop through.
class ScriptedSocket implements FrameSocket {
  final List<String> sent = <String>[];
  final StreamController<Object?> _in = StreamController<Object?>(sync: true);
  bool _open = true;
  int? _code;

  void receive(String frame) => _in.add(frame);

  void end(int code) {
    _open = false;
    _code = code;
    unawaited(_in.close());
  }

  @override
  bool get isOpen => _open;

  @override
  void add(String data) => sent.add(data);

  @override
  StreamSubscription<Object?> listen(
    void Function(Object? data) onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => _in.stream.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);

  @override
  int? get closeCode => _code;

  @override
  String? get closeReason => null;

  @override
  void close() => _open = false;
}
