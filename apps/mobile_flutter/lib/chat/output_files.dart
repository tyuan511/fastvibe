import 'message.dart';
import 'tool_card.dart' show argString;

/// What a file on the phone can be drawn as. Anything else is downloaded and handed to the
/// system, which knows how to open a PDF, a spreadsheet or a video.
enum OutputFileKind { image, markdown, text, office, other }

/// A file a reply wrote or presented.
class OutputFile {
  const OutputFile({
    required this.path,
    required this.name,
    required this.kind,
    required this.created,
  });

  /// As the tool named it — absolute, or relative to the conversation's directory. The
  /// machine resolves it; the phone has no idea where a conversation lives.
  final String path;
  final String name;
  final OutputFileKind kind;

  /// Written whole (a new file, or one replaced); `false` for an edit.
  final bool created;
}

const List<String> _pathKeys = <String>[
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'target_file',
  'target',
];

const Set<String> _imageExt = <String>{'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'};
const Set<String> _markdownExt = <String>{'md', 'markdown'};
// Plain text a reader can scroll. `svg` and `html` are here on purpose: the phone shows
// their source rather than running them.
const Set<String> _textExt = <String>{
  'txt', 'text', 'log', 'json', 'jsonl', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini', 'env',
  'xml', 'svg', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'dart', 'c', 'h', 'cpp', 'cc', 'cs',
  'sh', 'bash', 'zsh', 'sql', 'diff', 'patch', 'conf', 'gitignore',
};

String fileExtension(String name) {
  final dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.substring(dot + 1).toLowerCase() : '';
}

OutputFileKind outputFileKind(String name) {
  final ext = fileExtension(name);
  if (_imageExt.contains(ext)) return OutputFileKind.image;
  if (_markdownExt.contains(ext)) return OutputFileKind.markdown;
  if (_textExt.contains(ext)) return OutputFileKind.text;
  if (ext == 'docx' || ext == 'xlsx' || ext == 'pptx') return OutputFileKind.office;
  return OutputFileKind.other;
}

/// Office files a shell command will write. A scan, not a shell: `$FILE` is skipped.
List<String> officecliWriteTargets(String command) {
  final found = <String>[];
  final pattern = RegExp(
    r'''officecli(?:\.exe)?\s+(set|add|remove|move|swap|raw-set|add-part|batch|import|create|merge|refresh)\s+(?:"([^"]+\.(?:docx|xlsx|pptx))"|'([^']+\.(?:docx|xlsx|pptx))'|(\S+\.(?:docx|xlsx|pptx)))''',
    caseSensitive: false,
  );
  for (final match in pattern.allMatches(command)) {
    final verb = (match.group(1) ?? '').toLowerCase();
    final path = match.group(2) ?? match.group(3) ?? match.group(4) ?? '';
    if (path.isEmpty || path.contains(r'$')) continue;
    if (verb == 'merge') {
      final output = RegExp(
        r'''(?:"([^"]+\.(?:docx|xlsx|pptx))"|'([^']+\.(?:docx|xlsx|pptx))'|(\S+\.(?:docx|xlsx|pptx)))\s*$''',
        caseSensitive: false,
      ).firstMatch(command.substring(match.start));
      final written = output?.group(1) ?? output?.group(2) ?? output?.group(3);
      if (written != null && written.isNotEmpty) found.add(written);
      continue;
    }
    found.add(path);
  }
  return found;
}

String fileBaseName(String path) {
  final parts = path.split(RegExp(r'[/\\]')).where((part) => part.isNotEmpty).toList();
  return parts.isEmpty ? path : parts.last;
}

bool _isWrite(String name) => RegExp(
      r'^(write|write_file|writefile|create_file|createfile|create)$',
      caseSensitive: false,
    ).hasMatch(name.trim());

bool _isEdit(String name) => RegExp(
      r'^(edit|edit_file|editfile|apply_patch|applypatch|patch|str_replace|strreplace)$',
      caseSensitive: false,
    ).hasMatch(name.trim());

/// A reference the machine cannot read: a web address or an inline picture.
bool _isRemoteRef(String ref) =>
    ref.startsWith('data:') || RegExp(r'^[a-z][a-z0-9+.-]*://', caseSensitive: false).hasMatch(ref);

/// The files one reply produced, in the order its tools produced them.
///
/// The same sources the desktop's changed-file chips and `present` use: a `write` or an
/// `edit` names its file in its arguments, and `present` lists what the model chose to
/// show. Only a finished call counts (a write still running has not made the file), and a
/// path is listed once — a file written and then edited is one file, and it is *created*
/// if any of its calls wrote it whole.
///
/// Nothing is guessed from a command's printed output: the phone asks for tool results in
/// summary form, which leaves a long result out, so a guess would come and go with its length.
List<OutputFile> collectOutputFiles(Iterable<ToolBlock> tools) {
  final byPath = <String, OutputFile>{};
  void add(String path, bool created) {
    final value = path.trim();
    if (value.isEmpty || value.contains('\u0000') || _isRemoteRef(value)) return;
    final previous = byPath[value];
    if (previous != null) {
      if (created && !previous.created) {
        byPath[value] = OutputFile(path: value, name: previous.name, kind: previous.kind, created: true);
      }
      return;
    }
    final name = fileBaseName(value);
    byPath[value] = OutputFile(path: value, name: name, kind: outputFileKind(name), created: created);
  }

  for (final tool in tools) {
    if (tool.status != 'done') continue;
    if (tool.name == 'present') {
      final details = tool.details;
      final items = details is Map ? details['items'] : null;
      if (items is List) {
        for (final item in items) {
          if (item is! Map || item['ok'] == false) continue;
          final ref = item['ref'];
          if (ref is String) add(ref, true);
        }
      }
      continue;
    }
    if (tool.name == 'bash' || tool.name == 'shell') {
      for (final path in officecliWriteTargets(argString(tool.args, const <String>['command']))) {
        add(path, true);
      }
      continue;
    }
    final write = _isWrite(tool.name);
    if (!write && !_isEdit(tool.name)) continue;
    add(argString(tool.args, _pathKeys), write);
  }
  return byPath.values.toList(growable: false);
}
