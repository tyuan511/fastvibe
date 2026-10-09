import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Settings that belong to this phone, not to the machine it connects to: the theme,
/// whether taps buzz, and whether background activity raises local notifications.
/// (The language is `i18n/core.dart`.) Read once before the first screen draws.
enum ThemePreference { system, light, dark }

class Preferences extends ChangeNotifier {
  Preferences._();

  static final Preferences instance = Preferences._();

  static const String _key = 'fastvibe.preferences.v1';

  ThemePreference _theme = ThemePreference.system;
  bool _haptics = true;
  bool _notifications = true;
  bool _reduceGlass = false;

  ThemePreference get theme => _theme;

  bool get haptics => _haptics;

  bool get notifications => _notifications;
  bool get reduceGlass => _reduceGlass;

  ThemeMode get themeMode => switch (_theme) {
    ThemePreference.system => ThemeMode.system,
    ThemePreference.light => ThemeMode.light,
    ThemePreference.dark => ThemeMode.dark,
  };

  Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null) return;
      final theme = prefs.getString('$_key.theme');
      _theme = switch (theme) {
        'light' => ThemePreference.light,
        'dark' => ThemePreference.dark,
        _ => ThemePreference.system,
      };
      _haptics = prefs.getBool('$_key.haptics') ?? true;
      _notifications = prefs.getBool('$_key.notifications') ?? true;
      _reduceGlass = prefs.getBool('$_key.reduceGlass') ?? false;
    } catch (_) {
      // An unreadable preference file leaves the defaults, which are usable.
    }
  }

  Future<void> setTheme(ThemePreference value) async {
    _theme = value;
    notifyListeners();
    await _write();
  }

  Future<void> setHaptics(bool value) async {
    _haptics = value;
    notifyListeners();
    await _write();
  }

  Future<void> setNotifications(bool value) async {
    _notifications = value;
    notifyListeners();
    await _write();
  }

  Future<void> setReduceGlass(bool value) async {
    _reduceGlass = value;
    notifyListeners();
    await _write();
  }

  Future<void> _write() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, '1');
      await prefs.setString('$_key.theme', _theme.name);
      await prefs.setBool('$_key.haptics', _haptics);
      await prefs.setBool('$_key.notifications', _notifications);
      await prefs.setBool('$_key.reduceGlass', _reduceGlass);
    } catch (_) {
      // A preference that cannot be written still applies for this run.
    }
  }
}

/// Fire-and-forget haptics. A device with the feature off must not fail a tap because it
/// could not buzz. 设置 → 触感反馈 turns them all off at once.
abstract final class Haptic {
  static void tap() => _fire(HapticFeedback.lightImpact);

  static void select() => _fire(HapticFeedback.selectionClick);

  static void press() => _fire(HapticFeedback.mediumImpact);

  static void success() => _fire(HapticFeedback.mediumImpact);

  static void warning() => _fire(HapticFeedback.heavyImpact);

  static void _fire(Future<void> Function() effect) {
    if (!Preferences.instance.haptics) return;
    effect().catchError((Object _) {});
  }
}
