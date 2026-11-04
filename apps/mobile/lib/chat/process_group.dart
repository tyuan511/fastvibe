import 'package:flutter/material.dart';

import '../theme/theme.dart';
import 'file_transfer.dart';
import 'message.dart';
import 'output_files.dart' show OutputFile;
import 'thinking.dart';
import 'tool_card.dart';

/// A reply's working between two pieces of prose — its thinking and every tool call —
/// drawn as one card, one line each, even across the model's round trips.
///
/// A shared flat surface keeps a busy turn readable. Each tool discloses its own
/// bounded parameters and output; the collapsed row keeps just the action, subject
/// and secondary context.
class ProcessGroup extends StatelessWidget {
  const ProcessGroup({
    super.key,
    required this.steps,
    required this.palette,
    this.live = false,
    this.transfer,
    this.onOpenFile,
  });

  final List<ProcessStep> steps;
  final Palette palette;

  /// The reply is still streaming, so a trailing thinking row is in progress.
  final bool live;

  /// Reads a generated picture from the machine; null where there is no connection.
  final FileTransfer? transfer;
  final void Function(OutputFile file)? onOpenFile;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 3),
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: palette.border, width: 0.5),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          for (var index = 0; index < steps.length; index++)
            _row(steps[index], index > 0, index == steps.length - 1),
        ],
      ),
    );
  }

  Widget _row(ProcessStep step, bool divider, bool isLast) => switch (step) {
    ThinkingStep(:final text) => _Divider(
      palette: palette,
      divider: divider,
      child: ThinkingRow(text: text, palette: palette, live: live && isLast),
    ),
    ToolStep(:final tool) => ToolCard(
      key: ValueKey(tool.id),
      tool: tool,
      palette: palette,
      divider: divider,
      live: live,
      transfer: transfer,
      onOpenFile: onOpenFile,
    ),
  };
}

class _Divider extends StatelessWidget {
  const _Divider({
    required this.palette,
    required this.divider,
    required this.child,
  });

  final Palette palette;
  final bool divider;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: divider
          ? BoxDecoration(
              border: Border(
                top: BorderSide(color: palette.separator, width: 0.5),
              ),
            )
          : null,
      child: child,
    );
  }
}
