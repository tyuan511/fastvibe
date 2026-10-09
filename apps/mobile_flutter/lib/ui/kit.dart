import 'package:flutter/cupertino.dart'
    show
        CupertinoActivityIndicator,
        CupertinoSliverRefreshControl,
        RefreshIndicatorMode;
import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../theme/theme.dart';
import 'icons.dart';

/// A round icon button. The Expo client's `IconButton`: transparent, recessed or filled
/// depending on `tone`, with the glyph at ~52% of the box.
enum IconTone { plain, field, accent, soft }

class IconAction extends StatelessWidget {
  const IconAction({
    super.key,
    required this.icon,
    required this.onPressed,
    this.tone = IconTone.plain,
    this.size = 36,
    this.strokeWidth = 1.9,
    this.tooltip,
    this.enabled = true,
  });

  final List<List<dynamic>> icon;
  final VoidCallback? onPressed;
  final IconTone tone;
  final double size;
  final double strokeWidth;
  final String? tooltip;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final (background, foreground) = switch (tone) {
      IconTone.plain => (Colors.transparent, palette.text),
      IconTone.field => (palette.field, palette.text),
      IconTone.accent => (palette.accent, palette.accentText),
      IconTone.soft => (palette.accentSoft, palette.accent),
    };
    final button = Opacity(
      opacity: enabled ? 1 : 0.4,
      child: Material(
        color: background,
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: enabled ? onPressed : null,
          child: SizedBox(
            width: size,
            height: size,
            child: Center(
              child: HugeIcon(
                icon: icon,
                color: foreground,
                size: (size * 0.52).roundToDouble(),
                strokeWidth: strokeWidth,
              ),
            ),
          ),
        ),
      ),
    );
    if (tooltip == null) return button;
    return Semantics(label: tooltip, button: true, child: button);
  }
}

/// A coloured initial for a project, a provider or a device. The colour is derived from
/// the name, so the same project reads the same on every screen.
class Avatar extends StatelessWidget {
  const Avatar({
    super.key,
    required this.name,
    this.size = 32,
    this.icon,
    this.borderRadius,
  });

  final String name;
  final double size;
  final List<List<dynamic>>? icon;
  final double? borderRadius;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final tint = nameTint(name, palette);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: tint.bg,
        borderRadius: BorderRadius.circular(borderRadius ?? size * 0.3),
      ),
      alignment: Alignment.center,
      child: icon != null
          ? HugeIcon(
              icon: icon!,
              color: tint.fg,
              size: size * 0.52,
              strokeWidth: 1.9,
            )
          : Text(
              initials(name),
              style: TextStyle(
                color: tint.fg,
                fontSize: size * 0.42,
                fontWeight: FontWeight.w700,
              ),
            ),
    );
  }
}

enum PillTone { neutral, accent, warning, danger, success }

/// A small status chip: 运行中, 等你处理, 失败.
class Pill extends StatelessWidget {
  const Pill({
    super.key,
    required this.label,
    this.tone = PillTone.neutral,
    this.icon,
  });

  final String label;
  final PillTone tone;
  final List<List<dynamic>>? icon;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final (foreground, background) = switch (tone) {
      PillTone.neutral => (palette.muted, palette.field),
      PillTone.accent => (palette.accent, palette.accentSoft),
      PillTone.warning => (palette.warning, palette.warningSoft),
      PillTone.danger => (palette.danger, palette.dangerSoft),
      PillTone.success => (palette.success, palette.successSoft),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      constraints: const BoxConstraints(maxWidth: 160),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(Radii.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            HugeIcon(
              icon: icon!,
              color: foreground,
              size: 11,
              strokeWidth: 2.2,
            ),
            const SizedBox(width: 3),
          ],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: foreground,
                fontSize: 11,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// A search field on a surface that is already glass (a sheet), where `GlassSearchBar`
/// would refract inside refraction. Drawn to `UISearchTextField`'s metrics: 36pt tall,
/// 10pt corners, the system fill, 17pt text, a magnifier and a clear button.
class SearchField extends StatelessWidget {
  const SearchField({
    super.key,
    required this.controller,
    required this.placeholder,
    this.onChanged,
    this.onSubmitted,
    this.autofocus = false,
  });

  final TextEditingController controller;
  final String placeholder;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Container(
      height: 36,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        color: palette.field,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: <Widget>[
          HugeIcon(
            icon: AppIcons.search,
            color: palette.muted,
            size: 17,
            strokeWidth: 2,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              onSubmitted: onSubmitted,
              autofocus: autofocus,
              textInputAction: TextInputAction.search,
              autocorrect: false,
              style: TextStyle(color: palette.text, fontSize: 17),
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                hintText: placeholder,
                hintStyle: TextStyle(color: palette.subtle, fontSize: 17),
              ),
            ),
          ),
          if (controller.text.isNotEmpty)
            GestureDetector(
              onTap: () {
                controller.clear();
                onChanged?.call('');
              },
              child: Container(
                width: 16,
                height: 16,
                decoration: BoxDecoration(
                  color: palette.subtle,
                  shape: BoxShape.circle,
                ),
                child: Center(
                  child: HugeIcon(
                    icon: AppIcons.cancel,
                    color: palette.card,
                    size: 10,
                    strokeWidth: 3,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// The brand-gradient primary action: 登录并保存, 开始新对话, 连接.
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
    this.enabled = true,
    this.height = 50,
  });

  final String label;
  final VoidCallback? onPressed;
  final List<List<dynamic>>? icon;
  final bool busy;
  final bool enabled;
  final double height;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final active = enabled && !busy && onPressed != null;
    return GlassButton.custom(
      onTap: onPressed ?? () {},
      enabled: active,
      label: label,
      height: height,
      useOwnLayer: true,
      shape: const LiquidRoundedSuperellipse(borderRadius: 25),
      settings: LiquidGlassSettings(
        glassColor: palette.accent.withValues(alpha: 0.88),
        blur: 12,
        thickness: 18,
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: busy
            ? CupertinoActivityIndicator(color: palette.accentText)
            : Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (icon != null) ...[
                    HugeIcon(icon: icon!, size: 19, color: palette.accentText),
                    const SizedBox(width: 8),
                  ],
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 2,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: palette.accentText,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}

/// A secondary action: 取消, 重新连接. The iOS 26 `.glass` button — the neutral twin of
/// [PrimaryButton]'s `.glassProminent` — rather than a bordered card.
class SecondaryButton extends StatelessWidget {
  const SecondaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.height = 50,
  });

  final String label;
  final VoidCallback? onPressed;
  final List<List<dynamic>>? icon;
  final double height;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return GlassButton.custom(
      onTap: onPressed ?? () {},
      enabled: onPressed != null,
      label: label,
      height: height,
      useOwnLayer: true,
      shape: const LiquidRoundedSuperellipse(borderRadius: 25),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            if (icon != null) ...<Widget>[
              HugeIcon(
                icon: icon!,
                color: palette.accent,
                size: 19,
                strokeWidth: 2,
              ),
              const SizedBox(width: 8),
            ],
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: palette.accent,
                  fontSize: 17,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The header above an inset grouped section: 收藏, 等你处理, 最近. iOS draws it in the
/// footnote style (13pt, regular, secondary), aligned with the text inside the group, with
/// no count — a list does not announce how long it is in its headers.
class SectionLabel extends StatelessWidget {
  const SectionLabel({super.key, required this.title, this.trailing});

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 7),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              title,
              style: TextStyle(color: palette.muted, fontSize: 13),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// An inset grouped section: one rounded card, rows separated by hairlines that start
/// where the row's text starts (`separatorIndent`), never under the leading icon.
class InsetGroup extends StatelessWidget {
  const InsetGroup({
    super.key,
    required this.children,
    this.separatorIndent = 16,
    this.color,
  });

  final List<Widget> children;
  final double separatorIndent;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Material(
      color: color ?? palette.card,
      borderRadius: BorderRadius.circular(Radii.group),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          for (var index = 0; index < children.length; index++) ...<Widget>[
            if (index > 0)
              Padding(
                padding: EdgeInsets.only(left: separatorIndent),
                child: Container(height: 0.5, color: palette.separator),
              ),
            children[index],
          ],
        ],
      ),
    );
  }
}

/// The centred empty state, drawn like iOS's `ContentUnavailableView`: a large secondary
/// glyph with no tile behind it, a title, a line of explanation, then any actions.
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.body,
    this.children = const <Widget>[],
  });

  final List<List<dynamic>> icon;
  final String title;
  final String? body;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            HugeIcon(
              icon: icon,
              color: palette.subtle,
              size: 48,
              strokeWidth: 1.6,
            ),
            const SizedBox(height: 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: palette.text,
                fontSize: 20,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (body != null) ...<Widget>[
              const SizedBox(height: 6),
              Text(
                body!,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: palette.muted,
                  fontSize: 15,
                  height: 20 / 15,
                ),
              ),
            ],
            ...children,
          ],
        ),
      ),
    );
  }
}

/// The full-screen loading state: the app mark, then a spinner with a status line.
class BrandLoading extends StatelessWidget {
  const BrandLoading({super.key, this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const BrandLogo(size: 72),
            const SizedBox(height: 10),
            Text(
              'FastVibe',
              style: TextStyle(
                color: palette.text,
                fontSize: 18,
                fontWeight: FontWeight.w700,
                letterSpacing: -0.3,
              ),
            ),
            const SizedBox(height: 10),
            ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 20),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  DesktopSpinner(size: 14, color: palette.muted),
                  if (message != null) ...<Widget>[
                    const SizedBox(width: 7),
                    Text(
                      message!,
                      style: TextStyle(color: palette.muted, fontSize: 13),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The app icon, rounded like the icon on the home screen.
class BrandLogo extends StatelessWidget {
  const BrandLogo({super.key, this.size = 64});

  final double size;

  @override
  Widget build(BuildContext context) {
    // The artwork is full-bleed, so the mask is the whole shape: iOS's continuous
    // (superellipse) corner, 22.37% of the side, the same as the home-screen icon.
    return ClipRSuperellipse(
      borderRadius: BorderRadius.circular(size * 0.2237),
      child: Image.asset(
        'assets/icon.png',
        width: size,
        height: size,
        filterQuality: FilterQuality.medium,
      ),
    );
  }
}

/// A labelled row inside a settings card.
class SettingsRow extends StatelessWidget {
  const SettingsRow({
    super.key,
    required this.icon,
    required this.label,
    this.description,
    this.value,
    this.trailing,
    this.onTap,
  });

  final List<List<dynamic>> icon;
  final String label;
  final String? description;
  final String? value;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final content = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: <Widget>[
          SettingsIcon(icon: icon),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  label,
                  style: TextStyle(color: palette.text, fontSize: 17),
                ),
                if (description != null) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(
                    description!,
                    style: TextStyle(
                      color: palette.muted,
                      fontSize: 13,
                      height: 18 / 13,
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (value != null)
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 160),
              child: Text(
                value!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: palette.muted, fontSize: 17),
              ),
            ),
          if (value != null && onTap != null) const SizedBox(width: 6),
          if (value != null && onTap != null)
            HugeIcon(
              icon: AppIcons.arrowRight,
              color: palette.subtle,
              size: 15,
            ),
          ?trailing,
          if (trailing == null && value == null && onTap != null) ...<Widget>[
            HugeIcon(
              icon: AppIcons.arrowRight,
              color: palette.subtle,
              size: 16,
            ),
          ],
        ],
      ),
    );
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: content,
        ),
      ),
    );
  }
}

/// The coloured tile in front of a settings row, as in the Settings app: a 29pt rounded
/// square in the accent with a white glyph.
class SettingsIcon extends StatelessWidget {
  const SettingsIcon({super.key, required this.icon, this.color});

  final List<List<dynamic>> icon;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Container(
      width: 29,
      height: 29,
      decoration: BoxDecoration(
        color: color ?? palette.accent,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Center(
        child: HugeIcon(
          icon: icon,
          color: Colors.white,
          size: 17,
          strokeWidth: 1.9,
        ),
      ),
    );
  }
}

/// A settings section's rows: an [InsetGroup] whose hairlines start at the label, past
/// the 29pt icon tile.
class SettingsCard extends StatelessWidget {
  const SettingsCard({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) =>
      InsetGroup(separatorIndent: 16 + 29 + 12, children: children);
}

/// iOS pull-to-refresh, for a list that runs under the glass bar.
///
/// `CupertinoSliverRefreshControl` only sees the pull when it is the scroll view's
/// **first** sliver (a spacer before it swallows the overscroll — pinned by a probe test),
/// so it cannot sit below the bar's spacer. It goes first, and the indicator is drawn
/// `topInset` lower than its box, so it appears just under the bar instead of behind it.
Widget iosRefreshControl({
  required Future<void> Function() onRefresh,
  required double topInset,
}) {
  const diameter = 28.0;
  return CupertinoSliverRefreshControl(
    onRefresh: onRefresh,
    builder: (context, mode, pulled, trigger, extent) {
      final progress = (pulled / trigger).clamp(0.0, 1.0);
      final Widget? indicator = switch (mode) {
        RefreshIndicatorMode.inactive => null,
        RefreshIndicatorMode.drag =>
          CupertinoActivityIndicator.partiallyRevealed(
            radius: diameter / 2,
            progress: progress,
          ),
        RefreshIndicatorMode.armed ||
        RefreshIndicatorMode.refresh ||
        RefreshIndicatorMode.done => const CupertinoActivityIndicator(
          radius: diameter / 2,
        ),
      };
      if (indicator == null) return const SizedBox.shrink();
      // The strip the pull has opened is `pulled` tall and starts under the bar, at
      // `topInset`; the title sits right below it and rides up as it closes. The
      // indicator is centred in that strip and fades out before the strip is thinner
      // than itself, so on the way back it never runs into the title.
      final fade = ((pulled - diameter) / diameter).clamp(0.0, 1.0);
      return Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Positioned(
            top: topInset + pulled / 2 - diameter / 2,
            left: 0,
            right: 0,
            child: Opacity(
              opacity: fade,
              child: Center(child: indicator),
            ),
          ),
        ],
      );
    },
  );
}

/// Reads the active palette. Set once by the app root from 设置 → 外观.
class PaletteScope extends InheritedWidget {
  const PaletteScope({super.key, required this.palette, required super.child});

  final Palette palette;

  static Palette of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<PaletteScope>();
    assert(scope != null, 'PaletteScope is missing from the tree');
    return scope!.palette;
  }

  @override
  bool updateShouldNotify(PaletteScope oldWidget) =>
      oldWidget.palette != palette;
}

Palette paletteOf(BuildContext context) => PaletteScope.of(context);
