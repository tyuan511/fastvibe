import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../app_info.dart';
import '../i18n/core.dart';
import 'release.dart';

/// Android self-update from GitHub Releases: the APK is downloaded into the cache
/// directory and handed to the system package installer, which does the part that
/// matters — it refuses an APK not signed with the key the installed app was. So no
/// checksum of our own guards the install; the size check only tells a finished download
/// from one the network cut short.
///
/// iOS has no sideloading, so every entry point here is a no-op there.
bool get updatesSupported => !kIsWeb && Platform.isAndroid;

const String _skippedKey = 'fastvibe.update.skipped.v1';

/// How long an answer is reused. Not the process lifetime: backing out of the app on
/// Android keeps the process alive, so a "no update" cached per launch outlived the
/// release it predated and reopening the app never looked again.
const Duration _checkFresh = Duration(minutes: 10);

/// Per request. A network that silently drops GitHub's packets (common on mainland
/// mobile data) otherwise leaves a check hanging for minutes, and a manual 检查更新
/// spinning that long reads as broken rather than as "GitHub is unreachable".
const Duration _requestTimeout = Duration(seconds: 15);
const Duration _downloadTimeout = Duration(minutes: 10);

Future<AppRelease?>? _inflight;
({int at, AppRelease? release})? _settled;

Future<AppRelease?> checkForUpdate({bool force = false}) {
  if (!updatesSupported) return Future<AppRelease?>.value();
  final inflight = _inflight;
  if (inflight != null) return inflight;
  final settled = _settled;
  if (!force &&
      settled != null &&
      DateTime.now().millisecondsSinceEpoch - settled.at <
          _checkFresh.inMilliseconds) {
    return Future<AppRelease?>.value(settled.release);
  }
  final check = () async {
    final device = await DeviceInfoPlugin().androidInfo;
    return findNewerRelease(appVersion, supportedAbis: device.supportedAbis);
  }();
  _inflight = check;
  check
      .then(
        (release) => _settled = (
          at: DateTime.now().millisecondsSinceEpoch,
          release: release,
        ),
        // A failure is not remembered, so the next ask tries again.
        onError: (Object _) {},
      )
      .whenComplete(() {
        if (identical(_inflight, check)) _inflight = null;
      });
  return check;
}

/// A failed check as a sentence for the user; the raw error of a blocked request says
/// nothing.
String describeCheckError(Object error) {
  final message = error is Error ? error.toString() : '$error';
  if (error is TimeoutException || message.toLowerCase().contains('timeout')) {
    return t('update.githubTimeout');
  }
  if (message.contains('SocketException') || message.contains('network')) {
    return t('update.githubUnreachable');
  }
  if (error is GitHubStatusError && error.status == 403) {
    return t('update.githubRateLimited');
  }
  return message;
}

final List<void Function(AppRelease)> _releaseListeners =
    <void Function(AppRelease)>[];

void onReleaseAnnounced(void Function(AppRelease) listener) =>
    _releaseListeners.add(listener);

void offReleaseAnnounced(void Function(AppRelease) listener) =>
    _releaseListeners.remove(listener);

void announceRelease(AppRelease release) {
  for (final listener in List<void Function(AppRelease)>.from(
    _releaseListeners,
  )) {
    listener(release);
  }
}

Future<String?> skippedVersion() async {
  final prefs = await SharedPreferences.getInstance();
  return prefs.getString(_skippedKey);
}

Future<void> skipVersion(String version) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(_skippedKey, version);
}

Future<void> clearSkippedVersion() async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.remove(_skippedKey);
}

Future<Directory> _apkDirectory() async {
  final cache = await getTemporaryDirectory();
  final directory = Directory('${cache.path}/updates');
  if (!directory.existsSync()) directory.createSync(recursive: true);
  return directory;
}

File? downloadedApk(AppRelease release) {
  // The path is resolved asynchronously, so the caller checks by name after a download.
  return null;
}

/// Download the APK, reporting progress as a fraction. Throws when the bytes do not
/// arrive whole — a cut download is not an installable file.
Future<File> downloadApk(
  AppRelease release, {
  void Function(double progress)? onProgress,
  CancelToken? cancelToken,
}) async {
  final directory = await _apkDirectory();
  final target = File('${directory.path}/${release.apkName}');
  final dio = Dio(
    BaseOptions(
      connectTimeout: _requestTimeout,
      receiveTimeout: _downloadTimeout,
      followRedirects: true,
    ),
  );
  await dio.download(
    release.apkUrl,
    target.path,
    cancelToken: cancelToken,
    onReceiveProgress: (received, total) {
      final denominator = total > 0 ? total : release.apkSize;
      if (denominator > 0) {
        onProgress?.call((received / denominator).clamp(0, 1));
      }
    },
  );
  if (release.apkSize > 0 && await target.length() != release.apkSize) {
    await target.delete().catchError((Object _) => target);
    throw StateError(t('update.incomplete'));
  }
  return target;
}

/// Hand the APK to the system installer. Android asks the user to confirm, which is the
/// only way an app may install a package.
Future<void> installApk(File file) async {
  final result = await OpenFilex.open(
    file.path,
    type: 'application/vnd.android.package-archive',
  );
  if (result.type != ResultType.done) {
    throw StateError(t('update.installerFailed'));
  }
}

/// Remove APKs from older checks so the cache does not grow one release at a time.
Future<void> removeStaleApks() async {
  try {
    final directory = await _apkDirectory();
    for (final entry in directory.listSync()) {
      if (entry is File && entry.path.endsWith('.apk')) {
        await entry.delete();
      }
    }
  } catch (_) {
    // A cache that cannot be cleaned is not worth failing a check over.
  }
}
