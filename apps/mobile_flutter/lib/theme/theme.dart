import 'package:flutter/cupertino.dart' show CupertinoActivityIndicator;
import 'package:flutter/material.dart';

/// The phone's design tokens.
///
/// Grouped-list layout: `background` is the page, `card` the raised surface a row or a
/// panel sits on, `field` the recessed one (a search box, an input, a code block). The
/// accent follows the app icon's blue, and each status colour has a `…Soft` twin for the
/// tinted fill behind it, so a badge never has to guess an alpha of its own.
@immutable
class Palette {
  const Palette({
    required this.dark,
    required this.background,
    required this.card,
    required this.field,
    required this.text,
    required this.muted,
    required this.subtle,
    required this.border,
    required this.separator,
    required this.accent,
    required this.accentSoft,
    required this.accentText,
    required this.brand,
    required this.danger,
    required this.dangerSoft,
    required this.warning,
    required this.warningSoft,
    required this.success,
    required this.successSoft,
    required this.overlay,
    required this.shadow,
  });

  final bool dark;
  final Color background;
  final Color card;
  final Color field;
  final Color text;
  final Color muted;
  final Color subtle;
  final Color border;
  final Color separator;
  final Color accent;
  final Color accentSoft;
  final Color accentText;

  /// The icon's gradient, start → end.
  final List<Color> brand;
  final Color danger;
  final Color dangerSoft;
  final Color warning;
  final Color warningSoft;
  final Color success;
  final Color successSoft;
  final Color overlay;
  final Color shadow;

  /// Glass shows the page through itself, so a glass theme lightens the page and lets
  /// the material read as a material rather than as a flat fill. Content cards stay
  /// opaque either way — see the glass rules in the project instructions.
  Palette copyWithGlass() => this;
}

const Palette light = Palette(
  dark: false,
  background: Color(0xFFF2F6FA),
  card: Color(0xFFFFFFFF),
  field: Color(0xFFECEEF2),
  text: Color(0xFF0F1115),
  muted: Color(0xFF6B7080),
  subtle: Color(0xFF717B8C),
  border: Color(0xFFE3E5EA),
  separator: Color(0xFFECEEF2),
  accent: Color(0xFF1769DE),
  accentSoft: Color(0xFFE7EEFE),
  accentText: Color(0xFFFFFFFF),
  brand: <Color>[Color(0xFF3BA8FF), Color(0xFF4A3CFF)],
  danger: Color(0xFFE5484D),
  dangerSoft: Color(0xFFFDECEC),
  warning: Color(0xFFC27C00),
  warningSoft: Color(0xFFFDF3DC),
  success: Color(0xFF16A34A),
  successSoft: Color(0xFFE5F6EA),
  overlay: Color(0x6B0A0C14),
  shadow: Color(0xFF1A2340),
);

const Palette dark = Palette(
  dark: true,
  background: Color(0xFF0C111B),
  card: Color(0xFF171F2C),
  field: Color(0xFF222C3C),
  text: Color(0xFFF2F3F5),
  muted: Color(0xFF9A9EA9),
  subtle: Color(0xFF8B97A9),
  border: Color(0xFF334054),
  separator: Color(0xFF222C3C),
  accent: Color(0xFF5B8CFF),
  accentSoft: Color(0xFF1A2544),
  accentText: Color(0xFFFFFFFF),
  brand: <Color>[Color(0xFF3BA8FF), Color(0xFF5B4BFF)],
  danger: Color(0xFFFF6369),
  dangerSoft: Color(0xFF3A1A1C),
  warning: Color(0xFFF5B73B),
  warningSoft: Color(0xFF3A2D12),
  success: Color(0xFF3DD68C),
  successSoft: Color(0xFF12301F),
  overlay: Color(0x99000000),
  shadow: Color(0xFF000000),
);

/// Continuous, generous corners for the glass design.
abstract final class Radii {
  static const double sm = 8;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 30;

  /// An inset grouped section's corners.
  static const double group = 24;

  /// A free-standing list card (one conversation): a little tighter than a group.
  static const double card = 20;
  static const double pill = 999;
}

/// A soft lift for *floating* surfaces only — the FAB, a dialog, a toast. Cards that sit
/// on the page (list rows, settings groups, the hero) are flat: tinted fill, no shadow.
/// Flat in dark mode too, where a shadow reads as a smudge.
/// `0` is barely there — for things that sit on the page rather than float over it (the
/// composer, the 正在工作 pill), where anything heavier drew the eye away from the reply.
List<BoxShadow> elevation(Palette palette, [int level = 1]) {
  if (palette.dark) {
    return const <BoxShadow>[
      // Dark mode keeps the platform's own elevation instead of a shadow; a black
      // shadow on a black page is a smudge. The fill difference carries it.
    ];
  }
  final specs = <List<double>>[
    <double>[0.035, 4, 1],
    <double>[0.06, 8, 2],
    <double>[0.12, 18, 6],
  ];
  final spec = specs[level.clamp(0, 2)];
  return <BoxShadow>[
    BoxShadow(
      color: palette.shadow.withValues(alpha: spec[0]),
      blurRadius: spec[1],
      offset: Offset(0, spec[2]),
    ),
  ];
}

/// Material elevation, which is what the Expo client set alongside the shadow.
double androidElevation(int level) => level == 0 ? 1 : level * 2;

/// A stable hue for a name — a provider or a project gets the same colour on every
/// screen and every launch, so it can be recognised before it is read.
({Color fg, Color bg}) nameTint(String name, Palette palette) {
  var hash = 0;
  for (final unit in name.codeUnits) {
    hash = (hash * 31 + unit) & 0xFFFFFFFF;
  }
  final hue = (hash % 360).toDouble();
  return palette.dark
      ? (
          fg: HSLColor.fromAHSL(1, hue, 0.70, 0.72).toColor(),
          bg: HSLColor.fromAHSL(1, hue, 0.32, 0.20).toColor(),
        )
      : (
          fg: HSLColor.fromAHSL(1, hue, 0.62, 0.38).toColor(),
          bg: HSLColor.fromAHSL(1, hue, 0.70, 0.93).toColor(),
        );
}

/// The one or two characters an avatar draws for a name: `Anthropic` → `A`, `智谱` → `智`.
String initials(String name) {
  final trimmed = name.trim();
  if (trimmed.isEmpty) return '?';
  final words = trimmed
      .split(RegExp(r'[\s_\-/.]+'))
      .where((w) => w.isNotEmpty)
      .toList();
  if (words.length > 1 &&
      RegExp(r'^[a-z]', caseSensitive: false).hasMatch(words[0]) &&
      RegExp(r'^[a-z0-9]', caseSensitive: false).hasMatch(words[1])) {
    return '${words[0][0]}${words[1][0]}'.toUpperCase();
  }
  return String.fromCharCode(trimmed.runes.first).toUpperCase();
}

/// `1.2M` / `12K` / `340` — a token count in a chip or a stat line.
String formatTokens(num value) {
  if (value >= 1e6) return '${(value / 1e6).toStringAsFixed(1)}M';
  if (value >= 1e3) return '${(value / 1e3).round()}K';
  return '$value';
}

/// Clamps `text` to `maxLines` / `maxChars`, keeping the head or the tail.
/// Used by the tool card, which shows a command's beginning and an output's end.
String clipText(
  String text, {
  required int maxChars,
  required int maxLines,
  required bool keepHead,
}) {
  var value = text;
  final lines = value.split('\n');
  if (lines.length > maxLines) {
    value = keepHead
        ? lines.take(maxLines).join('\n')
        : lines.skip(lines.length - maxLines).join('\n');
    value = keepHead ? '$value\n…' : '…\n$value';
  }
  if (value.length > maxChars) {
    value = keepHead
        ? '${value.substring(0, maxChars)}\n…'
        : '…\n${value.substring(value.length - maxChars)}';
  }
  return value;
}

/// The app's single spinner: the iOS activity indicator (`UIActivityIndicatorView`), at
/// the size and colour asked for.
class DesktopSpinner extends StatelessWidget {
  const DesktopSpinner({super.key, this.size = 16, required this.color});

  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: size,
    child: CupertinoActivityIndicator(radius: size / 2, color: color),
  );
}

/// The brand gradient, drawn from the top-left to the bottom-right like the icon.
class BrandGradient extends StatelessWidget {
  const BrandGradient({
    super.key,
    required this.child,
    required this.palette,
    this.borderRadius,
    this.colors,
  });

  final Widget child;
  final Palette palette;
  final BorderRadius? borderRadius;
  final List<Color>? colors;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: borderRadius,
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: colors ?? palette.brand,
        ),
      ),
      child: child,
    );
  }
}
