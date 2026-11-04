import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';

import '../account/account.dart';
import '../account/official_devices.dart';
import '../account/lan_discovery.dart';
import '../chat/option_sheet.dart';
import '../i18n/core.dart';
import '../session/connection.dart';
import '../storage/servers.dart';
import '../theme/theme.dart';
import '../ui/app_screen.dart';
import '../ui/context_menu.dart';
import '../ui/feedback.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';

/// Computers belonging to the signed-in account. Connection details stay in Rust.
class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key});

  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  List<SavedServer> _servers = <SavedServer>[];
  bool _loaded = false;
  final _query = TextEditingController();
  int _loadGeneration = 0;

  @override
  void initState() {
    super.initState();
    ServerStore.instance.addListener(_reload);
    Connection.instance.addListener(_changed);
    AccountService.instance.addListener(_changed);
    OfficialDevices.instance.addListener(_changed);
    LanDiscovery.instance.addListener(_changed);
    _reload();
  }

  @override
  void dispose() {
    ServerStore.instance.removeListener(_reload);
    Connection.instance.removeListener(_changed);
    AccountService.instance.removeListener(_changed);
    OfficialDevices.instance.removeListener(_changed);
    LanDiscovery.instance.removeListener(_changed);
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
      // Old saved LAN devices can remain on disk after an upgrade. They are not
      // account devices and cannot be dialled through the Rust iroh connection.
      _servers = servers.where((server) => server.isOfficial).toList();
      _loaded = true;
    });
  }

  Future<void> _refresh() async {
    if (AccountService.instance.signedIn) {
      await OfficialDevices.instance.refresh();
    }
    await _reload();
  }

  void _menu(SavedServer server) {
    showContextMenu(
      context,
      contextMenuItems(<SheetOption>[
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
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final account = AccountService.instance;
    final devices = OfficialDevices.instance;
    final needle = _query.text.trim().toLowerCase();
    final shown = _servers
        .where(
          (server) =>
              '${server.alias} ${server.host}'.toLowerCase().contains(needle),
        )
        .toList();
    final favorites = shown.where((server) => server.favorite).toList();
    final others = shown.where((server) => !server.favorite).toList();
    return AppScreen(
      title: t('official.section', context: context),
      showBack: false,
      actions: <AppAction>[
        AppAction(
          icon: AppIcons.settings,
          tooltip: t('nav.settings', context: context),
          onPressed: () => context.push('/settings'),
        ),
      ],
      body: CustomScrollView(
        slivers: <Widget>[
          iosRefreshControl(onRefresh: _refresh),
          if (_servers.isNotEmpty && account.signedIn)
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              sliver: SliverToBoxAdapter(
                child: SearchField(
                  controller: _query,
                  placeholder: t('devices.search', context: context),
                  onChanged: (_) => setState(() {}),
                ),
              ),
            )
          else
            const SliverToBoxAdapter(child: SizedBox(height: 12)),
          SliverPadding(
            padding: AppInsets.pad(
              context,
              const EdgeInsets.fromLTRB(16, 0, 16, 16),
            ),
            sliver: SliverList(
              delegate: SliverChildListDelegate(<Widget>[
                if (!account.signedIn)
                  _signInCard()
                else ...<Widget>[
                  if (devices.error != null) ...<Widget>[
                    SettingsCard(
                      children: <Widget>[
                        SettingsRow(
                          icon: AppIcons.refresh,
                          label: t('official.loadFailed', context: context),
                          description: devices.error,
                          onTap: _refresh,
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                  ],
                  if (!_loaded || (devices.loading && _servers.isEmpty))
                    const Padding(
                      padding: EdgeInsets.only(top: 40),
                      child: BrandLoading(),
                    )
                  else if (_servers.isEmpty)
                    EmptyState(
                      icon: AppIcons.computer,
                      title: t('official.section', context: context),
                      body: t('official.empty', context: context),
                    )
                  else ...<Widget>[
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
                ],
              ]),
            ),
          ),
        ],
      ),
    );
  }

  Widget _signInCard() {
    final account = AccountService.instance;
    final signingIn = account.status == AccountStatus.signingIn;
    return SettingsCard(
      children: <Widget>[
        SettingsRow(
          icon: AppIcons.login,
          label: t(
            signingIn ? 'account.signingIn' : 'official.signInPrompt',
            context: context,
          ),
          description:
              account.error ?? t('account.signedOutBody', context: context),
          onTap: signingIn ? null : account.login,
          trailing: signingIn
              ? Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    DesktopSpinner(size: 16, color: paletteOf(context).muted),
                    const SizedBox(width: 4),
                    IconAction(
                      icon: AppIcons.cancel,
                      onPressed: account.cancelLogin,
                      tooltip: t('common.cancel', context: context),
                    ),
                  ],
                )
              : null,
        ),
      ],
    );
  }

  Widget _row(SavedServer server) {
    final connected =
        Connection.instance.server?.id == server.id &&
        Connection.instance.status == ConnectionStatus.ready &&
        !Connection.instance.reconnecting;
    final online = OfficialDevices.instance.isOnline(server);
    final lan = LanDiscovery.instance.endpointFor(server) != null;
    return DeviceRow(
      server: server,
      connected: connected,
      online: online,
      lan: lan,
      onTap: () {
        Haptic.tap();
        context.push('/server/${Uri.encodeComponent(server.id)}');
      },
      onLongPress: () => _menu(server),
    );
  }
}

/// Shared by the live device list and its widget fixtures.
class DeviceRow extends StatelessWidget {
  const DeviceRow({
    super.key,
    required this.server,
    required this.connected,
    required this.online,
    required this.lan,
    required this.onTap,
    this.onLongPress,
  });
  final SavedServer server;
  final bool connected;
  final bool online;
  final bool lan;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Material(
      color: palette.card,
      borderRadius: BorderRadius.circular(Radii.card),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
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
                              color: palette.text,
                              fontSize: 17,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        if (lan) ...<Widget>[
                          const SizedBox(width: 8),
                          Text(
                            t('devices.lan', context: context),
                            style: TextStyle(
                              color: palette.muted,
                              fontSize: 12,
                            ),
                          ),
                        ],
                        if (server.favorite) ...<Widget>[
                          const SizedBox(width: 6),
                          HugeIcon(
                            icon: AppIcons.star,
                            size: 17,
                            color: palette.warning,
                            strokeWidth: 2.2,
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      t(
                        connected
                            ? 'devices.connected'
                            : online
                            ? 'official.online'
                            : 'official.offline',
                        context: context,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: connected || online
                            ? palette.success
                            : palette.muted,
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
