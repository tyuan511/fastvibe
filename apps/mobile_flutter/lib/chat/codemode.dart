/// What the phone shows of a `codemode` call.
///
/// `codemode` takes one argument, `code` — JavaScript, not JSON. The tools the script ran
/// arrive in the result's `details.calls`, and each streaming update carries the same list
/// in the update's `partialResult.details` rather than on the event itself.
library;

class CodemodeCall {
  const CodemodeCall({
    required this.id,
    required this.name,
    this.args = '',
    this.status = 'running',
    this.durationMs,
    this.error,
  });

  final String id;
  final String name;

  /// Compact JSON of the arguments, already truncated by the engine.
  final String args;

  /// running | ok | error | cancelled
  final String status;
  final int? durationMs;
  final String? error;
}

final RegExp _optionsLine = RegExp(r'^\s*//\s*@options\s*:');
const Set<String> _statuses = <String>{'running', 'ok', 'error', 'cancelled'};

Map<String, Object?>? _asRecord(Object? value) =>
    value is Map && value is! List ? value.cast<String, Object?>() : null;

String codemodeCode(Object? args) {
  if (args is String) return args;
  final code = _asRecord(args)?['code'];
  return code is String ? code : '';
}

/// The script without its `// @options:` line, which is settings and not code.
String codemodeBody(String code) {
  final lines = code.split('\n');
  if (lines.isEmpty) return code;
  if (_optionsLine.hasMatch(lines.first)) {
    return lines.sublist(1).join('\n').replaceFirst(RegExp(r'^\n+'), '');
  }
  return code;
}

/// One line saying what the script is for: the model's leading comment, else its first
/// line of code.
String codemodeSummary(String code, [int limit = 100]) {
  final lines = codemodeBody(code).split('\n').map((line) => line.trim()).where((line) => line.isNotEmpty).toList();
  String? comment;
  for (final line in lines) {
    if (line.startsWith('//')) {
      comment = line;
      break;
    }
  }
  final line = comment != null ? comment.replaceFirst(RegExp(r'^//+\s*'), '') : (lines.isEmpty ? '' : lines.first);
  return line.length > limit ? '${line.substring(0, limit)}…' : line;
}

/// The calls a script made so far, from a result's or an update's `details`.
List<CodemodeCall> codemodeCalls(Object? details) {
  final list = _asRecord(details)?['calls'];
  if (list is! List) return <CodemodeCall>[];
  final calls = <CodemodeCall>[];
  for (final item in list) {
    final record = _asRecord(item);
    if (record == null) continue;
    final id = record['id'];
    final name = record['name'];
    if (id is! String || name is! String) continue;
    final status = record['status'];
    final duration = record['durationMs'];
    final error = record['error'];
    calls.add(CodemodeCall(
      id: id,
      name: name,
      args: record['args'] is String ? record['args'] as String : '',
      status: status is String && _statuses.contains(status) ? status : 'running',
      durationMs: duration is num ? duration.toInt() : null,
      error: error is String && error.isNotEmpty ? error : null,
    ));
  }
  return calls;
}

/// How many of the calls failed or were cut short.
int codemodeFailures(List<CodemodeCall> calls) =>
    calls.where((call) => call.status == 'error' || call.status == 'cancelled').length;

/// A duration for a row: 「120 ms」 below a second, 「1.5 s」 above.
String formatCallDuration(int? ms) {
  if (ms == null || ms < 0) return '';
  return ms < 1000 ? '$ms ms' : '${(ms / 1000).toStringAsFixed(1)} s';
}
