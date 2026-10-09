import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../account/account.dart';
import '../account/official_devices.dart';
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
import '../ui/context_menu.dart';

class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key});
  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  List<SavedServer> _servers = [];
  bool _loaded = false;
  final _query = TextEditingController();

  /// The large 设备列表 title's collapse into the bar; owns the list's scroll controller.
  final _title = GlassLargeTitleController();
  int _loadGeneration = 0;

  @override
  void initState() {
    super.initState();
    ServerStore.instance.addListener(_reload);
    Connection.instance.addListener(_changed);
    AccountService.instance.addListener(_changed);
    OfficialDevices.instance.addListener(_changed);
    _reload();
  }

  @override
  void dispose() {
    ServerStore.instance.removeListener(_reload);
    Connection.instance.removeListener(_changed);
    AccountService.instance.removeListener(_changed);
    OfficialDevices.instance.removeListener(_changed);
    _query.dispose();
    _title.dispose();
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

  /// Pull-to-refresh: the saved list, and — signed in — which of the account's computers
  /// are online right now.
  Future<void> _refresh() async {
    if (AccountService.instance.signedIn) await OfficialDevices.instance.refresh();
    await _reload();
  }

  Future<void> _remove(SavedServer server) async {
    if (!await AppDialog.confirm(
      context,
      title: t('devices.deleteTitle'),
      message: t('devices.deleteBody', vars: {'name': server.alias}),
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

  /// The row's actions, as an iOS pull-down menu (the ⋯ button) — the same list a long
  /// press opens as a sheet.
  List<SheetOption> _actions(SavedServer server) => <SheetOption>[
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
    // A computer on the account is named, listed and removed by the account.
    if (!server.isOfficial) ...<SheetOption>[
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
    )
    ],
  ];

  /// A long press: the same actions, as the iOS context menu at the finger.
  void _menu(SavedServer server) {
    showContextMenu(context, contextMenuItems(_actions(server)));
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
      title: t('devices.workspaces', context: context),
      showBack: false,
      largeTitleController: _title,
      actions: [
        GlassAction(
          icon: AppIcons.settings,
          tooltip: t('nav.settings', context: context),
          onPressed: () => context.push('/settings'),
        ),
      ],
      bottomBar: DeviceDock(onAdd: () => context.push('/add')),
      body: Builder(
        builder: (context) {
          final top = GlassInsets.pad(context).top;
          return CustomScrollView(
            controller: _title.scrollController,
            slivers: <Widget>[
              iosRefreshControl(onRefresh: _refresh, topInset: top),
              SliverToBoxAdapter(child: SizedBox(height: top)),
              GlassLargeTitle(
                text: t('devices.workspaces', context: context),
                controller: _title,
                searchBar: _servers.isEmpty
                    ? null
                    : GlassSearchBar(
                        controller: _query,
                        placeholder: t('devices.search', context: context),
                        onChanged: (_) => setState(() {}),
                        height: 40,
                      ),
              ),
              SliverPadding(
                padding: EdgeInsets.fromLTRB(
                  16,
                  0,
                  16,
                  GlassInsets.pad(
                    context,
                    const EdgeInsets.only(bottom: 8),
                  ).bottom,
                ),
                sliver: SliverList(
                  delegate: SliverChildListDelegate(<Widget>[
                    if (!AccountService.instance.signedIn) ...<Widget>[
                      _signInCard(),
                      const SizedBox(height: 16),
                    ],
                    if (!_loaded)
                      const Padding(
                        padding: EdgeInsets.only(top: 40),
                        child: BrandLoading(),
                      )
                    else if (_servers.isEmpty) ...<Widget>[
                      SectionLabel(
                        title: t('devices.heroTitle', context: context),
                      ),
                      InsetGroup(
                        separatorIndent: 16 + 29 + 12,
                        children: <Widget>[
                          for (final i in <int>[1, 2, 3])
                            _Step(index: i, palette: p),
                        ],
                      ),
                    ] else ...<Widget>[
                      if (favorites.isNotEmpty) ...<Widget>[
                        SectionLabel(
                          title: t('devices.favorites', context: context),
                        ),
                        for (final server in favorites)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: _row(server),
                          ),
                      ],
                      if (others.isNotEmpty) ...<Widget>[
                        SectionLabel(
                          title: t('devices.allDevices', context: context),
                        ),
                        for (final server in others)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: _row(server),
                          ),
                      ],
                      if (shown.isEmpty)
                        EmptyState(
                          icon: AppIcons.search,
                          title: t('common.noMatch', context: context),
                          body: t('devices.search', context: context),
                        ),
                    ],
                  ]),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  /// The way to the account's computers, for a phone that is not signed in.
  Widget _signInCard() {
    final account = AccountService.instance;
    final signingIn = account.status == AccountStatus.signingIn;
    return SettingsCard(
      children: <Widget>[
        SettingsRow(
          icon: AppIcons.login,
          label: signingIn ? t('account.signingIn') : t('official.signInPrompt'),
          description: account.error ?? t('account.signedOutBody'),
          onTap: signingIn ? null : account.login,
          trailing: signingIn ? DesktopSpinner(size: 16, color: paletteOf(context).muted) : null,
        ),
      ],
    );
  }

  /// One machine, as an iOS navigation row: icon, name, address and last connection,
  /// the ⋯ pull-down, and the whole row opening the machine.
  Widget _row(SavedServer server) {
    final p = paletteOf(context);
    final connected =
        Connection.instance.server?.id == server.id &&
        Connection.instance.status == ConnectionStatus.ready &&
        !Connection.instance.reconnecting;
    final online = server.isOfficial && OfficialDevices.instance.isOnline(server);
    final when = server.lastConnectedAt == null
        ? null
        : relativeTime(server.lastConnectedAt!);
    return Material(
      color: p.card,
      borderRadius: BorderRadius.circular(Radii.card),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () {
          Haptic.tap();
          context.push('/server/${server.id}');
        },
        onLongPress: () => _menu(server),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 16, 12),
          child: Row(
            children: <Widget>[
              Avatar(
                name: server.alias,
                icon: AppIcons.computer,
                size: 40,
                borderRadius: 10,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            server.alias,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: p.text,
                              fontSize: 17,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        if (server.favorite) ...<Widget>[
                          const SizedBox(width: 6),
                          HugeIcon(
                            icon: AppIcons.star,
                            size: 17,
                            color: p.warning,
                            strokeWidth: 2.2,
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      connected
                          ? t('devices.connected')
                          : server.isOfficial
                          ? '${t('official.badge')} · ${t(online ? 'official.online' : 'official.offline')}'
                          : when != null
                          ? t('devices.connectedAgo', vars: {'when': when})
                          : t('devices.neverConnected'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: connected || online ? p.success : p.muted,
                        fontSize: 15,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One step of first-run setup, as a numbered row.
class _Step extends StatelessWidget {
  const _Step({required this.index, required this.palette});

  final int index;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 29,
            height: 29,
            decoration: BoxDecoration(
              color: palette.accent,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: Text(
              '$index',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 15,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  t('devices.step${index}Title', context: context),
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  t('devices.step${index}Body', context: context),
                  style: TextStyle(
                    color: palette.muted,
                    fontSize: 15,
                    height: 20 / 15,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
