import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hugeicons/hugeicons.dart';

import '../ui/sheet.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';
import '../ui/scroll_fade.dart';

/// One option in a sheet: a label, an optional second line, an icon or a coloured
/// initial, and whether it is the destructive one.
class SheetOption {
  const SheetOption({
    required this.value,
    required this.label,
    this.description,
    this.icon,
    this.avatar,
    this.destructive = false,
    this.onSelect,
  });

  final String value;
  final String label;
  final String? description;
  final List<List<dynamic>>? icon;

  /// Draw a coloured initial for this name instead of an icon (a project).
  final String? avatar;
  final bool destructive;
  final VoidCallback? onSelect;
}

class SheetGroup {
  const SheetGroup({required this.label, required this.options});

  final String label;
  final List<SheetOption> options;
}

/// Past this many options a sheet grows a search field — a list the thumb cannot scan.
const int _searchThreshold = 9;

/// Bottom sheet of options — pickers, and a chat's actions.
///
/// Presented through the liquid-glass modal sheet so it matches the platform: it has
/// detents, it can be dragged down to close, and it morphs rather than sliding under a
/// separate barrier.
Future<void> showOptionSheet(
  BuildContext context, {
  required String title,
  String? subtitle,
  required List<SheetOption> options,
  List<SheetGroup> groups = const <SheetGroup>[],
  String? value,
  ValueChanged<String>? onSelect,
}) {
  final all = <SheetGroup>[
    ...groups,
    if (options.isNotEmpty) SheetGroup(label: '', options: options),
  ];
  final total = all.fold<int>(0, (sum, group) => sum + group.options.length);
  return showAppSheet<void>(
    context: context,
    height:
        120.0 + total.clamp(1, 8) * 60 + (total > 9 ? 56 : 0) + all.length * 12,
    builder: (sheetContext) => _OptionSheetBody(
      title: title,
      subtitle: subtitle,
      groups: all,
      searchable: total > _searchThreshold,
      value: value,
      onSelect: onSelect,
    ),
  );
}

class _OptionSheetBody extends StatefulWidget {
  const _OptionSheetBody({
    required this.title,
    required this.subtitle,
    required this.groups,
    required this.searchable,
    required this.value,
    required this.onSelect,
  });

  final String title;
  final String? subtitle;
  final List<SheetGroup> groups;
  final bool searchable;
  final String? value;
  final ValueChanged<String>? onSelect;

  @override
  State<_OptionSheetBody> createState() => _OptionSheetBodyState();
}

class _OptionSheetBodyState extends State<_OptionSheetBody> {
  final TextEditingController _query = TextEditingController();

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  List<SheetGroup> get _shown {
    final needle = _query.text.trim().toLowerCase();
    if (needle.isEmpty) return widget.groups;
    return widget.groups
        .map(
          (group) => SheetGroup(
            label: group.label,
            options: group.options
                .where(
                  (option) => '${option.label} ${option.description ?? ''}'
                      .toLowerCase()
                      .contains(needle),
                )
                .toList(),
          ),
        )
        .where((group) => group.options.isNotEmpty)
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final groups = _shown;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          AppSheetHeader(title: widget.title, subtitle: widget.subtitle),
          if (widget.searchable) ...<Widget>[
            SearchField(
              controller: _query,
              placeholder: t('common.search', context: context),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 8),
          ],
          Flexible(
            child: groups.isEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 24),
                    child: Center(
                      child: Text(
                        t('common.noMatch', context: context),
                        style: TextStyle(color: palette.muted, fontSize: 14),
                      ),
                    ),
                  )
                // A long list (a machine with many projects) is cut by the sheet's
                // bounds; fade that edge rather than slice the rounded card square.
                : ScrollFade(
                    child: ListView(
                      shrinkWrap: true,
                      padding: EdgeInsets.zero,
                      children: <Widget>[
                        for (final group in groups) ...<Widget>[
                          if (group.label.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.fromLTRB(6, 6, 6, 6),
                              child: Text(
                                group.label,
                                style: TextStyle(
                                  color: palette.muted,
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          Container(
                            decoration: BoxDecoration(
                              color: palette.card.withValues(alpha: 0.66),
                              borderRadius: BorderRadius.circular(Radii.lg),
                            ),
                            clipBehavior: Clip.antiAlias,
                            child: Column(
                              children: <Widget>[
                                for (
                                  var index = 0;
                                  index < group.options.length;
                                  index++
                                ) ...<Widget>[
                                  if (index > 0)
                                    Divider(
                                      height: 0.5,
                                      thickness: 0.5,
                                      color: palette.border,
                                    ),
                                  _OptionRow(
                                    option: group.options[index],
                                    selected:
                                        group.options[index].value ==
                                        widget.value,
                                    onTap: () {
                                      Haptic.select();
                                      final option = group.options[index];
                                      Navigator.of(context).pop();
                                      widget.onSelect?.call(option.value);
                                      option.onSelect?.call();
                                    },
                                  ),
                                ],
                              ],
                            ),
                          ),
                          const SizedBox(height: 8),
                        ],
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.option,
    required this.selected,
    required this.onTap,
  });

  final SheetOption option;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final color = option.destructive ? palette.danger : palette.text;
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 56),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(
            children: <Widget>[
              if (option.avatar != null) ...<Widget>[
                Avatar(name: option.avatar!, size: 30),
                const SizedBox(width: 12),
              ],
              if (option.icon != null) ...<Widget>[
                Container(
                  width: 30,
                  height: 30,
                  decoration: BoxDecoration(
                    color: option.destructive
                        ? palette.dangerSoft
                        : palette.card,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Center(
                    child: HugeIcon(
                      icon: option.icon!,
                      size: 17,
                      color: option.destructive ? palette.danger : palette.text,
                      strokeWidth: 1.9,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      option.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: color,
                        fontSize: 16,
                        fontWeight: selected
                            ? FontWeight.w600
                            : FontWeight.w400,
                      ),
                    ),
                    if (option.description != null &&
                        option.description!.isNotEmpty) ...<Widget>[
                      const SizedBox(height: 2),
                      Text(
                        option.description!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
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
              if (selected)
                HugeIcon(
                  icon: AppIcons.tick,
                  size: 19,
                  color: palette.accent,
                  strokeWidth: 2.4,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The scanner hands the address back without putting a URL into the route.
String? _scannedAddress;

void setScannedAddress(String value) => _scannedAddress = value;

String? takeScannedAddress() {
  final value = _scannedAddress;
  _scannedAddress = null;
  return value;
}

/// The one place the clipboard is written, so a copy always reports the same way.
Future<void> copyToClipboard(String value) async {
  await Clipboard.setData(ClipboardData(text: value));
}
