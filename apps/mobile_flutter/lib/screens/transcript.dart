import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../chat/dag_data.dart';
import '../chat/image_bytes.dart';
import '../chat/image_note.dart';
import '../chat/markdown_view.dart';
import '../chat/message.dart';
import '../chat/process_group.dart';
import '../chat/turn_meta.dart';
import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';

const double _messageBottomGap = 20;
const double _workingPillHeight = 30;
const double _workingGap = 8;
const double _workingBottomInset = 8;
const double _workingScrollSpace =
    _workingPillHeight + _workingGap + _workingBottomInset;

/// The transcript.
///
/// An **inverted** list: index 0 is the newest row and sits at the bottom, so the first
/// paint lands on the newest message with no scroll animation. `reverse: true` is what
/// makes that work, and it is why the header is the visual *bottom* spacer.
///
/// It is a separate widget from the screen on purpose: draft edits and the run clock must
/// not rebuild the list.
class TranscriptView extends StatefulWidget {
  const TranscriptView({
    super.key,
    required this.messages,
    required this.footers,
    required this.running,
    required this.waiting,
    required this.workingSince,
    required this.now,
    required this.onLongPress,
    required this.onOlder,
    this.dagWatcher,
    this.topInset = 0,
    this.bottomInset = 0,
  });

  /// Newest first, already merged into one row per reply.
  final List<ChatMessage> messages;
  final Map<String, TurnMeta> footers;
  final bool running;
  final bool waiting;
  final int? workingSince;
  final int now;
  final void Function(ChatMessage message) onLongPress;
  final VoidCallback onOlder;
  final DagWatcher? dagWatcher;

  /// How far the glass bar above and the footer below reach into this view. The list runs
  /// under both, so its content is padded by them rather than clipped at their edges.
  final double topInset;
  final double bottomInset;

  @override
  State<TranscriptView> createState() => _TranscriptViewState();
}

class _TranscriptViewState extends State<TranscriptView> {
  final ScrollController _controller = ScrollController();
  bool _away = false;
  double _viewport = 0;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onScroll);
  }

  @override
  void dispose() {
    _controller.removeListener(_onScroll);
    _controller.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_controller.hasClients) return;
    final threshold = _viewport > 0
        ? (_viewport * 0.6).clamp(160.0, double.infinity)
        : 480.0;
    final next = _controller.offset > threshold;
    if (next != _away) setState(() => _away = next);
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Stack(
      children: <Widget>[
        NotificationListener<ScrollNotification>(
          onNotification: (notification) {
            _viewport = notification.metrics.viewportDimension;
            // In an inverted list the "end" is the oldest edge, so this is where older
            // pages are prefetched.
            if (notification.metrics.extentAfter <
                notification.metrics.viewportDimension * 2) {
              widget.onOlder();
            }
            return false;
          },
          child: ListView.builder(
            controller: _controller,
            reverse: true,
            padding: EdgeInsets.fromLTRB(22, 16 + widget.topInset, 22, 16),
            itemCount: widget.messages.length + 1,
            itemBuilder: (context, index) {
              // Index 0 of the list is the visual bottom: the spacer.
              if (index == 0) {
                return SizedBox(
                  height:
                      (widget.running && !widget.waiting
                          ? _workingScrollSpace
                          : _messageBottomGap) +
                      widget.bottomInset,
                );
              }
              final position = index - 1;
              final message = widget.messages[position];
              final previous = position + 1 < widget.messages.length
                  ? widget.messages[position + 1]
                  : null;
              return Padding(
                padding: const EdgeInsets.only(bottom: 24),
                child: MessageRow(
                  message: message,
                  palette: palette,
                  meta: widget.footers[message.lastId ?? message.id],
                  turnStart:
                      message.isAssistant && previous?.isAssistant != true,
                  live: widget.running && position == 0,
                  dagWatcher: widget.dagWatcher,
                  onLongPress: widget.onLongPress,
                ),
              );
            },
          ),
        ),
        if (widget.running && !widget.waiting)
          Positioned(
            left: 0,
            right: 0,
            bottom: _workingBottomInset + widget.bottomInset,
            child: IgnorePointer(
              child: Center(
                child: WorkingPill(since: widget.workingSince, now: widget.now),
              ),
            ),
          ),
        if (_away)
          Positioned(
            right: 14,
            bottom:
                (widget.running && !widget.waiting
                    ? _workingScrollSpace + 4
                    : 12) +
                widget.bottomInset,
            child: GlassIconButton(
              icon: HugeIcon(
                icon: AppIcons.arrowDownLong,
                size: 20,
                color: palette.text,
              ),
              semanticLabel: t('chat.latest', context: context),
              size: 44,
              onPressed: () {
                Haptic.tap();
                if (MediaQuery.disableAnimationsOf(context)) {
                  _controller.jumpTo(0);
                } else {
                  _controller.animateTo(
                    0,
                    duration: const Duration(milliseconds: 260),
                    curve: Curves.easeOutCubic,
                  );
                }
              },
            ),
          ),
      ],
    );
  }
}

/// The floating 「正在工作」 capsule, with the run's elapsed time. It sits on the page
/// rather than floating over it, so it takes the faintest lift there is.
class WorkingPill extends StatelessWidget {
  const WorkingPill({super.key, required this.since, required this.now});

  final int? since;
  final int now;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Container(
      height: _workingPillHeight,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(Radii.pill),
        border: Border.all(color: palette.border, width: 0.5),
        boxShadow: elevation(palette, 0),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          DesktopSpinner(size: 15, color: palette.accent),
          const SizedBox(width: 7),
          Text(
            t('chat.working', context: context),
            style: TextStyle(
              color: palette.text,
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(width: 7),
          Text(
            formatElapsed(now - (since ?? now)),
            style: TextStyle(
              color: palette.muted,
              fontSize: 12,
              fontFamily: 'monospace',
              fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

/// One row of the transcript. A reply is a single row; its parts decide what is drawn.
class MessageRow extends StatelessWidget {
  const MessageRow({
    super.key,
    required this.message,
    required this.palette,
    required this.meta,
    required this.turnStart,
    required this.live,
    required this.onLongPress,
    this.dagWatcher,
  });

  final ChatMessage message;
  final Palette palette;
  final TurnMeta? meta;

  /// The first assistant row of a turn — it carries the reply's name.
  final bool turnStart;

  /// The newest row while a run is in flight.
  final bool live;
  final void Function(ChatMessage message) onLongPress;
  final DagWatcher? dagWatcher;

  @override
  Widget build(BuildContext context) {
    if (message.kind == 'dag') {
      return InkWell(
        onTap: dagWatcher == null ? null : () => dagWatcher!.open?.call(null),
        child: _Divider(
          palette: palette,
          label: t(
            message.dag?.settled == false ? 'dag.updated' : 'dag.settled',
            context: context,
          ),
        ),
      );
    }
    if (message.kind == 'compact') {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          CompactNotice(
            palette: palette,
            text: message.text,
            compact: message.compact,
          ),
          if (meta != null) _TurnMetaLine(meta: meta!, palette: palette),
        ],
      );
    }
    if (message.role == 'user') {
      return _UserRow(
        message: message,
        palette: palette,
        onLongPress: onLongPress,
      );
    }
    return _AssistantRow(
      message: message,
      palette: palette,
      meta: meta,
      turnStart: turnStart,
      live: live,
      onLongPress: onLongPress,
      dagWatcher: dagWatcher,
    );
  }
}

class _UserRow extends StatelessWidget {
  const _UserRow({
    required this.message,
    required this.palette,
    required this.onLongPress,
  });

  final ChatMessage message;
  final Palette palette;
  final void Function(ChatMessage message) onLongPress;

  @override
  Widget build(BuildContext context) {
    // The engine appends a resize note for the model; the photo above the text is
    // how the reader sees the image, so the note never reaches the bubble.
    final text = stripImageDimensionNote(message.text);
    return Align(
      alignment: Alignment.centerRight,
      child: GestureDetector(
        onLongPress: () => onLongPress(message),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.sizeOf(context).width * 0.86,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: palette.accentSoft,
                  borderRadius: const BorderRadius.only(
                    topLeft: Radius.circular(20),
                    topRight: Radius.circular(20),
                    bottomLeft: Radius.circular(20),
                    bottomRight: Radius.circular(6),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (message.attachments != null &&
                        message.attachments!.isNotEmpty) ...<Widget>[
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: <Widget>[
                          for (final attachment in message.attachments!)
                            if (attachment.dataUrl != null)
                              ClipRRect(
                                borderRadius: BorderRadius.circular(Radii.md),
                                child: _AttachmentImage(
                                  url: attachment.dataUrl!,
                                ),
                              ),
                        ],
                      ),
                      const SizedBox(height: 4),
                    ],
                    if (text.isNotEmpty)
                      MarkdownView(
                        text: text,
                        palette: palette,
                        compact: true,
                      ),
                  ],
                ),
              ),
              if (message.error != null) ...<Widget>[
                const SizedBox(height: 4),
                Text(
                  message.error!,
                  style: TextStyle(
                    color: palette.danger,
                    fontSize: 14,
                    height: 20 / 14,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _AssistantRow extends StatelessWidget {
  const _AssistantRow({
    required this.message,
    required this.palette,
    required this.meta,
    required this.turnStart,
    required this.live,
    required this.onLongPress,
    this.dagWatcher,
  });

  final ChatMessage message;
  final Palette palette;
  final TurnMeta? meta;
  final bool turnStart;
  final bool live;
  final void Function(ChatMessage message) onLongPress;
  final DagWatcher? dagWatcher;

  @override
  Widget build(BuildContext context) {
    final blocks = buildBlocks(message);
    return GestureDetector(
      onLongPress: () => onLongPress(message),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 680),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (turnStart) ...<Widget>[
              Row(
                children: <Widget>[
                  const BrandLogo(size: 17),
                  const SizedBox(width: 7),
                  Text(
                    'FastVibe',
                    style: TextStyle(
                      color: palette.muted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
            ],
            for (var index = 0; index < blocks.length; index++) ...<Widget>[
              if (index > 0) const SizedBox(height: 12),
              _block(blocks[index], index == blocks.length - 1),
            ],
            if (message.error != null) ...<Widget>[
              const SizedBox(height: 6),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 9,
                ),
                decoration: BoxDecoration(
                  color: palette.dangerSoft,
                  borderRadius: BorderRadius.circular(Radii.md),
                ),
                child: Text(
                  message.error!,
                  style: TextStyle(
                    color: palette.danger,
                    fontSize: 14,
                    height: 20 / 14,
                  ),
                ),
              ),
            ],
            if (meta != null) _TurnMetaLine(meta: meta!, palette: palette),
          ],
        ),
      ),
    );
  }

  Widget _block(RenderBlock block, bool isLast) => switch (block) {
    TextBlock(:final text) => MarkdownView(
      text: text,
      palette: palette,
      streaming: live,
    ),
    ProcessBlock(:final steps) => ProcessGroup(
      steps: steps,
      palette: palette,
      live: live && isLast,
    ),
    ErrorBlock(:final text) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: palette.dangerSoft,
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Text(
        text,
        style: TextStyle(color: palette.danger, fontSize: 14, height: 20 / 14),
      ),
    ),
    CompactBlock(:final text, :final compact) => CompactNotice(
      palette: palette,
      text: text,
      compact: compact,
    ),
    ModelBlock(:final model) => _Divider(
      palette: palette,
      label: t('chat.modelSwitched', vars: <String, Object?>{
        'model': model ?? t('chat.newModel'),
      }),
    ),
    DagBlock() => const SizedBox.shrink(),
  };
}

class _TurnMetaLine extends StatelessWidget {
  const _TurnMetaLine({required this.meta, required this.palette});

  final TurnMeta meta;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    final label = formatTurnMeta(meta);
    if (label.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text(
        label,
        style: TextStyle(
          color: palette.subtle,
          fontSize: 12,
          fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
        ),
      ),
    );
  }
}

/// A quiet rule with a label: a model switch, a DAG notice.
class _Divider extends StatelessWidget {
  const _Divider({required this.palette, required this.label});

  final Palette palette;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: <Widget>[
          Expanded(child: Container(height: 0.5, color: palette.border)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(
              label,
              style: TextStyle(
                color: palette.muted,
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          Expanded(child: Container(height: 0.5, color: palette.border)),
        ],
      ),
    );
  }
}

/// A compaction, drawn as its own notice: what happened, why, and the token delta.
class CompactNotice extends StatelessWidget {
  const CompactNotice({
    super.key,
    required this.palette,
    required this.text,
    this.compact,
  });

  final Palette palette;
  final String text;
  final CompactInfo? compact;

  @override
  Widget build(BuildContext context) {
    final status =
        compact?.status ?? (text.trim().isNotEmpty ? 'done' : 'running');
    final running = status == 'running';
    final label = switch (status) {
      'running' => t('chat.compacting', context: context),
      'aborted' => t('chat.compactCancelled', context: context),
      'error' => t('chat.compactFailed', context: context),
      _ => t('chat.compacted', context: context),
    };
    final reason = compact?.reason == 'threshold'
        ? t('chat.compactThreshold', context: context)
        : compact?.reason == 'overflow'
        ? t('chat.compactOverflow', context: context)
        : null;
    final before = compact?.tokensBefore;
    final after = compact?.tokensAfter;
    final tokens = before != null && after != null
        ? '${formatTokens(before)} → ${formatTokens(after)}'
        : before != null
        ? formatTokens(before)
        : null;
    final color = status == 'error'
        ? palette.danger
        : running
        ? palette.accent
        : palette.muted;
    final error = status == 'error' ? (compact?.error ?? text.trim()) : null;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: status == 'error'
            ? palette.dangerSoft
            : running
            ? palette.accentSoft
            : palette.field,
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              if (running)
                DesktopSpinner(size: 15, color: color)
              else
                HugeIcon(
                  icon: AppIcons.scissor,
                  size: 15,
                  color: color,
                  strokeWidth: 2,
                ),
              const SizedBox(width: 7),
              Text(
                label,
                style: TextStyle(
                  color: color,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (reason != null || tokens != null) ...<Widget>[
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    <String?>[reason, tokens].whereType<String>().join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: palette.muted, fontSize: 12),
                  ),
                ),
              ],
            ],
          ),
          if (error != null && error.isNotEmpty) ...<Widget>[
            const SizedBox(height: 3),
            Padding(
              padding: const EdgeInsets.only(left: 22),
              child: Text(
                error,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: palette.danger, fontSize: 13),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _AttachmentImage extends StatelessWidget {
  const _AttachmentImage({required this.url});
  final String url;

  /// A `data:` URL is never a valid widget key (it is megabytes long), so the
  /// key is a short fingerprint of it. Stable across rebuilds, which is what
  /// lets the image codec reuse the frame it already decoded instead of
  /// flashing a fresh one on every streamed token.
  String get _key {
    var hash = 0x811c9dc5;
    for (final unit in url.codeUnits) {
      hash = (hash ^ unit) * 0x01000193;
    }
    return '${url.length}:${hash & 0x7fffffff}';
  }

  @override
  Widget build(BuildContext context) {
    final fallback = Container(
      width: 160,
      height: 120,
      color: paletteOf(context).field,
      child: Center(
        child: HugeIcon(
          icon: AppIcons.imageAdd,
          color: paletteOf(context).muted,
        ),
      ),
    );
    final bytes = imageBytesOf(url);
    if (bytes != null) {
      return Image.memory(
        bytes,
        key: ValueKey<String>(_key),
        width: 160,
        height: 160,
        fit: BoxFit.cover,
        gaplessPlayback: true,
        errorBuilder: (_, _, _) => fallback,
      );
    }
    if (url.startsWith('data:')) return fallback;
    return Image.network(
      url,
      key: ValueKey<String>(url),
      width: 160,
      height: 160,
      fit: BoxFit.cover,
      gaplessPlayback: true,
      errorBuilder: (_, _, _) => fallback,
    );
  }
}
