import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import '../ui/feedback.dart';
import '../ui/kit.dart';
import '../ui/sheet.dart';
import '../ui/preferences.dart';

class PickerModel {
  const PickerModel({
    required this.provider,
    required this.providerName,
    required this.id,
    required this.name,
    this.thinkingLevels,
  });

  final String provider;
  final String providerName;
  final String id;
  final String name;
  final List<String>? thinkingLevels;
}

String modelKey(String provider, String id) => '$provider\u0000$id';

const int _recentLimit = 6;

String _recentsKey(String serverId) => 'fastvibe.modelRecents.v1.$serverId';

Future<List<String>> loadModelRecents(String serverId) async {
  if (serverId.isEmpty) return <String>[];
  try {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getStringList(_recentsKey(serverId)) ?? <String>[];
  } catch (_) {
    return <String>[];
  }
}

Future<void> rememberModel(String serverId, String provider, String id) async {
  if (serverId.isEmpty) return;
  try {
    final prefs = await SharedPreferences.getInstance();
    final key = modelKey(provider, id);
    final next = <String>[
      key,
      ...(prefs.getStringList(_recentsKey(serverId)) ?? <String>[]).where(
        (item) => item != key,
      ),
    ];
    await prefs.setStringList(
      _recentsKey(serverId),
      next.take(_recentLimit).toList(),
    );
  } catch (_) {
    // A recent list that cannot be written is a convenience, not a feature.
  }
}

/// The model picker, built for an install with many providers.
///
/// A flat list of every provider's every model was a scroll of several screens to reach
/// the one the user wanted, so the list is shaped around the three ways people actually
/// find a model: by name (the search field, across every provider at once), by provider
/// (the rail — one tap narrows to it), and by habit (最近, the ones this phone picked
/// last). With neither a query nor a provider chosen, each provider is one collapsed row
/// and only the current model's provider is open, so the sheet opens to a list about as
/// long as the number of providers rather than the number of models.
Future<void> showModelPicker(
  BuildContext context, {
  required String serverId,
  required String? currentProvider,
  required String? currentModelId,
  required void Function(String provider, String id) onPick,
}) async {
  final remote = _currentRemote;
  if (remote == null) return;
  List<PickerModel> models;
  try {
    final raw = await readCatalog(remote);
    models = raw;
  } catch (error) {
    toastFailure(error, t('models.loadFailed'));
    return;
  }
  if (!context.mounted) return;
  final recents = await loadModelRecents(serverId);
  if (!context.mounted) return;
  await showAppSheet<void>(
    context: context,
    height: 220.0 + models.length.clamp(1, 7) * 60,
    builder: (sheetContext) => _ModelPickerSheet(
      models: models,
      currentProvider: currentProvider,
      currentModelId: currentModelId,
      recents: recents,
      onPick: (model) {
        rememberModel(serverId, model.provider, model.id);
        onPick(model.provider, model.id);
      },
    ),
  );
}

/// Injected by the app root so this module does not import the connection layer and
/// create a cycle with `composer.dart`.
RemoteCatalogReader? _currentRemote;

typedef RemoteCatalogReader = Future<List<Object?>> Function();

void bindModelCatalogReader(RemoteCatalogReader reader) =>
    _currentRemote = reader;

Future<List<PickerModel>> readCatalog(RemoteCatalogReader remote) async {
  final raw = await remote();
  final models = <PickerModel>[];
  for (final item in raw) {
    if (item is! Map) continue;
    final provider = item['provider'];
    final id = item['id'];
    if (provider is! String || id is! String) continue;
    final levels = item['thinkingLevels'];
    models.add(
      PickerModel(
        provider: provider,
        providerName: item['providerName'] is String
            ? item['providerName'] as String
            : provider,
        id: id,
        name: item['name'] is String ? item['name'] as String : id,
        thinkingLevels: levels is List
            ? levels.whereType<String>().toList()
            : null,
      ),
    );
  }
  return models;
}

class _ModelPickerSheet extends StatefulWidget {
  const _ModelPickerSheet({
    required this.models,
    required this.currentProvider,
    required this.currentModelId,
    required this.recents,
    required this.onPick,
  });

  final List<PickerModel> models;
  final String? currentProvider;
  final String? currentModelId;
  final List<String> recents;
  final void Function(PickerModel model) onPick;

  @override
  State<_ModelPickerSheet> createState() => _ModelPickerSheetState();
}

class _ModelPickerSheetState extends State<_ModelPickerSheet> {
  final TextEditingController _query = TextEditingController();
  String? _scopeProvider;
  bool _scopeRecent = false;
  final Set<String> _expanded = <String>{};

  @override
  void initState() {
    super.initState();
    if (widget.currentProvider != null) _expanded.add(widget.currentProvider!);
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  List<({String provider, String name, List<PickerModel> models})>
  get _providers {
    final map =
        <String, ({String provider, String name, List<PickerModel> models})>{};
    for (final model in widget.models) {
      final entry = map[model.provider];
      if (entry == null) {
        map[model.provider] = (
          provider: model.provider,
          name: model.providerName,
          models: <PickerModel>[model],
        );
      } else {
        entry.models.add(model);
      }
    }
    return map.values.toList();
  }

  List<PickerModel> get _recentModels {
    final byKey = <String, PickerModel>{
      for (final model in widget.models)
        modelKey(model.provider, model.id): model,
    };
    return widget.recents
        .map((key) => byKey[key])
        .whereType<PickerModel>()
        .toList();
  }

  /// Few enough models that collapsing would hide more than it saves.
  bool get _small => widget.models.length <= 14 || _providers.length <= 1;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final providers = _providers;
    final needle = _query.text.trim().toLowerCase();
    final recentModels = _recentModels;

    return Container(
      decoration: BoxDecoration(color: Colors.transparent),
      child: SafeArea(
        top: false,
        child: Column(
          children: <Widget>[
            AppSheetHeader(
              title: t('models.title'),
              subtitle: t('models.summary', {
                'models': widget.models.length,
                'providers': providers.length,
              }),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: SearchField(
                controller: _query,
                placeholder: t('models.search'),
                onChanged: (_) => setState(() {}),
              ),
            ),
            if (providers.length > 1)
              SizedBox(
                height: 44,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                  children: <Widget>[
                    _RailChip(
                      label: t('models.all'),
                      active: !_scopeRecent && _scopeProvider == null,
                      palette: palette,
                      onPress: () => setState(() {
                        _scopeRecent = false;
                        _scopeProvider = null;
                      }),
                    ),
                    if (recentModels.isNotEmpty) ...<Widget>[
                      const SizedBox(width: 8),
                      _RailChip(
                        label: t('models.recent'),
                        active: _scopeRecent,
                        icon: AppIcons.clock,
                        palette: palette,
                        onPress: () => setState(() {
                          _scopeRecent = true;
                          _scopeProvider = null;
                        }),
                      ),
                    ],
                    for (final entry in providers) ...<Widget>[
                      const SizedBox(width: 8),
                      _RailChip(
                        label: entry.name,
                        count: entry.models.length,
                        avatar: true,
                        active: _scopeProvider == entry.provider,
                        palette: palette,
                        onPress: () => setState(() {
                          _scopeRecent = false;
                          _scopeProvider = entry.provider;
                        }),
                      ),
                    ],
                  ],
                ),
              ),
            Expanded(child: _list(palette, providers, recentModels, needle)),
          ],
        ),
      ),
    );
  }

  Widget _list(
    Palette palette,
    List<({String provider, String name, List<PickerModel> models})> providers,
    List<PickerModel> recentModels,
    String needle,
  ) {
    final children = <Widget>[];
    final currentKey =
        widget.currentProvider != null && widget.currentModelId != null
        ? modelKey(widget.currentProvider!, widget.currentModelId!)
        : null;

    void pushModels(List<PickerModel> list, {required bool showProvider}) {
      for (var index = 0; index < list.length; index++) {
        children.add(
          _ModelRow(
            model: list[index],
            selected:
                modelKey(list[index].provider, list[index].id) == currentKey,
            showProvider: showProvider,
            palette: palette,
            onTap: () {
              Haptic.select();
              Navigator.of(context).pop();
              widget.onPick(list[index]);
            },
          ),
        );
      }
    }

    if (needle.isNotEmpty) {
      final terms = needle
          .split(RegExp(r'\s+'))
          .where((term) => term.isNotEmpty)
          .toList();
      for (final entry in providers) {
        if (_scopeProvider != null && _scopeProvider != entry.provider) {
          continue;
        }
        final matches = entry.models.where((model) {
          final haystack = '${model.name} ${model.id} ${entry.name}'
              .toLowerCase();
          return terms.every(haystack.contains);
        }).toList();
        if (matches.isEmpty) continue;
        children.add(_Label(title: entry.name, palette: palette));
        pushModels(matches, showProvider: false);
      }
    } else if (_scopeRecent) {
      pushModels(recentModels, showProvider: true);
    } else if (_scopeProvider != null) {
      for (final entry in providers) {
        if (entry.provider != _scopeProvider) continue;
        pushModels(entry.models, showProvider: false);
      }
    } else {
      if (recentModels.isNotEmpty && !_small) {
        children.add(_Label(title: t('models.recentlyUsed'), palette: palette));
        pushModels(recentModels.take(3).toList(), showProvider: true);
      }
      if (!_small) {
        children.add(_Label(title: t('models.allProviders'), palette: palette));
      }
      for (final entry in providers) {
        final isOpen = _small || _expanded.contains(entry.provider);
        if (!_small || providers.length > 1) {
          children.add(
            _ProviderHeader(
              name: entry.name,
              count: entry.models.length,
              open: isOpen,
              current: widget.currentProvider == entry.provider,
              palette: palette,
              onTap: () {
                Haptic.tap();
                setState(() {
                  if (_expanded.contains(entry.provider)) {
                    _expanded.remove(entry.provider);
                  } else {
                    _expanded.add(entry.provider);
                  }
                });
              },
            ),
          );
        }
        if (isOpen) pushModels(entry.models, showProvider: false);
      }
    }

    if (children.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          child: Text(
            needle.isNotEmpty
                ? t('models.noMatch')
                : _scopeRecent
                ? t('models.noRecent')
                : t('models.none'),
            textAlign: TextAlign.center,
            style: TextStyle(
              color: palette.muted,
              fontSize: 14,
              height: 20 / 14,
            ),
          ),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 20),
      children: children,
    );
  }
}

class _Label extends StatelessWidget {
  const _Label({required this.title, required this.palette});

  final String title;
  final Palette palette;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(6, 14, 6, 6),
    child: Text(
      title,
      style: TextStyle(
        color: palette.muted,
        fontSize: 13,
        fontWeight: FontWeight.w700,
      ),
    ),
  );
}

class _ProviderHeader extends StatelessWidget {
  const _ProviderHeader({
    required this.name,
    required this.count,
    required this.open,
    required this.current,
    required this.palette,
    required this.onTap,
  });

  final String name;
  final int count;
  final bool open;
  final bool current;
  final Palette palette;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Material(
        color: palette.background,
        borderRadius: BorderRadius.vertical(
          top: const Radius.circular(Radii.lg),
          bottom: Radius.circular(open ? 0 : Radii.lg),
        ),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.vertical(
            top: const Radius.circular(Radii.lg),
            bottom: Radius.circular(open ? 0 : Radii.lg),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: <Widget>[
                Avatar(name: name, size: 30),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: palette.text,
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        '${t('models.count', <String, Object?>{'count': count})}${current ? t('models.current') : ''}',
                        style: TextStyle(color: palette.muted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                RotatedBox(
                  quarterTurns: open ? 2 : 0,
                  child: HugeIcon(
                    icon: AppIcons.arrowDown,
                    size: 18,
                    color: palette.muted,
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

class _ModelRow extends StatelessWidget {
  const _ModelRow({
    required this.model,
    required this.selected,
    required this.showProvider,
    required this.palette,
    required this.onTap,
  });

  final PickerModel model;
  final bool selected;
  final bool showProvider;
  final Palette palette;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final name = model.name.isNotEmpty ? model.name : model.id;
    final reasons = (model.thinkingLevels ?? const <String>[]).any(
      (level) => level != 'off',
    );
    return Material(
      color: selected
          ? palette.accentSoft
          : palette.card.withValues(alpha: 0.7),
      borderRadius: BorderRadius.circular(18),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 54),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            border: Border(top: BorderSide(color: palette.border, width: 0.5)),
          ),
          child: Row(
            children: <Widget>[
              if (showProvider) ...<Widget>[
                Avatar(name: model.providerName, size: 28),
                const SizedBox(width: 10),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: selected ? palette.accent : palette.text,
                        fontSize: 15,
                        fontWeight: selected
                            ? FontWeight.w700
                            : FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      showProvider
                          ? '${model.providerName} · ${model.id}'
                          : model.id,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: palette.muted,
                        fontSize: 12,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ],
                ),
              ),
              if (reasons) ...<Widget>[
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 7,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: palette.card,
                    borderRadius: BorderRadius.circular(Radii.pill),
                  ),
                  child: Row(
                    children: <Widget>[
                      HugeIcon(
                        icon: AppIcons.aiBrain,
                        size: 12,
                        color: palette.muted,
                      ),
                      const SizedBox(width: 3),
                      Text(
                        t('models.reasoning'),
                        style: TextStyle(
                          color: palette.muted,
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
              ],
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

class _RailChip extends StatelessWidget {
  const _RailChip({
    required this.label,
    required this.active,
    required this.palette,
    required this.onPress,
    this.avatar = false,
    this.icon,
    this.count,
  });

  final String label;
  final bool active;
  final Palette palette;
  final VoidCallback onPress;
  final bool avatar;
  final List<List<dynamic>>? icon;
  final int? count;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        Haptic.select();
        onPress();
      },
      child: Container(
        height: 34,
        padding: const EdgeInsets.only(left: 7, right: 12),
        decoration: BoxDecoration(
          color: active ? palette.accentSoft : palette.field,
          borderRadius: BorderRadius.circular(Radii.pill),
          border: Border.all(
            color: active ? palette.accent : Colors.transparent,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (avatar) ...<Widget>[
              Avatar(name: label, size: 20),
              const SizedBox(width: 3),
            ],
            if (icon != null) ...<Widget>[
              HugeIcon(
                icon: icon!,
                size: 14,
                color: active ? palette.accent : palette.muted,
              ),
              const SizedBox(width: 3),
            ],
            Padding(
              padding: const EdgeInsets.only(left: 3),
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: active ? palette.accent : palette.text,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            if (count != null) ...<Widget>[
              const SizedBox(width: 6),
              Text(
                '$count',
                style: TextStyle(
                  color: active ? palette.accent : palette.subtle,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
