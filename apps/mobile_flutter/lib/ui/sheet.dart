import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import 'feedback.dart';
import 'icons.dart';
import 'kit.dart';

/// A bottom sheet: a plain card rising from the bottom edge, as tall as its content needs up
/// to a bound. `height` is a hint in logical pixels and remains bounded by the phone.
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
  final fraction = (desired / screen.height).clamp(0.3, 0.9);
  return showModalBottomSheet<T>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    backgroundColor: p.card,
    barrierColor: p.overlay,
    elevation: 0,
    clipBehavior: Clip.antiAlias,
    constraints: BoxConstraints(maxWidth: math.min(screen.width, 640)),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Radii.xl)),
    ),
    builder: (context) => PaletteScope(
      palette: p,
      child: ToastHost(
        child: Material(
          type: MaterialType.transparency,
          child: SizedBox(
            height: screen.height * fraction,
            child: SafeArea(
              top: false,
              minimum: const EdgeInsets.only(bottom: 12),
              child: Column(
                children: <Widget>[
                  Container(
                    width: 36,
                    height: 4,
                    margin: const EdgeInsets.only(top: 8, bottom: 8),
                    decoration: BoxDecoration(
                      color: p.subtle.withValues(alpha: 0.45),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  Expanded(
                    child: MediaQuery.removePadding(
                      context: context,
                      removeTop: true,
                      removeBottom: true,
                      child: builder(context),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/// Sheets share hierarchy and an explicit close control. The control is ordinary ink
/// because the sheet already provides the surface.
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
            tooltip: t(
              onBack != null ? 'dag.back' : 'common.close',
              context: context,
            ),
            onPressed: onBack ?? () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}
