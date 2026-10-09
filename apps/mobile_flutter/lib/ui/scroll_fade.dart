import 'package:flutter/widgets.dart';

/// Dissolves a scrollable's content into whatever is behind it at an edge that still
/// has more to scroll, instead of letting the viewport cut it with a straight line.
///
/// A sheet's list is clipped by its own bounds, which inside a rounded glass sheet read
/// as a hard, square cut through the middle of a rounded card. Each fade's strength
/// follows how far there is left to scroll on that side, so it arrives and leaves with
/// the content rather than snapping on at the last pixel; an edge with nothing beyond it
/// is drawn untouched. A mask rather than a painted gradient, so it works over glass.
class ScrollFade extends StatefulWidget {
  const ScrollFade({super.key, required this.child, this.extent = 32});

  /// A scrollable (or something whose first scrollable descendant is the one to fade).
  final Widget child;

  /// How tall each fade is, in logical pixels.
  final double extent;

  @override
  State<ScrollFade> createState() => _ScrollFadeState();
}

class _ScrollFadeState extends State<ScrollFade> {
  double _top = 0;
  double _bottom = 0;

  bool _onMetrics(int depth, ScrollMetrics metrics) {
    if (depth != 0 || metrics.axis != Axis.vertical) return false;
    final top = (metrics.extentBefore / widget.extent).clamp(0.0, 1.0);
    final bottom = (metrics.extentAfter / widget.extent).clamp(0.0, 1.0);
    if (top != _top || bottom != _bottom) {
      setState(() {
        _top = top;
        _bottom = bottom;
      });
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return NotificationListener<ScrollMetricsNotification>(
      onNotification: (n) => _onMetrics(n.depth, n.metrics),
      child: NotificationListener<ScrollNotification>(
        onNotification: (n) => _onMetrics(n.depth, n.metrics),
        child: ShaderMask(
          blendMode: BlendMode.dstIn,
          shaderCallback: (bounds) {
            final edge = bounds.height <= 0
                ? 0.0
                : (widget.extent / bounds.height).clamp(0.0, 0.5);
            const solid = Color(0xFF000000);
            return LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[
                solid.withValues(alpha: 1 - _top),
                solid,
                solid,
                solid.withValues(alpha: 1 - _bottom),
              ],
              stops: <double>[0, edge, 1 - edge, 1],
            ).createShader(bounds);
          },
          child: widget.child,
        ),
      ),
    );
  }
}
