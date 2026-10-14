import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// How a file is read from the machine that has it: as slices, over the same call channel
/// every other method uses. The official connection is one WebRTC data channel with no HTTP
/// beside it, so there is nowhere to stream a download from — the phone asks for the next
/// slice until the machine says it reached the end.
typedef FileCall = Future<Object?> Function(String method, Object? payload, int? timeoutMs);

const String readFileMethod = 'workspace:read-file';

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
  void cancel() => _cancelled = true;
}

class FileStat {
  const FileStat({required this.size, required this.mtimeMs});

  final int size;
  final num mtimeMs;
}

class _Slice {
  const _Slice({required this.size, required this.mtimeMs, required this.bytes, required this.eof});

  final int size;
  final num mtimeMs;
  final Uint8List bytes;
  final bool eof;
}

/// Reads one conversation's files. The conversation is what lets the machine resolve a path
/// the agent wrote relative to its working directory.
class FileTransfer {
  FileTransfer({required this.call, required this.conversationId});

  final FileCall call;
  final String conversationId;

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
    if (size is! num || data is! String || eof is! bool) throw const FileTransferError('invalid');
    final mtime = reply['mtimeMs'];
    return _Slice(
      size: size.toInt(),
      mtimeMs: mtime is num ? mtime : 0,
      bytes: data.isEmpty ? Uint8List(0) : base64Decode(data),
      eof: eof,
    );
  }

  Future<FileStat> stat(String path) async {
    final slice = await _slice(path, 0, 0);
    return FileStat(size: slice.size, mtimeMs: slice.mtimeMs);
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
  /// file and renamed at the end, so a cut connection never leaves something that looks like
  /// the finished file.
  Future<File> download(
    String path, {
    required Directory directory,
    required String name,
    CancelToken? cancel,
    void Function(int received, int total)? onProgress,
  }) async {
    await directory.create(recursive: true);
    final target = _uniqueFile(directory, name);
    final part = File('${target.path}.part');
    final sink = await part.open(mode: FileMode.write);
    var done = false;
    try {
      var offset = 0;
      num? mtime;
      while (true) {
        if (cancel?.cancelled == true) throw const FileTransferError('cancelled');
        final slice = await _slice(path, offset, sliceBytes);
        if (mtime != null && slice.mtimeMs != mtime) throw const FileTransferError('changed');
        mtime = slice.mtimeMs;
        if (slice.bytes.isEmpty && !slice.eof) throw const FileTransferError('stalled');
        await sink.writeFrom(slice.bytes);
        offset += slice.bytes.length;
        onProgress?.call(offset, slice.size);
        if (slice.eof) break;
      }
      await sink.close();
      done = true;
      return await part.rename(target.path);
    } finally {
      if (!done) {
        try {
          await sink.close();
        } catch (_) {}
        try {
          await part.delete();
        } catch (_) {}
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
