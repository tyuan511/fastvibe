import 'package:flutter/cupertino.dart' show CupertinoActivityIndicator;
import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../i18n/core.dart';
import 'icons.dart';
import 'kit.dart';

/// The conversation list's bottom toolbar: the 全部 / 进行中 / 待处理 filter as a segmented
/// control, and the compose button at the trailing edge. iOS puts a segmented control in a
/// toolbar when it narrows the screen's one list (a tab bar would mean separate places),
/// and keeps it in thumb reach at the bottom.
class ConversationDock extends StatelessWidget implements PreferredSizeWidget {
  const ConversationDock({
    super.key,
    required this.selected,
    required this.onSelect,
    required this.onCreate,
    this.creating = false,
  });
  final int selected;
  final ValueChanged<int> onSelect;
  final VoidCallback onCreate;
  final bool creating;

  @override
  Size get preferredSize => const Size.fromHeight(72);

  @override
  Widget build(BuildContext context) {
    final p = paletteOf(context);
    return Align(
      heightFactor: 1,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
          child: Row(
            children: <Widget>[
              Expanded(
                child: GlassSegmentedControl(
                  segments: <GlassSegment>[
                    GlassSegment(label: t('server.filterAll', context: context)),
                    GlassSegment(label: t('server.filterActive', context: context)),
                    GlassSegment(label: t('server.filterWaiting', context: context)),
                  ],
                  selectedIndex: selected,
                  onSegmentSelected: onSelect,
                  height: 48,
                  selectedTextStyle: TextStyle(
                    color: p.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                  unselectedTextStyle: TextStyle(color: p.muted, fontSize: 15),
                ),
              ),
              const SizedBox(width: 10),
              GlassIconButton(
                icon: creating
                    ? CupertinoActivityIndicator(color: p.accent)
                    : HugeIcon(
                        icon: AppIcons.chatAdd,
                        size: 22,
                        color: p.accent,
                      ),
                onPressed: creating ? null : onCreate,
                size: 48,
                iconSize: 22,
                shape: GlassIconButtonShape.circle,
                semanticLabel: t('common.newChat', context: context),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The device list's bottom bar: one 添加 button. Scanning a code and typing an address
/// are two ways of the same thing, so they are one page (the scan card leads it) rather
/// than two competing buttons.
class DeviceDock extends StatelessWidget implements PreferredSizeWidget {
  const DeviceDock({super.key, required this.onAdd});
  final VoidCallback onAdd;
  @override
  Size get preferredSize => const Size.fromHeight(84);

  @override
  Widget build(BuildContext context) {
    final p = paletteOf(context);
    return Align(
      heightFactor: 1,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 540),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          child: GlassButton.custom(
            height: 60,
            shape: const LiquidRoundedSuperellipse(borderRadius: 30),
            onTap: onAdd,
            label: t('devices.add', context: context),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                HugeIcon(
                  icon: AppIcons.plus,
                  size: 22,
                  color: p.accent,
                  strokeWidth: 2.2,
                ),
                const SizedBox(width: 8),
                Text(
                  t('devices.add', context: context),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: p.text,
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
