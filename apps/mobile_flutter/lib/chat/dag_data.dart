import 'dart:async';

import 'package:flutter/foundation.dart';

import '../protocol/client.dart';
import '../session/connection.dart';

/// One node of a conversation's task graph.
class DagNode {
  const DagNode({
    required this.id,
    required this.title,
    this.profile = '',
    this.dependsOn = const <String>[],
    this.status = 'pending',
    this.parentId,
    this.parentRunId,
    this.coordinator = false,
    this.attempt,
    this.error,
    this.instruction,
    this.acceptance,
    this.report,
    this.model,
    this.outputLength,
    this.output,
    this.runId,
    this.createdAt = 0,
  });

  factory DagNode.fromJson(Map<String, Object?> json) => DagNode(
    id: '${json['id'] ?? ''}',
    title: '${json['title'] ?? ''}',
    profile: json['profile'] is Map
        ? '${(json['profile'] as Map)['name'] ?? ''}'
        : '${json['profile'] ?? ''}',
    dependsOn: json['dependsOn'] is List
        ? (json['dependsOn'] as List).whereType<String>().toList()
        : const <String>[],
    status: '${json['status'] ?? 'pending'}',
    parentId: json['parentId'] is String ? json['parentId'] as String : null,
    parentRunId: json['parentRunId'] is String
        ? json['parentRunId'] as String
        : null,
    coordinator: json['coordinator'] == true,
    attempt: json['attempt'] is num ? (json['attempt'] as num).toInt() : null,
    error: json['error'] is String ? json['error'] as String : null,
    instruction: json['instruction'] is String
        ? json['instruction'] as String
        : null,
    acceptance: json['acceptance'] is String
        ? json['acceptance'] as String
        : null,
    report: json['report'] is Map
        ? DagReport.fromJson((json['report'] as Map).cast<String, Object?>())
        : null,
    model: json['model'] is String ? json['model'] as String : null,
    output: json['output'] is String ? json['output'] as String : null,
    outputLength: json['outputLength'] is num
        ? (json['outputLength'] as num).toInt()
        : null,
    runId: json['runId'] is String ? json['runId'] as String : null,
    createdAt: json['createdAt'] is num
        ? (json['createdAt'] as num).toInt()
        : 0,
  );

  final String id;
  final String title;
  final String profile;
  final List<String> dependsOn;
  final String status;
  final String? parentId;
  final String? parentRunId;
  final bool coordinator;
  final int? attempt;
  final String? error;
  final String? instruction;
  final String? acceptance;
  final DagReport? report;
  final String? model;
  final int? outputLength;
  final String? output;
  final String? runId;
  final int createdAt;

  DagNode copyWith({String? status}) => DagNode(
    id: id,
    title: title,
    profile: profile,
    dependsOn: dependsOn,
    status: status ?? this.status,
    parentId: parentId,
    parentRunId: parentRunId,
    coordinator: coordinator,
    attempt: attempt,
    error: error,
    instruction: instruction,
    acceptance: acceptance,
    report: report,
    model: model,
    outputLength: outputLength,
    output: output,
    runId: runId,
    createdAt: createdAt,
  );
}

class DagReport {
  const DagReport({
    this.summary,
    this.evidence = const <String>[],
    this.artifacts = const <String>[],
  });

  factory DagReport.fromJson(Map<String, Object?> json) => DagReport(
    summary: json['summary'] is String ? json['summary'] as String : null,
    evidence: json['evidence'] is List
        ? (json['evidence'] as List).whereType<String>().toList()
        : const <String>[],
    artifacts: json['artifacts'] is List
        ? (json['artifacts'] as List).whereType<String>().toList()
        : const <String>[],
  );

  final String? summary;
  final List<String> evidence;
  final List<String> artifacts;
}

class DagGraph {
  const DagGraph({
    required this.conversationId,
    required this.nodes,
    this.revision = 0,
    this.paused = false,
  });

  final String conversationId;
  final List<DagNode> nodes;
  final int revision;
  final bool paused;
}

/// The preview bound: a node whose full output is longer offers 「读取完整结果」.
const int dagPreviewChars = 4000;

const List<String> dagNodeStatuses = <String>[
  'pending',
  'running',
  'completed',
  'blocked',
  'failed',
  'skipped',
  'cancelled',
];

bool dagNodeFinished(DagNode node) =>
    node.status == 'completed' ||
    node.status == 'blocked' ||
    node.status == 'failed' ||
    node.status == 'skipped' ||
    node.status == 'cancelled';

({int total, int completed, int active, int attention}) dagProgress(
  List<DagNode> nodes,
) {
  var completed = 0;
  var active = 0;
  var attention = 0;
  for (final node in nodes) {
    if (node.status == 'completed') completed++;
    if (!dagNodeFinished(node)) active++;
    if (node.status == 'failed' || node.status == 'blocked') attention++;
  }
  return (
    total: nodes.length,
    completed: completed,
    active: active,
    attention: attention,
  );
}

/// running | stopped | failed | completed
String dagGraphState(List<DagNode> nodes) {
  if (nodes.any((node) => node.status == 'running')) return 'running';
  if (nodes.any((node) => node.status == 'cancelled')) return 'stopped';
  if (nodes.any(
    (node) => node.status == 'failed' || node.status == 'blocked',
  )) {
    return 'failed';
  }
  if (nodes.any((node) => node.status == 'pending')) return 'running';
  return 'completed';
}

/// The execution pane's status: the same vocabulary a delegated run uses.
String dagRunStatus(DagNode node) => switch (node.status) {
  'running' => 'running',
  'completed' => 'completed',
  'failed' || 'blocked' => 'error',
  _ => 'aborted',
};

bool dagCanRetry(DagNode node, List<DagNode> nodes) {
  if (node.parentId == null) return true;
  DagNode? parent;
  for (final candidate in nodes) {
    if (candidate.id == node.parentId) {
      parent = candidate;
      break;
    }
  }
  if (parent == null) return true;
  if (parent.status != 'running') return false;
  return node.parentRunId == null || node.parentRunId == parent.runId;
}

class DagRow {
  const DagRow({
    required this.node,
    required this.depth,
    required this.previousAttempt,
  });

  final DagNode node;
  final int depth;

  /// This node is an earlier attempt of a task that was retried.
  final bool previousAttempt;

  double get indent => 12 + (depth > 3 ? 3 : depth) * 14;
}

/// The graph, flattened in the order the panel draws it: a task's children under it, and
/// anything that needs attention first at each level.
List<DagRow> dagTaskRows(List<DagNode> nodes) {
  const priority = <String, int>{
    'blocked': 0,
    'failed': 1,
    'running': 2,
    'pending': 3,
    'cancelled': 4,
    'skipped': 5,
    'completed': 6,
  };
  final byParent = <String, List<DagNode>>{};
  for (final node in nodes) {
    final parent = node.parentId ?? '';
    byParent.putIfAbsent(parent, () => <DagNode>[]).add(node);
  }
  for (final list in byParent.values) {
    list.sort((a, b) {
      final byStatus = (priority[a.status] ?? 9).compareTo(
        priority[b.status] ?? 9,
      );
      if (byStatus != 0) return byStatus;
      final byCreated = a.createdAt.compareTo(b.createdAt);
      return byCreated != 0 ? byCreated : a.id.compareTo(b.id);
    });
  }
  final rows = <DagRow>[];
  void walk(String parent, int depth) {
    for (final node in byParent[parent] ?? const <DagNode>[]) {
      rows.add(DagRow(node: node, depth: depth, previousAttempt: false));
      walk(node.id, depth + 1);
    }
  }

  walk('', 0);
  return rows;
}

/// The node a `dag_*` tool call was working on, from its arguments.
String? dagToolNodeId(Object? args) {
  if (args is Map && args['id'] is String) return args['id'] as String;
  return null;
}

/// Watches one conversation's graph.
///
/// Rules that keep the panel honest:
///
/// - **A revision gate.** A `dag_changed` push and a `dag:list` reply race each other
///   constantly; a graph whose `revision` is older than what is on screen is dropped, and
///   a deletion (`graph == null`) beats a concurrent list reply that still has the graph.
/// - **No `conversations.open`.** Reading a task graph must never move the engine's active
///   conversation — every desktop window follows that, and the phone reads chat by name.
/// - **Refresh on every replacement connection.** The journal may have a gap, and a
///   conversation snapshot does not contain its task graph. Replies from retired reads
///   or reads overtaken by a graph push cannot overwrite the current graph.
class DagWatcher extends ChangeNotifier {
  DagWatcher(this.conversationId) {
    _listener = _onEvent;
    Connection.instance.onEngineEvent(_listener!);
    Connection.instance.addListener(_connectionChanged);
    _connectionChanged();
  }

  final String conversationId;
  void Function(Map<String, Object?> event, Object? meta)? _listener;
  DagGraph? _graph;
  bool _deleted = false;
  int _revision = -1;
  bool _busy = false;
  bool _disposed = false;
  RemoteClient? _remote;
  String? _serverId;
  int _refreshGeneration = 0;
  int _eventGeneration = 0;

  DagGraph? get graph => _graph;

  bool get busy => _busy;

  bool get deleted => _deleted;

  void _connectionChanged() {
    if (_disposed) return;
    final connection = Connection.instance;
    _serverId ??= connection.server?.id;
    final next = connection.server?.id == _serverId ? connection.client : null;
    if (identical(_remote, next)) return;
    _remote = next;
    _refreshGeneration++;
    // Retain the last graph on screen, but the next connection establishes its own
    // revision baseline (the host may have restarted or restored older state).
    _revision = -1;
    if (next != null) unawaited(refresh());
  }

  void _onEvent(Map<String, Object?> event, Object? meta) {
    if (_disposed ||
        _remote == null ||
        !identical(_remote, Connection.instance.client) ||
        event['conversationId'] != conversationId ||
        event['type'] != 'dag_changed') {
      return;
    }
    final raw = event['graph'];
    if (raw == null) {
      // A deletion beats a concurrent list reply.
      _eventGeneration++;
      _deleted = true;
      _graph = null;
      _revision = -1;
      notifyListeners();
      return;
    }
    final next = _parseGraph(raw);
    if (next == null) return;
    _eventGeneration++;
    _accept(next);
  }

  Future<void> refresh() async {
    final remote = _remote;
    if (remote == null || _disposed) return;
    final generation = ++_refreshGeneration;
    final eventGeneration = _eventGeneration;
    try {
      final result = await remote.call('dag:list');
      if (_disposed ||
          generation != _refreshGeneration ||
          !identical(remote, Connection.instance.client) ||
          eventGeneration != _eventGeneration ||
          result is! List) {
        return;
      }
      for (final item in result) {
        final next = _parseGraph(item);
        if (next != null && next.conversationId == conversationId) {
          _accept(next);
          return;
        }
      }
      // The graph is gone from the machine's list: a tombstone that a push may not have
      // delivered.
      if (_graph != null) {
        _graph = null;
        _deleted = true;
        _revision = -1;
        notifyListeners();
      }
    } catch (_) {
      // A failed read leaves the last graph; the next push or refresh corrects it.
    }
  }

  void _accept(DagGraph next) {
    if (next.revision < _revision) return;
    _revision = next.revision;
    _graph = next;
    _deleted = false;
    notifyListeners();
  }

  DagGraph? _parseGraph(Object? value) {
    if (value is! Map) return null;
    final map = value.cast<String, Object?>();
    final id = map['conversationId'];
    final nodes = map['nodes'];
    if (id is! String || nodes is! List) return null;
    final parsed = <DagNode>[];
    for (final node in nodes) {
      if (node is! Map) return null;
      final record = node.cast<String, Object?>();
      if (record['id'] is! String || record['title'] is! String) return null;
      parsed.add(DagNode.fromJson(record));
    }
    return DagGraph(
      conversationId: id,
      nodes: parsed,
      revision: map['revision'] is num ? (map['revision'] as num).toInt() : 0,
      paused: map['paused'] == true,
    );
  }

  void setBusy(bool value) {
    if (_busy == value) return;
    _busy = value;
    notifyListeners();
  }

  /// Opens the panel for this graph. Replaced by the screen, which owns the sheet.
  void Function(String? nodeId)? open;

  @override
  void dispose() {
    _disposed = true;
    Connection.instance.removeListener(_connectionChanged);
    if (_listener != null) Connection.instance.offEngineEvent(_listener!);
    super.dispose();
  }
}
