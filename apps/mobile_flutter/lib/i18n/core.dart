

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'en.dart';
import 'zh.dart';

/// The phone's strings, in two languages.
///
/// The dictionaries are generated from the Expo client's (`tool/gen_i18n.mjs`), so the
/// Chinese copy is byte-identical and the key set cannot drift. `t` reads the language at
/// call time, so a string built in an event handler or an error follows a switch made
/// after the module loaded.
enum AppLanguage { zh, en }

/// What the user picked in 设置 → 语言; `system` follows the phone.
enum LanguagePreference { system, zh, en }

class I18n extends ChangeNotifier {
  I18n._();

  static final I18n instance = I18n._();

  static const String _key = 'fastvibe.language.v1';

  /// The device list's storage key — its presence marks an install from before i18n.
  static const String _serversKey = 'fastvibe.servers.v1';

  LanguagePreference _preference = LanguagePreference.system;
  AppLanguage _current = systemLanguage();

  LanguagePreference get preference => _preference;

  AppLanguage get language => _current;

  /// Chinese for any `zh*` locale, English for everything else.
  static AppLanguage systemLanguage() {
    final String tag;
    try {
      tag = PlatformDispatcher.instance.locale.toLanguageTag().toLowerCase();
    } catch (_) {
      return AppLanguage.zh;
    }
    return tag.startsWith('zh') ? AppLanguage.zh : AppLanguage.en;
  }

  /// Read the stored choice before the first screen draws.
  ///
  /// An install that predates the setting keeps 中文 — the only language it ever had —
  /// rather than switching to English because the phone's system language is English;
  /// a new install follows the system. Same rule as the desktop's 界面语言.
  Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final stored = prefs.getString(_key);
      if (stored != 'system' && stored != 'zh' && stored != 'en') {
        final legacy = prefs.getString(_serversKey) != null;
        final next = legacy ? LanguagePreference.zh : LanguagePreference.system;
        await prefs.setString(_key, next.name);
        _apply(next, notify: false);
        return;
      }
      _apply(LanguagePreference.values.byName(stored!), notify: false);
    } catch (_) {
      _apply(LanguagePreference.system, notify: false);
    }
  }

  Future<void> setPreference(LanguagePreference next) async {
    _apply(next);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, next.name);
    } catch (_) {
      // A preference that cannot be written still applies for this run.
    }
  }

  void _apply(LanguagePreference next, {bool notify = true}) {
    _preference = next;
    _current = switch (next) {
      LanguagePreference.system => systemLanguage(),
      LanguagePreference.zh => AppLanguage.zh,
      LanguagePreference.en => AppLanguage.en,
    };
    if (notify) notifyListeners();
  }

  /// `t('devices.deleteBody', {name})` — `{name}` in the message is replaced. With
  /// `count: 1`, a `<key>_one` entry wins where the language has one (English does:
  /// "1 chat", not "1 chats"; Chinese needs none).
  String t(String key, [Map<String, Object?>? vars]) {
    final dictionary = _current == AppLanguage.zh ? zh : en;
    String? template = vars?['count'] == 1 ? dictionary['${key}_one'] : null;
    template ??= dictionary[key] ?? zh[key] ?? key;
    if (vars == null || vars.isEmpty) return template;
    return template.replaceAllMapped(RegExp(r'\{(\w+)\}'), (match) {
      final name = match.group(1)!;
      return vars.containsKey(name) ? '${vars[name]}' : match.group(0)!;
    });
  }

  /// The locale tag `intl`-free date formatting should use.
  String get localeTag => _current == AppLanguage.zh ? 'zh-CN' : 'en-US';
}

/// The one entry point every widget uses: `t('common.save')`.
///
/// A call that builds text a widget draws passes `context:`. That registers the
/// widget on the language scope the app root publishes, so a switch in 设置 re-runs
/// the build of every page already on the stack. Without it a route stays as it was
/// drawn: the root rebuilds, but the router keeps each page by its key and never
/// asks it to build again, so the new language only appears after the page is
/// reopened. A string built for a toast, an error or a notification has no widget to
/// rebuild and omits it — it is read at the moment it is shown.
String t(String key, {Map<String, Object?>? vars, BuildContext? context}) {
  // `mounted` because a call from an event handler can arrive after the page it was
  // drawn on has closed, and registering a dependency on a dead element throws.
  if (context != null && context.mounted) {
    context.dependOnInheritedWidgetOfExactType<LanguageScope>();
  }
  return I18n.instance.t(key, vars);
}

/// Publishes the active language down the tree. The app root rebuilds it whenever
/// [I18n] notifies, which is what makes a `t(key, context: context)` call rebuild.
class LanguageScope extends InheritedWidget {
  const LanguageScope({
    super.key,
    required this.language,
    required super.child,
  });

  final AppLanguage language;

  @override
  bool updateShouldNotify(LanguageScope oldWidget) =>
      oldWidget.language != language;
}

I18n get i18n => I18n.instance;

const List<String> _months = <String>[
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// `9月3日` / `Sep 3`, with the year when it is not this one.
String formatMonthDay(DateTime date, {required bool withYear}) {
  final vars = <String, Object?>{
    'year': date.year,
    'month': date.month,
    'monthName': _months[date.month - 1],
    'day': date.day,
  };
  return withYear
      ? t('time.yearMonthDay', vars: vars)
      : t('time.monthDay', vars: vars);
}
