import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../i18n/core.dart';
import '../protocol/client.dart';
import '../theme/theme.dart';
import '../ui/feedback.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/sheet.dart';
import 'file_transfer.dart';
import 'markdown_view.dart';
import 'output_files.dart';

/// A picture larger than this is not decoded on the phone; it is offered as a download.
const int maxImagePreviewBytes = 12 * 1024 * 1024;

/// Text is read for the eye, not for editing: this much of it, then 「下载」.
const int maxTextPreviewBytes = 256 * 1024;

/// Where a download is kept, and how it is handed to the system. Both are replaced in tests.
typedef DownloadDirectory = Future<Directory> Function();
typedef FileOpener = Future<bool> Function(String path);

Future<Directory> defaultDownloadDirectory() async {
  // On iOS the documents directory is what the Files app lists under 「FastVibe」
  // (`UIFileSharingEnabled`), so a download is something the person can find again.
  final root = await getApplicationDocumentsDirectory();
  return Directory('${root.path}/Downloads');
}

Future<bool> defaultFileOpener(String path) async {
  final result = await OpenFilex.open(path);
  return result.type == ResultType.done;
}

/// 打开一个回复产出的文件：预览，并可以下载。
Future<void> showOutputFile(
  BuildContext context, {
  required OutputFile file,
  required FileTransfer transfer,
  DownloadDirectory downloadDirectory = defaultDownloadDirectory,
  FileOpener opener = defaultFileOpener,
  bool downloadOnOpen = false,
}) {
  return showAppSheet<void>(
    context: context,
    expanded: true,
    builder: (_) => FileViewer(
      file: file,
      transfer: transfer,
      downloadDirectory: downloadDirectory,
      opener: opener,
      downloadOnOpen: downloadOnOpen,
    ),
  );
}

sealed class _Preview {
  const _Preview();
}

class _ImagePreview extends _Preview {
  const _ImagePreview(this.bytes);

  final Uint8List bytes;
}

class _TextPreview extends _Preview {
  const _TextPreview(
    this.text, {
    required this.markdown,
    required this.truncatedAt,
  });

  final String text;
  final bool markdown;

  /// Set when the file went on past what was read: the size read.
  final int? truncatedAt;
}

/// The host-rendered page for a docx, xlsx or pptx.
class _OfficePreview extends _Preview {
  const _OfficePreview(this.controller);

  final WebViewController controller;
}

/// Nothing to draw; [message] is the i18n key that says why.
class _NoPreview extends _Preview {
  const _NoPreview(this.message, {this.failed = false});

  final String message;
  final bool failed;
}

@visibleForTesting
class FileViewer extends StatefulWidget {
  const FileViewer({
    super.key,
    required this.file,
    required this.transfer,
    this.downloadDirectory = defaultDownloadDirectory,
    this.opener = defaultFileOpener,
    this.downloadOnOpen = false,
  });

  final OutputFile file;
  final FileTransfer transfer;
  final DownloadDirectory downloadDirectory;
  final FileOpener opener;
  final bool downloadOnOpen;

  @override
  State<FileViewer> createState() => _FileViewerState();
}

class _FileViewerState extends State<FileViewer> {
  _Preview? _preview;
  final CancelToken _cancel = CancelToken();
  CancelToken _downloadCancel = CancelToken();
  double? _progress;
  bool _downloading = false;
  bool _resumeAvailable = false;
  File? _saved;

  @override
  void initState() {
    super.initState();
    _load();
    if (widget.downloadOnOpen) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _download();
      });
    }
  }

  @override
  void dispose() {
    // Closing pauses a download; only the explicit Cancel action discards progress.
    _cancel.cancel();
    _downloadCancel.cancel(discard: false);
    super.dispose();
  }

  Future<void> _load() async {
    final file = widget.file;
    try {
      final preview = switch (file.kind) {
        OutputFileKind.image => await _loadImage(),
        OutputFileKind.markdown || OutputFileKind.text => await _loadText(),
        OutputFileKind.office => await _loadOffice(),
        OutputFileKind.other => const _NoPreview('file.noPreview'),
      };
      if (mounted) setState(() => _preview = preview);
    } catch (error) {
      if (!mounted) return;
      setState(
        () => _preview = _NoPreview(describeFileError(error), failed: true),
      );
    }
  }

  Future<_Preview> _loadImage() async {
    final read = await widget.transfer.read(
      widget.file.path,
      maxBytes: maxImagePreviewBytes,
      cancel: _cancel,
    );
    if (read.truncated) return const _NoPreview('file.tooLarge');
    if (read.bytes.isEmpty) return const _NoPreview('file.empty');
    return _ImagePreview(read.bytes);
  }

  Future<_Preview> _loadOffice() async {
    final rendered = await widget.transfer.renderOffice(
      widget.file.path,
      cancel: _cancel,
    );
    final read = await widget.transfer.read(
      rendered,
      maxBytes: 8 * 1024 * 1024,
      cancel: _cancel,
    );
    if (read.bytes.isEmpty) return const _NoPreview('file.empty');
    if (read.truncated) return const _NoPreview('file.tooLarge');
    final html = utf8.decode(read.bytes, allowMalformed: true);
    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..loadHtmlString(html);
    return _OfficePreview(controller);
  }

  Future<_Preview> _loadText() async {
    final read = await widget.transfer.read(
      widget.file.path,
      maxBytes: maxTextPreviewBytes,
      cancel: _cancel,
    );
    final bytes = read.bytes;
    if (bytes.isEmpty) return const _NoPreview('file.empty');
    // A NUL byte is what separates a binary from text that merely has an odd extension.
    if (bytes.contains(0)) return const _NoPreview('file.binary');
    var text = utf8.decode(bytes, allowMalformed: true);
    if (read.truncated) {
      // The cut can land inside a line or a character; end on the last whole line.
      final end = text.lastIndexOf('\n');
      if (end > 0) text = text.substring(0, end);
    }
    return _TextPreview(
      text,
      markdown: widget.file.kind == OutputFileKind.markdown,
      truncatedAt: read.truncated ? read.bytes.length : null,
    );
  }

  Future<void> _download() async {
    if (_downloading) return;
    final saved = _saved;
    if (saved != null) {
      await _open(saved);
      return;
    }
    _downloadCancel = CancelToken();
    setState(() {
      _downloading = true;
      _progress = 0;
    });
    try {
      final directory = await widget.downloadDirectory();
      final file = await widget.transfer.download(
        widget.file.path,
        directory: directory,
        name: widget.file.name,
        cancel: _downloadCancel,
        onProgress: (received, total) {
          if (mounted) {
            setState(() => _progress = total <= 0 ? null : received / total);
          }
        },
      );
      if (!mounted) return;
      setState(() {
        _saved = file;
        _resumeAvailable = false;
        _downloading = false;
        _progress = null;
      });
      toastSuccess(
        !kIsWeb && Platform.isIOS
            ? t('file.savedIn')
            : t(
                'file.saved',
                vars: <String, Object?>{'name': widget.file.name},
              ),
      );
      await _open(file);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _downloading = false;
        _progress = null;
      });
      setState(
        () => _resumeAvailable =
            error is FileTransferError && error.code == 'interrupted',
      );
      if (error is FileTransferError && error.code == 'cancelled') return;
      toastError(describeFileError(error));
    }
  }

  Future<void> _open(File file) async {
    final opened = await widget.opener(file.path);
    if (!opened && mounted) toastInfo(t('file.openFailed'));
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final file = widget.file;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        AppSheetHeader(
          title: file.name,
          subtitle: file.path == file.name ? null : file.path,
          leading: _FileGlyph(kind: file.kind, palette: palette),
        ),
        Expanded(child: _body(palette)),
        if (_downloading || _resumeAvailable)
          TextButton(
            onPressed: () {
              _downloadCancel.cancel();
              setState(() => _resumeAvailable = false);
            },
            child: Text(t('file.cancelDownload')),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
          child: PrimaryButton(
            label: _downloading
                ? t(
                    'file.downloading',
                    vars: <String, Object?>{
                      'percent': ((_progress ?? 0) * 100).floor(),
                    },
                  )
                : t(
                    _saved == null
                        ? (_resumeAvailable ? 'file.resume' : 'file.download')
                        : 'file.open',
                  ),
            icon: _saved == null ? AppIcons.download : AppIcons.fileText,
            enabled: !_downloading,
            onPressed: _download,
          ),
        ),
      ],
    );
  }

  Widget _body(Palette palette) {
    final preview = _preview;
    if (preview == null) {
      return Center(child: DesktopSpinner(size: 20, color: palette.muted));
    }
    return switch (preview) {
      _ImagePreview(:final bytes) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: InteractiveViewer(
          maxScale: 6,
          child: Center(
            child: Image.memory(
              bytes,
              fit: BoxFit.contain,
              gaplessPlayback: true,
            ),
          ),
        ),
      ),
      _OfficePreview(:final controller) => WebViewWidget(
        controller: controller,
      ),
      _TextPreview(:final text, :final markdown, :final truncatedAt) =>
        ListView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
          children: <Widget>[
            if (markdown)
              MarkdownView(text: text, palette: palette, compact: true)
            else
              SelectableText(
                text,
                style: TextStyle(
                  color: palette.text,
                  fontSize: 12.5,
                  height: 1.5,
                  fontFamily: 'Menlo',
                  fontFamilyFallback: const <String>['monospace'],
                ),
              ),
            if (truncatedAt != null) ...<Widget>[
              const SizedBox(height: 12),
              Text(
                t(
                  'file.truncated',
                  vars: <String, Object?>{'size': formatFileSize(truncatedAt)},
                ),
                style: TextStyle(color: palette.subtle, fontSize: 12),
              ),
            ],
          ],
        ),
      _NoPreview(:final message, :final failed) => EmptyState(
        icon: failed ? AppIcons.alert : AppIcons.fileText,
        title: failed ? t('file.loadFailed') : t(message),
        body: failed ? message : null,
      ),
    };
  }
}

/// What to tell the reader about a failed read: the machine's own sentence when it sent
/// one (「文件不存在」), otherwise a line of ours. Never an error's class name.
String describeFileError(Object error) {
  if (error is FileTransferError) {
    return switch (error.code) {
      'changed' => t('file.changed'),
      'interrupted' => t('file.interrupted'),
      'busy' => t('file.busy'),
      _ => t('file.loadFailed'),
    };
  }
  if (error is StateError && error.message.isNotEmpty) return error.message;
  if (error is TransportError && error.message.isNotEmpty) return error.message;
  return t('file.loadFailed');
}

class _FileGlyph extends StatelessWidget {
  const _FileGlyph({required this.kind, required this.palette});

  final OutputFileKind kind;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        color: palette.accentSoft,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Center(
        child: HugeIcon(
          icon: fileGlyph(kind),
          size: 20,
          color: palette.accent,
          strokeWidth: 1.9,
        ),
      ),
    );
  }
}

List<List<dynamic>> fileGlyph(OutputFileKind kind) => switch (kind) {
  OutputFileKind.image => AppIcons.imageAdd,
  OutputFileKind.markdown ||
  OutputFileKind.text ||
  OutputFileKind.office => AppIcons.fileText,
  OutputFileKind.other => AppIcons.fileDownload,
};
