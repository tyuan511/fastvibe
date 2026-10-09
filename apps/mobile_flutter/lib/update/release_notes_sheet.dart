import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_info.dart';
import '../chat/markdown_view.dart';
import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/sheet.dart';
import 'release.dart';
import 'updater.dart';

/// 设置 → 关于 → 更新日志: the note of the version installed on this phone, read in the
/// app. It is the same `docs/release/app-v<version>.md` the release was published with —
/// the repository's release list mixes in the desktop and its agent runtime, so linking
/// there sent people hunting for the phone's entry among dozens of others.
Future<void> showReleaseNotesSheet(BuildContext context) {
  return showAppSheet<void>(
    context: context,
    expanded: true,
    builder: (_) => const _ReleaseNotesSheet(),
  );
}

class _ReleaseNotesSheet extends StatefulWidget {
  const _ReleaseNotesSheet();

  @override
  State<_ReleaseNotesSheet> createState() => _ReleaseNotesSheetState();
}

class _ReleaseNotesSheetState extends State<_ReleaseNotesSheet> {
  late Future<String?> _notes = fetchReleaseNotes(appVersion);

  void _retry() => setState(() => _notes = fetchReleaseNotes(appVersion));

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        AppSheetHeader(
          title: t('settings.releaseNotes', context: context),
          subtitle: t(
            'settings.versionValue',
            vars: <String, Object?>{'version': appVersion},
            context: context,
          ),
        ),
        Expanded(
          child: FutureBuilder<String?>(
            future: _notes,
            builder: (context, snapshot) {
              if (snapshot.connectionState != ConnectionState.done) {
                return Center(
                  child: DesktopSpinner(size: 20, color: palette.muted),
                );
              }
              final notes = snapshot.data;
              if (snapshot.hasError || notes == null || notes.isEmpty) {
                return EmptyState(
                  icon: AppIcons.information,
                  title: t(
                    snapshot.hasError
                        ? 'settings.releaseNotesFailed'
                        : notes == null
                        ? 'settings.releaseNotesUnpublished'
                        : 'settings.releaseNotesEmpty',
                    context: context,
                  ),
                  body: snapshot.hasError
                      ? describeCheckError(snapshot.error!)
                      : null,
                  children: <Widget>[
                    const SizedBox(height: 20),
                    if (snapshot.hasError) ...<Widget>[
                      SecondaryButton(
                        label: t('update.retry', context: context),
                        onPressed: _retry,
                      ),
                      const SizedBox(height: 8),
                    ],
                    SecondaryButton(
                      label: t(
                        'settings.releaseNotesOnGitHub',
                        context: context,
                      ),
                      onPressed: () => launchUrl(
                        Uri.parse(releasePageUrl(appVersion)),
                        mode: LaunchMode.externalApplication,
                      ),
                    ),
                  ],
                );
              }
              return SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(
                  20,
                  0,
                  20,
                  16 + MediaQuery.paddingOf(context).bottom,
                ),
                child: MarkdownView(
                  text: notes,
                  palette: palette,
                  compact: true,
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
