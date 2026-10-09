import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoActivityIndicator;
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';

import '../chat/option_sheet.dart';
import '../i18n/core.dart';
import '../protocol/address.dart';
import '../protocol/client.dart';
import '../protocol/discovery.dart';
import '../session/connection.dart';
import '../storage/servers.dart';
import '../theme/theme.dart';
import '../ui/glass_screen.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';

/// Connect to a machine: scan a QR code, or type its address and password.
class AddDeviceScreen extends StatefulWidget {
  const AddDeviceScreen({super.key, this.scanFirst = false});

  final bool scanFirst;

  @override
  State<AddDeviceScreen> createState() => _AddDeviceScreenState();
}

class _AddDeviceScreenState extends State<AddDeviceScreen> {
  final TextEditingController _url = TextEditingController();
  final TextEditingController _alias = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final FocusNode _passwordFocus = FocusNode();
  final NearbyDiscovery _nearby = NearbyDiscovery();
  bool _aliasTouched = false;
  String? _error;
  bool _busy = false;
  String? _resolving;

  @override
  void initState() {
    super.initState();
    _nearby.addListener(() {
      if (mounted) setState(() {});
    });
    unawaited(_nearby.start());
    _url.addListener(() => setState(() {}));
    if (widget.scanFirst) {
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (!mounted) return;
        await context.push('/scan');
        if (mounted) _applyScanned();
      });
    }
  }

  @override
  void dispose() {
    _nearby.dispose();
    _url.dispose();
    _alias.dispose();
    _password.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  ServerAddress? get _parsed => parseServerAddress(_url.text);

  String get _shownAlias {
    if (_aliasTouched) return _alias.text;
    final parsed = _parsed;
    if (_alias.text.isNotEmpty) return _alias.text;
    return parsed?.host ?? '';
  }

  Future<void> _submit() async {
    final address = parseServerAddress(_url.text);
    if (address == null) {
      setState(() => _error = t('add.badAddress'));
      return;
    }
    if (_password.text.isEmpty) {
      setState(() => _error = t('add.needPassword'));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final name = _shownAlias.trim().isNotEmpty
        ? _shownAlias.trim()
        : address.host;
    try {
      final remote = RemoteClient();
      final token = await remote.login(
        address.origin,
        _password.text,
        'FastVibe $name',
      );
      final saved = await ServerStore.instance.upsert(
        SavedServer(
          id: newServerId(),
          alias: name,
          origin: address.origin,
          host: address.host,
          kind: address.kind,
          createdAt: DateTime.now().millisecondsSinceEpoch,
        ),
      );
      await writeToken(saved.id, token);
      await Connection.instance.connectSaved(saved);
      if (!mounted) return;
      if (Connection.instance.status != ConnectionStatus.ready) {
        setState(
          () =>
              _error = Connection.instance.error ?? t('add.savedNotConnected'),
        );
        return;
      }
      Haptic.success();
      context.replace('/server/${saved.id}');
    } catch (error) {
      Haptic.warning();
      if (!mounted) return;
      setState(
        () =>
            _error = error is StateError ? error.message : t('add.loginFailed'),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Fill the form from a computer found on the network. The connection is named after the
  /// computer's host name; the address is the first of its announced ones this phone can
  /// actually reach, since a computer announces one per network interface.
  Future<void> _pickNearby(NearbyMachine machine) async {
    if (_resolving != null) return;
    Haptic.tap();
    setState(() {
      _resolving = machine.name;
      _error = null;
    });
    final origin = await firstReachable(machine.origins);
    if (!mounted) return;
    if (origin == null) {
      Haptic.warning();
      setState(() {
        _resolving = null;
        _error = t('add.nearbyUnreachable');
      });
      return;
    }
    _url.text = origin;
    _alias.text = machine.name;
    _aliasTouched = true;
    Haptic.success();
    setState(() => _resolving = null);
    Timer(const Duration(milliseconds: 350), () {
      if (mounted) _passwordFocus.requestFocus();
    });
  }

  void _applyScanned() {
    if (!mounted) return;
    final value = takeScannedAddress();
    if (value == null || value.isEmpty) return;
    final scanned = parseServerQr(value);
    _url.text = scanned?.address.origin ?? value;
    // A scan supplies a default name. Keep a name the user has already edited, and
    // replace previous automatic suggestions when scanning another computer.
    if (!_aliasTouched) _alias.text = scanned?.name ?? '';
    setState(() => _error = null);
    Haptic.success();
    Timer(const Duration(milliseconds: 350), () {
      if (mounted) _passwordFocus.requestFocus();
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final parsed = _parsed;
    return GlassScreen(
      title: t('nav.addDevice'),
      body: GestureDetector(
        onTap: () => FocusScope.of(context).unfocus(),
        child: Builder(
          builder: (context) => ListView(
            padding: GlassInsets.pad(
              context,
              const EdgeInsets.fromLTRB(16, 4, 16, 16),
            ),
            children: <Widget>[
              // A pushed form: the bar already says 添加设备, so no second, larger title
              // in the content — what the page is for goes under the first group, as an
              // iOS section footer.
              const SizedBox(height: 8),
              _ScanCard(
                onTap: () async {
                  Haptic.tap();
                  await context.push('/scan');
                  _applyScanned();
                },
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 7, 16, 0),
                child: Text(
                  t('add.workspaceSubtitle'),
                  style: TextStyle(
                    color: palette.muted,
                    fontSize: 13,
                    height: 18 / 13,
                  ),
                ),
              ),
              if (_nearby.machines.isNotEmpty || _nearby.searching) ...<Widget>[
                const SizedBox(height: 14),
                _NearbyList(
                  machines: _nearby.machines,
                  searching: _nearby.searching,
                  resolving: _resolving,
                  onPick: _pickNearby,
                ),
              ],
              SectionLabel(title: t('add.orManual')),
              Container(
                decoration: BoxDecoration(
                  color: palette.card,
                  borderRadius: BorderRadius.circular(Radii.lg),
                ),
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 6,
                ),
                child: Column(
                  children: <Widget>[
                    _Field(
                      label: t('add.address'),
                      icon: AppIcons.link,
                      palette: palette,
                      child: TextField(
                        controller: _url,
                        autocorrect: false,
                        keyboardType: TextInputType.url,
                        textInputAction: TextInputAction.next,
                        style: TextStyle(color: palette.text, fontSize: 17),
                        decoration: InputDecoration(
                          border: InputBorder.none,
                          isDense: true,
                          hintText: t('add.addressPlaceholder'),
                          hintStyle: TextStyle(
                            color: palette.subtle,
                            fontSize: 17,
                          ),
                        ),
                      ),
                    ),
                    if (_url.text.isNotEmpty) ...<Widget>[
                      Divider(
                        height: 0.5,
                        thickness: 0.5,
                        color: palette.border,
                      ),
                      if (parsed == null)
                        _AddressNote(
                          palette: palette,
                          tone: NoteTone.danger,
                          icon: AppIcons.alert,
                          text: t('add.unrecognized'),
                        )
                      else if (parsed.kind == AddressKind.loopback)
                        _AddressNote(
                          palette: palette,
                          tone: NoteTone.danger,
                          icon: AppIcons.alert,
                          text: t('add.loopbackWarning'),
                        )
                      else
                        _AddressNote(
                          palette: palette,
                          tone: NoteTone.success,
                          icon: AppIcons.checkCircle,
                          text: parsed.origin,
                        ),
                    ],
                    Divider(height: 0.5, thickness: 0.5, color: palette.border),
                    _Field(
                      label: t('add.alias'),
                      icon: AppIcons.pencilEdit,
                      palette: palette,
                      child: TextField(
                        controller: _alias,
                        textInputAction: TextInputAction.next,
                        onChanged: (value) {
                          if (!_aliasTouched) _aliasTouched = true;
                          setState(() {});
                        },
                        style: TextStyle(color: palette.text, fontSize: 17),
                        decoration: InputDecoration(
                          border: InputBorder.none,
                          isDense: true,
                          hintText: _shownAlias,
                          hintStyle: TextStyle(
                            color: palette.subtle,
                            fontSize: 17,
                          ),
                        ),
                      ),
                    ),
                    Divider(height: 0.5, thickness: 0.5, color: palette.border),
                    _Field(
                      label: t('add.password'),
                      icon: AppIcons.lockPassword,
                      palette: palette,
                      child: TextField(
                        controller: _password,
                        focusNode: _passwordFocus,
                        obscureText: true,
                        textInputAction: TextInputAction.go,
                        onSubmitted: (_) => _submit(),
                        style: TextStyle(color: palette.text, fontSize: 17),
                        decoration: InputDecoration(
                          border: InputBorder.none,
                          isDense: true,
                          hintText: '••••••',
                          hintStyle: TextStyle(
                            color: palette.subtle,
                            fontSize: 17,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (_error != null) ...<Widget>[
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: palette.dangerSoft,
                    borderRadius: BorderRadius.circular(Radii.md),
                  ),
                  child: Row(
                    children: <Widget>[
                      HugeIcon(
                        icon: AppIcons.alert,
                        color: palette.danger,
                        size: 16,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _error!,
                          style: TextStyle(
                            color: palette.danger,
                            fontSize: 14,
                            height: 20 / 14,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 18),
              PrimaryButton(
                label: t('add.submit'),
                busy: _busy,
                enabled: parsed != null && _password.text.isNotEmpty,
                onPressed: _submit,
              ),
              const SizedBox(height: 14),
              Text(
                t('add.hint'),
                style: TextStyle(
                  color: palette.muted,
                  fontSize: 13,
                  height: 20 / 13,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ScanCard extends StatelessWidget {
  const _ScanCard({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Material(
      color: palette.card,
      borderRadius: BorderRadius.circular(Radii.lg),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Radii.lg),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: <Widget>[
              Container(
                width: 50,
                height: 50,
                decoration: BoxDecoration(
                  color: palette.accent,
                  borderRadius: BorderRadius.circular(15),
                ),
                child: Center(
                  child: HugeIcon(
                    icon: AppIcons.qrCode,
                    size: 26,
                    color: palette.accentText,
                    strokeWidth: 1.9,
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      t('add.scanTitle'),
                      style: TextStyle(
                        color: palette.text,
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      t('add.scanBody'),
                      style: TextStyle(
                        color: palette.muted,
                        fontSize: 13,
                        height: 18 / 13,
                      ),
                    ),
                  ],
                ),
              ),
              HugeIcon(
                icon: AppIcons.arrowRight,
                size: 18,
                color: palette.subtle,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Computers announcing themselves on this Wi-Fi.
class _NearbyList extends StatelessWidget {
  const _NearbyList({
    required this.machines,
    required this.searching,
    required this.resolving,
    required this.onPick,
  });

  final List<NearbyMachine> machines;
  final bool searching;
  final String? resolving;
  final ValueChanged<NearbyMachine> onPick;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Container(
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(Radii.lg),
      ),
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: Text(
              t('add.nearbyTitle'),
              style: TextStyle(
                color: palette.muted,
                fontSize: 12,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.2,
              ),
            ),
          ),
          if (machines.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 10),
              child: Text(
                t('add.nearbySearching'),
                style: TextStyle(color: palette.subtle, fontSize: 14),
              ),
            ),
          for (final machine in machines)
            InkWell(
              onTap: resolving == null ? () => onPick(machine) : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                child: Row(
                  children: <Widget>[
                    HugeIcon(
                      icon: AppIcons.computer,
                      size: 22,
                      color: palette.accent,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        machine.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: palette.text,
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    if (resolving == machine.name)
                      const CupertinoActivityIndicator()
                    else
                      HugeIcon(
                        icon: AppIcons.arrowRight,
                        size: 18,
                        color: palette.subtle,
                      ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({
    required this.label,
    required this.icon,
    required this.palette,
    required this.child,
  });

  final String label;
  final List<List<dynamic>> icon;
  final Palette palette;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              HugeIcon(
                icon: icon,
                size: 14,
                color: palette.muted,
                strokeWidth: 2,
              ),
              const SizedBox(width: 5),
              Text(
                label,
                style: TextStyle(
                  color: palette.muted,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.2,
                ),
              ),
            ],
          ),
          const SizedBox(height: 2),
          child,
        ],
      ),
    );
  }
}

enum NoteTone { success, danger }

class _AddressNote extends StatelessWidget {
  const _AddressNote({
    required this.palette,
    required this.tone,
    required this.icon,
    required this.text,
  });

  final Palette palette;
  final NoteTone tone;
  final List<List<dynamic>> icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final (background, foreground) = tone == NoteTone.success
        ? (palette.successSoft, palette.success)
        : (palette.dangerSoft, palette.danger);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(Radii.sm),
      ),
      child: Row(
        children: <Widget>[
          HugeIcon(icon: icon, size: 15, color: foreground),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                color: foreground,
                fontSize: 13,
                height: 18 / 13,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
