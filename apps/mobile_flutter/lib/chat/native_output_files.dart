import 'package:flutter/material.dart';

import '../i18n/core.dart';
import '../ui/kit.dart';
import 'markdown_view.dart';

/// Workspace URLs carry no device identity: the owning transcript supplies its server/thread.
/// HTTP, data URLs and anchors remain ordinary links, never file read requests.
String? nativeMarkdownPath(String value) {
  try {
    final uri = Uri.tryParse(value);
    if (uri == null || value.isEmpty || value.startsWith('#')) return null;
    String path;
    if (uri.scheme == 'fvpath') {
      path = Uri.decodeComponent(
        value.substring('fvpath:'.length).split('#').first,
      );
    } else if (uri.scheme == 'file') {
      if (uri.host.isNotEmpty && uri.host != 'localhost') return null;
      path = Uri.decodeComponent(uri.path);
    } else if (uri.scheme.isEmpty && !value.startsWith('//')) {
      path = Uri.decodeComponent(uri.path);
    } else {
      return null;
    }
    // A line fragment is navigation metadata; a literal # in a path is percent-encoded.
    if (path.isEmpty || path.contains(RegExp(r'[\x00-\x1f\x7f]'))) return null;
    return path;
  } on FormatException {
    return null;
  } on ArgumentError {
    return null;
  }
}

/// Actual files named by successful native tool calls or structured file changes.
/// A pending/failed call and deleted files have no file to open. Shell output is not parsed.
List<String> nativeOutputPaths(Map<String, Object?> item) {
  final paths = <String>{};
  void add(Object? path) {
    if (path is String &&
        path.isNotEmpty &&
        !path.contains(RegExp(r'[\x00-\x1f\x7f]')) &&
        !RegExp(
          r'^[a-z][a-z0-9+.-]*://',
          caseSensitive: false,
        ).hasMatch(path)) {
      paths.add(path);
    }
  }

  if (item['isError'] == true) return <String>[];
  if (item['type'] == 'fileChange') {
    final changes = item['changes'];
    if (changes is List) {
      for (final change in changes.whereType<Map>()) {
        if (change['kind'] != 'delete' &&
            change['type'] != 'delete' &&
            change['deleted'] != true) {
          add(change['path']);
        }
      }
    } else if (item['deleted'] != true && item['kind'] != 'delete') {
      add(item['path']);
    }
    return paths.toList();
  }
  if (item['type'] != 'toolCall' || item['output'] == null) return <String>[];
  final arguments = item['arguments'];
  if (arguments is! Map) return <String>[];
  final name = item['name'];
  if (name == 'apply_patch') {
    final patch = arguments['input'];
    if (patch is! String) return <String>[];
    String? current;
    void flush() {
      add(current);
      current = null;
    }

    for (final line in patch.split('\n')) {
      if (line.startsWith('*** Add File: ') ||
          line.startsWith('*** Update File: ')) {
        flush();
        current = line.substring(line.indexOf(': ') + 2);
      } else if (line.startsWith('*** Delete File: ') ||
          line == '*** End Patch') {
        flush();
      } else if (line.startsWith('*** Move to: ') && current != null) {
        current = line.substring('*** Move to: '.length);
      }
    }
    flush();
  } else if (const <String>{
    'write',
    'write_file',
    'writeFile',
    'create_file',
    'edit',
    'edit_file',
    'editFile',
    'str_replace',
  }.contains(name)) {
    for (final key in const <String>[
      'path',
      'file_path',
      'filePath',
      'filename',
      'target_file',
    ]) {
      if (arguments[key] is String) {
        add(arguments[key]);
        break;
      }
    }
  }
  return paths.toList();
}

/// The native transcript stays compact; file actions and reply path links share one callback.
class NativeTranscriptItem extends StatelessWidget {
  const NativeTranscriptItem({
    super.key,
    required this.item,
    required this.onFile,
    this.enabled = true,
  });
  final Map<String, Object?> item;
  final void Function(String path, {required bool download}) onFile;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final text = '${item['text'] ?? item['message'] ?? item['name'] ?? ''}';
    final files = nativeOutputPaths(item);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (item['type'] == 'agentMessage')
          MarkdownView(
            text: text,
            palette: palette,
            handleLink: (url) {
              final path = nativeMarkdownPath(url);
              if (path == null) return false;
              if (enabled) onFile(path, download: false);
              return true;
            },
          )
        else
          SelectableText(
            text,
            style: TextStyle(
              color: item['type'] == 'reasoning' || item['type'] == 'toolCall'
                  ? palette.muted
                  : palette.text,
              fontSize: 16,
            ),
          ),
        for (final path in files)
          Row(
            children: <Widget>[
              Expanded(
                child: TextButton(
                  onPressed: enabled
                      ? () => onFile(path, download: false)
                      : null,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      path,
                      style: TextStyle(
                        color: enabled ? palette.accent : palette.muted,
                      ),
                    ),
                  ),
                ),
              ),
              TextButton(
                onPressed: enabled ? () => onFile(path, download: true) : null,
                child: Text(t('file.download')),
              ),
            ],
          ),
      ],
    );
  }
}
