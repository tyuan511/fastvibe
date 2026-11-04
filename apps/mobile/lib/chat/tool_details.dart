import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import 'markdown_chunks.dart';

/// Created only after opening a tool. Large output is laid out a screenful at a
/// time, while Copy keeps the full value, including portions outside the viewport.
class ToolDetails extends StatelessWidget {
  const ToolDetails({
    super.key,
    required this.args,
    required this.result,
    required this.palette,
    this.error = false,
  });

  final Object? args;
  final String? result;
  final Palette palette;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final arguments = _arguments(args);
    final output = result?.trim().isNotEmpty == true
        ? _Section(
            t(error ? 'tool.error' : 'tool.output', context: context),
            result!,
            error: error,
          )
        : null;
    final sections = <_Section>[
      if (error && output != null) output,
      if (arguments.isNotEmpty)
        _Section(t('tool.args', context: context), arguments),
      if (!error && output != null) output,
    ];
    if (sections.isEmpty) return const SizedBox.shrink();
    final height = math.min(260.0, MediaQuery.sizeOf(context).height * 0.4);
    final long =
        sections.fold<int>(0, (size, section) => size + section.text.length) >
        4000;
    final rows = <Widget Function()>[];
    for (final section in sections) {
      rows.add(() => _heading(context, section));
      for (final chunk in chunkPlainText(section.text)) {
        rows.add(
          () => Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
            child: SelectableText(
              chunk,
              style: TextStyle(
                color: section.error ? palette.danger : palette.muted,
                fontFamily: 'monospace',
                fontSize: 12,
                height: 1.55,
              ),
            ),
          ),
        );
      }
    }
    final body = long
        ? SizedBox(
            height: height,
            child: ListView.builder(
              primary: false,
              padding: EdgeInsets.zero,
              itemCount: rows.length,
              itemBuilder: (context, index) => rows[index](),
            ),
          )
        : ConstrainedBox(
            constraints: BoxConstraints(maxHeight: height),
            child: SingleChildScrollView(
              primary: false,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[for (final row in rows) row()],
              ),
            ),
          );
    return Padding(
      padding: const EdgeInsets.fromLTRB(36, 0, 12, 10),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: error ? palette.dangerSoft : palette.field,
          borderRadius: BorderRadius.circular(8),
        ),
        child: body,
      ),
    );
  }

  Widget _heading(BuildContext context, _Section section) => Padding(
    padding: const EdgeInsets.only(left: 12, right: 2),
    child: Row(
      children: <Widget>[
        Expanded(
          child: Text(
            section.title,
            style: TextStyle(
              color: palette.muted,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        IconButton(
          tooltip: t('common.copy', context: context),
          constraints: const BoxConstraints.tightFor(width: 40, height: 40),
          padding: EdgeInsets.zero,
          icon: HugeIcon(
            icon: AppIcons.copy,
            size: 14,
            color: palette.subtle,
            strokeWidth: 1.8,
          ),
          onPressed: () => Clipboard.setData(ClipboardData(text: section.text)),
        ),
      ],
    ),
  );
}

class _Section {
  const _Section(this.title, this.text, {this.error = false});
  final String title;
  final String text;
  final bool error;
}

String _arguments(Object? value) {
  if (value == null) return '';
  if (value is String) return value.trim();
  if (value is Map && value.isEmpty) return '';
  if (value is List && value.isEmpty) return '';
  try {
    return const JsonEncoder.withIndent('  ').convert(value);
  } on JsonUnsupportedObjectError {
    return value.toString();
  }
}

/// A tool keeps its identity icon. Only its running label gently pulses, and only
/// while the reader allows animation. No timer or transcript-wide rebuild is needed.
class ToolActivityLabel extends StatefulWidget {
  const ToolActivityLabel({
    super.key,
    required this.active,
    required this.child,
  });
  final bool active;
  final Widget child;

  @override
  State<ToolActivityLabel> createState() => _ToolActivityLabelState();
}

class _ToolActivityLabelState extends State<ToolActivityLabel>
    with SingleTickerProviderStateMixin {
  AnimationController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(ToolActivityLabel oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  void _sync() {
    if (widget.active && !MediaQuery.disableAnimationsOf(context)) {
      final controller = _controller ??= AnimationController(
        vsync: this,
        duration: const Duration(milliseconds: 1000),
        lowerBound: 0.55,
        upperBound: 1,
        value: 1,
      );
      if (!controller.isAnimating) controller.repeat(reverse: true);
    } else {
      _controller?.stop();
      _controller?.value = 1;
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _controller == null
      ? widget.child
      : FadeTransition(opacity: _controller!, child: widget.child);
}
