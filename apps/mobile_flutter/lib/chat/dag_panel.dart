import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../session/connection.dart';
import '../theme/theme.dart';
import '../ui/feedback.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/sheet.dart';
import 'run_transcript.dart';
import '../ui/preferences.dart';
import 'dag_data.dart';

/// The one-line summary above the composer, and the sheet it opens.
///
/// The summary is drawn only when there is a graph: a conversation that never delegated
/// anything has nothing to say here, and a permanent row would be furniture.
class MobileDagSummary extends StatelessWidget {
  const MobileDagSummary({super.key, required this.watcher});

  final DagWatcher watcher;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: watcher,
      builder: (context, _) {
        final graph = watcher.graph;
        if (graph == null || graph.nodes.isEmpty) {
          return const SizedBox.shrink();
        }
        final palette = paletteOf(context);
        final progress = dagProgress(graph.nodes);
        final connected = Connection.instance.status == ConnectionStatus.ready;
        return Material(
          color: palette.card,
          child: InkWell(
            onTap: () {
              Haptic.tap();
              showDagSheet(context, watcher);
            },
            child: Container(
              constraints: const BoxConstraints(minHeight: 44),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              decoration: BoxDecoration(
                border: Border(
                  bottom: BorderSide(color: palette.separator, width: 0.5),
                ),
              ),
              child: Row(
                children: <Widget>[
                  if (progress.active > 0)
                    DesktopSpinner(size: 15, color: palette.accent)
                  else
                    HugeIcon(
                      icon: AppIcons.bot,
                      size: 17,
                      color: palette.muted,
                    ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${t('dag.title')} · ${t('dag.progress', <String, Object?>{'done': progress.completed, 'total': progress.total})}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: palette.text,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Text(
                    !connected
                        ? t('dag.offline')
                        : progress.attention > 0
                        ? t('dag.attention', <String, Object?>{
                            'count': progress.attention,
                          })
                        : '',
                    style: TextStyle(
                      color: progress.attention > 0
                          ? palette.warning
                          : palette.muted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 6),
                  HugeIcon(
                    icon: AppIcons.arrowRight,
                    size: 15,
                    color: palette.subtle,
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

Future<void> showDagSheet(BuildContext context, DagWatcher watcher) {
  return showAppSheet<void>(
    context: context,
    expanded: true,
    builder: (sheetContext) => _DagSheet(watcher: watcher),
  );
}

class _DagSheet extends StatefulWidget {
  const _DagSheet({required this.watcher});

  final DagWatcher watcher;

  @override
  State<_DagSheet> createState() => _DagSheetState();
}

class _DagSheetState extends State<_DagSheet> {
  String? _selected;
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.watcher,
      builder: (context, _) {
        final graph = widget.watcher.graph;
        final nodes = graph?.nodes ?? const <DagNode>[];
        DagNode? selected;
        for (final node in nodes) {
          if (node.id == _selected) {
            selected = node;
            break;
          }
        }
        final progress = dagProgress(nodes);
        return Container(
          decoration: BoxDecoration(color: Colors.transparent),
          child: SafeArea(
            top: false,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                AppSheetHeader(
                  title: selected != null
                      ? '${selected.id} · ${selected.title}'
                      : t('dag.title'),
                  subtitle: selected != null
                      ? selected.profile
                      : t('dag.progress', {
                          'done': progress.completed,
                          'total': progress.total,
                        }),
                  onBack: selected == null
                      ? null
                      : () => setState(() => _selected = null),
                ),
                Expanded(
                  child: selected != null
                      ? _NodeDetail(
                          key: ValueKey(selected.id),
                          node: selected,
                          nodes: nodes,
                          conversationId: widget.watcher.conversationId,
                          busy: _busy,
                          onBusy: (value) {
                            if (mounted) setState(() => _busy = value);
                          },
                          onSelect: (id) => setState(() => _selected = id),
                        )
                      : _NodeList(
                          nodes: nodes,
                          progress: progress,
                          graphState: graph == null
                              ? 'completed'
                              : dagGraphState(nodes),
                          conversationId: widget.watcher.conversationId,
                          busy: _busy,
                          onBusy: (value) {
                            if (mounted) setState(() => _busy = value);
                          },
                          onSelect: (id) => setState(() => _selected = id),
                          onRefresh: () => widget.watcher.refresh(),
                        ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _NodeList extends StatelessWidget {
  const _NodeList({
    required this.nodes,
    required this.progress,
    required this.graphState,
    required this.conversationId,
    required this.busy,
    required this.onBusy,
    required this.onSelect,
    required this.onRefresh,
  });

  final List<DagNode> nodes;
  final ({int total, int completed, int active, int attention}) progress;
  final String graphState;
  final String conversationId;
  final bool busy;
  final ValueChanged<bool> onBusy;
  final ValueChanged<String> onSelect;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final rows = dagTaskRows(nodes);
    final disabled =
        busy || Connection.instance.status != ConnectionStatus.ready;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
      children: <Widget>[
        if (progress.attention > 0)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Text(
              t('dag.attention', <String, Object?>{
                'count': progress.attention,
              }),
              style: TextStyle(
                color: palette.warning,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        Row(
          children: <Widget>[
            if (progress.active > 0)
              _Action(
                label: t('dag.cancelAll'),
                palette: palette,
                disabled: disabled,
                onTap: () => _run(context, 'dag:cancel', <String, Object?>{
                  'conversationId': conversationId,
                }),
              ),
            if (graphState == 'stopped')
              _Action(
                label: t('dag.resume'),
                palette: palette,
                disabled: disabled,
                onTap: () => _run(context, 'dag:resume', <String, Object?>{
                  'conversationId': conversationId,
                }),
              ),
          ],
        ),
        for (final row in rows)
          Padding(
            padding: EdgeInsets.fromLTRB(row.indent, 4, 0, 0),
            child: Material(
              color: palette.background,
              borderRadius: BorderRadius.circular(Radii.md),
              child: InkWell(
                onTap: () {
                  Haptic.tap();
                  onSelect(row.node.id);
                },
                borderRadius: BorderRadius.circular(Radii.md),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Text(
                            row.node.id,
                            style: TextStyle(
                              color: palette.muted,
                              fontSize: 11,
                              fontFamily: 'monospace',
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            dagStatusLabel(row.node.status),
                            style: TextStyle(
                              color: dagStatusColor(row.node.status, palette),
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        row.node.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: palette.text,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        row.previousAttempt
                            ? t('dag.previousAttempt')
                            : row.node.coordinator
                            ? t('dag.coordinator')
                            : row.node.profile,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: palette.muted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  Future<void> _run(
    BuildContext context,
    String method,
    Map<String, Object?> payload,
  ) async {
    final remote = Connection.instance.client;
    if (remote == null) return;
    onBusy(true);
    try {
      await remote.call(method, payload);
      onRefresh();
    } catch (error) {
      toastFailure(error, t('dag.actionFailed'));
    } finally {
      onBusy(false);
    }
  }
}

class _NodeDetail extends StatefulWidget {
  const _NodeDetail({
    super.key,
    required this.node,
    required this.nodes,
    required this.conversationId,
    required this.busy,
    required this.onBusy,
    required this.onSelect,
  });

  final DagNode node;
  final List<DagNode> nodes;
  final String conversationId;
  final bool busy;
  final ValueChanged<bool> onBusy;
  final ValueChanged<String> onSelect;

  @override
  State<_NodeDetail> createState() => _NodeDetailState();
}

class _NodeDetailState extends State<_NodeDetail> {
  String? _output;
  int _offset = 0;
  int _total = 0;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final node = widget.node;
    final disabled =
        widget.busy || Connection.instance.status != ConnectionStatus.ready;
    final children = <String>[
      for (final candidate in widget.nodes)
        if (candidate.parentId == node.id) candidate.id,
    ];
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
      children: <Widget>[
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            if (node.runId != null)
              _Action(
                label: t('dag.execution'),
                palette: palette,
                disabled: disabled,
                onTap: () => showAppSheet<void>(
                  context: context,
                  expanded: true,
                  builder: (_) => RunTranscript(
                    conversationId: widget.conversationId,
                    runId: node.runId!,
                  ),
                ),
              ),
            if (node.coordinator)
              _Tag(label: t('dag.coordinator'), palette: palette),
            if (node.attempt != null)
              _Tag(
                label: t('dag.attempt', <String, Object?>{
                  'count': node.attempt,
                }),
                palette: palette,
              ),
            if (!dagNodeFinished(node))
              _Action(
                label: t('dag.stop'),
                palette: palette,
                disabled: disabled,
                onTap: () => _run('dag:cancel', <String, Object?>{
                  'conversationId': widget.conversationId,
                  'ids': <String>[node.id],
                }),
              ),
            if ((node.status == 'blocked' ||
                    node.status == 'failed' ||
                    node.status == 'cancelled') &&
                dagCanRetry(node, widget.nodes))
              _Action(
                label: t('dag.retry'),
                palette: palette,
                disabled: disabled,
                onTap: () => _run('dag:retry', <String, Object?>{
                  'conversationId': widget.conversationId,
                  'id': node.id,
                }),
              ),
          ],
        ),
        if (node.error != null) ...<Widget>[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: palette.dangerSoft,
              borderRadius: BorderRadius.circular(Radii.md),
            ),
            child: Text(
              node.error!,
              style: TextStyle(
                color: palette.danger,
                fontSize: 13,
                height: 19 / 13,
              ),
            ),
          ),
        ],
        if (node.parentId != null ||
            node.dependsOn.isNotEmpty ||
            children.isNotEmpty) ...<Widget>[
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              if (node.parentId != null)
                _Link(
                  label: '${t('dag.parent')} ${node.parentId}',
                  palette: palette,
                  onTap: () => widget.onSelect(node.parentId!),
                ),
              for (final dependency in node.dependsOn)
                _Link(
                  label: '${t('dag.dependencies')} $dependency',
                  palette: palette,
                  onTap: () => widget.onSelect(dependency),
                ),
              for (final child in children)
                _Link(
                  label: '${t('dag.children')} $child',
                  palette: palette,
                  onTap: () => widget.onSelect(child),
                ),
            ],
          ),
        ],
        if (node.instruction != null)
          _Section(
            title: t('dag.instruction'),
            body: node.instruction!,
            palette: palette,
          ),
        if (node.acceptance != null)
          _Section(
            title: t('dag.acceptance'),
            body: node.acceptance!,
            palette: palette,
          ),
        if (node.report?.summary != null)
          _Section(
            title: t('dag.conclusion'),
            body: node.report!.summary!,
            palette: palette,
          ),
        if (node.report?.evidence.isNotEmpty == true)
          _Section(
            title: t('dag.evidence'),
            body: node.report!.evidence.join('\n\n'),
            palette: palette,
          ),
        if (node.report?.artifacts.isNotEmpty == true)
          _Section(
            title: t('dag.artifacts'),
            body: node.report!.artifacts.join('\n'),
            palette: palette,
          ),
        if (node.model != null)
          _Section(title: t('dag.model'), body: node.model!, palette: palette),
        if (_output != null || node.output != null)
          _Section(
            title: t('dag.output'),
            body: _output ?? node.output!,
            palette: palette,
          ),
        const SizedBox(height: 14),
        if (_output == null &&
            ((node.outputLength ?? 0) > dagPreviewChars ||
                dagNodeFinished(node)))
          _Action(
            label: t('dag.readFull'),
            palette: palette,
            disabled: disabled,
            onTap: _readOutput,
          )
        else if (_output != null && _offset < _total)
          _Action(
            label: t('dag.readMore'),
            palette: palette,
            disabled: disabled,
            onTap: _readOutput,
          ),
      ],
    );
  }

  Future<void> _readOutput() async {
    final remote = Connection.instance.client;
    if (remote == null) return;
    widget.onBusy(true);
    try {
      final page = await remote.call('dag:output', <String, Object?>{
        'conversationId': widget.conversationId,
        'id': widget.node.id,
        'offset': _offset,
      });
      if (!mounted || page is! Map) return;
      setState(() {
        _output = '${_output ?? ''}${page['output'] ?? ''}';
        _total = page['totalChars'] is num
            ? (page['totalChars'] as num).toInt()
            : 0;
        _offset = page['nextOffset'] is num
            ? (page['nextOffset'] as num).toInt()
            : _total;
      });
    } catch (error) {
      toastFailure(error, t('dag.actionFailed'));
    } finally {
      widget.onBusy(false);
    }
  }

  Future<void> _run(String method, Map<String, Object?> payload) async {
    final remote = Connection.instance.client;
    if (remote == null) return;
    widget.onBusy(true);
    try {
      await remote.call(method, payload);
    } catch (error) {
      toastFailure(error, t('dag.actionFailed'));
    } finally {
      widget.onBusy(false);
    }
  }
}

class _Section extends StatelessWidget {
  const _Section({
    required this.title,
    required this.body,
    required this.palette,
  });

  final String title;
  final String body;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            title,
            style: TextStyle(
              color: palette.muted,
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.3,
            ),
          ),
          const SizedBox(height: 4),
          SelectableText(
            body,
            style: TextStyle(
              color: palette.text,
              fontSize: 14,
              height: 21 / 14,
            ),
          ),
        ],
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag({required this.label, required this.palette});

  final String label;
  final Palette palette;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
    decoration: BoxDecoration(
      color: palette.field,
      borderRadius: BorderRadius.circular(Radii.pill),
    ),
    child: Text(
      label,
      style: TextStyle(
        color: palette.muted,
        fontSize: 12,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

class _Link extends StatelessWidget {
  const _Link({
    required this.label,
    required this.palette,
    required this.onTap,
  });

  final String label;
  final Palette palette;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
    onTap: onTap,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: palette.accentSoft,
        borderRadius: BorderRadius.circular(Radii.pill),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: palette.accent,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    ),
  );
}

class _Action extends StatelessWidget {
  const _Action({
    required this.label,
    required this.palette,
    required this.disabled,
    required this.onTap,
  });

  final String label;
  final Palette palette;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: disabled ? 0.5 : 1,
    child: GestureDetector(
      onTap: disabled ? null : onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: palette.accentSoft,
          borderRadius: BorderRadius.circular(Radii.pill),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: palette.accent,
            fontSize: 13,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    ),
  );
}

String dagStatusLabel(String status) => switch (status) {
  'pending' => t('dag.status.pending'),
  'running' => t('dag.status.running'),
  'completed' => t('dag.status.completed'),
  'blocked' => t('dag.status.blocked'),
  'failed' => t('dag.status.failed'),
  'skipped' => t('dag.status.skipped'),
  'cancelled' => t('dag.status.cancelled'),
  _ => status,
};

Color dagStatusColor(String status, Palette palette) => switch (status) {
  'running' => palette.accent,
  'completed' => palette.success,
  'blocked' => palette.warning,
  'failed' => palette.danger,
  _ => palette.muted,
};
