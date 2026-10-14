import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import 'file_sheet.dart' show fileGlyph;
import 'output_files.dart';

/// How many files are listed before the rest fold behind 「更多」. A reply that wrote forty
/// files is not forty chips under its text.
const int visibleOutputFiles = 4;

/// The files a settled reply wrote or presented, one tappable row each. Tapping opens the
/// file — a preview, and a download — so a result that lives on the computer is reachable
/// from the phone that asked for it.
class OutputFilesRow extends StatefulWidget {
  const OutputFilesRow({
    super.key,
    required this.files,
    required this.palette,
    required this.onOpen,
  });

  final List<OutputFile> files;
  final Palette palette;
  final void Function(OutputFile file) onOpen;

  @override
  State<OutputFilesRow> createState() => _OutputFilesRowState();
}

class _OutputFilesRowState extends State<OutputFilesRow> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final files = widget.files;
    if (files.isEmpty) return const SizedBox.shrink();
    final shown = _all || files.length <= visibleOutputFiles
        ? files
        : files.sublist(0, visibleOutputFiles);
    final palette = widget.palette;
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 6),
            child: Text(
              t('file.outputs', vars: <String, Object?>{'count': files.length}),
              style: TextStyle(color: palette.subtle, fontSize: 12, fontWeight: FontWeight.w600),
            ),
          ),
          Container(
            decoration: BoxDecoration(
              color: palette.card,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: palette.border, width: 0.5),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: <Widget>[
                for (var index = 0; index < shown.length; index++)
                  _FileRow(
                    file: shown[index],
                    palette: palette,
                    divider: index > 0,
                    onTap: () => widget.onOpen(shown[index]),
                  ),
                if (shown.length < files.length)
                  InkWell(
                    onTap: () => setState(() => _all = true),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
                      decoration: BoxDecoration(
                        border: Border(top: BorderSide(color: palette.separator, width: 0.5)),
                      ),
                      child: Text(
                        t('file.more', vars: <String, Object?>{'count': files.length - shown.length}),
                        style: TextStyle(color: palette.accent, fontSize: 14, fontWeight: FontWeight.w500),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FileRow extends StatelessWidget {
  const _FileRow({
    required this.file,
    required this.palette,
    required this.divider,
    required this.onTap,
  });

  final OutputFile file;
  final Palette palette;
  final bool divider;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: divider
            ? BoxDecoration(border: Border(top: BorderSide(color: palette.separator, width: 0.5)))
            : null,
        child: Row(
          children: <Widget>[
            HugeIcon(icon: fileGlyph(file.kind), size: 18, color: palette.accent, strokeWidth: 1.9),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    file.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: palette.text, fontSize: 14.5, fontWeight: FontWeight.w500),
                  ),
                  Text(
                    t(file.created ? 'file.created' : 'file.edited'),
                    style: TextStyle(color: palette.subtle, fontSize: 12),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            HugeIcon(icon: AppIcons.download, size: 17, color: palette.muted, strokeWidth: 1.9),
          ],
        ),
      ),
    );
  }
}
