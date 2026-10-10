import 'dart:convert';

/// Current-run diagnostics only: never record tokens, URLs, passwords, or RPC payloads.
class Diagnostic {
  Diagnostic({
    required this.event,
    this.serverId,
    this.attempt,
    this.elapsedMs,
    this.appState,
    this.networkType,
    this.connected,
    this.detailKind,
    this.detailCode,
    this.failure,
    this.metric,
    this.frameChars,
    this.outcome,
    this.name,
    this.parseMs,
  }) : at = DateTime.now().toUtc().toIso8601String();

  factory Diagnostic.metric(
    String metric, {
    int? elapsedMs,
    int? frameChars,
    String? outcome,
    String? name,
    int? parseMs,
  }) =>
      Diagnostic(
        event: 'metric',
        metric: metric,
        elapsedMs: elapsedMs,
        frameChars: frameChars,
        outcome: outcome,
        name: name,
        parseMs: parseMs,
      );

  final String event;
  final String? serverId;
  final int? attempt;
  final int? elapsedMs;
  final String? appState;
  final String? networkType;
  final bool? connected;
  final String? detailKind;
  final int? detailCode;
  final String? failure;
  final String? metric;
  final int? frameChars;
  final String? outcome;

  /// Which call or phase a sample is of (a method name, never its payload).
  final String? name;

  /// How long decoding the reply's JSON took, for a reply large enough to matter.
  final int? parseMs;
  final String at;

  Map<String, Object?> toJson() => <String, Object?>{
        'event': event,
        'at': at,
        if (serverId != null) 'serverId': serverId,
        if (attempt != null) 'attempt': attempt,
        if (elapsedMs != null) 'elapsedMs': elapsedMs,
        if (appState != null) 'appState': appState,
        if (networkType != null) 'networkType': networkType,
        if (connected != null) 'connected': connected,
        if (detailKind != null) 'detail': <String, Object?>{
          'kind': detailKind,
          if (detailCode != null) 'code': detailCode,
        },
        if (failure != null) 'failure': failure,
        if (metric != null) 'metric': metric,
        if (frameChars != null) 'frameChars': frameChars,
        if (outcome != null) 'outcome': outcome,
        if (name != null) 'name': name,
        if (parseMs != null) 'parseMs': parseMs,
      };
}

final List<Diagnostic> _entries = <Diagnostic>[];
final Map<String, List<Diagnostic>> _metrics = <String, List<Diagnostic>>{};

const int _maxEntries = 100;
const int _maxMetricSamples = 32;

/// `--dart-define=FASTVIBE_TRACE=true` also writes every sample to the device log as it is
/// taken, for measuring a build on a real network. Off in a shipped build.
const bool _trace = bool.fromEnvironment('FASTVIBE_TRACE');

void recordConnectionDiagnostic(Diagnostic entry) {
  // ignore: avoid_print
  if (_trace) print('FVTRACE ${jsonEncode(entry.toJson())}');
  if (entry.event == 'metric' && entry.metric != null) {
    final recent = _metrics.putIfAbsent(entry.metric!, () => <Diagnostic>[]);
    recent.add(entry);
    if (recent.length > _maxMetricSamples) recent.removeAt(0);
    return; // Frequent RPC samples must not evict disconnects and network changes.
  }
  _entries.add(entry);
  if (_entries.length > _maxEntries) _entries.removeAt(0);
}

int _percentile(List<int> sorted, double fraction) => sorted[(sorted.length * fraction).ceil() - 1];

/// The JSON the 设置 → 复制连接诊断 button puts on the clipboard.
String connectionDiagnostics(String version) {
  final timings = <String, Object?>{};
  for (final entry in _metrics.entries) {
    final durations = entry.value.map((sample) => sample.elapsedMs).whereType<int>().toList()..sort();
    timings[entry.key] = <String, Object?>{
      'samples': entry.value.map((sample) => sample.toJson()).toList(),
      if (durations.isNotEmpty) 'p50Ms': _percentile(durations, 0.5),
      if (durations.isNotEmpty) 'p95Ms': _percentile(durations, 0.95),
    };
  }
  return const JsonEncoder.withIndent('  ').convert(<String, Object?>{
    'version': version,
    'entries': _entries.map((entry) => entry.toJson()).toList(),
    'timings': timings,
  });
}
