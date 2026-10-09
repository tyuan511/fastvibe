import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../chat/option_sheet.dart';
import 'preferences.dart';

/// The iOS long-press menu, for every screen.
///
/// A long press on iOS opens a context menu where the finger is, never a sheet from the
/// bottom of the screen. The press handlers in this app (`onLongPress` on a row) do not
/// receive a position, so the host remembers where the last finger went down and blooms
/// a [GlassMenu] from that point — the menu's own controller-driven, zero-size-trigger
/// mode, which exists for exactly this.
///
/// [GlassScreen] mounts one around every body; call [showContextMenu] from anything
/// inside it.
class ContextMenuHost extends StatefulWidget {
  const ContextMenuHost({super.key, required this.child});

  final Widget child;

  @override
  State<ContextMenuHost> createState() => _ContextMenuHostState();
}

class _ContextMenuHostState extends State<ContextMenuHost> {
  /// Every mounted host, oldest first. A screen's own handlers run in its `State`'s
  /// context, which sits *above* its `GlassScreen` and so above the host — an inherited
  /// lookup from there finds nothing. They are answered by the host on the route that is
  /// currently on top.
  static final List<_ContextMenuHostState> _mounted = <_ContextMenuHostState>[];

  final GlassMenuController _controller = GlassMenuController();
  Offset _lastDown = Offset.zero;
  Offset? _at;
  List<Widget> _items = const <Widget>[];

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
    final box = context.findRenderObject();
    if (box is! RenderBox || items.isEmpty) return;
    Haptic.press();
    setState(() {
      _at = box.globalToLocal(_lastDown);
      _items = items;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _controller.open();
    });
  }

  @override
  Widget build(BuildContext context) {
    final at = _at;
    return _ContextMenuScope(
      state: this,
      child: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (event) => _lastDown = event.position,
        child: Stack(
          children: <Widget>[
            Positioned.fill(child: widget.child),
            if (at != null)
              Positioned(
                left: at.dx,
                top: at.dy,
                child: GlassMenu(
                  controller: _controller,
                  trigger: const SizedBox(width: 1, height: 1),
                  morphFromZero: true,
                  autoAdjustToScreen: true,
                  menuWidth: 240,
                  items: _items,
                  onClose: () {
                    if (mounted) setState(() => _at = null);
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ContextMenuScope extends InheritedWidget {
  const _ContextMenuScope({required this.state, required super.child});

  final _ContextMenuHostState state;

  @override
  bool updateShouldNotify(_ContextMenuScope oldWidget) => false;
}

/// Opens an iOS context menu with [items] ([GlassMenuItem]s, [GlassMenuDivider]s) where
/// the user is pressing: the host above [context] if there is one, else the host on the
/// route that is on top. Returns false when no screen has a host.
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
/// destructive option gets a divider above it, as iOS separates delete from the rest.
List<Widget> contextMenuItems(List<SheetOption> options) => <Widget>[
  for (final option in options) ...<Widget>[
    if (option.destructive && option != options.first) const GlassMenuDivider(),
    GlassMenuItem(
      title: option.label,
      icon: option.icon == null ? null : HugeIcon(icon: option.icon!, size: 18),
      isDestructive: option.destructive,
      onTap: () => option.onSelect?.call(),
    ),
  ],
];
