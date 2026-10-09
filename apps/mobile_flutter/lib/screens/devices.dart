import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../chat/option_sheet.dart';
import '../chat/turn_meta.dart';
import '../i18n/core.dart';
import '../session/connection.dart';
import '../storage/servers.dart';
import '../theme/theme.dart';
import '../ui/feedback.dart';
import '../ui/glass_screen.dart';
import '../ui/dock.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';

class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key});
  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  List<SavedServer> _servers = [];
  bool _loaded = false;
  final _query = TextEditingController();
  int _loadGeneration = 0;

  @override
  void initState() {
    super.initState();
    ServerStore.instance.addListener(_reload);
    Connection.instance.addListener(_changed);
    _reload();
  }

  @override
  void dispose() {
    ServerStore.instance.removeListener(_reload);
    Connection.instance.removeListener(_changed);
    _query.dispose();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _reload() async {
    final generation = ++_loadGeneration;
    final servers = await ServerStore.instance.load();
    if (!mounted || generation != _loadGeneration) return;
    setState(() {
      _servers = servers;
      _loaded = true;
    });
  }

  Future<void> _remove(SavedServer server) async {
    if (!await AppDialog.confirm(
      context,
      title: t('devices.deleteTitle'),
      message: t('devices.deleteBody', {'name': server.alias}),
      confirmLabel: t('common.delete'),
      destructive: true,
    )) {
      return;
    }
    try {
      await ServerStore.instance.remove(server.id);
      if (Connection.instance.server?.id == server.id) {
        Connection.instance.disconnect();
      }
      toastSuccess(t('toast.deviceDeleted'));
    } catch (error) {
      toastFailure(error, t('common.operationFailed'));
    }
  }

  Future<void> _rename(SavedServer server) async {
    final next = await AppDialog.prompt(
      context,
      title: t('devices.alias'),
      initial: server.alias,
    );
    if (next == null || next.isEmpty || next == server.alias) return;
    try {
      await ServerStore.instance.patch(server.id, alias: next);
      toastSuccess(t('toast.renamed'));
    } catch (error) {
      toastFailure(error, t('common.operationFailed'));
    }
  }

  void _menu(SavedServer server) {
    Haptic.press();
    showOptionSheet(
      context,
      title: server.alias,
      subtitle: server.host,
      options: [
        SheetOption(
          value: 'favorite',
          label: t(server.favorite ? 'devices.unfavorite' : 'devices.favorite'),
          icon: AppIcons.star,
          onSelect: () async {
            try {
              await ServerStore.instance.patch(
                server.id,
                favorite: !server.favorite,
              );
            } catch (error) {
              toastFailure(error, t('common.operationFailed'));
            }
          },
        ),
        SheetOption(
          value: 'rename',
          label: t('common.rename'),
          icon: AppIcons.pencilEdit,
          onSelect: () => _rename(server),
        ),
        SheetOption(
          value: 'copy',
          label: t('devices.copyAddress'),
          icon: AppIcons.copy,
          onSelect: () async {
            await copyToClipboard(server.origin);
            toastSuccess(t('toast.addressCopied'));
          },
        ),
        SheetOption(
          value: 'delete',
          label: t('common.delete'),
          icon: AppIcons.delete,
          destructive: true,
          onSelect: () => _remove(server),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = paletteOf(context);
    final needle = _query.text.trim().toLowerCase();
    final shown = _servers
        .where((s) => '${s.alias} ${s.host}'.toLowerCase().contains(needle))
        .toList();
    final favorites = shown.where((s) => s.favorite).toList();
    final others = shown.where((s) => !s.favorite).toList();
    return GlassScreen(
      title: 'FastVibe',
      showBack: false,
      actions: [
        GlassAction(
          icon: AppIcons.settings,
          tooltip: t('nav.settings'),
          onPressed: () => context.push('/settings'),
        ),
      ],
      bottomBar: DeviceDock(
        onScan: () => context.push('/add?scan=1'),
        onAdd: () => context.push('/add'),
      ),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 40),
          children: [
            PageHeading(
              title: t('devices.workspaces'),
              subtitle: t('devices.workspaceHint'),
            ),
            if (!_loaded)
              const BrandLoading()
            else if (_servers.isEmpty) ...[
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  t('devices.heroTitle'),
                  style: TextStyle(
                    color: p.text,
                    fontSize: 22,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              for (final i in [1, 2, 3])
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Container(
                    padding: const EdgeInsets.all(20),
                    decoration: BoxDecoration(
                      color: p.card,
                      borderRadius: BorderRadius.circular(Radii.lg),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '0$i',
                          style: TextStyle(
                            color: p.accent,
                            fontSize: 20,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                t('devices.step${i}Title'),
                                style: TextStyle(
                                  color: p.text,
                                  fontSize: 16,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              const SizedBox(height: 6),
                              Text(
                                t('devices.step${i}Body'),
                                style: TextStyle(
                                  color: p.muted,
                                  fontSize: 14,
                                  height: 1.5,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ] else ...[
              SearchField(
                controller: _query,
                placeholder: t('devices.search'),
                onChanged: (_) => setState(() {}),
              ),
              if (favorites.isNotEmpty) ...[
                SectionLabel(
                  title: t('devices.favorites'),
                  count: favorites.length,
                ),
                for (final server in favorites) _row(server),
              ],
              if (others.isNotEmpty) ...[
                SectionLabel(
                  title: t('devices.allDevices'),
                  count: others.length,
                ),
                for (final server in others) _row(server),
              ],
              if (shown.isEmpty)
                EmptyState(
                  icon: AppIcons.search,
                  title: t('common.noMatch'),
                  body: t('devices.search'),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _row(SavedServer server) {
    final p = paletteOf(context);
    final connected =
        Connection.instance.server?.id == server.id &&
        Connection.instance.status == ConnectionStatus.ready &&
        !Connection.instance.reconnecting;
    final when = server.lastConnectedAt == null
        ? null
        : relativeTime(server.lastConnectedAt!);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: p.card,
        borderRadius: BorderRadius.circular(Radii.lg),
        child: InkWell(
          borderRadius: BorderRadius.circular(Radii.lg),
          onTap: () {
            Haptic.tap();
            context.push('/server/${server.id}');
          },
          onLongPress: () => _menu(server),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 20, 10, 20),
            child: Row(
              children: [
                Avatar(name: server.alias, icon: AppIcons.computer, size: 48),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        server.alias,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: p.text,
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        server.host,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: p.muted, fontSize: 13),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        connected
                            ? t('devices.connected')
                            : when != null
                            ? t('devices.connectedAgo', {'when': when})
                            : t('devices.neverConnected'),
                        style: TextStyle(
                          color: connected ? p.success : p.subtle,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                IconAction(
                  icon: AppIcons.moreHorizontal,
                  size: 44,
                  tooltip: t('devices.actions'),
                  onPressed: () => _menu(server),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
