import 'package:flutter/material.dart';

import '../theme/theme.dart';
import 'message.dart';
import 'thinking.dart';
import 'tool_card.dart';

/// A reply's working between two pieces of prose — its thinking and every tool call —
/// drawn as one card, one line each, even across the model's round trips.
///
/// Nothing a reader needs sits between them, and a card per call made a busy turn a
/// column of boxes. Collapsed is still the default, because the reply is the thing on
/// screen; but a phone is often the only screen the user has, and a failed command whose
/// output cannot be read at all is a dead end — so every line expands on its own tap.
class ProcessGroup extends StatelessWidget {
  const ProcessGroup({
    super.key,
    required this.steps,
    required this.palette,
    this.live = false,
    this.onOpenDag,
  });

  final List<ProcessStep> steps;
  final Palette palette;

  /// The reply is still streaming, so a trailing thinking row is in progress.
  final bool live;

  /// A `dag_*` row opens its run in the DAG panel rather than expanding.
  final void Function(String? nodeId)? onOpenDag;

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
            tool: tool,
            palette: palette,
            divider: divider,
            onOpenDag: onOpenDag == null
                ? null
                : () {
                    final args = tool.args;
                    String? nodeId;
                    if (args is Map && args['id'] is String) nodeId = args['id'] as String;
                    onOpenDag!(nodeId);
                  },
          ),
      };
}

class _Divider extends StatelessWidget {
  const _Divider({required this.palette, required this.divider, required this.child});

  final Palette palette;
  final bool divider;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: divider
          ? BoxDecoration(border: Border(top: BorderSide(color: palette.separator, width: 0.5)))
          : null,
      child: child,
    );
  }
}
