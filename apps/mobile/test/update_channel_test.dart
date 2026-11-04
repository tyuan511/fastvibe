import 'dart:convert';

import 'package:fastvibe_mobile/update/channel.dart';
import 'package:fastvibe_mobile/update/release.dart';
import 'package:fastvibe_mobile/update/updater.dart';
import 'package:fastvibe_mobile/ui/preferences.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('channel ids', () {
    test('unknown or missing ids read as the official channel', () {
      expect(channelFromId(null), same(channelGithub));
      expect(channelFromId(''), same(channelGithub));
      expect(channelFromId('nope.example'), same(channelGithub));
      expect(channelFromId('ghfast'), same(channelGhfast));
      expect(channelFromId('gh-proxy'), same(channelGhProxy));
    });

    test('the official channel is first; every channel has copy keys', () {
      expect(updateChannels.first, same(channelGithub));
      for (final channel in updateChannels) {
        expect(channel.nameKey, startsWith('update.channel'));
        expect(channel.descriptionKey, startsWith('update.channel'));
      }
    });
  });

  group('rewrite', () {
    const refs = 'https://github.com/tyuan511/fastvibe.git/info/refs';
    const raw = 'https://raw.githubusercontent.com/tyuan511/fastvibe/main/README.md';

    test('the official channel passes every URL through', () {
      expect(channelGithub.rewrite(refs), refs);
      expect(channelGithub.rewrite(raw), raw);
      expect(channelGithub.rewrite('https://example.com/x'), 'https://example.com/x');
    });

    test('a mirror prefixes GitHub hosts and nothing else', () {
      expect(channelGhProxy.rewrite(refs), 'https://gh-proxy.com/$refs');
      expect(channelGhfast.rewrite(raw), 'https://ghfast.top/$raw');
      expect(
        channelGhProxy.rewrite('https://example.com/x'),
        'https://example.com/x',
      );
    });

    test('rewriting twice does not stack prefixes', () {
      final once = channelGhProxy.rewrite(refs);
      expect(channelGhProxy.rewrite(once), once);
      // Switching mirrors re-prefixes from the canonical URL; a URL already behind
      // another mirror is left alone rather than mangled further.
      expect(channelGhfast.rewrite(once), once);
    });
  });

  group('findNewerRelease on a mirror', () {
    const version = '0.5.15';
    const apkName = 'FastVibe-app-v0.5.15-arm64-v8a.apk';
    final requests = <String>[];

    Future<http.Response> handler(http.Request request) async {
      requests.add(request.url.toString());
      final url = request.url.toString();
      if (url.endsWith('info/refs?service=git-upload-pack')) {
        return http.Response.bytes(
          latin1.encode(
            '# service=git-upload-pack\n'
            'refs/tags/app-v0.5.14\n'
            'refs/tags/app-v0.5.15\n',
          ),
          200,
        );
      }
      if (url.contains('releases/download/')) {
        return http.Response('', 200, headers: <String, String>{
          'content-length': '123456',
        });
      }
      if (url.endsWith('releases.atom')) {
        return http.Response('<feed></feed>', 200);
      }
      if (url.contains('raw.githubusercontent.com')) {
        return http.Response('## app-v$version\n\n- a fix\n', 200);
      }
      return http.Response('unexpected: $url', 404);
    }

    setUp(() => requests.clear());

    test('checks through the mirror and stores the canonical apk URL', () async {
      final client = MockClient(handler);
      final release = await findNewerRelease(
        '0.5.14',
        client: client,
        supportedAbis: const <String>['arm64-v8a'],
        channel: channelGhProxy,
      );
      expect(release, isNotNull);
      expect(release!.version, version);
      expect(release.apkName, apkName);
      // The stored URL stays canonical; the channel is applied when fetching.
      expect(
        release.apkUrl,
        'https://github.com/tyuan511/fastvibe/releases/download/'
        'app-v$version/$apkName',
      );
      expect(release.apkSize, 123456);
      expect(requests.where((url) => url.contains('releases/download/')), everyElement(startsWith('https://gh-proxy.com/https://github.com/')));
      expect(requests.where((url) => url.contains('releases.atom')), everyElement(startsWith('https://gh-proxy.com/')));
      expect(requests, everyElement(startsWith('https://gh-proxy.com/')));
    });
  });

  group('fetchReleaseNotes', () {
    test('a refused atom feed falls back to the raw note file', () async {
      final client = MockClient((request) async {
        final url = request.url.toString();
        if (url.endsWith('releases.atom')) {
          return http.Response('blocked', 403);
        }
        if (url.contains('raw.githubusercontent.com')) {
          return http.Response('## app-v0.5.14\n\n- a fix\n', 200);
        }
        return http.Response('unexpected: $url', 404);
      });
      final notes = await fetchReleaseNotes(
        '0.5.14',
        client: client,
        channel: channelGhfast,
      );
      expect(notes, '## app-v0.5.14\n\n- a fix');
    });

    test('a 404 note file answers null, not an error', () async {
      final client = MockClient((request) async {
        final url = request.url.toString();
        if (url.endsWith('releases.atom')) return http.Response('', 404);
        return http.Response('', 404);
      });
      expect(
        await fetchReleaseNotes('0.5.14', client: client),
        isNull,
      );
    });
  });

  group('resetUpdateCheck', () {
    test('drops the cached answer and backoff, keeps the channel', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'fastvibe.preferences.v1': '1',
        'fastvibe.preferences.v1.updateChannel': 'ghfast',
        'fastvibe.update.checked.v1': '{"at": 1, "release": null}',
        'fastvibe.update.backoffUntil.v1': 42,
        'fastvibe.update.skipped.v1': '0.5.14',
      });
      await Preferences.instance.load();
      expect(Preferences.instance.updateChannel, same(channelGhfast));

      await resetUpdateCheck();

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('fastvibe.update.checked.v1'), isNull);
      expect(prefs.getString('fastvibe.update.backoffUntil.v1'), isNull);
      // A skipped version is a decision about a version, not about a channel.
      expect(prefs.getString('fastvibe.update.skipped.v1'), '0.5.14');
      expect(Preferences.instance.updateChannel, same(channelGhfast));
    });

    test('a channel choice survives a reload', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      await Preferences.instance.load();
      await Preferences.instance.setUpdateChannel(channelGhfast);
      await Preferences.instance.load();
      expect(Preferences.instance.updateChannel, same(channelGhfast));
      await Preferences.instance.setUpdateChannel(channelGithub);
      await Preferences.instance.load();
      expect(Preferences.instance.updateChannel, same(channelGithub));
    });
  });
}
