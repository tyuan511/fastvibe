import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';

/// A thinking block, drawn as one row of a process card.
///
/// Same measurements as a tool call's row on purpose: thinking and tool calls are the
/// same kind of thing to a reader — work that happened between two pieces of prose — and
/// giving them two shapes would make one card look like two.
///
/// The phone does not show a duration. The desktop measures each block and prints
/// 「持续了 N 秒」; the phone's transcript carries no bounds for them, so a number here
/// would be invented rather than measured.
class ThinkingRow extends StatefulWidget {
  const ThinkingRow({
    super.key,
    required this.text,
    required this.palette,
    this.live = false,
  });

  final String text;
  final Palette palette;

  /// This row is the reply's tail and the run is still in flight.
  final bool live;

  @override
  State<ThinkingRow> createState() => _ThinkingRowState();
}

class _ThinkingRowState extends State<ThinkingRow> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final palette = widget.palette;
    final live = widget.live;
    final preview = widget.text.replaceAll(RegExp(r'\s+'), ' ').trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        InkWell(
          onTap: () => setState(() => _open = !_open),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 40),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              child: Row(
                children: <Widget>[
                  Container(
                    width: 24,
                    height: 24,
                    decoration: BoxDecoration(
                      color: live ? palette.accentSoft : palette.field,
                      borderRadius: BorderRadius.circular(7),
                    ),
                    child: Center(
                      child: live
                          ? DesktopSpinner(size: 13, color: palette.accent)
                          : HugeIcon(icon: AppIcons.aiBrain, size: 13, color: palette.muted, strokeWidth: 2),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    live ? t('chat.thinking') : t('chat.thoughts'),
                    style: TextStyle(
                      color: live ? palette.accent : palette.muted,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (!_open) ...<Widget>[
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        preview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: palette.text, fontSize: 13),
                      ),
                    ),
                  ] else
                    const Spacer(),
                  const SizedBox(width: 4),
                  RotatedBox(
                    quarterTurns: _open ? 1 : 0,
                    child: HugeIcon(icon: AppIcons.arrowRight, size: 14, color: palette.subtle, strokeWidth: 2),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (_open)
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(color: palette.field, borderRadius: BorderRadius.circular(10)),
              child: SelectableText(
                widget.text.trim(),
                style: TextStyle(color: palette.muted, fontSize: 14, height: 21 / 14),
              ),
            ),
          ),
      ],
    );
  }
}
