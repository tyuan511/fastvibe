import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../i18n/core.dart';
import 'feedback.dart';
import 'icons.dart';
import 'kit.dart';

/// A compact floating platter first; expand only when the content needs more room.
/// Height is a hint in logical pixels and remains bounded by the phone/keyboard.
Future<T?> showAppSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool expanded = false,
  double? height,
}) {
  final p = paletteOf(context);
  final screen = MediaQuery.sizeOf(context);
  final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
  final desired = height == null
      ? (expanded ? 620.0 : 400.0)
      : height * scale.clamp(1, 1.4);
  final fraction = (desired / screen.height).clamp(0.3, 0.82);
  return GlassModalSheet.show<T>(
    context: context,
    initialState: GlassSheetState.half,
    halfSize: fraction,
    fullSize: 0.92,
    fillThreshold: 0.96,
    horizontalMargin: 12,
    bottomMargin: 12,
    topBorderRadius: 32,
    bottomBorderRadius: 32,
    fullTopBorderRadius: 32,
    fullBottomBorderRadius: 32,
    padding: const EdgeInsets.only(top: 12, bottom: 8),
    dragIndicatorWidth: 32,
    dragIndicatorHeight: 4,
    dragIndicatorColor: p.subtle.withValues(alpha: 0.45),
    barrierColor: p.overlay.withValues(alpha: p.dark ? 0.48 : 0.22),
    expandedColor: p.card,
    expandedDarkColor: p.card,
    settings: LiquidGlassSettings(
      glassColor: p.card.withValues(alpha: 0.62),
      blur: 24,
      thickness: 18,
    ),
    builder: (context) => PaletteScope(
      palette: p,
      child: ToastHost(
        child: Material(
          type: MaterialType.transparency,
          child: MediaQuery.removePadding(
            context: context,
            removeTop: true,
            removeBottom: true,
            child: builder(context),
          ),
        ),
      ),
    ),
  );
}

/// Sheets share hierarchy and an explicit close control. The control is ordinary ink
/// because the sheet already provides the refractive surface.
class AppSheetHeader extends StatelessWidget {
  const AppSheetHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.onBack,
  });
  final String title;
  final String? subtitle;
  final Widget? leading;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final p = paletteOf(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 12, 18),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (leading != null) ...[leading!, const SizedBox(width: 12)],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: p.text,
                    fontSize: 22,
                    height: 1.2,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -0.5,
                  ),
                ),
                if (subtitle != null && subtitle!.isNotEmpty) ...[
                  const SizedBox(height: 5),
                  Text(
                    subtitle!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: p.muted, fontSize: 13, height: 1.4),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          IconAction(
            icon: onBack != null ? AppIcons.arrowLeft : AppIcons.cancel,
            tone: IconTone.field,
            size: 40,
            tooltip: t(onBack != null ? 'dag.back' : 'common.close'),
            onPressed: onBack ?? () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}
