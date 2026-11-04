import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:mermaid_core/mermaid_core.dart' as core;
import 'package:mermaid_flutter/mermaid_flutter.dart'
    show FlutterTextMeasurer, ScenePainter;

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import 'option_sheet.dart' show copyToClipboard;

/// A `mermaid` fence, drawn the way the desktop's `MermaidBlock` draws it.
///
/// The diagram renders natively — `mermaid_core` parses and lays the scene out,
/// `mermaid_flutter` paints it — so there is no WebView and no bundled JS. The
/// theme derives from the phone's palette with the same quiet mapping the
/// desktop renderer applies: low-saturation accent fills, rounded nodes, soft
/// neutral lines, no gradients or shadows. A syntax error or an oversized fence
/// keeps the source instead of the diagram, as on the desktop.
///
/// The Dart port is not the desktop's mermaid 12 engine, so complex diagrams can
/// differ in layout detail — the block still shows the source, and a diagram it
/// cannot parse falls back to it rather than vanishing.

/// Desktop keeps this cap in `mermaid-source.ts`; the two move together.
const int maxMermaidChars = 24000;

bool isMermaidFence(String name) =>
    RegExp(r'^(mermaid|mmd)$', caseSensitive: false).hasMatch(name.trim());

/// How tall the fenced source may stand before it scrolls internally. The desktop
/// shows the whole source because its 运行过程 fold bounds the row; the phone has no
/// fold, so a 24k-char source needs its own viewport like any tool's output.
const double maxSourceHeight = 360;

/// The blend mirrors `mixColor` in the desktop renderer (a fraction of the tint).
Color _mix(Color base, Color tint, double amount) {
  return Color.lerp(base, tint, amount) ?? base;
}

/// The Mermaid theme the desktop renderer computes from its theme tokens, mapped
/// onto the phone's own palette. Fills stay low-saturation mixes of the card with
/// the accent; lines and dividers are soft neutrals of background and text.
core.MermaidTheme _themeFor(Palette palette) {
  final dark = palette.dark;
  final nodeFill = _mix(palette.card, palette.accent, dark ? 0.10 : 0.035);
  final nodeBorder = _mix(palette.card, palette.accent, dark ? 0.42 : 0.26);
  final line = _mix(palette.background, palette.text, dark ? 0.55 : 0.46);
  final divider = _mix(palette.background, palette.text, dark ? 0.24 : 0.18);
  core.Color c(Color value) => core.Color(value.toARGB32());
  // The categorical scale the desktop leaves to mermaid's base theme; here the
  // core port takes explicit values, so a quiet ramp of the accent stands in.
  final scales = <core.Color>[
    for (var index = 0; index < 12; index++)
      c(
        _mix(
          palette.card,
          palette.accent,
          (dark ? 0.22 : 0.14) + index * 0.055,
        ),
      ),
  ];
  return core.MermaidTheme(
    // The card surface shows through; the scene paints no backdrop of its own.
    background: const core.Color(0x00000000),
    primaryColor: c(nodeFill),
    primaryTextColor: c(palette.text),
    primaryBorderColor: c(nodeBorder),
    secondaryColor: c(palette.accentSoft),
    lineColor: c(line),
    arrowheadColor: c(line),
    textColor: c(palette.text),
    nodeBorder: c(nodeBorder),
    mainBkg: c(nodeFill),
    clusterBkg: c(palette.card),
    clusterBorder: c(divider),
    titleColor: c(palette.text),
    edgeLabelBackground: c(palette.card),
    fontFamily: core.MermaidTheme.defaultTheme.fontFamily,
    fontSize: 14,
    cScale0: scales[0],
    cScale1: scales[1],
    cScale2: scales[2],
    cScale3: scales[3],
    cScale4: scales[4],
    cScale5: scales[5],
    cScale6: scales[6],
    cScale7: scales[7],
    cScale8: scales[8],
    cScale9: scales[9],
    cScale10: scales[10],
    cScale11: scales[11],
    cScaleLabel0: c(palette.text),
    cScaleLabel1: c(palette.text),
    cScaleLabel2: c(palette.text),
    cScaleLabel3: c(palette.text),
    cScaleLabel4: c(palette.text),
    cScaleLabel5: c(palette.text),
    cScaleLabel6: c(palette.text),
    cScaleLabel7: c(palette.text),
    cScaleLabel8: c(palette.text),
    cScaleLabel9: c(palette.text),
    cScaleLabel10: c(palette.text),
    cScaleLabel11: c(palette.text),
  );
}

class MermaidBlock extends StatefulWidget {
  const MermaidBlock({
    super.key,
    required this.code,
    required this.closed,
    required this.palette,
  });

  /// The fence's code, without the fence lines.
  final String code;

  /// Whether the fence has its closing line yet — streaming answers don't.
  final bool closed;
  final Palette palette;

  @override
  State<MermaidBlock> createState() => _MermaidBlockState();
}

/// One built diagram: the laid-out scene, painted directly.
class _Diagram {
  const _Diagram(this.scene);

  final core.RenderScene scene;
}

class _MermaidBlockState extends State<MermaidBlock> {
  bool _source = false;
  bool _expanded = false;
  bool _copied = false;
  Timer? _copiedTimer;

  bool _failed = false;
  _Diagram? _built;
  (bool, String)? _builtKey;

  bool get _oversized => widget.code.length > maxMermaidChars;

  /// The diagram itself is the default once it rendered; the source is a toggle.
  bool get _diagramMode => !_source;

  /// The laid-out scene for a closed, in-cap fence — memoized on (dark, code),
  /// so toggling to the source and back does not lay the diagram out again.
  /// Parse and layout run synchronously; a diagram this port cannot handle
  /// reports [_failed] and the source stays readable instead.
  _Diagram? get _diagram {
    if (!widget.closed || _oversized) return null;
    final key = (widget.palette.dark, widget.code);
    if (_builtKey != key) {
      try {
        _built = _Diagram(
          core.Mermaid(
            measurer: const FlutterTextMeasurer(),
            theme: _themeFor(widget.palette),
          ).render(widget.code),
        );
        _failed = false;
      } catch (_) {
        _built = null;
        _failed = true;
      }
      _builtKey = key;
    }
    return _built;
  }

  @override
  void dispose() {
    _copiedTimer?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await copyToClipboard(widget.code);
    if (!mounted) return;
    setState(() => _copied = true);
    _copiedTimer?.cancel();
    _copiedTimer = Timer(const Duration(milliseconds: 1200), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = widget.palette;
    final scene = _diagram;
    final diagram = _diagramMode && scene != null;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: diagram
            ? palette.card.withValues(alpha: 0.5)
            : palette.field.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: palette.border, width: 0.7),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Container(
            padding: const EdgeInsets.fromLTRB(12, 7, 6, 7),
            decoration: BoxDecoration(
              border: diagram
                  ? null
                  : Border(
                      bottom: BorderSide(color: palette.border, width: 0.7),
                    ),
            ),
            child: Row(
              children: <Widget>[
                HugeIcon(
                  icon: AppIcons.flow,
                  size: 14,
                  color: palette.muted,
                  strokeWidth: 1.75,
                ),
                const SizedBox(width: 6),
                Text(
                  'Mermaid',
                  style: TextStyle(
                    color: palette.muted,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const Spacer(),
                if (scene != null && !_failed) _action(
                  palette: palette,
                  icon: _source ? AppIcons.eye : AppIcons.sourceCode,
                  label: t(_source ? 'mermaid.diagram' : 'mermaid.source'),
                  onTap: () => setState(() => _source = !_source),
                ),
                _action(
                  palette: palette,
                  icon: _copied ? AppIcons.tick : AppIcons.copy,
                  label: t(_copied ? 'common.copied' : 'common.copy'),
                  onTap: _copy,
                ),
              ],
            ),
          ),
          _body(palette, scene),
        ],
      ),
    );
  }

  Widget _action({
    required Palette palette,
    required List<List<dynamic>> icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            HugeIcon(
              icon: icon,
              size: 13,
              color: palette.muted,
              strokeWidth: 1.75,
            ),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(color: palette.muted, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(Palette palette, _Diagram? diagram) {
    if (_diagramMode && diagram != null) {
      // Scaled down to fit the block, never wider — the desktop's `max-w-full`.
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
        child: FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.topCenter,
          child: CustomPaint(
            painter: ScenePainter(diagram.scene),
            // The core port ships its own Size type; convert to ui's.
            size: Size(diagram.scene.size.width, diagram.scene.size.height),
          ),
        ),
      );
    }
    return _sourceBody(palette, diagram);
  }

  Widget _sourceBody(Palette palette, _Diagram? diagram) {
    final note = _failed && widget.closed && !_oversized && diagram == null
        ? t('mermaid.invalid')
        : _oversized
        ? t('mermaid.tooLarge')
        : null;
    final code = _oversized && !_expanded
        ? '${widget.code.substring(0, maxMermaidChars)}\n…'
        : widget.code;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (note != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: Text(
              note,
              style: TextStyle(color: palette.muted, fontSize: 12, height: 1.5),
            ),
          ),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: maxSourceHeight),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
            child: SelectableText(
              code,
              style: TextStyle(
                color: palette.text,
                fontSize: 12.5,
                height: 1.5,
                fontFamily: 'Menlo',
                fontFamilyFallback: const <String>['monospace'],
              ),
            ),
          ),
        ),
        if (_oversized)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 4),
            child: _action(
              palette: palette,
              icon: _expanded ? AppIcons.arrowUp : AppIcons.arrowDown,
              label: t(
                _expanded ? 'common.collapseCode' : 'common.expandCode',
                vars: <String, Object?>{
                  'count': widget.code.length - maxMermaidChars,
                },
              ),
              onTap: () => setState(() => _expanded = !_expanded),
            ),
          ),
      ],
    );
  }
}
