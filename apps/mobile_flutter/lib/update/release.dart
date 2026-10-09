import 'dart:convert';

import 'package:http/http.dart' as http;

import '../i18n/core.dart';

/// Finding the newest Android build on GitHub Releases.
///
/// The repository's releases are shared with the desktop app and its agent runtime, which
/// ship several times a day, so neither `releases/latest` (a desktop version) nor the
/// first page of `releases` (a phone release a few weeks old has scrolled off it) can
/// answer "what is the newest phone build". The tags can: every phone release is an
/// `app-v<version>` tag, and `git/matching-refs` lists exactly those.
///
/// A tag is not yet a release — CI pushes the tag, then spends ten minutes building before
/// it publishes — so the newest tag without a published APK is skipped in favour of the
/// one below it.
const String releaseRepo = 'tyuan511/fastvibe';
const String releaseTagPrefix = 'app-v';

const String _api = 'https://api.github.com';

/// Tags tried, newest first, before giving up on finding a published build.
const int _maxTagsTried = 3;

const Map<String, String> _headers = <String, String>{
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

class AppRelease {
  const AppRelease({
    required this.version,
    required this.tag,
    required this.notes,
    required this.pageUrl,
    required this.apkUrl,
    required this.apkName,
    required this.apkSize,
  });

  final String version;
  final String tag;

  /// The release body: `docs/release/app-v<version>.md`, the note committed with the
  /// version bump. Markdown; read it through [notesForDisplay].
  final String notes;
  final String pageUrl;
  final String apkUrl;
  final String apkName;

  /// Bytes, as GitHub reports them; used to tell a finished download from a cut one.
  final int apkSize;
}

List<int>? parseVersion(String raw) {
  final match = RegExp(r'^v?(\d+)\.(\d+)\.(\d+)$').firstMatch(raw.trim());
  if (match == null) return null;
  return <int>[
    int.parse(match.group(1)!),
    int.parse(match.group(2)!),
    int.parse(match.group(3)!),
  ];
}

/// Negative when `a` is older than `b`. Unparseable versions sort below everything.
int compareVersions(String a, String b) {
  final left = parseVersion(a);
  final right = parseVersion(b);
  if (left == null || right == null) {
    return left != null ? 1 : (right != null ? -1 : 0);
  }
  for (var index = 0; index < 3; index++) {
    if (left[index] != right[index]) return left[index] - right[index];
  }
  return 0;
}

/// `refs/tags/app-v0.2.0` → `0.2.0`; anything else → null.
String? versionFromRef(String ref) {
  final prefix = 'refs/tags/$releaseTagPrefix';
  if (!ref.startsWith(prefix)) return null;
  final version = ref.substring(prefix.length);
  return parseVersion(version) != null ? version : null;
}

/// Phone versions named by `git/matching-refs`, newest first.
List<String> versionsFromRefs(Object? refs) {
  if (refs is! List) return <String>[];
  final versions = <String>{};
  for (final entry in refs) {
    if (entry is! Map) continue;
    final version = versionFromRef('${entry['ref'] ?? ''}');
    if (version != null) versions.add(version);
  }
  final sorted = versions.toList()..sort((a, b) => compareVersions(b, a));
  return sorted;
}

/// A `releases/tags/<tag>` body as an installable release, or null when it has no APK.
AppRelease? releaseFromPayload(
  String version,
  Object? payload, {
  List<String> supportedAbis = const [],
}) {
  if (payload is! Map) return null;
  if (payload['draft'] == true || payload['prerelease'] == true) return null;
  final assets = payload['assets'];
  if (assets is! List) return null;
  final candidates = assets
      .whereType<Map>()
      .where(
        (asset) =>
            asset['name'] is String &&
            (asset['name'] as String).toLowerCase().endsWith('.apk') &&
            asset['browser_download_url'] is String,
      )
      .toList();
  const knownAbis = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
  String? architecture(Map asset) => knownAbis
      .where((abi) => (asset['name'] as String).contains(abi))
      .firstOrNull;
  Map<dynamic, dynamic>? apk;
  for (final abi in supportedAbis) {
    apk = candidates.where((asset) => architecture(asset) == abi).firstOrNull;
    if (apk != null) break;
  }
  apk ??= candidates.where((asset) => architecture(asset) == null).firstOrNull;
  if (apk == null) return null;
  return AppRelease(
    version: version,
    tag: payload['tag_name'] is String
        ? payload['tag_name'] as String
        : '$releaseTagPrefix$version',
    notes: payload['body'] is String ? (payload['body'] as String).trim() : '',
    pageUrl: payload['html_url'] is String
        ? payload['html_url'] as String
        : 'https://github.com/$releaseRepo/releases',
    apkUrl: apk['browser_download_url'] as String,
    apkName: apk['name'] as String,
    apkSize: apk['size'] is num ? (apk['size'] as num).toInt() : 0,
  );
}

/// A release note as the app shows it. The note is written for the GitHub Release page,
/// whose last line is a `**Full Changelog**` compare link between two tags — a diff
/// nobody reads on a phone.
String notesForDisplay(String body) => body
    .split('\n')
    .where((line) => !line.trimLeft().startsWith('**Full Changelog**'))
    .join('\n')
    .trim();

/// The release page of one phone version, for when its note cannot be read in the app.
String releasePageUrl(String version) =>
    'https://github.com/$releaseRepo/releases/tag/$releaseTagPrefix$version';

/// The note of one published phone version, as written in `docs/release/app-v<version>.md`
/// (the workflow publishes that file as the release body). Null when the version was
/// never published — a debug build, or a tag whose build has not finished. Unlike
/// [findNewerRelease] this needs no APK, so it answers on iOS too.
Future<String?> fetchReleaseNotes(String version, {http.Client? client}) async {
  final httpClient = client ?? http.Client();
  try {
    final response = await httpClient
        .get(
          Uri.parse(
            '$_api/repos/$releaseRepo/releases/tags/$releaseTagPrefix$version',
          ),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 20));
    if (response.statusCode == 404) return null;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw GitHubStatusError(response.statusCode);
    }
    final payload = jsonDecode(response.body);
    if (payload is! Map || payload['draft'] == true) return null;
    final body = payload['body'];
    return body is String ? notesForDisplay(body) : '';
  } finally {
    if (client == null) httpClient.close();
  }
}

/// GitHub answered with an error status; `status` is what callers branch on.
class GitHubStatusError extends Error {
  GitHubStatusError(this.status)
    : message = t('update.githubStatus', vars: <String, Object?>{'status': status});

  final int status;
  final String message;

  @override
  String toString() => message;
}

/// The newest published phone build strictly newer than `currentVersion`, or null when
/// this install is current. Throws on a network or API failure, so a caller can tell
/// "up to date" from "could not check".
Future<AppRelease?> findNewerRelease(
  String currentVersion, {
  http.Client? client,
  List<String> supportedAbis = const [],
}) async {
  final httpClient = client ?? http.Client();
  try {
    final refsResponse = await httpClient
        .get(
          Uri.parse(
            '$_api/repos/$releaseRepo/git/matching-refs/tags/$releaseTagPrefix',
          ),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 20));
    if (refsResponse.statusCode < 200 || refsResponse.statusCode >= 300) {
      throw GitHubStatusError(refsResponse.statusCode);
    }
    final newer = versionsFromRefs(jsonDecode(refsResponse.body))
        .where((version) => compareVersions(version, currentVersion) > 0)
        .toList();

    for (final version in newer.take(_maxTagsTried)) {
      final response = await httpClient
          .get(
            Uri.parse(
              '$_api/repos/$releaseRepo/releases/tags/$releaseTagPrefix$version',
            ),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 20));
      // 404: the tag is pushed but CI has not published it yet (or the build failed).
      if (response.statusCode == 404) continue;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw GitHubStatusError(response.statusCode);
      }
      final release = releaseFromPayload(
        version,
        jsonDecode(response.body),
        supportedAbis: supportedAbis,
      );
      if (release != null) return release;
    }
    return null;
  } finally {
    if (client == null) httpClient.close();
  }
}
