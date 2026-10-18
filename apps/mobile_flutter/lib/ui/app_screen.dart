import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import 'context_menu.dart';
import 'icons.dart';
import 'kit.dart';

/// Room a scroll view leaves at its end: the home indicator plus a little air. A screen's
/// bars are ordinary rows above and below its body, so nothing scrolls under them and there
/// is no top reach to pad for.
abstract final class AppInsets {
  static EdgeInsets pad(
    BuildContext context, [
    EdgeInsets base = EdgeInsets.zero,
  ]) => base.copyWith(
    bottom: base.bottom + MediaQuery.paddingOf(context).bottom + 12,
  );
}

/// Publishes the keyboard overlap and hides it from [child].
///
/// A screen that resizes with the keyboard lays its body out again on every frame of the
/// animation, which a long transcript cannot afford. Descendants that have to stay above
/// the keyboard read [of]; the page underneath sees a stable inset of zero and keeps its
/// size.
class KeyboardLift extends StatelessWidget {
  const KeyboardLift({super.key, required this.child});

  final Widget child;

  static double of(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<_KeyboardLiftScope>()
          ?.bottom ??
      0;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final bottom = media.viewInsets.bottom;
    // Zeroing the inset makes this data equal to the previous frame's for as
    // long as nothing but the keyboard moved, so the page is not rebuilt.
    final data = bottom == 0
        ? media
        : media.copyWith(viewInsets: media.viewInsets.copyWith(bottom: 0));
    return _KeyboardLiftScope(
      bottom: bottom,
      child: MediaQuery(data: data, child: child),
    );
  }
}

class _KeyboardLiftScope extends InheritedWidget {
  const _KeyboardLiftScope({required this.bottom, required super.child});

  final double bottom;

  @override
  bool updateShouldNotify(_KeyboardLiftScope oldWidget) =>
      bottom != oldWidget.bottom;
}

/// Every route's frame: a flat page, a plain top bar (back, title, actions), the body, and an
/// optional bottom bar. Nothing is blurred or translucent.
class AppScreen extends StatelessWidget {
  const AppScreen({
    super.key,
    required this.title,
    required this.body,
    this.subtitle,
    this.statusColor,
    this.actions = const <Widget>[],
    this.bottomBar,
    this.floatingAction,
    this.showBack = true,
    this.resizeToAvoidBottomInset = true,
  });

  final String title;
  final String? subtitle;
  final Color? statusColor;
  final Widget body;
  final List<Widget> actions;
  final Widget? bottomBar;
  final Widget? floatingAction;
  final bool showBack;

  /// `false` leaves the body full height while the keyboard moves. The chat does this:
  /// resizing would lay out every visible message on each frame. Pair it with
  /// [KeyboardLift], which is what actually clears the keyboard.
  final bool resizeToAvoidBottomInset;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final bottom = bottomBar;
    Widget content = ContextMenuHost(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 880),
          child: Stack(
            fit: StackFit.expand,
            children: <Widget>[
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
    );
    content = MediaQuery.removePadding(
      context: context,
      removeTop: true,
      removeBottom: bottom != null,
      child: content,
    );
    Widget page = Column(
      children: <Widget>[
        _TopBar(
          title: title,
          subtitle: subtitle,
          statusColor: statusColor,
          showBack: showBack,
          actions: actions,
        ),
        Expanded(child: Material(type: MaterialType.transparency, child: content)),
        if (bottom != null)
          Material(
            type: MaterialType.transparency,
            child: SafeArea(top: false, child: bottom),
          ),
      ],
    );
    if (resizeToAvoidBottomInset) {
      page = Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: page,
      );
    }
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: palette.dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
      child: ColoredBox(color: palette.background, child: page),
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({
    required this.title,
    required this.subtitle,
    required this.statusColor,
    required this.showBack,
    required this.actions,
  });

  final String title;
  final String? subtitle;
  final Color? statusColor;
  final bool showBack;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Container(
      padding: EdgeInsets.only(top: MediaQuery.paddingOf(context).top),
      decoration: BoxDecoration(
        color: palette.background,
        border: Border(bottom: BorderSide(color: palette.separator, width: 0.5)),
      ),
      child: SizedBox(
        height: 52,
        child: NavigationToolbar(
          centerMiddle: true,
          leading: showBack
              ? Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: IconAction(
                    icon: AppIcons.arrowLeft,
                    size: 40,
                    onPressed: () {
                      if (context.canPop()) {
                        context.pop();
                      } else {
                        context.go('/');
                      }
                    },
                  ),
                )
              : const SizedBox(width: 16),
          middle: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
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
                  children: <Widget>[
                    if (statusColor != null) ...<Widget>[
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
          trailing: Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Row(mainAxisSize: MainAxisSize.min, children: actions),
          ),
        ),
      ),
    );
  }
}

/// A button in the top bar.
class AppAction extends StatelessWidget {
  const AppAction({
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
  Widget build(BuildContext context) => IconAction(
    icon: icon,
    onPressed: onPressed,
    size: 40,
    tone: active ? IconTone.soft : IconTone.plain,
    tooltip: tooltip,
  );
}

/// A top-bar button that opens a menu under itself instead of acting — the chat's ⋯.
class AppMenuAction extends StatelessWidget {
  const AppMenuAction({
    super.key,
    required this.icon,
    required this.items,
    this.tooltip,
  });

  final List<List<dynamic>> icon;
  final List<Widget> items;
  final String? tooltip;

  @override
  Widget build(BuildContext context) => IconAction(
    icon: icon,
    size: 40,
    tooltip: tooltip,
    onPressed: () {
      final box = context.findRenderObject();
      if (box is! RenderBox) return;
      final origin = box.localToGlobal(Offset.zero);
      showAppMenu(
        context,
        anchor: Rect.fromLTWH(origin.dx, origin.dy, box.size.width, box.size.height),
        items: items,
      );
    },
  );
}
