import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../theme/theme.dart';
import 'kit.dart';
import 'context_menu.dart';

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

/// How far the glass bars reach into a screen's body.
///
/// The body runs edge to edge and scrolls *under* the bars — which is what makes them read
/// as glass, and what the soft edge fade needs something to fade. So a scroll view has to
/// start below the top bar and end above the bottom one by itself: it pads its content with
/// these, and the first row rests where it would have with the bar above it while a
/// scrolled one passes behind the bar instead of being cut off at its edge.
class GlassInsets extends InheritedWidget {
  const GlassInsets({
    super.key,
    required this.top,
    required this.bottom,
    required super.child,
  });

  /// Status bar plus the pinned bar.
  final double top;

  /// The bottom bar (if any) plus the home-indicator inset.
  final double bottom;

  static GlassInsets? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<GlassInsets>();

  /// `base` with the bars' reach added to its top and bottom.
  static EdgeInsets pad(
    BuildContext context, [
    EdgeInsets base = EdgeInsets.zero,
  ]) {
    final insets = maybeOf(context);
    if (insets == null) return base;
    return base.copyWith(
      top: base.top + insets.top,
      bottom: base.bottom + insets.bottom,
    );
  }

  @override
  bool updateShouldNotify(GlassInsets oldWidget) =>
      top != oldWidget.top || bottom != oldWidget.bottom;
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
    this.edgeFade = true,
    this.fadeBottom = true,
    this.topScrim = true,
    this.contentBehindBars = true,
    this.largeTitleController,
  });

  final String title;
  final String? subtitle;
  final Color? statusColor;
  final Widget body;
  final List<Widget> actions;
  final Widget? bottomBar;
  final Widget? floatingAction;
  final bool showBack;

  /// Content dissolves into the page as it passes under the bars (iOS 26's soft scroll-edge
  /// effect). Off for a body that is not scrolling text — the camera.
  final bool edgeFade;

  /// The bottom half of that fade. A body that draws its own footer over the content (the
  /// chat's composer) turns it off, or the fade would wash out the footer too.
  final bool fadeBottom;

  /// Keeps the large-title area readable on list pages. Detail pages whose title
  /// lives only in the pinned bar can leave the wallpaper gradient unobstructed.
  final bool topScrim;

  /// `false` keeps the body between the bars, for a body that cannot pad itself.
  final bool contentBehindBars;

  /// A page with an iOS large title (`GlassLargeTitle` in its scroll view) passes the
  /// controller it shares with it; the bar's own title then fades in as the large one goes.
  final GlassLargeTitleController? largeTitleController;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final media = MediaQuery.of(context);
    const barHeight = 44.0;
    final bottomBarHeight = bottomBar == null
        ? 0.0
        : bottomBar is PreferredSizeWidget
        ? (bottomBar as PreferredSizeWidget).preferredSize.height
        : 84.0;
    final insets = GlassInsets(
      top: contentBehindBars ? media.padding.top + barHeight + 8 : 0,
      bottom: contentBehindBars
          ? media.padding.bottom +
                bottomBarHeight +
                (bottomBar == null ? 12 : 8)
          : 0,
      child: _scaffold(context, palette),
    );
    return insets;
  }

  Widget _scaffold(BuildContext context, Palette palette) {
    return GlassScaffold(
      background: const GlassWallpaper(),
      statusBarStyle: palette.dark
          ? GlassStatusBarStyle.light
          : GlassStatusBarStyle.dark,
      resizeToAvoidBottomInset: true,
      // The body runs under the bars and dissolves into the page at their edges, as a
      // list does under an iOS 26 navigation bar. Bodies pad their own scrolling content
      // with `GlassInsets`, so the first row still starts below the bar.
      extendBody: contentBehindBars,
      edgeFade: edgeFade,
      topEdgeFade: edgeFade,
      bottomEdgeFade: edgeFade && fadeBottom,
      // `soft` is a gradient to the page colour that is only ~20% opaque where the title
      // sits, so a reply scrolling past shows through the header text. A progressive blur
      // melts the text under the bar instead — the title stays legible and the content is
      // still there, which is what the iOS 26 scroll-edge effect does.
      edgeStyle: GlassScrollEdgeStyle.blur,
      maxSigma: 14,
      // Keep a short buffer for the pinned bar's gradient, while the explicit
      // scrim below ends before the large title so its glyphs stay crisp.
      topEdgeFadeExtent: 8,
      bottomEdgeFadeExtent: 8,
      // The fade's target colour: the page, or the content would dissolve into black.
      backgroundColor: palette.background,
      contentAwareBrightness: true,
      bodyOverlays: contentBehindBars && edgeFade
          ? <Widget>[
              if (topScrim)
                _BarScrim(
                  top: true,
                  // End the wash in the spacer before the large title. Extending it
                  // into the title row leaves the glyph tops soft under the header.
                  height: MediaQuery.paddingOf(context).top + 44 + 8,
                  solid: MediaQuery.paddingOf(context).top + 44,
                  palette: palette,
                ),
              if (bottomBar != null)
                _BarScrim(
                  top: false,
                  height: MediaQuery.paddingOf(context).bottom + 84 + 20,
                  solid: MediaQuery.paddingOf(context).bottom + 84 - 8,
                  palette: palette,
                ),
            ]
          : null,
      appBar: GlassAppBar.pinned(
        largeTitleController: largeTitleController,
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
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (statusColor != null) ...[
                    Container(
                      width: 5,
                      height: 5,
                      decoration: BoxDecoration(
                        color: statusColor,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 5),
                  ],
                  Flexible(
                    child: Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: palette.muted, fontSize: 11),
                    ),
                  ),
                ],
              ),
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
                // A filter that is on reads as the iOS tinted capsule.
                background: action.active
                    ? GlassBarItemBackground.separate
                    : GlassBarItemBackground.shared,
                tintColor: action.active ? palette.accent : null,
              )
            else if (actions[i] case final GlassMenuAction menu)
              // `UIBarButtonItem.menu`: the capsule itself grows into the pull-down.
              GlassBarItem.menu(
                id: menu.tooltip ?? 'menu-$i',
                icon: HugeIcon(icon: menu.icon, size: 20),
                label: menu.tooltip,
                menuItems: menu.items,
                menuWidth: 240,
                menuHeight: _barMenuHeight(context, menu.items),
                background: menu.active
                    ? GlassBarItemBackground.separate
                    : GlassBarItemBackground.shared,
                tintColor: menu.active ? palette.accent : null,
              )
            else
              GlassBarItem.custom(child: actions[i]),
        ],
      ),
      bottomBar: bottomBar == null
          ? null
          : PreferredSize(
              preferredSize: bottomBar is PreferredSizeWidget
                  ? (bottomBar as PreferredSizeWidget).preferredSize
                  : const Size.fromHeight(84),
              child: Material(
                type: MaterialType.transparency,
                child: bottomBar!,
              ),
            ),
      body: Material(
        type: MaterialType.transparency,
        child: ContextMenuHost(
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
      ),
    );
  }
}

/// A wash of the page colour behind a bar: nearly opaque where the bar's text sits, fading
/// out below it. The progressive blur alone is weakest exactly under a title — the row a
/// reader looks at — so a card's text scrolling past still showed through it.
class _BarScrim extends StatelessWidget {
  const _BarScrim({
    required this.top,
    required this.height,
    required this.solid,
    required this.palette,
  });

  final bool top;
  final double height;

  /// How much of `height` is held at full strength before the fade begins.
  final double solid;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    final hold = (solid / height).clamp(0.0, 1.0);
    final color = palette.background;
    final stops = <double>[0, hold, 1];
    final colors = <Color>[
      color.withValues(alpha: top ? 0.9 : 0.78),
      color.withValues(alpha: top ? 0.86 : 0.7),
      color.withValues(alpha: 0),
    ];
    return Positioned(
      left: 0,
      right: 0,
      top: top ? 0 : null,
      bottom: top ? null : 0,
      height: height,
      child: IgnorePointer(
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: top ? Alignment.topCenter : Alignment.bottomCenter,
              end: top ? Alignment.bottomCenter : Alignment.topCenter,
              stops: stops,
              colors: colors,
            ),
          ),
        ),
      ),
    );
  }
}

/// A bar button that opens an iOS pull-down menu ([GlassMenuItem]s, [GlassMenuDivider]s)
/// instead of acting itself — the chat's ⋯, the project filter. Only meaningful in a
/// [GlassScreen]'s `actions`, which turns it into the bar's own menu item.
/// The height a nav-bar pull-down is held to, or null while its rows fit.
///
/// A bar item's menu never bounds itself: the package caps a menu only with
/// `autoAdjustToScreen`, which [GlassBarItem.menu] cannot set, so a project filter with
/// more rows than the screen ran off the bottom with no way to reach the rest. A fixed
/// `menuHeight` is what switches on the menu's own scrolling, so it is passed only once
/// the rows — measured the way the package measures them — outgrow the room below the bar.
double? _barMenuHeight(BuildContext context, List<Widget> items) {
  final media = MediaQuery.of(context);
  final scaler = media.textScaler;
  var natural = 24.0 + math.max(0, items.length - 1) * 2.0;
  for (final item in items) {
    if (item is GlassMenuItem) {
      final title =
          scaler.scale(item.titleStyle?.fontSize ?? 17) * 1.2 * item.maxLines;
      final subtitle = item.subtitle == null
          ? 0.0
          : scaler.scale(item.subtitleStyle?.fontSize ?? 13) * 1.2;
      natural += math.max(item.height, title + subtitle + 16);
    } else if (item is GlassMenuDivider) {
      natural += item.height;
    } else {
      natural += 44;
    }
  }
  // The capsule sits just under the status bar; keep the menu clear of the home
  // indicator with the same breathing room the sheets keep from the screen edge.
  final room =
      media.size.height - media.padding.top - media.padding.bottom - 72;
  return natural > room ? math.max(room, 160.0) : null;
}

class GlassMenuAction extends StatelessWidget {
  const GlassMenuAction({
    super.key,
    required this.icon,
    required this.items,
    this.tooltip,
    this.active = false,
  });

  final List<List<dynamic>> icon;
  final List<Widget> items;
  final String? tooltip;

  /// The menu is narrowing what is shown (a filter that is on).
  final bool active;

  @override
  Widget build(BuildContext context) => GlassPullDownButton(
    icon: HugeIcon(icon: icon, size: 20, color: paletteOf(context).text),
    items: items,
    semanticLabel: tooltip,
  );
}

class GlassAction extends StatelessWidget {
  const GlassAction({
    super.key,
    required this.icon,
    required this.onPressed,
    this.tooltip,
    this.active = false,
  });

  /// The control is currently doing something (a filter that is applied).
  final bool active;
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
