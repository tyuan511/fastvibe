import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:fastvibe_mobile/chat/file_sheet.dart';
import 'package:fastvibe_mobile/chat/file_transfer.dart';
import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/chat/output_files.dart';
import 'package:fastvibe_mobile/chat/output_files_row.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/main.dart';
import 'package:fastvibe_mobile/protocol/client.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/feedback.dart';
import 'package:fastvibe_mobile/ui/kit.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/plain.dart';
import 'package:shared_preferences/shared_preferences.dart';

ToolBlock tool(String name, Object? args, {String status = 'done', Object? details}) =>
    ToolBlock(id: '$name-${args.hashCode}', name: name, args: args, status: status, details: details);

/// A machine that holds one file and answers `workspace:read-file` the way Main does.
class FakeMachine {
  FakeMachine(this.bytes, {this.mtimeMs = 1});

  Uint8List bytes;
  num mtimeMs;
  final List<Map<String, Object?>> requests = <Map<String, Object?>>[];

  /// Called before each slice is answered, so a test can change the file mid-transfer.
  void Function(int served)? beforeSlice;

  /// Answer every slice with nothing and no end.
  bool stall = false;

  Future<Object?> call(String method, Object? payload, int? timeoutMs) async {
    expect(method, readFileMethod);
    final request = (payload as Map).cast<String, Object?>();
    requests.add(request);
    beforeSlice?.call(requests.length - 1);
    final offset = request['offset'] as int;
    final length = request['length'] as int;
    if (stall) return <String, Object?>{'name': 'f', 'size': bytes.length, 'mtimeMs': mtimeMs, 'offset': offset, 'data': '', 'eof': false};
    final end = (offset + length).clamp(0, bytes.length);
    final start = offset.clamp(0, bytes.length);
    final slice = length == 0 ? Uint8List(0) : bytes.sublist(start, end);
    return <String, Object?>{
      'name': 'f',
      'size': bytes.length,
      'mtimeMs': mtimeMs,
      'offset': offset,
      'data': base64Encode(slice),
      'eof': length == 0 || end >= bytes.length,
    };
  }
}

/// A transfer whose download completes at once with a file that already exists, so a widget
/// test does not wait on real file IO inside the test's fake clock.
class _InstantDownload extends FileTransfer {
  _InstantDownload(FakeMachine machine, this.result) : super(call: machine.call, conversationId: 'c1');

  final File result;
  final List<String> downloaded = <String>[];

  @override
  Future<File> download(
    String path, {
    required Directory directory,
    required String name,
    CancelToken? cancel,
    void Function(int received, int total)? onProgress,
  }) async {
    downloaded.add(path);
    onProgress?.call(1, 1);
    return result;
  }
}

Uint8List sample(int length) => Uint8List.fromList(List<int>.generate(length, (i) => (i * 7) % 256));

class _InterruptedDownload extends FileTransfer {
  _InterruptedDownload() : super(call: (_, _, _) async => null, conversationId: 'c1');
  CancelToken? token;

  @override
  Future<File> download(String path, {
    required Directory directory,
    required String name,
    CancelToken? cancel,
    void Function(int received, int total)? onProgress,
  }) async {
    token = cancel;
    throw const FileTransferError('interrupted');
  }
}

void main() {
  setUpAll(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await i18n.setPreference(LanguagePreference.en);
  });

  group('collectOutputFiles', () {
    test('a write and an edit each name their file, and a file is listed once', () {
      final files = collectOutputFiles(<ToolBlock>[
        tool('write', <String, Object?>{'path': 'out/report.md', 'content': 'x'}),
        tool('edit', <String, Object?>{'path': 'src/a.ts'}),
        tool('edit', <String, Object?>{'file_path': 'out/report.md'}),
      ]);
      expect(files.map((f) => f.path), <String>['out/report.md', 'src/a.ts']);
      expect(files.first.created, isTrue);
      expect(files.last.created, isFalse);
      expect(files.first.kind, OutputFileKind.markdown);
    });

    test('a file edited first and written later is a created one', () {
      final files = collectOutputFiles(<ToolBlock>[
        tool('edit', <String, Object?>{'path': 'a.txt'}),
        tool('write', <String, Object?>{'path': 'a.txt'}),
      ]);
      expect(files.single.created, isTrue);
    });

    test('only a finished call made the file', () {
      expect(
        collectOutputFiles(<ToolBlock>[
          tool('write', <String, Object?>{'path': 'a.txt'}, status: 'running'),
          tool('write', <String, Object?>{'path': 'b.txt'}, status: 'error'),
          tool('write', <String, Object?>{'path': 'c.txt'}, status: 'aborted'),
        ]),
        isEmpty,
      );
    });

    test('other tools do not produce files', () {
      expect(
        collectOutputFiles(<ToolBlock>[
          tool('read', <String, Object?>{'path': 'a.txt'}),
          tool('bash', <String, Object?>{'command': 'echo hi > b.txt'}),
          tool('grep', <String, Object?>{'path': 'src'}),
        ]),
        isEmpty,
      );
    });

    test('present lists what it showed, never a failure or a web address', () {
      final files = collectOutputFiles(<ToolBlock>[
        tool('present', null, details: <String, Object?>{
          'items': <Object?>[
            <String, Object?>{'ref': '/tmp/chart.png', 'ok': true},
            <String, Object?>{'ref': '/tmp/missing.png', 'ok': false},
            <String, Object?>{'ref': 'https://example.com/a.png', 'ok': true},
            <String, Object?>{'ref': 'data:image/png;base64,AAAA', 'ok': true},
          ],
        }),
      ]);
      expect(files.map((f) => f.path), <String>['/tmp/chart.png']);
      expect(files.single.kind, OutputFileKind.image);
    });

    test('kinds follow the extension; unknown ones are downloads', () {
      expect(outputFileKind('a.PNG'), OutputFileKind.image);
      expect(outputFileKind('a.md'), OutputFileKind.markdown);
      expect(outputFileKind('a.json'), OutputFileKind.text);
      expect(outputFileKind('a.svg'), OutputFileKind.text);
      expect(outputFileKind('a.pdf'), OutputFileKind.other);
      expect(outputFileKind('a.xlsx'), OutputFileKind.office);
      expect(outputFileKind('deck.PPTX'), OutputFileKind.office);
      expect(outputFileKind('Makefile'), OutputFileKind.other);
      expect(outputFileKind('.png'), OutputFileKind.other);
    });
  });

  group('FileTransfer', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('fv-dl-'));
    tearDown(() => dir.deleteSync(recursive: true));

    FileTransfer over(FakeMachine machine) => FileTransfer(call: machine.call, conversationId: 'c1');

    test('slices stitch back into the original file, and each request names the conversation', () async {
      final machine = FakeMachine(sample(sliceBytes * 2 + 123));
      final progress = <int>[];
      final file = await over(machine).download(
        'out/blob.bin',
        directory: dir,
        name: 'blob.bin',
        onProgress: (received, total) => progress.add(received),
      );
      expect(await file.readAsBytes(), machine.bytes);
      expect(machine.requests, hasLength(3));
      expect(machine.requests.every((r) => r['conversationId'] == 'c1' && r['path'] == 'out/blob.bin'), isTrue);
      expect(progress.last, machine.bytes.length);
      expect(dir.listSync().map((e) => e.path.split('/').last), <String>['blob.bin']);
    });

    test('a dropped connection resumes at saved bytes after validating the remote file', () async {
      final machine = FakeMachine(sample(sliceBytes * 2 + 10));
      final transfer = over(machine);
      machine.beforeSlice = (served) { if (served == 1) throw TransportError('dropped', 'offline'); };
      await expectLater(transfer.download('big.bin', directory: dir, name: 'big.bin'), throwsA(isA<FileTransferError>().having((e) => e.code, 'code', 'interrupted')));
      expect(dir.listSync().whereType<File>().where((file) => file.path.endsWith('.part')).single.lengthSync(), sliceBytes);
      machine.beforeSlice = null;
      machine.requests.clear();
      final file = await over(machine).download('big.bin', directory: dir, name: 'big.bin');
      expect(machine.requests.first['length'], 0);
      expect(machine.requests[1]['offset'], sliceBytes);
      expect(await file.readAsBytes(), machine.bytes);
      expect(dir.listSync().length, 1);
    });

    test('resuming a replaced remote file restarts without mixing old bytes', () async {
      final machine = FakeMachine(sample(sliceBytes * 2));
      machine.beforeSlice = (served) { if (served == 1) throw TransportError('closed', 'offline'); };
      await expectLater(over(machine).download('big.bin', directory: dir, name: 'big.bin'), throwsA(isA<FileTransferError>()));
      machine.beforeSlice = null;
      machine.mtimeMs = 2;
      machine.bytes = Uint8List.fromList(List<int>.filled(sliceBytes + 5, 42));
      machine.requests.clear();
      final file = await over(machine).download('big.bin', directory: dir, name: 'big.bin');
      expect(machine.requests[1]['offset'], 0);
      expect(await file.readAsBytes(), machine.bytes);
      expect(dir.listSync().length, 1);
    });

    test('cancelling after a disconnect deletes the retained checkpoint', () async {
      final machine = FakeMachine(sample(sliceBytes * 2));
      final cancel = CancelToken();
      machine.beforeSlice = (served) { if (served == 1) throw TransportError('timeout', 'offline'); };
      await expectLater(over(machine).download('big.bin', directory: dir, name: 'big.bin', cancel: cancel), throwsA(isA<FileTransferError>()));
      cancel.cancel();
      for (var i = 0; i < 20 && dir.listSync().isNotEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      expect(dir.listSync(), isEmpty);
    });

    test('closing a viewer pauses in-flight work and a new instance resumes it', () async {
      final machine = FakeMachine(sample(sliceBytes * 2 + 7));
      final cancel = CancelToken();
      machine.beforeSlice = (served) { if (served == 1) cancel.cancel(discard: false); };
      await expectLater(over(machine).download('big.bin', directory: dir, name: 'big.bin', cancel: cancel),
        throwsA(isA<FileTransferError>().having((e) => e.code, 'code', 'cancelled')));
      expect(dir.listSync().whereType<File>().where((file) => file.path.endsWith('.part')).single.lengthSync(), sliceBytes);
      machine.beforeSlice = null;
      machine.requests.clear();
      final file = await over(machine).download('big.bin', directory: dir, name: 'big.bin');
      expect(machine.requests[1]['offset'], sliceBytes);
      expect(await file.readAsBytes(), machine.bytes);
    });

    test('older hosts without offset and modification time still preview and download', () async {
      final machine = FakeMachine(sample(sliceBytes + 5));
      final transfer = FileTransfer(conversationId: 'c1', call: (method, payload, timeout) async {
        final reply = (await machine.call(method, payload, timeout) as Map).cast<String, Object?>();
        reply.remove('offset');
        reply.remove('mtimeMs');
        return reply;
      });
      expect((await transfer.read('old.bin', maxBytes: 10)).bytes, machine.bytes.take(10).toList());
      final file = await transfer.download('old.bin', directory: dir, name: 'old.bin');
      expect(await file.readAsBytes(), machine.bytes);
      expect(dir.listSync().length, 1);
    });

    test('a dropped legacy transfer without validators is not resumed blindly', () async {
      final machine = FakeMachine(sample(sliceBytes * 2));
      final transfer = FileTransfer(conversationId: 'c1', call: (method, payload, timeout) async {
        if ((payload as Map)['offset'] == sliceBytes) throw TransportError('dropped', 'offline');
        final reply = (await machine.call(method, payload, timeout) as Map).cast<String, Object?>();
        reply.remove('offset');
        reply.remove('mtimeMs');
        return reply;
      });
      await expectLater(transfer.download('old.bin', directory: dir, name: 'old.bin'), throwsA(isA<TransportError>()));
      expect(dir.listSync(), isEmpty);
    });

    test('supplied but incorrect offset remains an invalid reply', () async {
      final machine = FakeMachine(sample(10));
      final transfer = FileTransfer(conversationId: 'c1', call: (method, payload, timeout) async {
        final reply = (await machine.call(method, payload, timeout) as Map).cast<String, Object?>();
        reply['offset'] = 99;
        return reply;
      });
      await expectLater(transfer.download('bad.bin', directory: dir, name: 'bad.bin'), throwsA(isA<FileTransferError>().having((e) => e.code, 'code', 'invalid')));
      expect(dir.listSync(), isEmpty);
    });

    test('maintenance removes crash orphans, expires old checkpoints, and preserves completed files', () async {
      final completed = File('${dir.path}/report.txt')..writeAsStringSync('keep');
      final orphan = File('${dir.path}/.fastvibe-${'a' * 64}.part')..writeAsStringSync('orphan');
      final orphanMeta = File('${dir.path}/.fastvibe-${'b' * 64}.part.json')..writeAsStringSync('{}');
      final machine = FakeMachine(sample(sliceBytes * 2));
      machine.beforeSlice = (served) { if (served == 1) throw TransportError('dropped', 'offline'); };
      await expectLater(over(machine).download('big.bin', directory: dir, name: 'big.bin'), throwsA(isA<FileTransferError>()));
      expect(orphan.existsSync(), isFalse);
      expect(orphanMeta.existsSync(), isFalse);
      await FileTransfer.cleanupCheckpoints(dir, now: DateTime.now().add(const Duration(days: 8)));
      expect(dir.listSync().map((file) => file.path), <String>[completed.path]);
      expect(completed.readAsStringSync(), 'keep');
    });

    test('maintenance enforces its byte budget but cannot remove an active writer', () async {
      final machine = FakeMachine(sample(sliceBytes * 2));
      machine.beforeSlice = (served) { if (served == 1) throw TransportError('dropped', 'offline'); };
      await expectLater(over(machine).download('big.bin', directory: dir, name: 'big.bin'), throwsA(isA<FileTransferError>()));
      await FileTransfer.cleanupCheckpoints(dir, maxBytes: 1);
      expect(dir.listSync(), isEmpty);
      machine.beforeSlice = null;
      final transfer = FileTransfer(conversationId: 'c1', call: (method, payload, timeout) async {
        if ((payload as Map)['offset'] == sliceBytes) {
          await FileTransfer.cleanupCheckpoints(dir, maxBytes: 0);
          expect(dir.listSync().whereType<File>().where((file) => file.path.endsWith('.part')), hasLength(1));
        }
        return machine.call(method, payload, timeout);
      });
      final saved = await transfer.download('big.bin', directory: dir, name: 'big.bin');
      expect(await saved.readAsBytes(), machine.bytes);
    });

    test('a second download does not replace the first', () async {
      final machine = FakeMachine(sample(10));
      final first = await over(machine).download('a.txt', directory: dir, name: 'a.txt');
      final second = await over(machine).download('a.txt', directory: dir, name: 'a.txt');
      expect(first.path, isNot(second.path));
      expect(second.path, endsWith('a (2).txt'));
    });

    test('an empty file downloads as an empty file', () async {
      final file = await over(FakeMachine(Uint8List(0))).download('e.txt', directory: dir, name: 'e.txt');
      expect(await file.length(), 0);
    });

    test('a file rewritten mid-transfer is refused and leaves nothing behind', () async {
      final machine = FakeMachine(sample(sliceBytes * 2));
      machine.beforeSlice = (served) {
        if (served == 1) machine.mtimeMs = 2;
      };
      await expectLater(
        over(machine).download('a.bin', directory: dir, name: 'a.bin'),
        throwsA(isA<FileTransferError>().having((e) => e.code, 'code', 'changed')),
      );
      expect(dir.listSync(), isEmpty);
    });

    test('a machine that answers nothing and never ends does not loop forever', () async {
      final machine = FakeMachine(sample(10))..stall = true;
      await expectLater(
        over(machine).download('a.bin', directory: dir, name: 'a.bin'),
        throwsA(isA<FileTransferError>().having((e) => e.code, 'code', 'stalled')),
      );
      expect(dir.listSync(), isEmpty);
    });

    test('a cancelled download stops between slices and cleans up', () async {
      final machine = FakeMachine(sample(sliceBytes * 3));
      final cancel = CancelToken();
      machine.beforeSlice = (served) {
        if (served == 1) cancel.cancel();
      };
      await expectLater(
        over(machine).download('a.bin', directory: dir, name: 'a.bin', cancel: cancel),
        throwsA(isA<FileTransferError>().having((e) => e.code, 'code', 'cancelled')),
      );
      expect(machine.requests.length, lessThan(3));
      expect(dir.listSync(), isEmpty);
    });

    test('a reply that is not a slice is an error, not a crash', () async {
      final transfer = FileTransfer(call: (_, _, _) async => 'nope', conversationId: 'c1');
      await expectLater(transfer.stat('a'), throwsA(isA<FileTransferError>()));
    });

    test('a preview read stops at its cap and says the file went on', () async {
      final machine = FakeMachine(sample(sliceBytes + 500));
      final read = await over(machine).read('a.txt', maxBytes: 1000);
      expect(read.bytes, hasLength(1000));
      expect(read.truncated, isTrue);
      expect(machine.requests, hasLength(1));
      expect(machine.requests.single['length'], 1000);
      final whole = await over(FakeMachine(sample(900))).read('a.txt', maxBytes: 1000);
      expect(whole.truncated, isFalse);
      expect(whole.bytes, hasLength(900));
    });

    test('a name cannot leave its directory', () {
      expect(safeFileName('../../etc/passwd'), isNot(contains('/')));
      expect(safeFileName('..'), 'file');
      expect(safeFileName(''), 'file');
      expect(safeFileName('报告.md'), '报告.md');
    });

    test('sizes read as people say them', () {
      expect(formatFileSize(512), '512 B');
      expect(formatFileSize(2048), '2 KB');
      expect(formatFileSize(1536), '1.5 KB');
      expect(formatFileSize(5 * 1024 * 1024), '5 MB');
    });
  });

  group('screens', () {
    Future<void> pump(WidgetTester tester, Widget child, Palette palette) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        plain(
          child: MaterialApp(
            theme: buildTheme(palette),
            builder: (_, child) => PaletteScope(palette: palette, child: ToastHost(child: child!)),
            home: Material(child: child),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 300));
    }

    for (final p in <Palette>[light, dark]) {
      testWidgets('the file list opens a file, and folds the rest (${p.dark})', (tester) async {
        final opened = <String>[];
        final files = <OutputFile>[
          for (var i = 0; i < 6; i++)
            OutputFile(path: 'f$i.txt', name: 'f$i.txt', kind: OutputFileKind.text, created: i.isEven),
        ];
        await pump(
          tester,
          OutputFilesRow(files: files, palette: p, onOpen: (file) => opened.add(file.path)),
          p,
        );
        expect(tester.takeException(), isNull);
        expect(find.text('6 files'), findsOneWidget);
        expect(find.text('f3.txt'), findsOneWidget);
        expect(find.text('f4.txt'), findsNothing);
        await tester.tap(find.text('f1.txt'));
        expect(opened, <String>['f1.txt']);
        await tester.tap(find.text('2 more'));
        await tester.pump();
        expect(find.text('f5.txt'), findsOneWidget);
      });

      testWidgets('a text file previews, downloads, then opens (${p.dark})', (tester) async {
        final machine = FakeMachine(Uint8List.fromList(utf8.encode('line one\nline two\n')));
        final saved = File('${Directory.systemTemp.path}/fv-saved-not-written.txt');
        final opened = <String>[];
        final transfer = _InstantDownload(machine, saved);
        await pump(
          tester,
          FileViewer(
            file: const OutputFile(path: 'notes.txt', name: 'notes.txt', kind: OutputFileKind.text, created: true),
            transfer: transfer,
            downloadDirectory: () async => Directory.systemTemp,
            opener: (path) async {
              opened.add(path);
              return true;
            },
          ),
          p,
        );
        await tester.pump(const Duration(milliseconds: 100));
        expect(tester.takeException(), isNull);
        expect(find.textContaining('line one'), findsOneWidget);
        expect(find.text('Download'), findsOneWidget);
        await tester.tap(find.text('Download'));
        await tester.pump(const Duration(milliseconds: 100));
        expect(transfer.downloaded, <String>['notes.txt']);
        expect(opened, <String>[saved.path]);
        expect(find.text('Open'), findsOneWidget);
        // The second tap opens what is already saved instead of fetching it again.
        await tester.tap(find.text('Open'));
        await tester.pump(const Duration(milliseconds: 100));
        expect(transfer.downloaded, hasLength(1));
        expect(opened, hasLength(2));
        // The toast's timer must not outlive the test.
        await tester.pump(const Duration(seconds: 10));
      });

      testWidgets('a long text file scrolls inside the bottom sheet (${p.dark})', (tester) async {
        final text = [for (var i = 0; i < 120; i++) 'line number $i'].join('\n');
        final machine = FakeMachine(Uint8List.fromList(utf8.encode(text)));
        final transfer = _InstantDownload(machine, File('${Directory.systemTemp.path}/fv-scroll-not-written.txt'));
        await pump(
          tester,
          Builder(
            builder: (context) => TextButton(
              onPressed: () => showOutputFile(
                context,
                file: const OutputFile(path: 'long.txt', name: 'long.txt', kind: OutputFileKind.text, created: true),
                transfer: transfer,
              ),
              child: const Text('open'),
            ),
          ),
          p,
        );
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        final first = find.textContaining('line number 0');
        expect(first, findsOneWidget);
        final list = find.descendant(of: find.byType(FileViewer), matching: find.byType(Scrollable));
        final position = tester.state<ScrollableState>(list.first).position;
        expect(position.pixels, 0);
        await tester.drag(list.first, const Offset(0, -300));
        await tester.pumpAndSettle();
        // The text moved with the finger and the sheet is still open.
        expect(position.pixels, greaterThan(100));
        expect(find.byType(FileViewer), findsOneWidget);
        await tester.pump(const Duration(seconds: 10));
      });

      testWidgets('closing an interrupted file viewer preserves its checkpoint (${p.dark})', (tester) async {
        final transfer = _InterruptedDownload();
        await pump(tester, FileViewer(
          file: const OutputFile(path: 'archive.zip', name: 'archive.zip', kind: OutputFileKind.other, created: true),
          transfer: transfer,
          downloadDirectory: () async => Directory.systemTemp,
        ), p);
        await tester.tap(find.text('Download'));
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('Resume download'), findsOneWidget);
        expect(find.text('Cancel download and discard progress'), findsOneWidget);
        await pump(tester, const SizedBox(), p);
        expect(transfer.token!.cancelled, isTrue);
        expect(transfer.token!.discardOnCancel, isFalse);
        await tester.pump(const Duration(seconds: 10));
      });

      testWidgets('explicit cancel discards interrupted progress (${p.dark})', (tester) async {
        final transfer = _InterruptedDownload();
        await pump(tester, FileViewer(
          file: const OutputFile(path: 'archive.zip', name: 'archive.zip', kind: OutputFileKind.other, created: true),
          transfer: transfer,
          downloadDirectory: () async => Directory.systemTemp,
        ), p);
        await tester.tap(find.text('Download'));
        await tester.pump(const Duration(milliseconds: 100));
        await tester.tap(find.text('Cancel download and discard progress'));
        await tester.pump();
        expect(transfer.token!.discardOnCancel, isTrue);
        expect(find.text('Resume download'), findsNothing);
        await tester.pump(const Duration(seconds: 10));
      });

      testWidgets('a binary file is not drawn as text (${p.dark})', (tester) async {
        final machine = FakeMachine(Uint8List.fromList(<int>[1, 2, 0, 3]));
        await pump(
          tester,
          FileViewer(
            file: const OutputFile(path: 'x.log', name: 'x.log', kind: OutputFileKind.text, created: true),
            transfer: FileTransfer(call: machine.call, conversationId: 'c1'),
          ),
          p,
        );
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.textContaining('not text'), findsOneWidget);
      });

      testWidgets('a machine that refuses is explained in its own words (${p.dark})', (tester) async {
        await pump(
          tester,
          FileViewer(
            file: const OutputFile(path: 'gone.txt', name: 'gone.txt', kind: OutputFileKind.text, created: true),
            transfer: FileTransfer(call: (_, _, _) async => throw StateError('File does not exist'), conversationId: 'c1'),
          ),
          p,
        );
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('Could not read this file'), findsOneWidget);
        expect(find.text('File does not exist'), findsOneWidget);
      });
    }
  });
}
