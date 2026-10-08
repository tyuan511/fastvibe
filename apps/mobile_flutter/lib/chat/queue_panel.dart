import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import 'queue.dart';

/// The durable queue, shown above the composer.
///
/// The queue's only authority is Main; this is a projection of it. That is why nothing
/// here is optimistic: a cancelled item disappears when Main says it is gone, and a
/// claimed one cannot be cancelled at all, because it is already on its way into the run.
class QueuePanel extends StatelessWidget {
  const QueuePanel({
    super.key,
    required this.queue,
    required this.disabled,
    required this.onCancel,
    required this.onResume,
  });

  final QueueState queue;
  final bool disabled;
  final void Function(String id) onCancel;
  final VoidCallback onResume;

  @override
  Widget build(BuildContext context) {
    if (queue.items.isEmpty) return const SizedBox.shrink();
    final palette = paletteOf(context);
    final paused = queue.pause != null;
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(Radii.lg),
        border: Border.all(color: palette.border, width: 0.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 30),
            child: Row(
              children: <Widget>[
                HugeIcon(
                  icon: AppIcons.clock,
                  size: 14,
                  color: paused ? palette.warning : palette.accent,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    paused
                        ? t('queue.paused', <String, Object?>{'count': queue.items.length})
                        : t('queue.pending', <String, Object?>{'count': queue.items.length}),
                    style: TextStyle(
                      color: paused ? palette.warning : palette.text,
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                if (paused)
                  GestureDetector(
                    onTap: disabled ? null : onResume,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                      decoration: BoxDecoration(
                        color: disabled ? palette.field : palette.accent,
                        borderRadius: BorderRadius.circular(Radii.pill),
                      ),
                      child: Text(
                        t('queue.resume'),
                        style: TextStyle(
                          color: disabled ? palette.muted : palette.accentText,
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (paused)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                queue.pause == 'stopped' ? t('queue.stoppedNote') : t('queue.errorNote'),
                style: TextStyle(color: palette.muted, fontSize: 12),
              ),
            ),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 160),
            child: ListView(
              shrinkWrap: true,
              padding: EdgeInsets.zero,
              children: <Widget>[
                for (final item in queue.items)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Container(
                      constraints: const BoxConstraints(minHeight: 44),
                      padding: const EdgeInsets.only(left: 10, top: 4, bottom: 4),
                      decoration: BoxDecoration(
                        color: palette.field,
                        borderRadius: BorderRadius.circular(Radii.md),
                      ),
                      child: Row(
                        children: <Widget>[
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: <Widget>[
                                Text(
                                  item.text,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(color: palette.text, fontSize: 14),
                                ),
                                Text(
                                  _status(item),
                                  style: TextStyle(color: palette.muted, fontSize: 12),
                                ),
                              ],
                            ),
                          ),
                          SizedBox(
                            width: 40,
                            height: 40,
                            child: IconButton(
                              padding: EdgeInsets.zero,
                              onPressed: disabled || item.claimed ? null : () => onCancel(item.id),
                              icon: Opacity(
                                opacity: item.claimed ? 0.35 : 1,
                                child: HugeIcon(icon: AppIcons.cancel, size: 16, color: palette.muted),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _status(QueueItem item) {
    if (item.claimed) return t('queue.claimed');
    if (item.sending) return t('queue.sending');
    return item.behavior == 'steer' ? t('queue.steer') : t('queue.followUp');
  }
}
