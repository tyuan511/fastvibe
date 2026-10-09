import 'dart:math' as math;

import 'package:flutter/cupertino.dart' show CupertinoActivityIndicator;
import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../i18n/core.dart';
import '../protocol/model_cache.dart';
import '../session/connection.dart';
import '../theme/theme.dart';
import '../ui/feedback.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';
import 'image_bytes.dart';
import 'images.dart';
import 'model_picker.dart';
import 'option_sheet.dart';

/// The mobile composer: the input, its chips, the context ring, and the one action button
/// that is Send, Stop or Continue depending on what the conversation is doing.
///
/// It reads its own session state (`engine:get-state` plus the cached model catalog)
/// rather than taking it as a prop: the chips belong to the conversation, and a parent
/// that had to thread them through would re-render the transcript on every refresh.
class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.conversationId,
    required this.running,
    required this.draft,
    required this.images,
    required this.onImagesChange,
    required this.onDraftChange,
    required this.onSend,
    required this.onAbort,
    required this.onContinue,
    required this.canContinue,
    this.sending = false,
    this.queueing = false,
    this.disabled = false,
  });

  final String conversationId;
  final bool running;

  /// Waiting for a direct submission or a durable enqueue acknowledgement.
  final bool sending;
  final bool queueing;
  final bool disabled;
  final TextEditingController draft;
  final List<ComposerImage> images;
  final ValueChanged<List<ComposerImage>> onImagesChange;
  final ValueChanged<String> onDraftChange;
  final Future<void> Function() onSend;
  final VoidCallback onAbort;
  final VoidCallback onContinue;
  final bool canContinue;

  @override
  State<Composer> createState() => _ComposerState();
}

const List<String> _thinkingLevels = <String>[
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
];

class _ComposerState extends State<Composer> {
  final FocusNode _focus = FocusNode();
  int _refreshGeneration = 0;
  bool _imageBusy = false;
  Map<String, Object?>? _session;
  List<Map<String, Object?>> _models = <Map<String, Object?>>[];

  @override
  void initState() {
    super.initState();
    Connection.instance.addListener(_refresh);
    _refresh();
  }

  @override
  void didUpdateWidget(Composer oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The context window only moves while a run is going, so the state is re-read at the
    // boundaries rather than on a timer.
    if (oldWidget.running != widget.running ||
        oldWidget.conversationId != widget.conversationId) {
      _refresh();
    }
  }

  @override
  void dispose() {
    Connection.instance.removeListener(_refresh);
    _focus.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    final remote = Connection.instance.client;
    final generation = ++_refreshGeneration;
    final conversationId = widget.conversationId;
    if (remote == null) return;
    try {
      final results = await Future.wait<Object?>(<Future<Object?>>[
        remote.call('engine:get-state', <String, Object?>{
          'conversationId': widget.conversationId,
        }),
        readModelCatalog(remote),
      ]);
      if (!mounted ||
          generation != _refreshGeneration ||
          conversationId != widget.conversationId ||
          Connection.instance.client != remote) {
        return;
      }
      final state = results[0];
      setState(() {
        _session = state is Map ? state.cast<String, Object?>() : null;
        _models = <Map<String, Object?>>[
          for (final model in results[1] as List<Object?>)
            if (model is Map) model.cast<String, Object?>(),
        ];
      });
    } catch (_) {
      // A failed read leaves the chips as they were; the send path reports real failures.
    }
  }

  ({String provider, String id})? get _currentModel {
    final model = _session?['model'];
    if (model is! Map) return null;
    final provider = model['provider'];
    final id = model['id'];
    if (provider is! String || id is! String) return null;
    return (provider: provider, id: id);
  }

  Map<String, Object?>? get _currentModelEntry {
    final current = _currentModel;
    if (current == null) return null;
    for (final model in _models) {
      if (model['provider'] == current.provider && model['id'] == current.id) {
        return model;
      }
    }
    return null;
  }

  List<String> get _modelThinkingLevels {
    final entry = _currentModelEntry;
    final levels = entry?['thinkingLevels'];
    if (levels is! List) return <String>[];
    return levels.whereType<String>().where((level) => level != 'off').toList();
  }

  ({int? tokens, int? window, double? percent})? get _contextUsage {
    final usage = _session?['contextUsage'];
    if (usage is! Map) return null;
    final percent = usage['percent'];
    if (percent is! num) return null;
    final window = usage['contextWindow'];
    final tokens = usage['tokens'];
    return (
      tokens: tokens is num ? tokens.toInt() : null,
      window: window is num ? window.toInt() : null,
      percent: percent.toDouble(),
    );
  }

  void _imageMenu() {
    showOptionSheet(
      context,
      title: t('composer.chooseImage'),
      options: [
        SheetOption(
          value: 'photos',
          label: t('composer.chooseImage'),
          icon: AppIcons.imageAdd,
          onSelect: _pickImages,
        ),
        SheetOption(
          value: 'paste',
          label: t('composer.pasteImage'),
          icon: AppIcons.clipboardPaste,
          onSelect: _pasteImage,
        ),
      ],
    );
  }

  Future<void> _pasteImage() async {
    if (_imageBusy || widget.images.length >= maxComposerImages) return;
    final conversationId = widget.conversationId;
    setState(() => _imageBusy = true);
    try {
      final image = await pasteImage();
      if (!mounted || conversationId != widget.conversationId) return;
      if (image == null) {
        toastInfo(t('composer.noImageClipboard'));
        return;
      }
      widget.onImagesChange(
        [...widget.images, image].take(maxComposerImages).toList(),
      );
    } catch (_) {
      toastError(t('composer.imageFailed'));
    } finally {
      if (mounted) setState(() => _imageBusy = false);
    }
  }

  Future<void> _pickImages() async {
    if (_imageBusy) return;
    final conversationId = widget.conversationId;
    final remaining = maxComposerImages - widget.images.length;
    if (remaining <= 0) {
      toastInfo(
        t('composer.imageLimit', vars: <String, Object?>{'count': maxComposerImages}),
      );
      return;
    }
    setState(() => _imageBusy = true);
    try {
      final picked = await pickImages(limit: remaining);
      if (!mounted ||
          conversationId != widget.conversationId ||
          picked.isEmpty) {
        return;
      }
      widget.onImagesChange(
        <ComposerImage>[
          ...widget.images,
          ...picked,
        ].take(maxComposerImages).toList(),
      );
    } catch (error) {
      final message = error is StateError ? error.message : '';
      toastError(switch (message) {
        'image-too-large' => t('composer.imageTooLarge'),
        'image-encoding-failed' => t('composer.imageEncodingFailed'),
        _ => t('composer.imageFailed'),
      });
    } finally {
      if (mounted) setState(() => _imageBusy = false);
    }
  }

  Future<void> _pickModel() async {
    final remote = Connection.instance.client;
    if (remote == null) return;
    // Opening the picker is the moment to re-read the catalog: a provider may have been
    // added on the machine since this chat was opened.
    invalidateModelCatalog(remote);
    final current = _currentModel;
    await showModelPicker(
      context,
      serverId: Connection.instance.server?.id ?? '',
      currentProvider: current?.provider,
      currentModelId: current?.id,
      onPick: (provider, id) => _setModel(provider, id),
    );
  }

  Future<void> _setModel(String provider, String id) async {
    final remote = Connection.instance.client;
    if (remote == null) return;
    try {
      final state = await remote.call('engine:set-model', <String, Object?>{
        'provider': provider,
        'modelId': id,
        'conversationId': widget.conversationId,
      });
      if (!mounted) return;
      setState(
        () =>
            _session = state is Map ? state.cast<String, Object?>() : _session,
      );
      toastSuccess(t('toast.modelSwitched', vars: <String, Object?>{'model': id}));
      // A model with a narrower set of levels must not leave the session on one it
      // cannot take.
      final levels = _modelThinkingLevels;
      final currentLevel = _session?['thinkingLevel'];
      if (levels.isNotEmpty &&
          (currentLevel is! String || !levels.contains(currentLevel))) {
        await _setThinking(levels.contains('high') ? 'high' : levels.first);
      }
    } catch (error) {
      toastFailure(error, t('composer.modelFailed'));
    }
  }

  Future<void> _setThinking(String level) async {
    final remote = Connection.instance.client;
    if (remote == null) return;
    try {
      final state = await remote.call('engine:set-thinking', <String, Object?>{
        'level': level,
        'conversationId': widget.conversationId,
      });
      if (!mounted) return;
      setState(
        () =>
            _session = state is Map ? state.cast<String, Object?>() : _session,
      );
    } catch (error) {
      toastFailure(error, t('composer.thinkingFailed'));
    }
  }

  void _pickThinking() {
    final levels = _modelThinkingLevels;
    final current = _session?['thinkingLevel'];
    showOptionSheet(
      context,
      title: t('composer.thinkingTitle'),
      subtitle: _currentModelEntry?['name'] is String
          ? _currentModelEntry!['name'] as String
          : null,
      value: current is String ? current : null,
      options: <SheetOption>[
        for (final level in levels)
          SheetOption(
            value: level,
            label: _thinkingLabel(level),
            description: _thinkingHint(level),
            onSelect: () => _setThinking(level),
          ),
      ],
    );
  }

  String _thinkingLabel(String level) =>
      _thinkingLevels.contains(level) ? t('thinking.$level') : level;

  String? _thinkingHint(String level) =>
      level != 'off' && level != 'auto' && _thinkingLevels.contains(level)
      ? t('thinking.${level}Hint')
      : null;

  void _showContext() {
    final usage = _contextUsage;
    if (usage == null) return;
    final detail = usage.tokens != null
        ? '${formatTokens(usage.tokens!)} / ${formatTokens(usage.window ?? 0)} tokens'
        : t('composer.contextWindow', vars: <String, Object?>{
            'window': formatTokens(usage.window ?? 0),
          });
    AppDialog.alert(
      context,
      title: t('composer.contextUsed', vars: <String, Object?>{
        'percent': usage.percent!.round(),
      }),
      message: detail,
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final hasContent =
        widget.draft.text.trim().isNotEmpty || widget.images.isNotEmpty;
    final action = widget.sending
        ? 'sending'
        : widget.running && !hasContent
        ? 'stop'
        : widget.canContinue && !hasContent
        ? 'continue'
        : 'send';
    final actionDisabled =
        widget.disabled ||
        widget.sending ||
        _imageBusy ||
        (action == 'send' && !hasContent);
    final placeholder = widget.disabled
        ? t('composer.placeholderLoading', context: context)
        : widget.queueing
        ? t('composer.placeholderQueue', context: context)
        : t('composer.placeholder', context: context);

    return Padding(
      padding: EdgeInsets.fromLTRB(
        10,
        6,
        10,
        math.max(MediaQuery.paddingOf(context).bottom, 10),
      ),
      child: GlassContainer(
        useOwnLayer: true,
        shape: const LiquidRoundedSuperellipse(borderRadius: Radii.xl),
        padding: const EdgeInsets.only(bottom: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            if (widget.images.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    for (final image in widget.images)
                      _Thumbnail(
                        image: image,
                        palette: palette,
                        onRemove: () => widget.onImagesChange(
                          widget.images
                              .where((item) => item.id != image.id)
                              .toList(),
                        ),
                      ),
                  ],
                ),
              ),
            TextField(
              controller: widget.draft,
              focusNode: _focus,
              enabled: !widget.disabled,
              onChanged: widget.onDraftChange,
              // Enter inserts a newline: a soft keyboard has no Shift+Enter, so
              // submitting on Enter would make a multi-line prompt impossible.
              maxLines: null,
              minLines: 1,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.newline,
              style: TextStyle(
                color: palette.text,
                fontSize: 17,
                height: 22 / 17,
              ),
              decoration: InputDecoration(
                border: InputBorder.none,
                isDense: true,
                contentPadding: const EdgeInsets.fromLTRB(16, 13, 16, 6),
                hintText: placeholder,
                hintStyle: TextStyle(color: palette.subtle, fontSize: 17),
                constraints: const BoxConstraints(
                  minHeight: 48,
                  maxHeight: 150,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 4, 10, 0),
              child: Row(
                children: <Widget>[
                  IconAction(
                    icon: AppIcons.imageAdd,
                    tone: IconTone.field,
                    size: 40,
                    enabled:
                        !widget.disabled &&
                        !_imageBusy &&
                        widget.images.length < maxComposerImages,
                    tooltip: t('composer.chooseImage', context: context),
                    onPressed: _imageMenu,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: <Widget>[
                          _Chip(
                            palette: palette,
                            label: _modelLabel,
                            leading: _currentModel == null
                                ? null
                                : Avatar(
                                    name: _currentModel!.provider,
                                    size: 18,
                                  ),
                            enabled: !widget.disabled && _models.isNotEmpty,
                            onTap: _pickModel,
                          ),
                          if (_modelThinkingLevels.isNotEmpty) ...<Widget>[
                            const SizedBox(width: 6),
                            _Chip(
                              palette: palette,
                              label: _thinkingLabelText,
                              icon: AppIcons.aiBrain,
                              enabled: !widget.disabled,
                              onTap: _pickThinking,
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                  if (_contextUsage != null) ...<Widget>[
                    const SizedBox(width: 8),
                    GestureDetector(
                      onTap: _showContext,
                      child: SizedBox(
                        width: 28,
                        height: 28,
                        child: Center(
                          child: CustomPaint(
                            size: const Size.square(22),
                            painter: _RingPainter(
                              percent: (_contextUsage!.percent! / 100).clamp(
                                0,
                                1,
                              ),
                              track: palette.field,
                              progress: _contextUsage!.percent! >= 90
                                  ? palette.danger
                                  : _contextUsage!.percent! >= 70
                                  ? palette.warning
                                  : palette.accent,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(width: 8),
                  _ActionButton(
                    palette: palette,
                    action: action,
                    disabled: actionDisabled,
                    // Sending puts the keyboard away, as Messages does: what comes next
                    // is the reply, which needs the screen the keyboard is covering.
                    onSend: () {
                      _focus.unfocus();
                      return widget.onSend();
                    },
                    onAbort: widget.onAbort,
                    onContinue: widget.onContinue,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String get _modelLabel {
    final entry = _currentModelEntry;
    final name = entry?['name'];
    if (name is String && name.isNotEmpty) return name;
    final current = _currentModel;
    if (current != null) return current.id;
    if (_models.isEmpty) return t('composer.noModels');
    return t('composer.defaultModel');
  }

  String get _thinkingLabelText {
    final level = _session?['thinkingLevel'];
    return level is String && level.isNotEmpty
        ? _thinkingLabel(level)
        : t('composer.thinkingChip');
  }
}

class _Thumbnail extends StatelessWidget {
  const _Thumbnail({
    required this.image,
    required this.palette,
    required this.onRemove,
  });

  final ComposerImage image;
  final Palette palette;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        ClipRRect(
          borderRadius: BorderRadius.circular(Radii.md),
          // Keyed by the photo, and fed bytes decoded once: a rebuild per keystroke
          // otherwise re-decodes the base64 and the thumbnail flickers while typing.
          child: Image.memory(
            imageBytesOfPayload(image.uri, image.data),
            key: ValueKey<String>(image.id),
            width: 64,
            height: 64,
            fit: BoxFit.cover,
            gaplessPlayback: true,
          ),
        ),
        Positioned(
          right: -6,
          top: -6,
          child: GestureDetector(
            onTap: onRemove,
            child: Container(
              width: 20,
              height: 20,
              decoration: BoxDecoration(
                color: palette.card,
                shape: BoxShape.circle,
                border: Border.all(color: palette.border, width: 0.5),
              ),
              child: Center(
                child: HugeIcon(
                  icon: AppIcons.cancel,
                  size: 12,
                  color: palette.text,
                  strokeWidth: 2.5,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.palette,
    required this.label,
    this.icon,
    this.leading,
    required this.enabled,
    required this.onTap,
  });

  final Palette palette;
  final String label;
  final List<List<dynamic>>? icon;
  final Widget? leading;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: enabled ? 1 : 0.5,
      child: GestureDetector(
        onTap: enabled ? onTap : null,
        // An iOS pop-up button (the model, the thinking level): the current value and the
        // up-down chevron, on a faint capsule — the composer is already glass, so no
        // glass control of its own inside it.
        child: Container(
          height: 32,
          constraints: const BoxConstraints(maxWidth: 200),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: palette.text.withValues(alpha: palette.dark ? 0.10 : 0.06),
            borderRadius: BorderRadius.circular(Radii.pill),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (leading != null) ...<Widget>[
                leading!,
                const SizedBox(width: 5),
              ],
              if (icon != null) ...<Widget>[
                HugeIcon(
                  icon: icon!,
                  size: 14,
                  color: palette.muted,
                  strokeWidth: 2,
                ),
                const SizedBox(width: 5),
              ],
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              const SizedBox(width: 3),
              HugeIcon(
                icon: AppIcons.chevronUpDown,
                size: 14,
                color: palette.muted,
                strokeWidth: 2,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.palette,
    required this.action,
    required this.disabled,
    required this.onSend,
    required this.onAbort,
    required this.onContinue,
  });

  final Palette palette;
  final String action;
  final bool disabled;
  final Future<void> Function() onSend;
  final VoidCallback onAbort;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    if (action == 'stop') {
      return Semantics(
        label: t('composer.stop', context: context),
        button: true,
        enabled: !disabled,
        child: GestureDetector(
          onTap: disabled
              ? null
              : () {
                  Haptic.press();
                  onAbort();
                },
          child: Container(
            width: 36,
            height: 36,
            margin: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              color: palette.text,
              shape: BoxShape.circle,
            ),
            child: Center(
              child: HugeIcon(
                icon: AppIcons.square,
                size: 16,
                color: palette.card,
                strokeWidth: 2.4,
              ),
            ),
          ),
        ),
      );
    }
    final label = action == 'sending'
        ? t('composer.sending', context: context)
        : action == 'continue'
        ? t('composer.continue', context: context)
        : t('composer.send', context: context);
    return Opacity(
      opacity: disabled ? 0.35 : 1,
      child: Semantics(
        label: label,
        button: true,
        enabled: !disabled,
        child: GestureDetector(
          onTap: disabled
              ? null
              : () {
                  if (action == 'continue') {
                    Haptic.tap();
                    onContinue();
                  } else {
                    Haptic.tap();
                    onSend();
                  }
                },
          child: Container(
            width: 36,
            height: 36,
            margin: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              color: palette.accent,
              shape: BoxShape.circle,
            ),
            child: SizedBox(
              width: 36,
              height: 36,
              child: Center(
                child: action == 'sending'
                    ? const CupertinoActivityIndicator(color: Colors.white)
                    : HugeIcon(
                        icon: action == 'continue'
                            ? AppIcons.play
                            : AppIcons.arrowUp,
                        size: 18,
                        color: Colors.white,
                        strokeWidth: 2.2,
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({
    required this.percent,
    required this.track,
    required this.progress,
  });

  final double percent;
  final Color track;
  final Color progress;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 2.6;
    final rect = (Offset.zero & size).deflate(stroke / 2);
    final base = Paint()
      ..color = track
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke;
    canvas.drawArc(rect, 0, math.pi * 2, false, base);
    final arc = Paint()
      ..color = progress
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;
    // From 12 o'clock, clockwise — the direction a reader expects a gauge to fill.
    canvas.drawArc(rect, -math.pi / 2, math.pi * 2 * percent, false, arc);
  }

  @override
  bool shouldRepaint(_RingPainter oldDelegate) =>
      oldDelegate.percent != percent || oldDelegate.progress != progress;
}
