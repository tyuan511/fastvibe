import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:crypto/crypto.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../i18n/core.dart';

/// Where the phone signs in; overridden for local development with
/// `--dart-define=FASTVIBE_CLOUD_URL=http://192.168.x.x:9088`.
const String defaultAccountOrigin = String.fromEnvironment(
  'FASTVIBE_CLOUD_URL',
  defaultValue: 'https://app.fastvibe.dev',
);

const String _clientId = 'fastvibe-mobile';
const String _redirectUri = 'fastvibe://oauth/callback';
const String _callbackScheme = 'fastvibe';
const Duration _requestTimeout = Duration(seconds: 15);

class AccountUser {
  const AccountUser({required this.id, required this.login, this.avatarUrl, this.email});

  final String id;

  /// The GitHub username the account was created from.
  final String login;
  final String? avatarUrl;
  final String? email;

  static AccountUser? fromJson(Object? value) {
    if (value is! Map) return null;
    final id = value['id'];
    final login = value['login'];
    if (id is! String || login is! String || login.isEmpty) return null;
    final avatar = value['avatar_url'];
    final email = value['email'];
    return AccountUser(
      id: id,
      login: login,
      avatarUrl: avatar is String && avatar.startsWith('https://') ? avatar : null,
      email: email is String ? email : null,
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'login': login,
    if (avatarUrl != null) 'avatar_url': avatarUrl,
    if (email != null) 'email': email,
  };
}

enum AccountStatus { signedOut, signingIn, signedIn }

/// A sign-in that was kept: the token, who it belongs to, and the site that issued it.
class StoredAccount {
  const StoredAccount({required this.origin, required this.token, required this.user});

  final String origin;
  final String token;
  final AccountUser user;
}

/// Where the account is kept. The token is the only secret this phone holds for the account,
/// so it lives in the Keychain / Keystore; who it belongs to is only a label.
abstract class AccountStorage {
  Future<StoredAccount?> read();
  Future<void> write(StoredAccount account);
  Future<void> clear();
}

class SecureAccountStorage implements AccountStorage {
  const SecureAccountStorage();

  static const FlutterSecureStorage _secure = FlutterSecureStorage();
  static const String _tokenKey = 'fv.account.token';
  static const String _metaKey = 'fastvibe.account.v1';

  @override
  Future<StoredAccount?> read() async {
    try {
      final token = await _secure.read(key: _tokenKey);
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_metaKey);
      if (token == null || token.isEmpty || raw == null) return null;
      final meta = jsonDecode(raw);
      if (meta is! Map) return null;
      final user = AccountUser.fromJson(meta['user']);
      final origin = meta['origin'];
      if (user == null || origin is! String) return null;
      return StoredAccount(origin: origin, token: token, user: user);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> write(StoredAccount account) async {
    await _secure.write(key: _tokenKey, value: account.token);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _metaKey,
      jsonEncode(<String, Object?>{'origin': account.origin, 'user': account.user.toJson()}),
    );
  }

  @override
  Future<void> clear() async {
    try {
      await _secure.delete(key: _tokenKey);
    } catch (_) {
      // A token that cannot be deleted must not keep the phone signed in on screen.
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_metaKey);
  }
}

/// Runs the browser half of the sign-in and returns the URL the browser ended on.
typedef BrowserAuthenticator = Future<String> Function(String url);

Future<String> _systemBrowser(String url) =>
    FlutterWebAuth2.authenticate(url: url, callbackUrlScheme: _callbackScheme);

/// A sign-in the person did not finish is not an error worth a red line.
class LoginCancelled implements Exception {
  const LoginCancelled();
}

/// Raised for failures a person should be told about, in words they can read.
class LoginFailure implements Exception {
  const LoginFailure(this.message);

  final String message;

  @override
  String toString() => message;
}

/// The FastVibe account this phone is signed in to (app.fastvibe.dev): the browser
/// authorization-code flow for native apps (RFC 8252) with PKCE (RFC 7636).
///
/// The phone opens the site's `/authorize` page in a system browser session with a PKCE
/// challenge and a random `state`; the person confirms there; the browser is sent to
/// `fastvibe://oauth/callback?code=…`, which the OS hands back to this app. The code is
/// useless without the verifier, which never leaves this process, so another app that
/// registered the same scheme and saw the redirect holds a code it cannot trade.
class AccountService extends ChangeNotifier {
  AccountService({
    AccountStorage? storage,
    http.Client? client,
    BrowserAuthenticator? authenticate,
    String? origin,
    Future<String> Function()? deviceName,
    String? platform,
  }) : _storage = storage ?? const SecureAccountStorage(),
       _client = client ?? http.Client(),
       _authenticate = authenticate ?? _systemBrowser,
       origin = (origin ?? defaultAccountOrigin).replaceFirst(RegExp(r'/+$'), ''),
       _deviceName = deviceName ?? _defaultDeviceName,
       _platform = platform ?? (Platform.isIOS ? 'ios' : Platform.isAndroid ? 'android' : Platform.operatingSystem);

  static final AccountService instance = AccountService();

  final AccountStorage _storage;
  final http.Client _client;
  final BrowserAuthenticator _authenticate;
  final Future<String> Function() _deviceName;
  final String _platform;

  /// The site the account lives on. A token is only ever sent here.
  final String origin;

  AccountStatus status = AccountStatus.signedOut;
  AccountUser? user;

  /// Why the last sign-in did not complete, for a person to read.
  String? error;

  String? _token;

  /// The token for requests to [origin]. Never shown, never written to a log.
  String? get token => _token;

  bool get signedIn => status == AccountStatus.signedIn && _token != null;

  /// What this phone is called to the computers it connects to.
  Future<String> deviceLabel() => _deviceName();

  /// `ios` / `android`, as the account's device list shows it.
  String get platform => _platform;

  /// Pick up a sign-in from a previous run, then check it in the background: being signed in
  /// must not depend on being online, but a token the server has revoked has to go.
  Future<void> init() async {
    final stored = await _storage.read();
    // A token goes only to the site that issued it. A build pointed at another server must not
    // carry the real credential there.
    if (stored != null && stored.origin == origin) {
      _token = stored.token;
      user = stored.user;
      status = AccountStatus.signedIn;
      notifyListeners();
      unawaited(refresh());
    }
  }

  Future<void> login() async {
    if (status == AccountStatus.signingIn) return;
    error = null;
    status = AccountStatus.signingIn;
    notifyListeners();
    try {
      final verifier = _randomUrlSafe(32);
      final state = _randomUrlSafe(24);
      final challenge = base64Url.encode(sha256.convert(utf8.encode(verifier)).bytes).replaceAll('=', '');
      final url = Uri.parse('$origin/authorize').replace(queryParameters: <String, String>{
        'client_id': _clientId,
        'redirect_uri': _redirectUri,
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        'device_name': String.fromCharCodes((await _deviceName()).runes.take(80)),
        'platform': _platform,
      });

      final String callback;
      try {
        callback = await _authenticate(url.toString());
      } catch (_) {
        throw const LoginCancelled();
      }
      final query = Uri.parse(callback).queryParameters;
      if (query['error'] != null) throw const LoginCancelled();
      if (query['state'] != state) throw LoginFailure(t('account.errorState'));
      final code = query['code'];
      if (code == null || code.isEmpty) throw LoginFailure(t('account.errorGeneric'));

      final stored = await _exchange(code, verifier);
      await _storage.write(stored);
      _token = stored.token;
      user = stored.user;
      status = AccountStatus.signedIn;
    } on LoginCancelled {
      status = AccountStatus.signedOut;
    } on LoginFailure catch (failure) {
      status = AccountStatus.signedOut;
      error = failure.message;
    } catch (_) {
      status = AccountStatus.signedOut;
      error = t('account.errorGeneric');
    }
    notifyListeners();
  }

  Future<void> logout() async {
    final token = _token;
    await _forget();
    if (token != null) {
      // Telling the service is what makes the token stop working elsewhere; the phone is
      // signed out whatever happens next, so a failure only leaves it to expire.
      unawaited(
        _call('/api/auth/logout', method: 'POST', token: token).then<void>((_) {}).catchError((Object _) {}),
      );
    }
  }

  /// Check the token and refresh who it belongs to. One the server refuses is dropped; one it
  /// could not be asked about (offline) is kept.
  Future<void> refresh() async {
    final token = _token;
    if (token == null) return;
    try {
      final response = await _call('/api/me', token: token);
      if (response.statusCode == 401) {
        if (_token == token) await _forget();
        return;
      }
      if (response.statusCode != 200) return;
      final refreshed = AccountUser.fromJson(jsonDecode(response.body));
      if (refreshed != null && _token == token) {
        user = refreshed;
        await _storage.write(StoredAccount(origin: origin, token: token, user: refreshed));
        notifyListeners();
      }
    } catch (_) {
      // Offline or the service is down: still signed in.
    }
  }

  /// A request made with the token came back 401: it is dead, so the phone is signed out.
  Future<void> tokenRejected(String token) async {
    if (_token == token) await _forget();
  }

  Future<void> _forget() async {
    _token = null;
    user = null;
    status = AccountStatus.signedOut;
    error = null;
    await _storage.clear();
    notifyListeners();
  }

  Future<StoredAccount> _exchange(String code, String verifier) async {
    final http.Response response;
    try {
      response = await _call(
        '/api/oauth/token',
        method: 'POST',
        body: <String, Object?>{
          'grant_type': 'authorization_code',
          'code': code,
          'code_verifier': verifier,
          'client_id': _clientId,
          'redirect_uri': _redirectUri,
        },
      );
    } catch (_) {
      throw LoginFailure(t('account.errorNetwork'));
    }
    Object? body;
    try {
      body = jsonDecode(response.body);
    } catch (_) {
      body = null;
    }
    if (response.statusCode != 200 || body is! Map) {
      final errorCode = body is Map && body['error'] is Map ? (body['error'] as Map)['code'] : null;
      if (errorCode == 'account_disabled') throw LoginFailure(t('account.errorDisabled'));
      if (errorCode == 'invalid_grant') throw LoginFailure(t('account.errorExpired'));
      throw LoginFailure(t('account.errorGeneric'));
    }
    final token = body['access_token'];
    final parsed = AccountUser.fromJson(body['user']);
    if (token is! String || token.isEmpty || parsed == null) throw LoginFailure(t('account.errorGeneric'));
    return StoredAccount(origin: origin, token: token, user: parsed);
  }

  Future<http.Response> _call(String path, {String method = 'GET', String? token, Object? body}) {
    final headers = <String, String>{
      'accept': 'application/json',
      if (token != null) 'authorization': 'Bearer $token',
      if (body != null) 'content-type': 'application/json',
    };
    final uri = Uri.parse('$origin$path');
    final encoded = body == null ? null : jsonEncode(body);
    final request = method == 'POST'
        ? _client.post(uri, headers: headers, body: encoded)
        : _client.get(uri, headers: headers);
    return request.timeout(_requestTimeout);
  }
}

String _randomUrlSafe(int bytes) {
  final random = math.Random.secure();
  return base64Url.encode(List<int>.generate(bytes, (_) => random.nextInt(256))).replaceAll('=', '');
}

Future<String> _defaultDeviceName() async {
  try {
    final info = DeviceInfoPlugin();
    if (Platform.isIOS) {
      final ios = await info.iosInfo;
      return ios.name.isNotEmpty ? ios.name : ios.model;
    }
    if (Platform.isAndroid) {
      final android = await info.androidInfo;
      return '${android.manufacturer} ${android.model}'.trim();
    }
  } catch (_) {
    // The name is only a label in the account's device list.
  }
  return 'FastVibe';
}
