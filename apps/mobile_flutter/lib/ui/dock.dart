import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../i18n/core.dart';
import 'icons.dart';
import 'kit.dart';

/// The conversation's navigation and primary action form one thumb-level dock.
/// The filter pill and compose button own separate glass surfaces.
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
  Size get preferredSize => const Size.fromHeight(84);

  @override
  Widget build(BuildContext context) {
    final p = paletteOf(context);
    final options = [
      (AppIcons.bubbleChat, t('server.filterAll')),
      (AppIcons.loading, t('server.filterActive')),
      (AppIcons.messageQuestion, t('server.filterWaiting')),
    ];
    return Align(
      heightFactor: 1,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: GlassTabBar.bottom(
          tabs: [
            for (var i = 0; i < options.length; i++)
              GlassTab(
                icon: HugeIcon(
                  icon: options[i].$1,
                  size: 22,
                  color: i == selected ? p.accent : p.muted,
                ),
                label: options[i].$2,
              ),
          ],
          selectedIndex: selected,
          onTabSelected: onSelect,
          horizontalPadding: 16,
          verticalPadding: 12,
          barHeight: 60,
          iconLabelSpacing: 3,
          selectedLabelColor: p.accent,
          unselectedLabelColor: p.muted,
          labelFontSize: 11,
          extraButton: GlassTabBarExtraButton(
            icon: creating
                ? SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: p.accent,
                    ),
                  )
                : HugeIcon(icon: AppIcons.chatAdd, size: 25, color: p.accent),
            label: t('common.newChat'),
            enabled: !creating,
            size: 60,
            onTap: onCreate,
          ),
        ),
      ),
    );
  }
}

class DeviceDock extends StatelessWidget implements PreferredSizeWidget {
  const DeviceDock({super.key, required this.onScan, required this.onAdd});
  final VoidCallback onScan;
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
          child: Row(
            children: [
              Expanded(
                child: GlassButton.custom(
                  height: 60,
                  shape: const LiquidRoundedSuperellipse(borderRadius: 30),
                  onTap: onScan,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      HugeIcon(
                        icon: AppIcons.qrCode,
                        size: 22,
                        color: p.accent,
                      ),
                      const SizedBox(width: 10),
                      Flexible(
                        child: Text(
                          t('devices.scanAdd'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: p.text,
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 12),
              GlassIconButton(
                icon: HugeIcon(icon: AppIcons.link, size: 23, color: p.accent),
                size: 60,
                semanticLabel: t('devices.enterAddress'),
                onPressed: onAdd,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
