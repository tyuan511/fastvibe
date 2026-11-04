import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../chat/option_sheet.dart';
import '../theme/theme.dart';
import 'kit.dart';
import 'preferences.dart';

/// One row of a menu. Choosing it closes the menu first, then runs [onTap].
class AppMenuItem extends StatelessWidget {
  const AppMenuItem({
    super.key,
    required this.title,
    required this.onTap,
    this.icon,
    this.destructive = false,
  });

  final String title;
  final List<List<dynamic>>? icon;
  final VoidCallback onTap;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final color = destructive ? palette.danger : palette.text;
    return InkWell(
      onTap: () {
        Navigator.of(context, rootNavigator: true).pop();
        onTap();
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Text(
                title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: color, fontSize: 16),
              ),
            ),
            if (icon != null) ...<Widget>[
              const SizedBox(width: 12),
              HugeIcon(icon: icon!, size: 18, color: color),
            ],
          ],
        ),
      ),
    );
  }
}

class AppMenuDivider extends StatelessWidget {
  const AppMenuDivider({super.key});

  @override
  Widget build(BuildContext context) =>
      Divider(height: 0.5, thickness: 0.5, color: paletteOf(context).separator);
}

/// Opens [items] as a small card next to [anchor]: under it, right-aligned when it is a bar
/// button, or at a point (a zero-size rectangle) for a press.
Future<void> showAppMenu(
  BuildContext context, {
  required Rect anchor,
  required List<Widget> items,
}) {
  final palette = paletteOf(context);
  return showGeneralDialog<void>(
    context: context,
    useRootNavigator: true,
    barrierDismissible: true,
    barrierLabel: MaterialLocalizations.of(context).modalBarrierDismissLabel,
    barrierColor: Colors.transparent,
    transitionDuration: const Duration(milliseconds: 120),
    pageBuilder: (dialogContext, _, _) => PaletteScope(
      palette: palette,
      child: Material(
        type: MaterialType.transparency,
        child: CustomSingleChildLayout(
          delegate: _MenuLayout(anchor, MediaQuery.paddingOf(dialogContext)),
          child: Container(
            width: 240,
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(dialogContext).height * 0.6,
            ),
            decoration: BoxDecoration(
              color: palette.card,
              borderRadius: BorderRadius.circular(Radii.md),
              border: Border.all(color: palette.border, width: 0.5),
              boxShadow: elevation(palette, 2),
            ),
            clipBehavior: Clip.antiAlias,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: items,
              ),
            ),
          ),
        ),
      ),
    ),
    transitionBuilder: (context, animation, _, child) => FadeTransition(
      opacity: CurvedAnimation(parent: animation, curve: Curves.easeOut),
      child: child,
    ),
  );
}

class _MenuLayout extends SingleChildLayoutDelegate {
  _MenuLayout(this.anchor, this.padding);

  final Rect anchor;
  final EdgeInsets padding;

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) =>
      constraints.loosen();

  @override
  Offset getPositionForChild(Size size, Size child) {
    const margin = 8.0;
    // Under a bar button the menu hangs from its right edge; at a press point it starts there.
    final x = anchor.width > 0 ? anchor.right - child.width : anchor.left;
    final left = x.clamp(margin, math.max(margin, size.width - child.width - margin)).toDouble();
    var top = anchor.bottom + 6;
    final limit = size.height - padding.bottom - margin;
    if (top + child.height > limit) {
      // No room below: sit above the anchor, or at the bottom margin if that is no better.
      top = math.max(padding.top + margin, math.min(anchor.top - child.height - 6, limit - child.height));
    }
    return Offset(left, top);
  }

  @override
  bool shouldRelayout(_MenuLayout oldDelegate) =>
      anchor != oldDelegate.anchor || padding != oldDelegate.padding;
}

/// The long-press menu, for every screen.
///
/// The press handlers in this app (`onLongPress` on a row) do not receive a position, so
/// the host remembers where the last finger went down and opens the menu there.
///
/// [AppScreen] mounts one around every body; call [showContextMenu] from anything inside it.
class ContextMenuHost extends StatefulWidget {
  const ContextMenuHost({super.key, required this.child});

  final Widget child;

  @override
  State<ContextMenuHost> createState() => _ContextMenuHostState();
}

class _ContextMenuHostState extends State<ContextMenuHost> {
  /// Every mounted host, oldest first. A screen's own handlers run in its `State`'s
  /// context, which sits *above* its `AppScreen` and so above the host — an inherited
  /// lookup from there finds nothing. They are answered by the host on the route that is
  /// currently on top.
  static final List<_ContextMenuHostState> _mounted = <_ContextMenuHostState>[];

  Offset _lastDown = Offset.zero;

  @override
  void initState() {
    super.initState();
    _mounted.add(this);
  }

  @override
  void dispose() {
    _mounted.remove(this);
    super.dispose();
  }

  static _ContextMenuHostState? get _current {
    for (final host in _mounted.reversed) {
      if (host.mounted && (ModalRoute.of(host.context)?.isCurrent ?? true)) {
        return host;
      }
    }
    return null;
  }

  /// Opens [items] at the point the last finger touched down.
  void show(List<Widget> items) {
    if (items.isEmpty) return;
    Haptic.press();
    showAppMenu(
      context,
      anchor: Rect.fromLTWH(_lastDown.dx, _lastDown.dy, 0, 0),
      items: items,
    );
  }

  @override
  Widget build(BuildContext context) => _ContextMenuScope(
    state: this,
    child: Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: (event) => _lastDown = event.position,
      child: widget.child,
    ),
  );
}

class _ContextMenuScope extends InheritedWidget {
  const _ContextMenuScope({required this.state, required super.child});

  final _ContextMenuHostState state;

  @override
  bool updateShouldNotify(_ContextMenuScope oldWidget) => false;
}

/// Opens a menu with [items] ([AppMenuItem]s, [AppMenuDivider]s) where the user is
/// pressing: the host above [context] if there is one, else the host on the route that is
/// on top. Returns false when no screen has a host.
bool showContextMenu(BuildContext context, List<Widget> items) {
  final host =
      context.getInheritedWidgetOfExactType<_ContextMenuScope>()?.state ??
      _ContextMenuHostState._current;
  if (host == null) return false;
  host.show(items);
  return true;
}

/// The menu rows for a list of [SheetOption]s — the same actions a sheet offered, so a
/// screen keeps one list of what can be done and only the presentation changes. A
/// destructive option gets a divider above it, separating delete from the rest.
List<Widget> contextMenuItems(List<SheetOption> options) => <Widget>[
  for (final option in options) ...<Widget>[
    if (option.destructive && option != options.first) const AppMenuDivider(),
    AppMenuItem(
      title: option.label,
      icon: option.icon,
      destructive: option.destructive,
      onTap: () => option.onSelect?.call(),
    ),
  ],
];
