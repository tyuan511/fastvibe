import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:fastvibe_mobile/update/release.dart';

void main() {
  Map<String, Object?> asset(String name) => {
    'name': name,
    'browser_download_url': 'https://example.test/$name',
    'size': 100,
  };
  test('Android selects the first supported architecture, independent of asset order', () {
    final payload = {
      'assets': [
        asset('app-x86_64-release.apk'),
        asset('app-armeabi-v7a-release.apk'),
        asset('app-arm64-v8a-release.apk'),
      ],
    };
    expect(
      releaseFromPayload(
        '0.5.0',
        payload,
        supportedAbis: ['arm64-v8a', 'armeabi-v7a'],
      )?.apkName,
      'app-arm64-v8a-release.apk',
    );
    expect(
      releaseFromPayload('0.5.0', payload, supportedAbis: ['x86_64'])?.apkName,
      'app-x86_64-release.apk',
    );
    expect(
      releaseFromPayload('0.5.0', payload, supportedAbis: ['unknown']),
      isNull,
    );
  });
  test('universal APKs remain a fallback but checksums and prereleases never install', () {
    final payload = {
      'assets': [
        asset('app-arm64-v8a-release.apk'),
        asset('FastVibe.apk.sha256'),
        asset('FastVibe.apk'),
      ],
    };
    expect(releaseFromPayload('0.5.0', payload)?.apkName, 'FastVibe.apk');
    expect(
      releaseFromPayload('0.5.0', {...payload, 'prerelease': true}),
      isNull,
    );
    expect(
      releaseFromPayload('0.5.0', {
        'assets': [asset('only.apk.sha256')],
      }),
      isNull,
    );
  });
  test('the published arm64 build is offered only to compatible devices', () {
    final payload = {
      'assets': [
        asset('FastVibe-app-v0.5.0-arm64-v8a.apk'),
        asset('FastVibe-app-v0.5.0-arm64-v8a.apk.sha256'),
      ],
    };
    expect(
      releaseFromPayload('0.5.0', payload, supportedAbis: ['arm64-v8a'])?.apkName,
      'FastVibe-app-v0.5.0-arm64-v8a.apk',
    );
    for (final abis in [['armeabi-v7a'], ['x86_64', 'x86']]) {
      expect(releaseFromPayload('0.5.0', payload, supportedAbis: abis), isNull);
    }
  });
  test('the tag advertisement sorts numerically and skips an unpublished build', () {
    final versions = versionsFromAdvertisement('''
0032abc refs/tags/app-v0.5.0
0033abc refs/tags/app-v0.10.0
0030abc refs/tags/v1.0.0
0038abc refs/tags/app-v0.6.0-rc1
0040abc refs/tags/app-v0.5.0^{}
''');
    expect(versions, ['0.10.0', '0.5.0']);
  });

  test('an arm64 phone is offered its own package, not the universal one', () {
    expect(apkCandidates('0.5.0', ['arm64-v8a', 'armeabi-v7a']), [
      'FastVibe-app-v0.5.0-arm64-v8a.apk',
      'FastVibe-app-v0.5.0-armeabi-v7a.apk',
      'FastVibe.apk',
    ]);
  });

  test('tags sort numerically and unfinished builds fall back to a published release', () async {
    final asked = <String>[];
    final client = MockClient((request) async {
      asked.add('${request.method} ${request.url}');
      if (request.url.path.endsWith('/info/refs')) {
        return http.Response(
          'refs/tags/app-v0.5.0\nrefs/tags/app-v0.10.0\nrefs/tags/v1.0.0\n',
          200,
        );
      }
      if (request.url.path.contains('app-v0.10.0')) {
        return http.Response('missing', 404);
      }
      if (request.method == 'HEAD') {
        return http.Response(
          '',
          200,
          headers: {'content-length': '42'},
        );
      }
      return http.Response('<feed></feed>', 200);
    });
    final release = await findNewerRelease('0.4.0', client: client);
    expect(release?.version, '0.5.0');
    expect(release?.apkName, 'FastVibe.apk');
    expect(release?.apkSize, 42);
    expect(release?.apkUrl, contains('/releases/download/app-v0.5.0/FastVibe.apk'));
    expect(asked.first, contains('info/refs'));
    expect(asked.any((url) => url.contains('api.github.com')), isFalse);
    client.close();
  });

  test('release notes drop the GitHub compare link, which means nothing on a phone', () {
    expect(
      notesForDisplay(
        '### Fixed\n\n- A bug.\n\n**Full Changelog**: https://example.test/compare/a...b\n',
      ),
      '### Fixed\n\n- A bug.',
    );
  });

  test('atom notes become markdown and drop the compare link', () {
    const xml = '''
<entry>
<id>tag:github.com,2008:Repository/1/app-v0.5.0</id>
<content type="html">&lt;h3&gt;Fixed&lt;/h3&gt;
&lt;ul&gt;
&lt;li&gt;A bug.&lt;/li&gt;
&lt;/ul&gt;
&lt;p&gt;&lt;strong&gt;Full Changelog&lt;/strong&gt;: &lt;a href="https://example.test/compare/a...b"&gt;https://example.test/compare/a...b&lt;/a&gt;&lt;/p&gt;</content>
</entry>
''';
    expect(notesFromAtom(xml, '0.5.0'), '### Fixed\n\n- A bug.');
  });

  test('the changelog reads the installed version, and an unpublished one is null', () async {
    final asked = <String>[];
    final client = MockClient((request) async {
      asked.add(request.url.path);
      if (request.url.path.endsWith('releases.atom')) {
        return http.Response(
          '<entry><id>tag:github.com,2008:Repository/1/app-v0.4.5</id>'
          '<content type="html">&lt;p&gt;Faster.&lt;/p&gt;</content></entry>',
          200,
        );
      }
      return http.Response('missing', 404);
    });
    expect(await fetchReleaseNotes('0.4.5', client: client), 'Faster.');
    expect(asked.single, endsWith('/releases.atom'));
    expect(await fetchReleaseNotes('0.0.1', client: client), isNull);
    expect(asked.last, endsWith('/docs/release/app-v0.0.1.md'));
    client.close();
  });
}
