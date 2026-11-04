import 'package:package_info_plus/package_info_plus.dart';

/// Read once at startup. The handshake reports it so Main can tell builds apart, and
/// 设置 → 关于 shows it.
String appVersion = '0.0.0';

Future<void> loadAppVersion() async {
  try {
    final info = await PackageInfo.fromPlatform();
    appVersion = info.version;
  } catch (_) {
    // A build without package metadata still connects; the version is cosmetic.
  }
}
