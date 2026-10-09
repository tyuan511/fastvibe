import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_info.dart';
import '../chat/option_sheet.dart';
import '../i18n/core.dart';
import '../protocol/diagnostics.dart';
import '../theme/theme.dart';
import '../ui/feedback.dart';
import '../ui/glass_screen.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';
import '../notifications/local.dart';
import '../update/release.dart';
import '../update/updater.dart';

/// Settings that belong to this phone. Which model the agent runs and what it may do are
/// the machine's settings and stay in the chat's composer; this page is only the app
/// itself — how it looks, what language it speaks, and which build it is.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    i18n.addListener(_onChange);
    Preferences.instance.addListener(_onChange);
  }

  @override
  void dispose() {
    i18n.removeListener(_onChange);
    Preferences.instance.removeListener(_onChange);
    super.dispose();
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  Future<void> _checkForUpdates() async {
    setState(() => _checking = true);
    try {
      final release = await checkForUpdate(force: true);
      if (release != null) {
        announceRelease(release);
      } else {
        toastSuccess(t('update.upToDateVersion', {'version': appVersion}));
      }
    } catch (error) {
      toastError(describeCheckError(error));
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _copyDiagnostics() async {
    try {
      await copyToClipboard(connectionDiagnostics(appVersion));
      toastSuccess(t('common.copied'));
    } catch (_) {
      toastError(t('settings.diagnosticsCopyFailed'));
    }
  }

  Future<void> _pickLanguage() async {
    await showOptionSheet(
      context,
      title: t('settings.language'),
      subtitle: t('settings.languageHint'),
      value: i18n.preference.name,
      options: <SheetOption>[
        SheetOption(
          value: LanguagePreference.system.name,
          label: t('settings.system'),
          icon: AppIcons.globe,
          onSelect: () => i18n.setPreference(LanguagePreference.system),
        ),
        SheetOption(
          value: LanguagePreference.zh.name,
          label: '简体中文',
          onSelect: () => i18n.setPreference(LanguagePreference.zh),
        ),
        SheetOption(
          value: LanguagePreference.en.name,
          label: 'English',
          onSelect: () => i18n.setPreference(LanguagePreference.en),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final preferences = Preferences.instance;
    return GlassScreen(
      title: t('nav.settings'),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
        children: <Widget>[
          PageHeading(
            title: t('settings.preferencesTitle'),
            subtitle: t('settings.personalize'),
          ),
          _Section(
            title: t('settings.appearance'),
            palette: palette,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        _RowIcon(icon: AppIcons.sun, palette: palette),
                        const SizedBox(width: 12),
                        Text(
                          t('settings.theme'),
                          style: TextStyle(
                            color: palette.text,
                            fontSize: 16,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    _AppearancePreview(palette: palette),
                    const SizedBox(height: 18),
                    _Segmented(
                      palette: palette,
                      value: preferences.theme,
                      items: <ThemePreference, String>{
                        ThemePreference.system: t('settings.system'),
                        ThemePreference.light: t('settings.light'),
                        ThemePreference.dark: t('settings.dark'),
                      },
                      onChanged: (value) {
                        Haptic.select();
                        preferences.setTheme(value);
                      },
                    ),
                  ],
                ),
              ),
              _Divider(palette: palette),
              SettingsRow(
                icon: AppIcons.sparkles,
                label: t('settings.reduceGlass'),
                description: t('settings.reduceGlassHint'),
                trailing: GlassSwitch(
                  useOwnLayer: true,
                  enableHaptics: preferences.haptics,
                  activeColor: palette.accent,
                  value: preferences.reduceGlass,
                  onChanged: preferences.setReduceGlass,
                ),
              ),
              _Divider(palette: palette),
              SettingsRow(
                icon: AppIcons.globe,
                label: t('settings.language'),
                value: switch (i18n.preference) {
                  LanguagePreference.system => t('settings.system'),
                  LanguagePreference.zh => '简体中文',
                  LanguagePreference.en => 'English',
                },
                onTap: _pickLanguage,
              ),
            ],
          ),
          _Section(
            title: t('settings.general'),
            palette: palette,
            children: <Widget>[
              SettingsRow(
                icon: AppIcons.notification,
                label: t('settings.notifications'),
                description: t('settings.notificationsHint'),
                trailing: GlassSwitch(
                  useOwnLayer: true,
                  enableHaptics: preferences.haptics,
                  value: preferences.notifications,
                  thumbColor: palette.accentText,
                  activeColor: palette.accent,
                  onChanged: (value) async {
                    if (value) {
                      await enableLocalNotifications();
                    } else {
                      await preferences.setNotifications(false);
                    }
                    if (mounted) setState(() {});
                  },
                ),
              ),
              _Divider(palette: palette),
              SettingsRow(
                icon: AppIcons.touchInteraction,
                label: t('settings.haptics'),
                description: t('settings.hapticsHint'),
                trailing: GlassSwitch(
                  useOwnLayer: true,
                  enableHaptics: preferences.haptics,
                  value: preferences.haptics,
                  thumbColor: palette.accentText,
                  activeColor: palette.accent,
                  onChanged: (value) {
                    preferences.setHaptics(value);
                    if (value) Haptic.success();
                    setState(() {});
                  },
                ),
              ),
            ],
          ),
          _Section(
            title: t('settings.about'),
            palette: palette,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  children: <Widget>[
                    const BrandLogo(size: 52),
                    const SizedBox(width: 14),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          'FastVibe',
                          style: TextStyle(
                            color: palette.text,
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                            letterSpacing: -0.3,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          t('settings.versionValue', <String, Object?>{
                            'version': appVersion,
                          }),
                          style: TextStyle(color: palette.muted, fontSize: 13),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              if (updatesSupported) ...<Widget>[
                _Divider(palette: palette),
                SettingsRow(
                  icon: AppIcons.arrowUp,
                  label: t('update.check'),
                  onTap: _checking ? null : _checkForUpdates,
                  trailing: _checking
                      ? SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: palette.muted,
                          ),
                        )
                      : null,
                ),
              ],
              _Divider(palette: palette),
              SettingsRow(
                icon: AppIcons.information,
                label: t('settings.releaseNotes'),
                onTap: () => launchUrl(
                  Uri.parse('https://github.com/$releaseRepo/releases'),
                ),
              ),
              _Divider(palette: palette),
              SettingsRow(
                icon: AppIcons.copy,
                label: t('settings.connectionDiagnostics'),
                description: t('settings.connectionDiagnosticsHint'),
                onTap: _copyDiagnostics,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({
    required this.title,
    required this.palette,
    required this.children,
  });

  final String title;
  final Palette palette;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 0, 6, 8),
            child: Text(
              title,
              style: TextStyle(
                color: palette.muted,
                fontSize: 13,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          Container(
            decoration: BoxDecoration(
              color: palette.card,
              borderRadius: BorderRadius.circular(Radii.lg),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(children: children),
          ),
        ],
      ),
    );
  }
}

class _RowIcon extends StatelessWidget {
  const _RowIcon({required this.icon, required this.palette});

  final List<List<dynamic>> icon;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 30,
      height: 30,
      decoration: BoxDecoration(
        color: palette.accentSoft,
        borderRadius: BorderRadius.circular(9),
      ),
      child: Center(
        child: HugeIcon(
          icon: icon,
          size: 17,
          color: palette.accent,
          strokeWidth: 2,
        ),
      ),
    );
  }
}

class _Divider extends StatelessWidget {
  const _Divider({required this.palette});

  final Palette palette;

  @override
  Widget build(BuildContext context) => Container(
    height: 0.5,
    margin: const EdgeInsets.only(left: 56),
    color: palette.separator,
  );
}

class _Segmented extends StatelessWidget {
  const _Segmented({
    required this.palette,
    required this.value,
    required this.items,
    required this.onChanged,
  });

  final Palette palette;
  final ThemePreference value;
  final Map<ThemePreference, String> items;
  final ValueChanged<ThemePreference> onChanged;

  @override
  Widget build(BuildContext context) {
    return GlassSegmentedControl(
      segments: [for (final label in items.values) GlassSegment(label: label)],
      selectedIndex: items.keys.toList().indexOf(value),
      onSegmentSelected: (index) => onChanged(items.keys.elementAt(index)),
      height: 44,
      selectedTextStyle: TextStyle(
        color: palette.text,
        fontSize: 14,
        fontWeight: FontWeight.w600,
      ),
      unselectedTextStyle: TextStyle(color: palette.muted, fontSize: 14),
    );
  }
}

/// A small, live preview explains the appearance choice before the user leaves Settings.
class _AppearancePreview extends StatelessWidget {
  const _AppearancePreview({required this.palette});
  final Palette palette;
  @override
  Widget build(BuildContext context) => Container(
    height: 136,
    padding: const EdgeInsets.fromLTRB(18, 12, 18, 10),
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(20),
      gradient: LinearGradient(
        colors: [palette.accentSoft, palette.background],
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
      ),
      border: Border.all(color: palette.border, width: 0.5),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'FastVibe',
          style: TextStyle(
            color: palette.text,
            fontSize: 11,
            fontWeight: FontWeight.w600,
          ),
        ),
        const Spacer(),
        Align(
          alignment: Alignment.centerRight,
          child: Container(
            width: 100,
            height: 20,
            decoration: BoxDecoration(
              color: palette.accentSoft,
              borderRadius: BorderRadius.circular(10),
            ),
          ),
        ),
        const SizedBox(height: 8),
        FractionallySizedBox(
          widthFactor: 0.76,
          child: Container(
            height: 5,
            decoration: BoxDecoration(
              color: palette.muted.withValues(alpha: 0.3),
              borderRadius: BorderRadius.circular(3),
            ),
          ),
        ),
        const SizedBox(height: 6),
        FractionallySizedBox(
          widthFactor: 0.5,
          child: Container(
            height: 5,
            decoration: BoxDecoration(
              color: palette.muted.withValues(alpha: 0.2),
              borderRadius: BorderRadius.circular(3),
            ),
          ),
        ),
        const Spacer(),
        Container(
          height: 24,
          decoration: BoxDecoration(
            color: palette.card.withValues(alpha: 0.8),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: palette.border, width: 0.5),
          ),
          alignment: Alignment.centerRight,
          padding: const EdgeInsets.all(4),
          child: Container(
            width: 16,
            decoration: BoxDecoration(
              color: palette.accent,
              shape: BoxShape.circle,
            ),
          ),
        ),
      ],
    ),
  );
}
