import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:crypto/crypto.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

const MethodChannel _channel = MethodChannel('dev.fastvibe.mobile/device');
const String _fallbackKey = 'fastvibe.deviceId.v1';

String? _cached;

/// A stable id for this phone, which the desktop uses to tell one phone reconnecting from
/// two phones.
///
/// It is what the platform lets an app read, hashed together with a fixed label so the raw
/// value never leaves the phone: `ANDROID_ID` on Android (kept across reinstalls),
/// `identifierForVendor` on iOS. A hardware serial or IMEI is not readable by an app on
/// either. When the system gives nothing, a random id saved on first use stands in, which
/// is only as stable as the install.
Future<String> stableDeviceId() async {
  final cached = _cached;
  if (cached != null) return cached;
  final raw = await _platformId() ?? await _fallbackId();
  return _cached = sha256.convert(utf8.encode('fastvibe-device:$raw')).toString().substring(0, 32);
}

Future<String?> _platformId() async {
  try {
    String? id;
    if (Platform.isAndroid) {
      id = await _channel.invokeMethod<String>('deviceId');
    } else if (Platform.isIOS) {
      id = (await DeviceInfoPlugin().iosInfo).identifierForVendor;
    }
    return id == null || id.isEmpty ? null : id;
  } catch (_) {
    return null;
  }
}

Future<String> _fallbackId() async {
  final prefs = await SharedPreferences.getInstance();
  final saved = prefs.getString(_fallbackKey);
  if (saved != null && saved.isNotEmpty) return saved;
  final random = math.Random.secure();
  final fresh = List<String>.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  await prefs.setString(_fallbackKey, fresh);
  return fresh;
}
