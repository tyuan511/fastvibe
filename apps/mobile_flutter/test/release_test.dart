import 'dart:convert';

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
  test('tags sort numerically and unfinished builds fall back to a published release', () async {
    final asked = <String>[];
    final client = MockClient((request) async {
      asked.add(request.url.path);
      if (request.url.path.contains('matching-refs')) {
        return http.Response(
          jsonEncode([
            {'ref': 'refs/tags/app-v0.5.0'},
            {'ref': 'refs/tags/app-v0.10.0'},
            {'ref': 'refs/tags/v1.0.0'},
            {'ref': 'refs/tags/app-v0.6.0-rc1'},
          ]),
          200,
        );
      }
      if (request.url.path.endsWith('app-v0.10.0')) {
        return http.Response('{}', 404);
      }
      return http.Response(
        jsonEncode({
          'assets': [asset('FastVibe.apk')],
        }),
        200,
      );
    });
    final release = await findNewerRelease('0.4.0', client: client);
    expect(release?.version, '0.5.0');
    expect(asked.last, endsWith('app-v0.5.0'));
    client.close();
  });
}
