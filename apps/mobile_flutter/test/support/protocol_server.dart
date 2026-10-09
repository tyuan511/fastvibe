import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// A loopback-only App Protocol peer. No production server or model is used in tests.
class ProtocolServer {
  late HttpServer _http;
  final sockets = <WebSocket>[];
  final frames = <Map<String, dynamic>>[];
  final calls = <Map<String, dynamic>>[];
  final handlers = <String, FutureOr<Object?> Function(Map<String, dynamic>)>{};
  final features = <String, bool>{
    'promptSubmit': true,
    'conversationResume': true,
    'historyPaging': true,
  };
  String get origin => 'http://127.0.0.1:${_http.port}';
  String epoch = 'test-epoch';
  int seq = 0;
  int revision = 0;
  bool running = false;
  final items = <Map<String, dynamic>>[];
  final messages = <Map<String, dynamic>>[
    {
      'id': 'u1',
      'role': 'user',
      'text': 'Review the mobile client',
      'createdAt': DateTime.now().millisecondsSinceEpoch - 9000,
    },
    {
      'id': 'a1',
      'role': 'assistant',
      'text': 'The workspace is ready.\n\n- Connect securely\n- Keep your work in sync',
      'createdAt': DateTime.now().millisecondsSinceEpoch - 8000,
      'completedAt': DateTime.now().millisecondsSinceEpoch - 2000,
    },
  ];
  Map<String, Object?> queue([String id = 'c1']) => {
    'conversationId': id,
    'revision': revision,
    'items': List.of(items),
    'pause': null,
  };
  List<Map<String, Object?>> get conversations => [
    {
      'id': 'c1',
      'title': 'Mobile workspace',
      'preview': 'The workspace is ready',
      'project': '/workspace',
      'createdAt': DateTime.now().millisecondsSinceEpoch - 9000,
      'updatedAt': DateTime.now().millisecondsSinceEpoch - 2000,
    },
    {
      'id': 'c2',
      'title': 'Design review',
      'project': '/workspace',
      'createdAt': DateTime.now().millisecondsSinceEpoch - 9000,
      'updatedAt': DateTime.now().millisecondsSinceEpoch - 3000,
    },
  ];

  Future<void> start() async {
    _http = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _http.listen((request) async {
      if (request.uri.path == '/api/login') {
        final data = jsonDecode(await utf8.decoder.bind(request).join());
        request.response.headers.contentType = ContentType.json;
        request.response.statusCode = data['password'] == 'test-password'
            ? 200
            : 401;
        request.response.write(
          jsonEncode(
            data['password'] == 'test-password'
                ? {'token': 'test-token'}
                : {'error': 'invalid password'},
          ),
        );
        await request.response.close();
        return;
      }
      if (!WebSocketTransformer.isUpgradeRequest(request)) {
        request.response.statusCode = 404;
        await request.response.close();
        return;
      }
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      socket.listen((raw) async {
        final frame = (jsonDecode(raw as String) as Map)
            .cast<String, dynamic>();
        frames.add(frame);
        if (frame['type'] == 'auth') {
          _send(socket, {'type': 'auth', 'ok': frame['token'] == 'test-token'});
        } else if (frame['kind'] == 'hello') {
          _send(socket, {
            'kind': 'welcome',
            'epoch': epoch,
            'features': features,
          });
        } else if (frame['kind'] == 'ping') {
          _send(socket, {'kind': 'pong'});
        } else if (frame['kind'] == 'subscribe' && frame['requestId'] != null) {
          _send(socket, {
            'kind': 'subscribed',
            'requestId': frame['requestId'],
            'cursors': {
              for (final scope in frame['scopes'] as List)
                scope: {'epoch': epoch, 'seq': seq},
            },
          });
        } else if (frame['kind'] == 'call') {
          calls.add(frame);
          final method = frame['method'] as String;
          final payload = (frame['payload'] as Map? ?? {})
              .cast<String, dynamic>();
          try {
            final result =
                await (handlers[method]?.call(payload) ??
                    _default(method, payload));
            _send(socket, {
              'kind': 'result',
              'requestId': frame['requestId'],
              'ok': true,
              'result': result,
            });
          } catch (error) {
            _send(socket, {
              'kind': 'result',
              'requestId': frame['requestId'],
              'ok': false,
              'error': {'message': '$error'},
            });
          }
        }
      }, onDone: () => sockets.remove(socket));
    });
  }

  Object? _default(String method, Map<String, dynamic> p) {
    final id = p['conversationId'] as String? ?? 'c1';
    return switch (method) {
      'conversations:list' => {
        'projects': [
          {'cwd': '/workspace', 'name': 'FastVibe'},
        ],
        'conversations': conversations,
      },
      'settings:get' => {
        'archivedConversations': [],
        'queueBehavior': 'followUp',
      },
      'engine:get-running' => running ? ['c1'] : [],
      'engine:get-pending-ui' => [],
      'engine:get-models' => [
        {
          'provider': 'test',
          'id': 'local-model',
          'name': 'Local Model',
          'thinkingLevels': ['low', 'high'],
        },
      ],
      'engine:get-state' || 'engine:set-model' || 'engine:set-thinking' => {
        'conversationId': id,
        'model': {'provider': 'test', 'id': 'local-model'},
        'thinkingLevel': 'high',
        'contextUsage': {'tokens': 8000, 'contextWindow': 32000, 'percent': 25},
      },
      'engine:get-snapshot' => {
        'conversationId': id,
        'seq': seq,
        'running': running,
        'pendingUi': [],
        'queue': queue(id),
        'messages': messages,
      },
      'engine:submit-prompt' => _submit(p),
      'engine:queue-cancel' => _cancel(p),
      'engine:queue-resume' => queue(id),
      'engine:abort' => _stop(),
      'engine:continue' => _continue(),
      'dag:list' => [],
      'engine:get-subagent-messages' => [
        {'id': 'sub1', 'role': 'assistant', 'text': 'Subagent checkpoint'},
      ],
      'conversations:search' => [],
      _ => throw StateError('Unexpected test method: $method'),
    };
  }

  Object _submit(Map<String, dynamic> p) {
    final id = p['conversationId'] as String;
    if (p['enqueue'] == true) {
      items.add({
        'id': 'q${++revision}',
        'conversationId': id,
        'text': p['text'],
        'behavior': 'followUp',
      });
      emit({'type': 'queue_changed', 'queue': queue(id)}, id: id);
    } else {
      messages.add({
        'id': 'u${messages.length}',
        'role': 'user',
        'text': p['text'],
        'createdAt': DateTime.now().millisecondsSinceEpoch,
      });
      running = true;
      emit({'type': 'conversation_running', 'running': true}, id: id);
    }
    return queue(id);
  }

  Object _cancel(Map<String, dynamic> p) {
    items.removeWhere((item) => item['id'] == p['id']);
    revision++;
    emit({'type': 'queue_changed', 'queue': queue()});
    return queue();
  }

  Object? _stop() {
    running = false;
    emit({'type': 'conversation_running', 'running': false});
    emit({'type': 'agent_settled'});
    return null;
  }

  Object? _continue() {
    running = true;
    emit({'type': 'conversation_running', 'running': true});
    return null;
  }

  void emit(Map<String, Object?> event, {String id = 'c1'}) {
    seq++;
    for (final socket in List.of(sockets)) {
      _send(socket, {
        'kind': 'event',
        'channel': 'engine:event',
        'scope': 'conversation:$id',
        'epoch': epoch,
        'seq': seq,
        'payload': {'conversationId': id, 'seq': seq, ...event},
      });
    }
  }

  void _send(WebSocket socket, Object value) {
    try {
      if (socket.readyState == WebSocket.open) socket.add(jsonEncode(value));
    } on StateError {
      /* Closed by a lost-ack test. */
    }
  }

  Future<void> drop() async {
    for (final socket in List.of(sockets)) {
      await socket.close(4000, 'local test reconnect');
    }
  }

  Future<void> close() async {
    await drop();
    await _http.close(force: true);
  }
}
