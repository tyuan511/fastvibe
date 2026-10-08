import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../storage/servers.dart';
import '../theme/theme.dart';
import '../ui/feedback.dart';
import '../ui/glass_screen.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';
import '../chat/option_sheet.dart';
import '../chat/turn_meta.dart';
import '../session/connection.dart';

/// The saved machines. One row each, with the hero card that leads to 扫码 / 输入地址.
class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key});

  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  List<SavedServer> _servers = <SavedServer>[];
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    try {
      final servers = await ServerStore.instance.load();
      if (!mounted) return;
      setState(() {
        _servers = servers;
        _loaded = true;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _loaded = true);
      toastFailure(error, t('devices.loadFailed'));
    }
  }

  Future<void> _remove(SavedServer server) async {
    final confirmed = await AppDialog.confirm(
      context,
      title: t('devices.deleteTitle'),
      message: t('devices.deleteBody', <String, Object?>{'name': server.alias}),
      confirmLabel: t('common.delete'),
      destructive: true,
    );
    if (!confirmed) return;
    try {
      final servers = await ServerStore.instance.remove(server.id);
      if (!mounted) return;
      setState(() => _servers = servers);
      toastSuccess(t('toast.deviceDeleted'));
    } catch (error) {
      toastFailure(error, t('common.operationFailed'));
    }
  }

  Future<void> _rename(SavedServer server) async {
    final next = await AppDialog.prompt(
      context,
      title: t('devices.renameTitle'),
      initial: server.alias,
    );
    if (next == null || next.isEmpty || next == server.alias) return;
    try {
      final servers = await ServerStore.instance.patch(server.id, alias: next);
      if (!mounted) return;
      setState(() => _servers = servers);
      toastSuccess(t('toast.renamed'));
    } catch (error) {
      toastFailure(error, t('common.operationFailed'));
    }
  }

  void _openMenu(SavedServer server) {
    Haptic.press();
    showOptionSheet(
      context,
      title: server.alias,
      subtitle: server.host,
      options: <SheetOption>[
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
          onSelect: () {
            copyToClipboard(server.origin);
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
    return GlassScreen(
      title: 'FastVibe',
      showBack: false,
      actions: <Widget>[
        GlassAction(
          icon: AppIcons.settings,
          tooltip: t('nav.settings'),
          onPressed: () => context.push('/settings'),
        ),
      ],
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
        children: <Widget>[
          if (_loaded) _HeroCard(onScan: () => context.push('/add?scan=1'), onManual: () => context.push('/add')),
          if (_servers.isNotEmpty) SectionLabel(title: t('devices.mine'), count: _servers.length),
          for (final server in _servers)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _DeviceRow(
                server: server,
                onTap: () {
                  Haptic.tap();
                  context.push('/server/${server.id}');
                },
                onLongPress: () => _openMenu(server),
              ),
            ),
          if (_loaded && _servers.isEmpty) ...<Widget>[
            const SizedBox(height: 16),
            _Step(index: '1', title: t('devices.step1Title'), body: t('devices.step1Body')),
            const SizedBox(height: 10),
            _Step(index: '2', title: t('devices.step2Title'), body: t('devices.step2Body')),
            const SizedBox(height: 10),
            _Step(index: '3', title: t('devices.step3Title'), body: t('devices.step3Body')),
          ],
        ],
      ),
    );
  }
}

class _HeroCard extends StatelessWidget {
  const _HeroCard({required this.onScan, required this.onManual});

  final VoidCallback onScan;
  final VoidCallback onManual;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return BrandGradient(
      palette: palette,
      borderRadius: BorderRadius.circular(Radii.xl),
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: Colors.white.withValues(alpha: 0.35), width: 2),
                  ),
                  child: const BrandLogo(size: 46),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        t('devices.heroTitle'),
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 19,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -0.3,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        t('devices.heroBody'),
                        style: TextStyle(color: Colors.white.withValues(alpha: 0.85), fontSize: 13, height: 19 / 13),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              children: <Widget>[
                Expanded(child: _HeroButton(icon: AppIcons.qrCode, label: t('devices.scan'), onTap: onScan)),
                const SizedBox(width: 10),
                Expanded(child: _HeroButton(icon: AppIcons.link, label: t('devices.manual'), onTap: onManual)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _HeroButton extends StatelessWidget {
  const _HeroButton({required this.icon, required this.label, required this.onTap});

  final List<List<dynamic>> icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white.withValues(alpha: 0.18),
      borderRadius: BorderRadius.circular(Radii.md),
      child: InkWell(
        onTap: () {
          Haptic.tap();
          onTap();
        },
        borderRadius: BorderRadius.circular(Radii.md),
        child: Container(
          height: 42,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Radii.md),
            border: Border.all(color: Colors.white.withValues(alpha: 0.4), width: 0.5),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              HugeIcon(icon: icon, color: Colors.white, size: 17),
              const SizedBox(width: 7),
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700)),
            ],
          ),
        ),
      ),
    );
  }
}

class _DeviceRow extends StatelessWidget {
  const _DeviceRow({required this.server, required this.onTap, required this.onLongPress});

  final SavedServer server;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final connection = Connection.instance;
    final online = identical(connection.server?.id, server.id) && connection.status == ConnectionStatus.ready;
    final when = server.lastConnectedAt != null ? relativeTime(server.lastConnectedAt!) : null;
    return Material(
      color: palette.card,
      borderRadius: BorderRadius.circular(Radii.lg),
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        borderRadius: BorderRadius.circular(Radii.lg),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: <Widget>[
              Stack(
                clipBehavior: Clip.none,
                children: <Widget>[
                  Container(
                    width: 46,
                    height: 46,
                    decoration: BoxDecoration(color: palette.accentSoft, borderRadius: BorderRadius.circular(14)),
                    child: Center(child: HugeIcon(icon: AppIcons.computer, color: palette.accent, size: 22)),
                  ),
                  if (online)
                    Positioned(
                      right: -2,
                      bottom: -2,
                      child: Container(
                        width: 14,
                        height: 14,
                        decoration: BoxDecoration(
                          color: palette.success,
                          shape: BoxShape.circle,
                          border: Border.all(color: palette.card, width: 2.5),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      server.alias,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: palette.text,
                        fontSize: 17,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.2,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      server.host,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: palette.muted,
                        fontSize: 13,
                        fontFamily: 'monospace',
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      online
                          ? t('devices.connected')
                          : when != null
                              ? t('devices.connectedAgo', <String, Object?>{'when': when})
                              : t('devices.neverConnected'),
                      style: TextStyle(
                        color: online ? palette.success : palette.subtle,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
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

class _Step extends StatelessWidget {
  const _Step({required this.index, required this.title, required this.body});

  final String index;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: palette.card, borderRadius: BorderRadius.circular(Radii.lg)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(color: palette.accentSoft, borderRadius: BorderRadius.circular(9)),
            alignment: Alignment.center,
            child: Text(
              index,
              style: TextStyle(color: palette.accent, fontSize: 14, fontWeight: FontWeight.w800),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: TextStyle(color: palette.text, fontSize: 15, fontWeight: FontWeight.w700)),
                const SizedBox(height: 3),
                Text(body, style: TextStyle(color: palette.muted, fontSize: 13, height: 19 / 13)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
