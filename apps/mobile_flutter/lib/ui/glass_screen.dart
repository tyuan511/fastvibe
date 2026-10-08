import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../theme/theme.dart';
import 'icons.dart';
import 'kit.dart';

/// The glass shell every screen sits in.
///
/// Glass in the iOS 26 design system is the *navigation and control layer*: bars,
/// floating buttons, sheets, dialogs. Content — a conversation's rows, a settings card, a
/// transcript — stays opaque, because a reader has to read it. So this shell draws the
/// chrome as glass and hands the body an ordinary `Scaffold`-less canvas to fill.
///
/// `GlassScaffold` is used rather than `Scaffold` for one reason that is not cosmetic:
/// it owns the z-order and the edge fade, so a list scrolling under a glass bar fades
/// instead of colliding with the buttons, and a glass card in the body can never paint
/// over the bar.
class GlassScreen extends StatelessWidget {
  const GlassScreen({
    super.key,
    required this.title,
    required this.body,
    this.subtitle,
    this.leading,
    this.actions = const <Widget>[],
    this.bottomBar,
    this.floatingAction,
    this.showBack = true,
  });

  final String title;
  final String? subtitle;
  final Widget body;

  /// Replaces the automatic back button when the screen has something else to put there.
  final Widget? leading;
  final List<Widget> actions;
  final Widget? bottomBar;
  final Widget? floatingAction;
  final bool showBack;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return GlassScaffold(
      // The page behind the glass. It is the same colour the content cards sit on, so a
      // bar reads as a material over the page rather than as a second surface.
      backgroundColor: palette.background,
      statusBarStyle: palette.dark ? GlassStatusBarStyle.light : GlassStatusBarStyle.dark,
      // The bar's own labels flip with what scrolls under it — the iOS 26 behaviour, and
      // the reason a title stays legible over a photo or a dark transcript.
      contentAwareBrightness: true,
      appBar: GlassAppBar(
        centerTitle: false,
        title: _Title(title: title, subtitle: subtitle, palette: palette),
        leading: leading ?? (showBack ? _BackButton(palette: palette) : null),
        actions: <Widget>[
          for (final action in actions)
            Padding(padding: const EdgeInsets.only(right: 4), child: action),
        ],
      ),
      bottomBar: bottomBar,
      // `GlassScaffold` is not a `Scaffold`: it draws no Material of its own, and every
      // `TextField`, `InkWell` and `Switch` in a body needs one — without it the first
      // frame of any screen with an input throws `No Material widget found` and takes the
      // whole tree down. The page colour comes from `backgroundColor` above, so this
      // layer is deliberately transparent: it exists for the ancestor, not for a fill.
      body: Material(
        type: MaterialType.transparency,
        child: Stack(
          children: <Widget>[
            body,
            if (floatingAction != null)
              Positioned(right: 18, bottom: 18, child: floatingAction!),
          ],
        ),
      ),
    );
  }
}

class _Title extends StatelessWidget {
  const _Title({required this.title, required this.subtitle, required this.palette});

  final String title;
  final String? subtitle;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    if (subtitle == null) {
      return Text(
        title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: palette.text, fontSize: 17, fontWeight: FontWeight.w700),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: palette.text, fontSize: 16, fontWeight: FontWeight.w700),
        ),
        Text(
          subtitle!,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: palette.muted, fontSize: 12, fontWeight: FontWeight.w500),
        ),
      ],
    );
  }
}

class _BackButton extends StatelessWidget {
  const _BackButton({required this.palette});

  final Palette palette;

  @override
  Widget build(BuildContext context) {
    if (!Navigator.of(context).canPop()) return const SizedBox.shrink();
    return GlassIconButton(
      icon: HugeIcon(icon: AppIcons.arrowRight, size: 20, color: palette.text),
      // The glyph is drawn pointing right; the back affordance points the other way.
      onPressed: () => Navigator.of(context).maybePop(),
      size: 36,
      iconSize: 20,
      shape: GlassIconButtonShape.circle,
    );
  }
}

/// A glass icon button for a bar's `actions`. Wraps the same component the shell's back
/// button uses, so every control in the chrome has one look.
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
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final button = GlassIconButton(
      icon: HugeIcon(icon: icon, size: 18, color: palette.text),
      onPressed: onPressed,
      size: 34,
      iconSize: 18,
      shape: GlassIconButtonShape.circle,
      semanticLabel: tooltip,
    );
    return button;
  }
}
