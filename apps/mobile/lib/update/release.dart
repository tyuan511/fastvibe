import 'dart:convert';

import 'package:http/http.dart' as http;

import '../app_info.dart';
import '../i18n/core.dart';

/// Finding the newest Android build on GitHub.
///
/// Not the REST API. Unauthenticated `api.github.com` allows 60 requests an hour per IP,
/// and a phone on a carrier network shares that IP with everyone else on it — which is
/// why a check here came back 403 over and over. The desktop updater already avoids that
/// host for the same reason and reads `github.com` instead. So does this: the tag list is
/// the public git advertisement (every `app-v*` tag, so a phone release that has scrolled
/// off the releases page is still found), and the APK is the release's own download URL.
///
/// A tag is not yet a release — CI pushes the tag, then spends ten minutes building before
/// it publishes — so the newest tag whose APK is not there yet is skipped for the one below.
const String releaseRepo = 'tyuan511/fastvibe';
const String releaseTagPrefix = 'app-v';

/// Tags tried, newest first, before giving up on finding a published build.
const int _maxTagsTried = 3;

const String _refsUrl =
    'https://github.com/$releaseRepo.git/info/refs?service=git-upload-pack';
const String _atomUrl = 'https://github.com/$releaseRepo/releases.atom';

const List<String> _knownAbis = <String>[
  'arm64-v8a',
  'armeabi-v7a',
  'x86_64',
  'x86',
];

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

/// APK file names to try, the device's own ABI first and a universal package last.
List<String> apkCandidates(String version, List<String> supportedAbis) {
  final names = <String>[];
  final seen = <String>{};
  for (final abi in supportedAbis) {
    if (!_knownAbis.contains(abi)) continue;
    final name = 'FastVibe-$releaseTagPrefix$version-$abi.apk';
    if (seen.add(name)) names.add(name);
  }
  if (seen.add('FastVibe.apk')) names.add('FastVibe.apk');
  return names;
}

String apkDownloadUrl(String version, String name) =>
    'https://github.com/$releaseRepo/releases/download/$releaseTagPrefix$version/$name';

String _notesFileUrl(String version) =>
    'https://raw.githubusercontent.com/$releaseRepo/$releaseTagPrefix$version/docs/release/$releaseTagPrefix$version.md';

/// `refs/tags/app-v*` lines out of a git advertisement, newest first.
///
/// Anything that is not exactly `app-v<major>.<minor>.<patch>` is dropped, which is
/// what keeps a desktop tag and an `app-v0.6.0-rc1` out of the list.
List<String> versionsFromAdvertisement(String body) {
  final versions = <String>{};
  for (final match in RegExp(r'refs/tags/\S+').allMatches(body)) {
    final version = versionFromRef(match.group(0)!);
    if (version != null) versions.add(version);
  }
  final sorted = versions.toList()..sort((a, b) => compareVersions(b, a));
  return sorted;
}

/// One release's notes out of a `releases.atom` document, or null when it is not there.
///
/// The feed only carries the newest releases, so a version that has scrolled off comes
/// back null and the caller reads `docs/release/app-v<version>.md` instead.
String? notesFromAtom(String xml, String version) {
  final id = '/$releaseTagPrefix$version</id>';
  for (final match in RegExp(
    r'<entry\b[^>]*>[\s\S]*?</entry>',
  ).allMatches(xml)) {
    final block = match.group(0)!;
    if (!block.contains(id)) continue;
    final content = RegExp(
      r'<content\b[^>]*>([\s\S]*?)</content>',
    ).firstMatch(block);
    if (content == null) return '';
    return notesForDisplay(
      markdownFromGitHubHtml(_xmlUnescape(content.group(1)!)),
    );
  }
  return null;
}

/// GitHub's rendered release notes (the atom `<content>`) back into markdown.
String markdownFromGitHubHtml(String html) {
  var text = html;
  text = text.replaceAllMapped(
    RegExp(
      r'<pre[^>]*>\s*<code[^>]*>([\s\S]*?)</code>\s*</pre>',
      caseSensitive: false,
    ),
    (match) => '\n```\n${_inlineHtml(match.group(1)!)}\n```\n',
  );
  text = text.replaceAllMapped(
    RegExp(r'<h([1-6])[^>]*>([\s\S]*?)</h\1>', caseSensitive: false),
    (match) =>
        '\n${"#" * int.parse(match.group(1)!)} ${_inlineHtml(match.group(2)!)}\n\n',
  );
  text = text.replaceAllMapped(
    RegExp(r'<li[^>]*>([\s\S]*?)</li>', caseSensitive: false),
    (match) => '\n- ${_inlineHtml(match.group(1)!)}\n',
  );
  text = text.replaceAll(RegExp(r'<br\s*/?>', caseSensitive: false), '\n');
  text = text.replaceAll(RegExp(r'</p>', caseSensitive: false), '\n\n');
  text = text.replaceAll(RegExp(r'<p[^>]*>', caseSensitive: false), '');
  text = text.replaceAll(
    RegExp(r'</?(ul|ol)[^>]*>', caseSensitive: false),
    '\n',
  );
  text = _inlineHtml(text);
  return text.replaceAll(RegExp(r'\n{3,}'), '\n\n').trim();
}

String _inlineHtml(String html) {
  var text = html.replaceAllMapped(
    RegExp(r'<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', caseSensitive: false),
    (match) {
      final href = _xmlUnescape(match.group(1)!);
      final label = _xmlUnescape(
        match.group(2)!.replaceAll(RegExp(r'<[^>]+>'), ''),
      ).trim();
      if (label.isEmpty || label == href) return href;
      return '[$label]($href)';
    },
  );
  text = text.replaceAllMapped(
    RegExp(r'<strong\b[^>]*>([\s\S]*?)</strong>', caseSensitive: false),
    (match) =>
        '**${_xmlUnescape(match.group(1)!.replaceAll(RegExp(r'<[^>]+>'), ''))}**',
  );
  text = text.replaceAllMapped(
    RegExp(r'<em\b[^>]*>([\s\S]*?)</em>', caseSensitive: false),
    (match) => '*${_xmlUnescape(match.group(1)!)}*',
  );
  text = text.replaceAllMapped(
    RegExp(r'<code\b[^>]*>([\s\S]*?)</code>', caseSensitive: false),
    (match) => '`$_xmlUnescape(match.group(1)!)`',
  );
  text = text.replaceAll(RegExp(r'<[^>]+>'), '');
  return _xmlUnescape(text);
}

String _xmlUnescape(String value) => value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');

Map<String, String> get _requestHeaders => <String, String>{
  'User-Agent': 'FastVibe/$appVersion',
};

/// The note of one published phone version. The atom feed carries it while the release
/// is recent; otherwise it is `docs/release/app-v<version>.md` at that tag. Null when
/// the version was never published. Unlike [findNewerRelease] this needs no APK, so it
/// answers on iOS too.
Future<String?> fetchReleaseNotes(String version, {http.Client? client}) async {
  final httpClient = client ?? http.Client();
  try {
    final atom = await _send(httpClient, Uri.parse(_atomUrl));
    if (atom.statusCode == 403 || atom.statusCode == 429) {
      throw GitHubStatusError(atom.statusCode);
    }
    if (atom.statusCode >= 200 && atom.statusCode < 300) {
      final notes = notesFromAtom(atom.body, version);
      if (notes != null) return notes;
    }
    final file = await _send(httpClient, Uri.parse(_notesFileUrl(version)));
    if (file.statusCode == 404) return null;
    _requireOk(file);
    return notesForDisplay(file.body);
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
/// this install is current. Throws on a network or GitHub failure, so a caller can tell
/// "up to date" from "could not check".
Future<AppRelease?> findNewerRelease(
  String currentVersion, {
  http.Client? client,
  List<String> supportedAbis = const [],
}) async {
  final httpClient = client ?? http.Client();
  try {
    final refs = await _send(httpClient, Uri.parse(_refsUrl));
    _requireOk(refs);
    // The advertisement is pkt-line and may carry a null; latin1 keeps every byte.
    final newer = versionsFromAdvertisement(latin1.decode(refs.bodyBytes))
        .where((version) => compareVersions(version, currentVersion) > 0)
        .toList();

    for (final version in newer.take(_maxTagsTried)) {
      final apk = await _publishedApk(httpClient, version, supportedAbis);
      if (apk == null) continue;
      return AppRelease(
        version: version,
        tag: '$releaseTagPrefix$version',
        notes: await _notesOrEmpty(httpClient, version),
        pageUrl: releasePageUrl(version),
        apkUrl: apkDownloadUrl(version, apk.name),
        apkName: apk.name,
        apkSize: apk.size,
      );
    }
    return null;
  } finally {
    if (client == null) httpClient.close();
  }
}

Future<({String name, int size})?> _publishedApk(
  http.Client client,
  String version,
  List<String> supportedAbis,
) async {
  for (final name in apkCandidates(version, supportedAbis)) {
    final response = await _send(
      client,
      Uri.parse(apkDownloadUrl(version, name)),
      head: true,
    );
    // 404: the tag is pushed but CI has not published this file yet.
    if (response.statusCode == 404) continue;
    _requireOk(response, allowRedirect: true);
    final length = int.tryParse(response.headers['content-length'] ?? '') ?? 0;
    return (name: name, size: length);
  }
  return null;
}

/// Notes are decoration on the update prompt. A feed that cannot be read must not
/// turn a found release into a failed check.
Future<String> _notesOrEmpty(http.Client client, String version) async {
  try {
    return await fetchReleaseNotes(version, client: client) ?? '';
  } catch (_) {
    return '';
  }
}

Future<http.Response> _send(
  http.Client client,
  Uri uri, {
  bool head = false,
}) {
  final request = head
      ? client.head(uri, headers: _requestHeaders)
      : client.get(uri, headers: _requestHeaders);
  return request.timeout(const Duration(seconds: 20));
}

void _requireOk(http.Response response, {bool allowRedirect = false}) {
  final status = response.statusCode;
  if (status >= 200 && status < 300) return;
  if (allowRedirect && (status == 301 || status == 302)) return;
  throw GitHubStatusError(status);
}
