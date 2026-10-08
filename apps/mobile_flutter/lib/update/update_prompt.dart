import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import 'release.dart';
import 'updater.dart';

/// The update prompt, mounted once at the app root rather than on a screen.
///
/// It is global because an update found while the user is in a chat is still worth
/// showing, and because confirmation, download progress and the final install action all
/// belong to the same one modal — a progress bar on a settings page and a button
/// somewhere else is two halves of one thing.
///
/// A check only ever *announces* a version. Nothing downloads until the user asks, so a
/// metered connection is never spent on an update nobody wanted.
class UpdatePrompt extends StatefulWidget {
  const UpdatePrompt({super.key, required this.child});

  final Widget child;

  @override
  State<UpdatePrompt> createState() => _UpdatePromptState();
}

/// Longest stretch of release notes shown in the dialog.
const int _notesLimit = 600;

enum _Phase { available, downloading, ready, installing, error }

class _UpdatePromptState extends State<UpdatePrompt> with WidgetsBindingObserver {
  AppRelease? _release;
  _Phase _phase = _Phase.available;
  double? _progress;
  String? _error;
  String? _shownVersion;
  bool _downloading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (updatesSupported) {
      unawaited(removeStaleApks());
      onReleaseAnnounced(_show);
      unawaited(_check());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The check is not run in the background: a version offered while the phone is in a
    // pocket is a dialog nobody sees, and Android would have already killed the socket.
    if (state == AppLifecycleState.resumed) unawaited(_check());
  }

  Future<void> _check() async {
    try {
      final results = await Future.wait<Object?>(<Future<Object?>>[checkForUpdate(), skippedVersion()]);
      final found = results[0] as AppRelease?;
      final skipped = results[1] as String?;
      if (found != null && found.version != skipped) _show(found);
    } catch (_) {
      // A background check that cannot reach GitHub says nothing; a manual one reports.
    }
  }

  void _show(AppRelease release) {
    if (!mounted || release.version == _shownVersion || _downloading) return;
    _shownVersion = release.version;
    setState(() {
      _release = release;
      _phase = _Phase.available;
      _error = null;
      _progress = null;
    });
  }

  Future<void> _download() async {
    final release = _release;
    if (release == null) return;
    setState(() {
      _phase = _Phase.downloading;
      _downloading = true;
      _progress = null;
    });
    try {
      final file = await downloadApk(release, onProgress: (value) {
        if (mounted) setState(() => _progress = value);
      });
      if (!mounted) return;
      setState(() {
        _phase = _Phase.ready;
        _file = file;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.error;
        _error = describeCheckError(error);
      });
    } finally {
      _downloading = false;
    }
  }

  File? _file;

  Future<void> _install() async {
    final file = _file;
    if (file == null) return;
    setState(() => _phase = _Phase.installing);
    try {
      await installApk(file);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.error;
        _error = describeCheckError(error);
      });
    }
  }

  Future<void> _skip() async {
    final release = _release;
    setState(() => _release = null);
    if (release != null) await skipVersion(release.version);
  }

  @override
  Widget build(BuildContext context) {
    final release = _release;
    return Stack(
      children: <Widget>[
        widget.child,
        if (release != null)
          _UpdateDialog(
            release: release,
            phase: _phase,
            progress: _progress,
            error: _error,
            onDownload: _download,
            onInstall: _install,
            onSkip: _skip,
            onClose: () => setState(() => _release = null),
          ),
      ],
    );
  }
}

class _UpdateDialog extends StatelessWidget {
  const _UpdateDialog({
    required this.release,
    required this.phase,
    required this.progress,
    required this.error,
    required this.onDownload,
    required this.onInstall,
    required this.onSkip,
    required this.onClose,
  });

  final AppRelease release;
  final _Phase phase;
  final double? progress;
  final String? error;
  final VoidCallback onDownload;
  final VoidCallback onInstall;
  final VoidCallback onSkip;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final notes = release.notes.length > _notesLimit ? '${release.notes.substring(0, _notesLimit)}…' : release.notes;
    return ColoredBox(
      color: palette.overlay,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: palette.card,
                borderRadius: BorderRadius.circular(Radii.xl),
                boxShadow: elevation(palette, 2),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Container(
                        width: 34,
                        height: 34,
                        decoration: BoxDecoration(color: palette.accentSoft, borderRadius: BorderRadius.circular(10)),
                        child: Center(child: HugeIcon(icon: AppIcons.arrowUp, size: 18, color: palette.accent)),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              t('update.title'),
                              style: TextStyle(color: palette.text, fontSize: 18, fontWeight: FontWeight.w700, height: 24 / 18),
                            ),
                            Text(
                              t('update.version', <String, Object?>{'version': release.version}),
                              style: TextStyle(color: palette.muted, fontSize: 13),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  if (notes.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 14),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 200),
                      child: SingleChildScrollView(
                        child: Text(
                          notes,
                          style: TextStyle(color: palette.muted, fontSize: 15, height: 22 / 15),
                        ),
                      ),
                    ),
                  ],
                  if (phase == _Phase.downloading) ...<Widget>[
                    const SizedBox(height: 16),
                    LinearProgressIndicator(
                      value: progress,
                      color: palette.accent,
                      backgroundColor: palette.field,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      progress == null
                          ? t('update.downloading')
                          : t('update.downloadingPercent', <String, Object?>{'percent': (progress! * 100).round()}),
                      style: TextStyle(color: palette.muted, fontSize: 13),
                    ),
                  ],
                  if (error != null) ...<Widget>[
                    const SizedBox(height: 14),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: palette.dangerSoft, borderRadius: BorderRadius.circular(Radii.md)),
                      child: Text(error!, style: TextStyle(color: palette.danger, fontSize: 14, height: 20 / 14)),
                    ),
                  ],
                  const SizedBox(height: 16),
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: _DialogButton(
                          label: phase == _Phase.ready ? t('update.later') : t('update.skip'),
                          palette: palette,
                          onTap: onSkip,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _DialogButton(
                          label: switch (phase) {
                            _Phase.downloading => t('update.downloadingShort'),
                            _Phase.ready => t('update.install'),
                            _Phase.installing => t('update.installing'),
                            _ => t('update.download'),
                          },
                          palette: palette,
                          primary: true,
                          disabled: phase == _Phase.downloading || phase == _Phase.installing,
                          onTap: phase == _Phase.ready ? onInstall : onDownload,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _DialogButton extends StatelessWidget {
  const _DialogButton({
    required this.label,
    required this.palette,
    this.primary = false,
    this.disabled = false,
    required this.onTap,
  });

  final String label;
  final Palette palette;
  final bool primary;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Opacity(
        opacity: disabled ? 0.5 : 1,
        child: GestureDetector(
          onTap: disabled ? null : onTap,
          child: Container(
            height: 46,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: primary ? null : palette.field,
              gradient: primary
                  ? LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: palette.brand)
                  : null,
              borderRadius: BorderRadius.circular(Radii.md),
            ),
            child: Text(
              label,
              style: TextStyle(
                color: primary ? Colors.white : palette.text,
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
      );
}
