import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import 'kit.dart';

/// A quiet, coloured canvas gives the floating controls something to refract.
/// Content remains opaque; the wallpaper itself has no blur or shader cost.
class GlassWallpaper extends StatelessWidget {
  const GlassWallpaper({super.key});

  @override
  Widget build(BuildContext context) {
    final p = paletteOf(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: p.background,
        gradient: RadialGradient(
          center: const Alignment(-1, -0.9),
          radius: 1.25,
          colors: [p.accentSoft, p.background],
        ),
      ),
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: const Alignment(1.3, 0.35),
            radius: 1,
            colors: [
              p.brand.last.withValues(alpha: p.dark ? 0.12 : 0.08),
              p.background.withValues(alpha: 0),
            ],
          ),
        ),
        child: const SizedBox.expand(),
      ),
    );
  }
}

/// All routes share pinned navigation, readable content, and keyboard-safe bounds.
class GlassScreen extends StatelessWidget {
  const GlassScreen({
    super.key,
    required this.title,
    required this.body,
    this.subtitle,
    this.statusColor,
    this.actions = const <Widget>[],
    this.bottomBar,
    this.floatingAction,
    this.showBack = true,
  });

  final String title;
  final String? subtitle;
  final Color? statusColor;
  final Widget body;
  final List<Widget> actions;
  final Widget? bottomBar;
  final Widget? floatingAction;
  final bool showBack;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return GlassScaffold(
      background: const GlassWallpaper(),
      statusBarStyle: palette.dark
          ? GlassStatusBarStyle.light
          : GlassStatusBarStyle.dark,
      resizeToAvoidBottomInset: true,
      // Bodies wrap their own scrolling content. Explicit bounds keep headings and
      // fixed composers out of the pinned navigation and system safe areas.
      extendBody: false,
      // Bodies can contain a fixed composer. Fading that region hides the send button.
      bottomEdgeFade: false,
      contentAwareBrightness: true,
      appBar: GlassAppBar.pinned(
        centerTitle: true,
        backButton: showBack,
        onBack: () {
          if (context.canPop()) {
            context.pop();
          } else {
            context.go('/');
          }
        },
        title: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: palette.text,
                fontSize: 17,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (subtitle != null)
              Row(mainAxisSize: MainAxisSize.min, children: [
                if (statusColor != null) ...[
                  Container(width: 5, height: 5, decoration: BoxDecoration(color: statusColor, shape: BoxShape.circle)),
                  const SizedBox(width: 5),
                ],
                Flexible(child: Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.muted, fontSize: 11))),
              ]),
          ],
        ),
        actions: [
          for (var i = 0; i < actions.length; i++)
            if (actions[i] case final GlassAction action)
              GlassBarItem.icon(
                id: action.tooltip ?? 'action-$i',
                icon: HugeIcon(icon: action.icon, size: 20),
                label: action.tooltip,
                onTap: action.onPressed,
              )
            else
              GlassBarItem.custom(child: actions[i]),
        ],
      ),
      bottomBar: bottomBar == null ? null : PreferredSize(
        preferredSize: bottomBar is PreferredSizeWidget ? (bottomBar as PreferredSizeWidget).preferredSize : const Size.fromHeight(84),
        child: Material(type: MaterialType.transparency, child: bottomBar!),
      ),
      body: Material(
        type: MaterialType.transparency,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 880),
            child: Stack(
              fit: StackFit.expand,
              children: [
                body,
                if (floatingAction != null)
                  Positioned(
                    right: 20,
                    bottom: MediaQuery.paddingOf(context).bottom + 20,
                    child: floatingAction!,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class GlassAction extends StatelessWidget {
  const GlassAction({
    super.key,
    required this.icon,
    required this.onPressed,
    this.tooltip,
  });
  final List<List<dynamic>> icon;
  final VoidCallback onPressed;
  final String? tooltip;

  @override
  Widget build(BuildContext context) => GlassIconButton(
    icon: HugeIcon(icon: icon, size: 20, color: paletteOf(context).text),
    onPressed: onPressed,
    size: 44,
    iconSize: 20,
    semanticLabel: tooltip,
  );
}

/// Large editorial titles live in the content; only controls float above it.
class PageHeading extends StatelessWidget {
  const PageHeading({super.key, required this.title, this.subtitle});
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final p = paletteOf(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 12, 4, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: p.text,
              fontSize: 34,
              fontWeight: FontWeight.w700,
              letterSpacing: -1.2,
            ),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 8),
            Text(
              subtitle!,
              style: TextStyle(color: p.muted, fontSize: 15, height: 1.5),
            ),
          ],
        ],
      ),
    );
  }
}
