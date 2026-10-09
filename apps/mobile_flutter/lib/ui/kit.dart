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
    return Tooltip(message: tooltip!, child: button);
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

/// The list's search box. Recessed fill, a leading glyph, and a clear button once there
/// is something to clear.
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
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: palette.field,
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Row(
        children: <Widget>[
          HugeIcon(
            icon: AppIcons.search,
            color: palette.muted,
            size: 17,
            strokeWidth: 2,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              onSubmitted: onSubmitted,
              autofocus: autofocus,
              textInputAction: TextInputAction.search,
              autocorrect: false,
              style: TextStyle(color: palette.text, fontSize: 16),
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                hintText: placeholder,
                hintStyle: TextStyle(color: palette.subtle, fontSize: 16),
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
            ? SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: palette.accentText,
                ),
              )
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

/// A secondary action: 取消, 重新连接 — a card fill with a hairline border.
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
    return Material(
      color: palette.card,
      borderRadius: BorderRadius.circular(Radii.md),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(Radii.md),
        child: Container(
          height: height,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Radii.md),
            border: Border.all(color: palette.border, width: 0.5),
          ),
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
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Text(
                    label,
                    style: TextStyle(
                      color: palette.text,
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A list section header: 我的设备, 等你处理, 最近.
class SectionLabel extends StatelessWidget {
  const SectionLabel({
    super.key,
    required this.title,
    this.count,
    this.trailing,
  });

  final String title;
  final int? count;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 14, 4, 6),
      child: Row(
        children: <Widget>[
          Text(
            title,
            style: TextStyle(
              color: palette.muted,
              fontSize: 13,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.2,
            ),
          ),
          if (count != null) ...<Widget>[
            const SizedBox(width: 6),
            Text(
              '$count',
              style: TextStyle(
                color: palette.subtle,
                fontSize: 12,
                fontWeight: FontWeight.w600,
                fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
              ),
            ),
          ],
          const Spacer(),
          ?trailing,
        ],
      ),
    );
  }
}

/// The centred empty state: a tinted glyph block, a title and a line of explanation.
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
            Container(
              width: 60,
              height: 60,
              decoration: BoxDecoration(
                color: palette.accentSoft,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Center(
                child: HugeIcon(
                  icon: icon,
                  color: palette.accent,
                  size: 28,
                  strokeWidth: 1.8,
                ),
              ),
            ),
            const SizedBox(height: 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: palette.text,
                fontSize: 17,
                fontWeight: FontWeight.w700,
              ),
            ),
            if (body != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                body!,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: palette.muted,
                  fontSize: 14,
                  height: 21 / 14,
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
    return ClipRRect(
      borderRadius: BorderRadius.circular(size * 0.22),
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
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: <Widget>[
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
              color: palette.accentSoft,
              borderRadius: BorderRadius.circular(9),
            ),
            child: Center(
              child: HugeIcon(
                icon: icon,
                color: palette.accent,
                size: 17,
                strokeWidth: 1.9,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  label,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 16,
                    fontWeight: FontWeight.w500,
                  ),
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
                style: TextStyle(color: palette.muted, fontSize: 15),
              ),
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
          constraints: const BoxConstraints(minHeight: 54),
          child: content,
        ),
      ),
    );
  }
}

/// A settings card: rows on a raised surface, separated by a hairline inset past the icon.
class SettingsCard extends StatelessWidget {
  const SettingsCard({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final rows = <Widget>[];
    for (var index = 0; index < children.length; index++) {
      if (index > 0) {
        rows.add(
          Divider(
            height: 0.5,
            thickness: 0.5,
            indent: 56,
            color: palette.separator,
          ),
        );
      }
      rows.add(children[index]);
    }
    return Container(
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(Radii.lg),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(children: rows),
    );
  }
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
