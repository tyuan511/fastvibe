import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/protocol/native_client.dart';

/// Run against an explicitly selected freshly built native binary. No installed app data,
/// SSH configuration, account, or external service is used.
void main() {
  final binary = Platform.environment['FASTVIBE_TEST_SERVER_BIN'];
  test(
    'Flutter native client drives real Rust LAN protocol and resumes after disconnect',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'fv-dart-native-',
      );
      final process = await Process.start(binary!, <String>[
        '--data-dir',
        directory.path,
        '--listen',
        'unix',
        '--model',
        'echo',
      ]);
      final logs = <String>[];
      final stderr = process.stderr.transform(utf8.decoder).listen(logs.add);
      final stdout = process.stdout.drain<void>();
      Socket? owner;
      final native = NativeClient();
      try {
        final socketPath = '${directory.path}/server.sock';
        for (
          var attempt = 0;
          attempt < 200 && !await File(socketPath).exists();
          attempt++
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
        owner = await Socket.connect(
          InternetAddress(socketPath, type: InternetAddressType.unix),
          0,
        );
        final lines = StreamIterator<String>(
          owner
              .cast<List<int>>()
              .transform(utf8.decoder)
              .transform(const LineSplitter()),
        );
        var next = 1;
        Future<Map<String, Object?>> ownerCall(
          String method,
          Map<String, Object?> params,
        ) async {
          final id = next++;
          owner!.write(
            '${jsonEncode(<String, Object?>{'id': id, 'method': method, 'params': params})}\n',
          );
          await owner.flush();
          while (await lines.moveNext().timeout(const Duration(seconds: 60))) {
            final frame = jsonDecode(lines.current) as Map;
            if (frame['id'] == id) {
              if (frame['error'] != null) throw StateError('${frame['error']}');
              return (frame['result'] as Map).cast<String, Object?>();
            }
          }
          throw StateError('Rust server closed: ${logs.join()}');
        }

        await ownerCall('initialize', <String, Object?>{
          'clientInfo': <String, Object?>{'name': 'dart-owner', 'version': '0'},
          'protocolVersion': 1,
          'capabilities': <String, Object?>{},
        });
        await ownerCall('settings/set', <String, Object?>{
          'replySuggestions': false,
        });
        final reservation = await ServerSocket.bind(
          InternetAddress.loopbackIPv4,
          0,
        );
        final port = reservation.port;
        await reservation.close();
        await ownerCall('remote/configure', <String, Object?>{
          'enabled': true,
          'port': port,
        });
        await ownerCall('remote/setPassword', <String, Object?>{
          'password': 'native interop secret',
        });
        final origin = Uri.parse('http://127.0.0.1:$port');
        final token = await NativeClient.login(
          origin,
          'native interop secret',
          'Flutter interop',
        );
        await native.connect(origin, token);
        final started = await native.call('thread/start', <String, Object?>{
          'cwd': directory.path,
        }) as Map;
        final threadId = (started['thread'] as Map)['id'] as String;
        final thread = NativeThread(native, threadId);
        final events = <Map<String, Object?>>[];
        final stream = thread.events.listen(events.add);
        await thread.resume();
        await thread.send('Flutter to Rust');
        await Future<void>.delayed(const Duration(milliseconds: 100));
        await stream.cancel();
        await native.close();
        await native.connect(origin, token);
        final restored = await native.call('thread/resume', <String, Object?>{
          'threadId': threadId,
        }) as Map;
        final turns = restored['turns'] as List;
        expect(
          turns
              .expand((turn) => (turn as Map)['items'] as List)
              .whereType<Map>()
              .any((item) => item['text'] == 'Flutter to Rust'),
          isTrue,
        );
        final output = File('${directory.path}/out.bin');
        await output.writeAsBytes(<int>[0, 1, 255]);
        final chunk = await native.call('workspace/readFile', <String, Object?>{
          'threadId': threadId,
          'path': 'out.bin',
          'offset': 0,
          'length': 3,
        }) as Map;
        expect(base64Decode(chunk['data'] as String), <int>[0, 1, 255]);
        expect(chunk['eof'], isTrue);
        expect(events, isNotEmpty);
        await lines.cancel();
      } finally {
        await native.dispose();
        owner?.destroy();
        process.kill(ProcessSignal.sigterm);
        await process.exitCode.timeout(const Duration(seconds: 10));
        await stdout;
        await stderr.cancel();
        await directory.delete(recursive: true);
      }
    },
    skip: binary == null
        ? 'Set FASTVIBE_TEST_SERVER_BIN to a freshly built native server'
        : false,
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
