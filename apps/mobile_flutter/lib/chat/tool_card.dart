import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import 'codemode.dart';
import 'message.dart';

/// Mobile keeps each tool call to one compact transcript row.
///
/// The desktop has room for a disclosure panel with parameters, output and diffs. On a
/// phone those bodies make a reply jump several screens and bury the answer, so the
/// mobile row answers only the useful question — what is the agent doing, and what is it
/// doing it to?
enum ToolFamily {
  read,
  edit,
  write,
  delete,
  search,
  web,
  list,
  terminal,
  skill,
  agent,
  todo,
  question,
  mcp,
  codemode,
  browser,
  other,
}

/// The title pair for each family: [done, running].
const Map<ToolFamily, (String, String)> _labels =
    <ToolFamily, (String, String)>{
      ToolFamily.read: ('tool.read', 'tool.readRunning'),
      ToolFamily.edit: ('tool.edit', 'tool.editRunning'),
      ToolFamily.write: ('tool.write', 'tool.writeRunning'),
      ToolFamily.delete: ('tool.delete', 'tool.deleteRunning'),
      ToolFamily.search: ('tool.search', 'tool.searchRunning'),
      ToolFamily.web: ('tool.web', 'tool.webRunning'),
      ToolFamily.list: ('tool.list', 'tool.listRunning'),
      ToolFamily.terminal: ('tool.terminal', 'tool.terminalRunning'),
      ToolFamily.skill: ('tool.skill', 'tool.skillRunning'),
      ToolFamily.agent: ('tool.agent', 'tool.agentRunning'),
      ToolFamily.todo: ('tool.todo', 'tool.todoRunning'),
      ToolFamily.question: ('tool.question', 'tool.questionRunning'),
      ToolFamily.mcp: ('tool.mcp', 'tool.mcpRunning'),
      ToolFamily.codemode: ('tool.codemode', 'tool.codemodeRunning'),
      ToolFamily.browser: ('tool.browser', 'tool.browserRunning'),
      ToolFamily.other: ('tool.other', 'tool.otherRunning'),
    };

const Map<ToolFamily, List<List<dynamic>>> _icons =
    <ToolFamily, List<List<dynamic>>>{
      ToolFamily.read: AppIcons.fileText,
      ToolFamily.edit: AppIcons.fileEdit,
      ToolFamily.write: AppIcons.filePlus,
      ToolFamily.delete: AppIcons.fileMinus,
      ToolFamily.search: AppIcons.search,
      ToolFamily.web: AppIcons.search,
      ToolFamily.list: AppIcons.folderTree,
      ToolFamily.terminal: AppIcons.terminal,
      ToolFamily.skill: AppIcons.sparkles,
      ToolFamily.agent: AppIcons.bot,
      ToolFamily.todo: AppIcons.listChecks,
      ToolFamily.question: AppIcons.messageQuestion,
      ToolFamily.mcp: AppIcons.plug,
      ToolFamily.codemode: AppIcons.code,
      ToolFamily.browser: AppIcons.chrome,
      ToolFamily.other: AppIcons.wrench,
    };

const List<String> _fileKeys = <String>[
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'target_file',
  'target',
];
const List<String> _searchKeys = <String>[
  'search_query',
  'searchQuery',
  'query',
  'pattern',
  'regex',
  'path',
  'url',
  'prompt',
  'target',
  'name',
];
const List<String> _commandKeys = <String>[
  'command',
  'cmd',
  'script',
  'parsed_cmd',
];

const Map<String, String> _dagToolLabels = <String, String>{
  'dag_add_tasks': 'dag.tool.add',
  'dag_status': 'dag.tool.status',
  'dag_result': 'dag.tool.result',
  'dag_wait': 'dag.tool.wait',
  'dag_cancel': 'dag.tool.cancel',
  'dag_resume': 'dag.tool.resume',
  'dag_retry': 'dag.tool.retry',
  'dag_update': 'dag.tool.update',
  'dag_send': 'dag.tool.send',
  'dag_report': 'dag.tool.report',
};

ToolFamily familyOf(String name) {
  final key = name.trim().toLowerCase();
  if (key.isEmpty) return ToolFamily.other;
  if (key.startsWith('dag_')) return ToolFamily.agent;
  if (key == 'codemode') return ToolFamily.codemode;
  if (key.startsWith('mcp') || key.contains('__')) return ToolFamily.mcp;
  if (key.startsWith('browser_')) return ToolFamily.browser;
  if (RegExp(r'^(read|read_file|readfile|view|cat)$').hasMatch(key)) {
    return ToolFamily.read;
  }
  if (RegExp(
    r'^(edit|edit_file|editfile|apply_patch|applypatch|patch|str_replace|strreplace)$',
  ).hasMatch(key)) {
    return ToolFamily.edit;
  }
  if (RegExp(r'^(write|write_file|writefile|create_file|createfile|create)$')
      .hasMatch(key)) {
    return ToolFamily.write;
  }
  if (RegExp(r'^(delete|delete_file|remove|remove_file|rm)$').hasMatch(key)) {
    return ToolFamily.delete;
  }
  if (RegExp(r'^(web_search|websearch)$').hasMatch(key)) return ToolFamily.web;
  if (RegExp(
    r'^(grep|search|search_files|searchfiles|ripgrep|rg|fetch|webfetch|conversation_search|memory_search|memory_recent|tool_search)$',
  ).hasMatch(key)) {
    return ToolFamily.search;
  }
  if (RegExp(
    r'^(find|glob|ls|list|list_dir|listdir|tree|list_files|listfiles)$',
  ).hasMatch(key)) {
    return ToolFamily.list;
  }
  if (RegExp(
    r'^(bash|shell|shell_exec|shellexec|exec|execute|run_command|runcommand|command|terminal|run)$',
  ).hasMatch(key)) {
    return ToolFamily.terminal;
  }
  if (key.contains('skill')) return ToolFamily.skill;
  if (RegExp(r'^(task|agent|subagent|dispatch|delegate)').hasMatch(key)) {
    return ToolFamily.agent;
  }
  if (key.contains('todo')) return ToolFamily.todo;
  if (RegExp(r'^(question|ask_user|askuser|questionnaire)$').hasMatch(key)) {
    return ToolFamily.question;
  }
  return ToolFamily.other;
}

class ToolSummary {
  const ToolSummary({
    required this.family,
    required this.label,
    required this.subject,
    this.context,
    this.error = false,
    this.running = false,
  });

  final ToolFamily family;
  final String label;
  final String subject;
  final String? context;
  final bool error;
  final bool running;
}

/// What the collapsed row says: the family's verb, then the thing it acted on.
ToolSummary summarize(ToolBlock tool) {
  final family = familyOf(tool.name);
  final running = tool.status == 'running';
  final error = tool.status == 'error';
  final labels = _labels[family]!;
  var label = t(running ? labels.$2 : labels.$1);
  var subject = tool.name;
  String? context;

  if (tool.name.startsWith('dag_')) {
    label = t(_dagToolLabels[tool.name] ?? 'dag.title');
    subject = argString(tool.args, <String>['id']);
    final tasks = _asRecord(tool.args)?['tasks'];
    if (tasks is List) {
      subject = tasks
          .map((item) => _asRecord(item)?['title'])
          .whereType<String>()
          .take(2)
          .join(' · ');
    }
    return ToolSummary(
      family: family,
      label: label,
      subject: subject,
      error: error,
      running: running,
    );
  }

  switch (family) {
    case ToolFamily.read:
    case ToolFamily.edit:
    case ToolFamily.write:
    case ToolFamily.delete:
      final path = argString(tool.args, _fileKeys);
      subject = path.isNotEmpty ? _basename(path) : _friendlyName(tool.name);
      if (path.isNotEmpty) context = _dirname(path);
    case ToolFamily.search:
      if (tool.name == 'memory_recent') {
        subject = t('tool.recentMemory');
        context = t('tool.longTermMemory');
        break;
      }
      if (tool.name == 'memory_search') {
        subject = argString(tool.args, <String>['query']);
        if (subject.isEmpty) subject = t('tool.longTermMemory');
        context = t('tool.memory');
        break;
      }
      subject = argString(tool.args, _searchKeys);
      if (subject.isEmpty) subject = _friendlyName(tool.name);
      final glob = argString(tool.args, <String>['glob']);
      if (glob.isNotEmpty) context = glob;
    case ToolFamily.web:
      subject = argString(tool.args, <String>[
        'query',
        'search_query',
        'searchQuery',
      ]);
      if (subject.isEmpty) subject = t('tool.webPage');
      final sources = _asRecord(tool.details)?['sources'];
      if (sources is List && sources.isNotEmpty) {
        context = t(
          'tool.sources',
          vars: <String, Object?>{'count': sources.length},
        );
      }
    case ToolFamily.list:
      subject = argString(tool.args, <String>[
        'path',
        'dir',
        'directory',
        'pattern',
      ]);
      if (subject.isEmpty) subject = '.';
    case ToolFamily.terminal:
      subject = argString(tool.args, _commandKeys);
      if (subject.isEmpty) subject = t('tool.runCommand');
    case ToolFamily.skill:
      subject = argString(tool.args, <String>['skill', 'name', 'command']);
      if (subject.isEmpty) subject = _friendlyName(tool.name);
    case ToolFamily.question:
      final questions = _asRecord(tool.args)?['questions'];
      String first = '';
      if (questions is List && questions.isNotEmpty) {
        final value = _asRecord(questions.first)?['question'];
        if (value is String) first = value.trim();
      }
      subject = first.isNotEmpty ? first : t('tool.clarify');
      if (questions is List && questions.length > 1) {
        context = t(
          'tool.questions',
          vars: <String, Object?>{'count': questions.length},
        );
      }
    case ToolFamily.todo:
      final todos = _todoItems(tool);
      TodoItem? current;
      for (final item in todos) {
        if (item.status == 'in_progress') {
          current = item;
          break;
        }
      }
      current ??= todos.where((item) => item.status == 'pending').firstOrNull;
      final done = todos
          .where(
            (item) => item.status == 'completed' || item.status == 'cancelled',
          )
          .length;
      if (todos.isNotEmpty) {
        final index = current != null
            ? todos.indexOf(current) + 1
            : todos.length;
        subject =
            '$index/${todos.length}${current?.content != null ? ' · ${current!.content}' : ''}';
        context = t(
          'tool.todosDone',
          vars: <String, Object?>{'done': done, 'total': todos.length},
        );
      } else {
        subject = t('tool.updateList');
      }
    case ToolFamily.agent:
      final roles = _agentRoles(tool.args);
      subject = roles.isNotEmpty ? _compactRoles(roles) : t('tool.agent');
      if (roles.length > 1) {
        context = t(
          'tool.tasks',
          vars: <String, Object?>{'count': roles.length},
        );
      }
    case ToolFamily.codemode:
      // The script is the call: the row says what it is for and how many tools it ran.
      final summary = codemodeSummary(codemodeCode(tool.args));
      subject = summary.isNotEmpty ? summary : tool.name;
      final calls = codemodeCalls(tool.details);
      if (calls.isNotEmpty) {
        final failed = codemodeFailures(calls);
        context = failed > 0
            ? t(
                'tool.callsFailed',
                vars: <String, Object?>{
                  'count': calls.length,
                  'failed': failed,
                },
              )
            : t('tool.calls', vars: <String, Object?>{'count': calls.length});
      }
    case ToolFamily.browser:
      subject = argString(tool.args, <String>[
        'url',
        'text',
        'selector',
        'tabId',
        'key',
      ]);
      if (subject.isEmpty) {
        subject = _friendlyName(
          tool.name.replaceFirst(RegExp(r'^browser_'), ''),
        );
      }
    case ToolFamily.mcp:
    case ToolFamily.other:
      subject = _friendlyName(tool.name);
  }
  return ToolSummary(
    family: family,
    label: label,
    subject: subject,
    context: context,
    error: error,
    running: running,
  );
}

/// One tool call, rendered as a compact line on the phone.
///
/// Tool arguments, output and diffs stay out of the mobile transcript. A DAG row may
/// still open the dedicated graph view, which is navigation rather than tool detail.
class ToolCard extends StatelessWidget {
  const ToolCard({
    super.key,
    required this.tool,
    required this.palette,
    this.divider = false,
    this.onOpenDag,
  });

  final ToolBlock tool;
  final Palette palette;
  final bool divider;

  /// A `dag_*` row does not expand — it opens the run in the DAG panel, which is where
  /// that call's result is readable.
  final VoidCallback? onOpenDag;

  @override
  Widget build(BuildContext context) {
    final palette = this.palette;
    final tool = this.tool;
    final summary = summarize(tool);
    final opensDag =
        tool.name.startsWith('dag_') &&
        tool.name != 'dag_report' &&
        !summary.error &&
        onOpenDag != null;
    final tint = summary.error
        ? palette.danger
        : summary.running
        ? palette.accent
        : palette.muted;
    final row = InkWell(
      onTap: opensDag ? onOpenDag : null,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 40),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          child: Row(
            children: <Widget>[
              Container(
                width: 24,
                height: 24,
                decoration: BoxDecoration(
                  color: summary.error
                      ? palette.dangerSoft
                      : summary.running
                      ? palette.accentSoft
                      : palette.field,
                  borderRadius: BorderRadius.circular(7),
                ),
                child: Center(
                  child: summary.running
                      ? DesktopSpinner(size: 13, color: palette.accent)
                      : HugeIcon(
                          icon: _icons[summary.family]!,
                          size: 13,
                          color: tint,
                          strokeWidth: 2,
                        ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                summary.label,
                maxLines: 1,
                style: TextStyle(
                  color: summary.running ? palette.accent : palette.muted,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  summary.subject,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 12.5,
                    fontFamily: 'monospace',
                  ),
                ),
              ),
              if (summary.context != null) ...<Widget>[
                const SizedBox(width: 6),
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: MediaQuery.sizeOf(context).width * 0.28,
                  ),
                  child: Opacity(
                    opacity: 0.7,
                    child: Text(
                      summary.context!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: palette.muted,
                        fontSize: 11.5,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                ),
              ],
              if (summary.error)
                Text(
                  t('tool.failed', context: context),
                  style: TextStyle(
                    color: palette.danger,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              if (opensDag) ...<Widget>[
                const SizedBox(width: 4),
                HugeIcon(
                  icon: AppIcons.arrowRight,
                  size: 14,
                  color: palette.subtle,
                  strokeWidth: 2,
                ),
              ],
            ],
          ),
        ),
      ),
    );

    return Container(
      decoration: divider
          ? BoxDecoration(
              border: Border(
                top: BorderSide(color: palette.separator, width: 0.5),
              ),
            )
          : null,
      child: row,
    );
  }
}

Map<String, Object?>? _asRecord(Object? value) =>
    value is Map && value is! List ? value.cast<String, Object?>() : null;

String argString(Object? args, List<String> keys) {
  final record = _asRecord(args);
  if (record == null) return args is String ? args.trim() : '';
  for (final key in keys) {
    final value = record[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return '';
}

String _basename(String path) {
  final parts = path
      .split(RegExp(r'[/\\]'))
      .where((part) => part.isNotEmpty)
      .toList();
  return parts.isEmpty ? path : parts.last;
}

String _dirname(String path) {
  final parts = path
      .split(RegExp(r'[/\\]'))
      .where((part) => part.isNotEmpty)
      .toList();
  if (parts.isEmpty) return '';
  parts.removeLast();
  return parts.join('/');
}

String _friendlyName(String name) => name
    .replaceFirst(RegExp(r'^(browser_|mcp__)'), '')
    .replaceAll(RegExp(r'[_-]+'), ' ');

class TodoItem {
  const TodoItem({this.status, this.content});

  final String? status;
  final String? content;
}

List<TodoItem> _todoItems(ToolBlock tool) {
  final details = _asRecord(tool.details);
  final raw = details?['todos'] is List
      ? details!['todos'] as List
      : _asRecord(tool.args)?['todos'];
  if (raw is! List) return <TodoItem>[];
  final items = <TodoItem>[];
  for (final item in raw) {
    final record = _asRecord(item);
    if (record == null) continue;
    final content = record['content'];
    final activeForm = record['activeForm'];
    items.add(
      TodoItem(
        status: record['status'] is String ? record['status'] as String : null,
        content: content is String
            ? content
            : (activeForm is String ? activeForm : null),
      ),
    );
  }
  return items;
}

List<String> _agentRoles(Object? args) {
  final record = _asRecord(args);
  if (record == null) return <String>[];
  final roles = <String>[];
  if (record['agent'] is String) roles.add(record['agent'] as String);
  for (final key in <String>['tasks', 'chain']) {
    final list = record[key];
    if (list is! List) continue;
    for (final item in list) {
      final value = _asRecord(item)?['agent'];
      if (value is String) roles.add(value);
    }
  }
  return roles;
}

String _compactRoles(List<String> roles) {
  final counts = <String, int>{};
  for (final role in roles) {
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts.entries
      .take(2)
      .map(
        (entry) => entry.value > 1 ? '${entry.key} ×${entry.value}' : entry.key,
      )
      .join(', ');
}
