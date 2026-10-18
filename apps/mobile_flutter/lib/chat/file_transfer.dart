import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import '../protocol/client.dart' show TransportError, ConnectionError;

/// How a file is read from the machine that has it: as slices, over the same call channel
/// every other method uses. The official connection is one WebRTC data channel with no HTTP
/// beside it, so there is nowhere to stream a download from — the phone asks for the next
/// slice until the machine says it reached the end.
typedef FileCall = Future<Object?> Function(String method, Object? payload, int? timeoutMs);

const String readFileMethod = 'workspace:read-file';
const String officeRenderMethod = 'office:render';

/// One slice is about half a megabyte on the wire after base64: few enough round trips over a
/// relay, small enough that a transcript update waiting behind it on the ordered channel
/// is not held for long.
const int sliceBytes = 384 * 1024;
const Duration _sliceTimeout = Duration(seconds: 60);

class FileTransferError implements Exception {
  const FileTransferError(this.code, [this.detail]);

  /// `changed` — the file was rewritten while it was being read.
  /// `stalled` — the machine answered a slice with nothing and no end.
  /// `cancelled` — the reader gave up.
  /// `invalid` — the answer was not a slice.
  final String code;
  final String? detail;

  @override
  String toString() => 'FileTransferError($code${detail == null ? '' : ': $detail'})';
}

class CancelToken {
  bool _cancelled = false;
  bool get cancelled => _cancelled;
  bool _discardOnCancel = false;
  bool get discardOnCancel => _discardOnCancel;
  final Set<void Function()> _listeners = <void Function()>{};
  void Function() onCancel(void Function() listener) {
    if (_cancelled) { listener(); return () {}; }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }
  /// File reads are side-effect free; a closed sheet need not wait for a dead socket.
  Future<T> race<T>(Future<T> operation) async {
    final cancelled = Completer<T>();
    final remove = onCancel(() {
      if (!cancelled.isCompleted) cancelled.completeError(const FileTransferError('cancelled'));
    });
    try { return await Future.any(<Future<T>>[operation, cancelled.future]); }
    finally { remove(); }
  }

  void cancel({bool discard = true}) {
    _cancelled = true;
    _discardOnCancel |= discard;
    for (final listener in _listeners.toList()) { listener(); }
    if (discard) _listeners.clear();
  }
}

class FileStat {
  const FileStat({required this.size, required this.mtimeMs, required this.resumable});

  final int size;
  final num? mtimeMs;
  final bool resumable;
}

class _Slice {
  const _Slice({required this.size, required this.mtimeMs, required this.bytes, required this.eof, required this.resumable});

  final int size;
  final num? mtimeMs;
  final bool resumable;
  final Uint8List bytes;
  final bool eof;
}

/// Reads one conversation's files. The conversation is what lets the machine resolve a path
/// the agent wrote relative to its working directory.
class FileTransfer {
  FileTransfer({required this.call, required this.conversationId, this.serverId = ""});

  final FileCall call;
  final String conversationId;
  final String serverId;
  static final Set<String> _activeDownloads = <String>{};

  /// Remove orphaned/expired checkpoints on launch and before downloads. Only our
  /// hashed checkpoint names are eligible; completed files and active writers stay.
  static Future<void> cleanupCheckpoints(
    Directory directory, {
    DateTime? now,
    Duration maxAge = const Duration(days: 7),
    int maxBytes = 512 * 1024 * 1024,
  }) async {
    if (!await directory.exists()) return;
    final cutoff = (now ?? DateTime.now()).subtract(maxAge);
    final candidates = <({File part, File metadata, DateTime modified, int bytes})>[];
    final owned = RegExp(r'^\.fastvibe-([0-9a-f]{64})\.part(?:\.json)?$');
    final paths = <String>{};
    await for (final entry in directory.list(followLinks: false)) {
      if (entry is! File) continue;
      final name = entry.uri.pathSegments.last;
      if (!owned.hasMatch(name)) continue;
      paths.add(entry.path.endsWith('.json') ? entry.path.substring(0, entry.path.length - 5) : entry.path);
    }
    Future<void> remove(File part, File metadata) async {
      if (!_activeDownloads.add(part.path)) return;
      try {
        for (final file in <File>[part, metadata]) {
          if (await file.exists()) await file.delete();
        }
      } finally { _activeDownloads.remove(part.path); }
    }
    for (final path in paths) {
      if (_activeDownloads.contains(path)) continue;
      final part = File(path);
      final metadata = File('$path.json');
      try {
        final stat = await part.stat();
        final metaStat = await metadata.stat();
        if (stat.type != FileSystemEntityType.file || metaStat.type != FileSystemEntityType.file) {
          await remove(part, metadata);
          continue;
        }
        final stored = jsonDecode(await metadata.readAsString());
        final expectedKey = owned.firstMatch(part.uri.pathSegments.last)!.group(1);
        if (stored is! Map || stored['key'] != expectedKey || stored['size'] is! int ||
            (stored['size'] as int) < stat.size || stored['mtimeMs'] is! num ||
            !(stored['mtimeMs'] as num).isFinite || stat.modified.isBefore(cutoff)) {
          await remove(part, metadata);
          continue;
        }
        candidates.add((part: part, metadata: metadata, modified: stat.modified, bytes: stat.size + metaStat.size));
      } on FormatException {
        await remove(part, metadata);
      } on FileSystemException {
        // A concurrent completion/removal or inaccessible file is retried next sweep.
      }
    }
    candidates.sort((a, b) => a.modified.compareTo(b.modified));
    var bytes = candidates.fold<int>(0, (sum, item) => sum + item.bytes);
    for (final item in candidates) {
      if (bytes <= maxBytes) break;
      if (_activeDownloads.contains(item.part.path)) continue;
      try { await remove(item.part, item.metadata); bytes -= item.bytes; }
      on FileSystemException { /* Retry next sweep. */ }
    }
  }

  Future<_Slice> _slice(String path, int offset, int length) async {
    final reply = await call(
      readFileMethod,
      <String, Object?>{
        'path': path,
        'conversationId': conversationId,
        'offset': offset,
        'length': length,
      },
      _sliceTimeout.inMilliseconds,
    );
    if (reply is! Map) throw const FileTransferError('invalid');
    final size = reply['size'];
    final data = reply['data'];
    final eof = reply['eof'];
    final mtime = reply['mtimeMs'];
    if (size is! int || size < 0 || data is! String || eof is! bool ||
        (mtime != null && (mtime is! num || !mtime.isFinite)) ||
        (reply.containsKey('offset') && reply['offset'] != offset)) {
      throw const FileTransferError('invalid');
    }
    Uint8List bytes;
    try { bytes = data.isEmpty ? Uint8List(0) : base64Decode(data); }
    on FormatException { throw const FileTransferError('invalid'); }
    if (bytes.length > length) throw const FileTransferError('invalid');
    return _Slice(size: size, mtimeMs: mtime as num?, bytes: bytes, eof: eof, resumable: mtime != null && reply.containsKey('offset'));
  }

  Future<FileStat> stat(String path) async {
    final slice = await _slice(path, 0, 0);
    return FileStat(size: slice.size, mtimeMs: slice.mtimeMs, resumable: slice.resumable);
  }

  /// The rendered HTML page for an Office file, as a path on the machine that has it.
  ///
  /// The phone cannot lay a docx out itself. The host runs OfficeCLI and this reads the
  /// page back through the same slice channel as any other file.
  Future<String> renderOffice(String path, {CancelToken? cancel}) async {
    if (cancel?.cancelled == true) throw const FileTransferError('cancelled');
    final reply = await call(
      officeRenderMethod,
      <String, Object?>{'path': path, 'conversationId': conversationId},
      const Duration(seconds: 90).inMilliseconds,
    );
    if (reply is! Map) throw const FileTransferError('invalid');
    final rendered = reply['path'];
    if (rendered is! String || rendered.isEmpty) throw const FileTransferError('invalid');
    return rendered;
  }

  /// The file's bytes, up to [maxBytes]. [truncated] says the file went on past that.
  Future<({Uint8List bytes, bool truncated, int size})> read(
    String path, {
    required int maxBytes,
    CancelToken? cancel,
    void Function(int received, int total)? onProgress,
  }) async {
    final builder = BytesBuilder(copy: false);
    num? mtime;
    var size = 0;
    var truncated = false;
    while (true) {
      if (cancel?.cancelled == true) throw const FileTransferError('cancelled');
      final want = (maxBytes - builder.length).clamp(0, sliceBytes).toInt();
      if (want == 0) {
        truncated = true;
        break;
      }
      final slice = await _slice(path, builder.length, want);
      if (mtime != null && slice.mtimeMs != mtime) throw const FileTransferError('changed');
      mtime = slice.mtimeMs;
      size = slice.size;
      if (slice.bytes.isEmpty && !slice.eof) throw const FileTransferError('stalled');
      builder.add(slice.bytes);
      onProgress?.call(builder.length, size);
      if (slice.eof) break;
    }
    return (bytes: builder.takeBytes(), truncated: truncated, size: size);
  }

  /// Copy the whole file into [directory] and return it. The bytes are written to a `.part`
  /// file and renamed at the end. Transient disconnects retain a checkpoint keyed by
  /// host, conversation and path; resuming verifies remote size and modification time.
  Future<File> download(
    String path, {
    required Directory directory,
    required String name,
    CancelToken? cancel,
    void Function(int received, int total)? onProgress,
  }) async {
    await directory.create(recursive: true);
    await cleanupCheckpoints(directory);
    final key = sha256.convert(utf8.encode(jsonEncode(<String>[serverId, conversationId, path]))).toString();
    final part = File('${directory.path}/.fastvibe-$key.part');
    final metadata = File('${part.path}.json');
    if (!_activeDownloads.add(part.path)) throw const FileTransferError('busy');
    RandomAccessFile? sink;
    var keep = false;
    var done = false;
    Future<void> clean() async {
      for (final file in <File>[part, metadata]) {
        if (await file.exists()) await file.delete();
      }
    }
    final removeCancel = cancel?.onCancel(() {
      if (cancel.discardOnCancel && _activeDownloads.add(part.path)) {
        unawaited(clean().whenComplete(() => _activeDownloads.remove(part.path)).catchError((Object _) {}));
      }
    });
    try {
      var offset = 0;
      num? mtime;
      int? expectedSize;
      if (await part.exists() && await metadata.exists()) {
        try {
          final stored = jsonDecode(await metadata.readAsString());
          if (stored is Map && stored['key'] == key && stored['size'] is int && stored['mtimeMs'] is num) {
            offset = await part.length();
            expectedSize = stored['size'] as int;
            mtime = stored['mtimeMs'] as num;
          }
        } on FormatException { /* An incomplete checkpoint is restarted. */ }
        if (expectedSize != null && offset > 0 && offset <= expectedSize) {
          if (cancel?.cancelled == true) throw const FileTransferError('cancelled');
          final current = await (cancel == null ? stat(path) : cancel.race(stat(path)));
          if (!current.resumable || current.size != expectedSize || current.mtimeMs != mtime) {
            offset = 0;
            expectedSize = null;
            mtime = null;
          }
        } else {
          offset = 0;
          expectedSize = null;
          mtime = null;
        }
      }
      if (offset == 0) await clean();
      sink = await part.open(mode: offset > 0 ? FileMode.append : FileMode.write);
      if (offset > 0) onProgress?.call(offset, expectedSize!);
      while (true) {
        if (cancel?.cancelled == true) throw const FileTransferError('cancelled');
        final slice = await (cancel == null ? _slice(path, offset, sliceBytes) : cancel.race(_slice(path, offset, sliceBytes)));
        if (cancel?.cancelled == true) throw const FileTransferError('cancelled');
        if ((mtime != null && slice.mtimeMs != mtime) || (expectedSize != null && slice.size != expectedSize)) throw const FileTransferError('changed');
        mtime = slice.mtimeMs;
        expectedSize = slice.size;
        if (slice.bytes.isEmpty && !slice.eof) throw const FileTransferError('stalled');
        if (offset + slice.bytes.length > slice.size || (slice.eof && offset + slice.bytes.length != slice.size)) throw const FileTransferError('invalid');
        await sink.writeFrom(slice.bytes);
        offset += slice.bytes.length;
        // Offset is the part file's length. Metadata only records immutable identity,
        // so a lost reply can safely retry the same read after reconnecting.
        if (slice.resumable && !await metadata.exists()) {
          await metadata.writeAsString(jsonEncode(<String, Object?>{'key': key, 'size': slice.size, 'mtimeMs': mtime}), flush: true);
        }
        onProgress?.call(offset, slice.size);
        if (slice.eof) break;
      }
      await sink.close();
      sink = null;
      final target = _uniqueFile(directory, name);
      final saved = await part.rename(target.path);
      done = true;
      if (await metadata.exists()) await metadata.delete();
      return saved;
    } catch (error) {
      final transient = error is TransportError && const <String>{'timeout', 'dropped', 'closed'}.contains(error.code)
          || error is ConnectionError && const <String>{'timeout', 'unreachable', 'closed-early'}.contains(error.code)
          || error is SocketException || error is TimeoutException;
      final paused = cancel?.cancelled == true && cancel?.discardOnCancel != true;
      keep = (transient || paused) && cancel?.discardOnCancel != true && await part.exists() && await metadata.exists();
      if (keep && !paused) throw const FileTransferError('interrupted');
      rethrow;
    } finally {
      try {
        if (sink != null) await sink.close();
      } finally {
        _activeDownloads.remove(part.path);
        if (!keep || cancel?.discardOnCancel == true) {
          removeCancel?.call();
          if (!done) await clean();
        }
      }
    }
  }
}

/// A name that cannot walk out of the directory, and does not replace an earlier download.
String safeFileName(String name) {
  final cleaned = name.replaceAll(RegExp(r'[\\/\u0000-\u001f:*?"<>|]'), '_').trim();
  if (cleaned.isEmpty || cleaned == '.' || cleaned == '..') return 'file';
  return cleaned.length > 120 ? cleaned.substring(cleaned.length - 120) : cleaned;
}

File _uniqueFile(Directory directory, String name) {
  final safe = safeFileName(name);
  final dot = safe.lastIndexOf('.');
  final stem = dot > 0 ? safe.substring(0, dot) : safe;
  final extension = dot > 0 ? safe.substring(dot) : '';
  var candidate = File('${directory.path}/$safe');
  for (var n = 2; candidate.existsSync(); n++) {
    candidate = File('${directory.path}/$stem ($n)$extension');
  }
  return candidate;
}

String formatFileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  const units = <String>['KB', 'MB', 'GB'];
  var value = bytes / 1024;
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return '${value >= 100 || value == value.roundToDouble() ? value.round() : value.toStringAsFixed(1)} ${units[unit]}';
}
