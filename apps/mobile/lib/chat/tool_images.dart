import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import 'file_sheet.dart' show maxImagePreviewBytes;
import 'file_transfer.dart';
import 'message.dart';
import 'output_files.dart' show OutputFile, OutputFileKind, fileBaseName;

/// The generated pictures a `generate_image` call delivered, rendered inline
/// under its row — the desktop's `ImageResultsGrid` on the phone's terms.
///
/// The paths live on the machine, so each tile reads its bytes through the same
/// sliced channel any file preview uses, and a tap hands the file to the sheet's
/// zoom-and-download viewer. This is not part of the reply's output-file row: the
/// picture is the call's own answer, shown where the call stands.

class ImageTaskView {
  const ImageTaskView({
    required this.paths,
    required this.requestedCount,
    required this.generating,
    this.aspectRatio = 1,
  });

  final List<String> paths;

  /// Slots shown while still generating (1–4, as the task requested).
  final int requestedCount;
  final bool generating;

  /// Width / height of the tiles, from the task's aspect or size option.
  final double aspectRatio;

  bool get isEmpty => paths.isEmpty && !generating;
}

Map<String, Object?>? _record(Object? value) =>
    value is Map && value is! List ? value.cast<String, Object?>() : null;

List<String> _imagePaths(Object? list) {
  if (list is! List) return const <String>[];
  return <String>[
    for (final item in list)
      if (_record(item)?['path'] is String) _record(item)?['path'] as String,
  ];
}

/// Projects a tool snapshot the way the desktop's `imagePreviewFromTool` does:
/// the task's own image list is authoritative; the legacy `items` refs and the
/// result JSON are fallbacks for older payloads.
ImageTaskView imageTaskView(ToolBlock tool) {
  final details = _record(tool.details);
  final task = _record(details?['task']);
  final options = _record(task?['options']);
  final args = _record(tool.args);
  var paths = <String>[];
  if (task?['images'] is List) {
    paths = _imagePaths(task?['images']);
  } else {
    final legacy = details?['items'];
    if (legacy is List) {
      paths = <String>[
        for (final item in legacy)
          if (!_isFailed(item) && _record(item)?['ref'] is String)
            _record(item)?['ref'] as String,
      ];
    }
    if (paths.isEmpty && tool.result != null) {
      Object? parsed;
      try {
        parsed = jsonDecode(tool.result!);
      } on FormatException {
        parsed = null; // Plain text and unfinished JSON carry no paths.
      }
      if (paths.isEmpty) paths = _imagePaths(_record(parsed)?['images']);
    }
  }
  String? option(String name) => switch (_record(options)?[name] ?? args?[name]) {
        final String value when value.trim().isNotEmpty => value.trim(),
        _ => null,
      };
  final ratio = aspectRatioOf(option('aspectRatio'), option('size'));
  final countValue = args?['count'] ?? options?['count'];
  final requested = countValue is num && countValue >= 1
      ? countValue.clamp(1, 4).toInt()
      : 1;
  final terminal = switch (task?['status']) {
    'succeeded' || 'partial' || 'failed' || 'cancelled' || 'interrupted' => true,
    _ => false,
  };
  return ImageTaskView(
    paths: paths,
    requestedCount: requested,
    generating: tool.status == 'running' && !terminal,
    aspectRatio: ratio,
  );
}

bool _isFailed(Object? item) => _record(item)?['ok'] == false;

/// `1:1`, or `1024x1024`; anything unreadable falls back to a square.
double aspectRatioOf(String? aspectRatio, String? size) {
  final parts = aspectRatio?.split(':') ?? const <String>[];
  if (parts.length == 2) {
    final w = double.tryParse(parts[0].trim());
    final h = double.tryParse(parts[1].trim());
    if (w != null && h != null && w > 0 && h > 0) return w / h;
  }
  final dimensions = size?.split('x') ?? const <String>[];
  if (dimensions.length == 2) {
    final w = double.tryParse(dimensions[0].trim());
    final h = double.tryParse(dimensions[1].trim());
    if (w != null && h != null && w > 0 && h > 0) return w / h;
  }
  return 1;
}

/// One picture of a generation: loaded bytes, still loading, or unreadable.
class _Tile {
  const _Tile.loading() : bytes = null, failed = false;
  const _Tile.ready(this.bytes) : failed = false;
  const _Tile.broken() : bytes = null, failed = true;

  final Uint8List? bytes;
  final bool failed;
  bool get loaded => bytes != null || failed;
}

class ToolImageStrip extends StatefulWidget {
  const ToolImageStrip({
    super.key,
    required this.tool,
    required this.palette,
    required this.transfer,
    required this.onOpenFile,
  });

  final ToolBlock tool;
  final Palette palette;
  final FileTransfer transfer;
  final void Function(OutputFile file) onOpenFile;

  @override
  State<ToolImageStrip> createState() => _ToolImageStripState();
}

class _ToolImageStripState extends State<ToolImageStrip> {
  final Map<String, _Tile> _tiles = <String, _Tile>{};
  final CancelToken _cancel = CancelToken();

  @override
  void initState() {
    super.initState();
    _sync(imageTaskView(widget.tool));
  }

  @override
  void didUpdateWidget(ToolImageStrip oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.tool.id != widget.tool.id) {
      _tiles.clear();
    }
    _sync(imageTaskView(widget.tool));
  }

  @override
  void dispose() {
    _cancel.cancel();
    super.dispose();
  }

  void _sync(ImageTaskView task) {
    for (final path in task.paths) {
      if (!_tiles.containsKey(path)) {
        _tiles[path] = const _Tile.loading();
        _load(path);
      }
    }
  }

  Future<void> _load(String path) async {
    try {
      final read = await widget.transfer.read(
        path,
        maxBytes: maxImagePreviewBytes,
        cancel: _cancel,
      );
      if (!mounted) return;
      setState(() {
        _tiles[path] = read.truncated || read.bytes.isEmpty
            ? const _Tile.broken()
            : _Tile.ready(read.bytes);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _tiles[path] = const _Tile.broken());
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = widget.palette;
    final task = imageTaskView(widget.tool);
    if (task.isEmpty) return const SizedBox.shrink();
    final ratio = task.aspectRatio;
    final slots = <Widget>[
      for (final path in task.paths) _tile(path, ratio, palette),
      if (task.generating)
        for (var slot = task.paths.length;
            slot < task.requestedCount;
            slot++)
          _pending(ratio, palette),
    ];
    // Two columns, as the desktop's grid is on a narrow pane; a lone picture
    // keeps the same tile size rather than filling the row.
    final rows = <Widget>[
      for (var index = 0; index < slots.length; index += 2)
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(child: slots[index]),
            if (index + 1 < slots.length) ...<Widget>[
              const SizedBox(width: 8),
              Expanded(child: slots[index + 1]),
            ] else
              const Spacer(),
          ],
        ),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 2, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          for (var index = 0; index < rows.length; index++) ...<Widget>[
            if (index > 0) const SizedBox(height: 8),
            rows[index],
          ],
        ],
      ),
    );
  }

  Widget _tile(String path, double ratio, Palette palette) {
    final tile = _tiles[path] ?? const _Tile.loading();
    return AspectRatio(
      aspectRatio: ratio,
      child: InkWell(
        onTap: tile.bytes == null
            ? null
            : () => widget.onOpenFile(
                OutputFile(
                  path: path,
                  name: fileBaseName(path),
                  kind: OutputFileKind.image,
                  created: true,
                ),
              ),
        borderRadius: BorderRadius.circular(12),
        child: Container(
          decoration: BoxDecoration(
            color: palette.field,
            borderRadius: BorderRadius.circular(12),
          ),
          clipBehavior: Clip.antiAlias,
          child: switch (tile) {
            _Tile(:final bytes?) => Semantics(
                button: true,
                label: t('image.open'),
                child: Image.memory(
                  bytes,
                  fit: BoxFit.contain,
                  gaplessPlayback: true,
                  cacheWidth: 720,
                ),
              ),
            _Tile(failed: true) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    HugeIcon(
                      icon: AppIcons.image,
                      size: 22,
                      color: palette.subtle,
                      strokeWidth: 1.8,
                    ),
                    const SizedBox(height: 6),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      child: Text(
                        t('image.unavailable'),
                        maxLines: 2,
                        textAlign: TextAlign.center,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: palette.subtle,
                          fontSize: 11,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            _ => Center(child: DesktopSpinner(size: 16, color: palette.subtle)),
          },
        ),
      ),
    );
  }

  Widget _pending(double ratio, Palette palette) {
    return AspectRatio(
      aspectRatio: ratio,
      child: Container(
        decoration: BoxDecoration(
          color: palette.field.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: palette.border, width: 0.5),
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            DesktopSpinner(size: 16, color: palette.subtle),
            Positioned(
              left: 12,
              bottom: 12,
              right: 12,
              child: Text(
                t('image.creating'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: palette.text.withValues(alpha: 0.7),
                  fontSize: 11,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
