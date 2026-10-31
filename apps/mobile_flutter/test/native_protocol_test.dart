import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/protocol/native_client.dart';

void main() {
  test(
    'native client authenticates in upgrade and resumes native thread frames',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final received = <Map<String, Object?>>[];
      final connections = <WebSocket>[];
      var resumeSeq = 3;
      var malformedInitialize = false;
      final serving = server.listen((request) async {
        if (request.uri.path == '/api/login') {
          request.response.headers.contentType = ContentType.json;
          request.response.write(
            jsonEncode(<String, Object?>{'token': 'native-token'}),
          );
          await request.response.close();
          return;
        }
        expect(request.headers.value('authorization'), 'Bearer native-token');
        final socket = await WebSocketTransformer.upgrade(request);
        connections.add(socket);
        socket.listen((raw) {
          final frame = (jsonDecode(raw as String) as Map)
              .cast<String, Object?>();
          received.add(frame);
          final method = frame['method'];
          if (method == 'request/cancel') return;
          Object? result = <String, Object?>{};
          if (method == 'initialize') {
            result = <String, Object?>{
              'protocolVersion': 1,
              'serverVersion': '0.1.0',
              'dataDir': '/test/native',
            };
          }
          if (method == 'initialize' && malformedInitialize) {
            result = <String, Object?>{'protocolVersion': 1};
          }
          if (method == 'thread/resume') {
            socket.add(
              jsonEncode(<String, Object?>{
                'method': 'item/agentMessage/delta',
                'params': <String, Object?>{
                  'threadId': 'thread',
                  'seq': resumeSeq,
                  'delta': 'live',
                },
              }),
            );
            result = <String, Object?>{
              'seq': 2,
              'thread': <String, Object?>{
                'id': 'thread',
                'title': 'Test',
                'createdAt': 1,
                'updatedAt': 1,
                'archived': false,
                'unread': false,
              },
              'turns': <Object?>[],
              'running': false,
            };
          }
          if (method == 'turn/start') {
            result = <String, Object?>{'turnId': 'turn'};
          }
          if (method == 'workspace/readFile') {
            result = <String, Object?>{
              'size': 1,
              'mtimeMs': 1,
              'offset': 0,
              'data': 'eA==',
              'eof': true,
            };
          }
          socket.add(
            jsonEncode(<String, Object?>{'id': frame['id'], 'result': result}),
          );
        });
      });
      final origin = Uri.parse('http://127.0.0.1:${server.port}');
      final token = await NativeClient.login(origin, 'secret', 'phone');
      final client = NativeClient();
      await client.connect(origin, token);
      final sentBeforeInvalid = received.length;
      await expectLater(
        client.call('turn/start', <String, Object?>{'threadId': 'thread'}),
        throwsFormatException,
      );
      expect(received.length, sentBeforeInvalid);
      final thread = NativeThread(client, 'thread');
      final events = <Map<String, Object?>>[];
      final errors = <Object>[];
      final subscription = thread.events.listen(
        events.add,
        onError: errors.add,
      );
      await thread.resume();
      await thread.send('hello');
      await thread.interrupt();
      expect((await thread.readFile('out.txt', 0, 1) as Map)['data'], 'eA==');
      expect(events.single['method'], 'item/agentMessage/delta');
      expect(
        received.map((frame) => frame['method']),
        containsAll(<String>[
          'initialize',
          'thread/resume',
          'turn/start',
          'turn/interrupt',
          'workspace/readFile',
        ]),
      );
      expect(
        received.every(
          (frame) => !frame.containsKey('kind') && !frame.containsKey('type'),
        ),
        isTrue,
      );
      resumeSeq = 5;
      await expectLater(thread.resume(), throwsStateError);
      expect(errors, hasLength(1));
      resumeSeq = 3;
      await thread.resume();
      await thread.dispose();
      await subscription.cancel();
      malformedInitialize = true;
      await expectLater(
        client.connect(origin, token).timeout(const Duration(seconds: 2)),
        throwsFormatException,
      );
      expect(client.ready, isFalse);
      malformedInitialize = false;
      await client.connect(origin, token);
      expect(client.ready, isTrue);
      await client.dispose();
      for (final socket in connections) {
        await socket.close();
      }
      await serving.cancel();
      await server.close(force: true);
    },
  );
}
