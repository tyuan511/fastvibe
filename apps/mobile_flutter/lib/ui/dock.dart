import 'package:flutter/material.dart';

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
  Size get preferredSize => const Size.fromHeight(64);

  @override
  Widget build(BuildContext context) {
    return Align(
      heightFactor: 1,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Segmented(
                  labels: <String>[
                    t('server.filterAll', context: context),
                    t('server.filterActive', context: context),
                    t('server.filterWaiting', context: context),
                  ],
                  selected: selected,
                  onSelect: onSelect,
                  height: 44,
                ),
              ),
              const SizedBox(width: 10),
              IconAction(
                icon: AppIcons.chatAdd,
                tone: IconTone.accent,
                size: 44,
                tooltip: t('common.newChat', context: context),
                enabled: !creating,
                onPressed: creating ? null : onCreate,
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
    return Align(
      heightFactor: 1,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 540),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          child: PrimaryButton(
            label: t('devices.add', context: context),
            icon: AppIcons.plus,
            height: 52,
            onPressed: onAdd,
          ),
        ),
      ),
    );
  }
}
