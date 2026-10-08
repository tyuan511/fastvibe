import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
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
      await checkForUpdate(force: true);
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
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 40),
        children: <Widget>[
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
                        Text(t('settings.theme'), style: TextStyle(color: palette.text, fontSize: 16, fontWeight: FontWeight.w500)),
                      ],
                    ),
                    const SizedBox(height: 12),
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
                trailing: Switch(
                  value: preferences.notifications,
                  activeThumbColor: palette.accentText,
                  activeTrackColor: palette.accent,
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
                trailing: Switch(
                  value: preferences.haptics,
                  activeThumbColor: palette.accentText,
                  activeTrackColor: palette.accent,
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
                          style: TextStyle(color: palette.text, fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: -0.3),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          t('settings.versionValue', <String, Object?>{'version': appVersion}),
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
                          child: CircularProgressIndicator(strokeWidth: 2, color: palette.muted),
                        )
                      : null,
                ),
              ],
              _Divider(palette: palette),
              SettingsRow(
                icon: AppIcons.information,
                label: t('settings.releaseNotes'),
                onTap: () => launchUrl(Uri.parse('https://github.com/$releaseRepo/releases')),
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
  const _Section({required this.title, required this.palette, required this.children});

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
            child: Text(title, style: TextStyle(color: palette.muted, fontSize: 13, fontWeight: FontWeight.w700)),
          ),
          Container(
            decoration: BoxDecoration(color: palette.card, borderRadius: BorderRadius.circular(Radii.lg)),
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
      decoration: BoxDecoration(color: palette.accentSoft, borderRadius: BorderRadius.circular(9)),
      child: Center(child: HugeIcon(icon: icon, size: 17, color: palette.accent, strokeWidth: 2)),
    );
  }
}

class _Divider extends StatelessWidget {
  const _Divider({required this.palette});

  final Palette palette;

  @override
  Widget build(BuildContext context) =>
      Container(height: 0.5, margin: const EdgeInsets.only(left: 56), color: palette.separator);
}

class _Segmented extends StatelessWidget {
  const _Segmented({required this.palette, required this.value, required this.items, required this.onChanged});

  final Palette palette;
  final ThemePreference value;
  final Map<ThemePreference, String> items;
  final ValueChanged<ThemePreference> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: palette.field, borderRadius: BorderRadius.circular(Radii.md)),
      child: Row(
        children: <Widget>[
          for (final entry in items.entries)
            Expanded(
              child: GestureDetector(
                onTap: () => onChanged(entry.key),
                child: Container(
                  height: 34,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: value == entry.key ? palette.card : Colors.transparent,
                    borderRadius: BorderRadius.circular(9),
                    boxShadow: value == entry.key ? elevation(palette) : null,
                  ),
                  child: Text(
                    entry.value,
                    style: TextStyle(
                      color: value == entry.key ? palette.text : palette.muted,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
