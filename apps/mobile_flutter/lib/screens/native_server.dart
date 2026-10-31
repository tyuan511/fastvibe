import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../chat/file_sheet.dart';
import '../chat/file_transfer.dart';
import '../chat/native_output_files.dart';
import '../chat/output_files.dart';

import '../i18n/core.dart';
import '../protocol/native_client.dart';
import '../protocol/native_rtc.dart';
import '../account/account.dart';
import '../storage/servers.dart';
import '../ui/app_screen.dart';
import '../ui/feedback.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';

/// Native protocol device journey. Saved identity selects this route explicitly; no fallback
/// translates a failed native handshake into an Electron connection.
class NativeServerScreen extends StatefulWidget {
  const NativeServerScreen({super.key, required this.serverId});
  final String serverId;
  @override
  State<NativeServerScreen> createState() => _NativeServerScreenState();
}

class _NativeServerScreenState extends State<NativeServerScreen>
    with WidgetsBindingObserver {
  final _client = NativeClient();
  final _draft = TextEditingController();
  SavedServer? _server;
  NativeThread? _thread;
  StreamSubscription<Map<String, Object?>>? _events;
  StreamSubscription<Map<String, Object?>>? _requests;
  List<Map<String, Object?>> _threads = <Map<String, Object?>>[];
  final Map<String, Map<String, Object?>> _items =
      <String, Map<String, Object?>>{};
  final List<Map<String, Object?>> _prompts = <Map<String, Object?>>[];
  String? _error;
  bool _busy = true;
  bool _running = false;
  int _generation = 0;
  Timer? _reconnect;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _client.onDisconnect = (error) {
      if (!mounted) return;
      setState(() => _error = '$error');
      _reconnect?.cancel();
      _reconnect = Timer(const Duration(seconds: 1), () {
        if (mounted &&
            WidgetsBinding.instance.lifecycleState !=
                AppLifecycleState.paused) {
          unawaited(_connect());
        }
      });
    };
    _requests = _client.requests.listen((frame) {
      if (!mounted) return;
      setState(() {
        _prompts.removeWhere((prompt) => prompt['id'] == frame['id']);
        _prompts.add(frame);
      });
    });
    unawaited(_connect());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_connect());
    }
  }

  @override
  void dispose() {
    _generation++;
    _client.onDisconnect = null;
    WidgetsBinding.instance.removeObserver(this);
    _reconnect?.cancel();
    unawaited(_events?.cancel());
    unawaited(_requests?.cancel());
    unawaited(_client.dispose());
    _draft.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final generation = ++_generation;
    if (mounted) {
      setState(() {
        _busy = true;
        _error = null;
      });
    }
    try {
      final servers = await ServerStore.instance.load();
      if (!mounted || generation != _generation) return;
      final server = servers
          .where((entry) => entry.id == widget.serverId)
          .firstOrNull;
      if (server == null) throw StateError(t('notifications.deviceMissing'));
      final token = server.isOfficial
          ? AccountService.instance.token
          : await readToken(server.id);
      if (!mounted || generation != _generation) return;
      if (token == null) throw StateError(t('conn.needPassword'));
      if (server.isOfficial) {
        final account = AccountService.instance;
        await _client.connectOpened(
          () => NativeRtcDialer(
            origin: account.origin,
            token: token,
            deviceId: server.officialDeviceId!,
            clientName: 'FastVibe mobile',
            platform: account.platform,
          ).dial(),
        );
      } else {
        await _client.connect(Uri.parse(server.origin), token);
      }
      if (!mounted || generation != _generation) return;
      _server = server;
      await _list();
      if (!mounted || generation != _generation) return;
      final threadId = _thread?.threadId;
      if (threadId != null) await _open(threadId);
      if (!mounted || generation != _generation) return;
      setState(() => _busy = false);
    } catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _busy = false;
        _error = '$error';
      });
    }
  }

  Future<void> _list() async {
    final generation = _generation;
    final result = await _client.call('thread/list', <String, Object?>{
      'includeArchived': false,
    });
    if (!mounted ||
        generation != _generation ||
        result is! Map ||
        result['threads'] is! List) {
      return;
    }
    setState(
      () => _threads = (result['threads'] as List)
          .whereType<Map>()
          .map((value) => value.cast<String, Object?>())
          .toList(),
    );
  }

  Future<void> _open(String id) async {
    final generation = _generation;
    await _events?.cancel();
    if (!mounted || generation != _generation) return;
    final previous = _thread;
    if (previous != null) await previous.dispose();
    if (!mounted || generation != _generation) return;
    final thread = NativeThread(_client, id);
    _thread = thread;
    _items.clear();
    _prompts.clear();
    // Events can arrive during resume; retain their native updates until the baseline is drawn.
    final held = <Map<String, Object?>>[];
    var loading = true;
    _events = thread.events.listen(
      (event) {
        if (loading) {
          held.add(event);
        } else {
          _event(event);
        }
      },
      onError: (Object error) {
        if (!mounted || _thread != thread) return;
        setState(() => _error = '$error');
        _reconnect?.cancel();
        _reconnect = Timer(const Duration(milliseconds: 300), () {
          if (mounted && _thread == thread) unawaited(_connect());
        });
      },
    );
    final snapshot = await thread.resume();
    if (!mounted || _thread != thread) return;
    for (final turn
        in (snapshot['turns'] as List? ?? <Object?>[]).whereType<Map>()) {
      for (final item
          in (turn['items'] as List? ?? <Object?>[]).whereType<Map>()) {
        if (item['id'] is String) {
          _items[item['id'] as String] = item.cast<String, Object?>();
        }
      }
    }
    _running = snapshot['running'] == true;
    loading = false;
    for (final event in held) {
      _event(event);
    }
    setState(() {});
  }

  void _event(Map<String, Object?> event) {
    if (!mounted) return;
    final params = event['params'];
    if (params is! Map) return;
    final method = event['method'];
    setState(() {
      if (method == 'turn/started') _running = true;
      if (method == 'turn/completed') _running = false;
      if (method == 'item/started' || method == 'item/completed') {
        final item = params['item'];
        if (item is Map && item['id'] is String) {
          _items[item['id'] as String] = item.cast<String, Object?>();
        }
      }
      if (method == 'item/agentMessage/delta' ||
          method == 'item/reasoning/delta') {
        final id = params['itemId'];
        final item = _items[id];
        if (item != null && params['delta'] is String) {
          item['text'] = '${item['text'] ?? ''}${params['delta']}';
        }
      }
      if (method == 'serverRequest/resolved') {
        _prompts.removeWhere((prompt) => prompt['id'] == params['requestId']);
      }
    });
  }

  Future<void> _perform(Future<void> Function() operation) async {
    try {
      await operation();
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    }
  }

  Future<void> _create() async {
    final result = await _client.call('thread/start', <String, Object?>{});
    if (result is Map && result['thread'] is Map) {
      await _list();
      await _open((result['thread'] as Map)['id'] as String);
    }
  }

  Future<void> _send() async {
    final text = _draft.text;
    if (text.trim().isEmpty || _thread == null) return;
    await _thread!.send(text);
    if (mounted) {
      setState(() {
        _draft.clear();
        _running = true;
      });
    }
  }

  Future<void> _answer(Map<String, Object?> prompt) async {
    final params = prompt['params'];
    if (params is! Map) return;
    final id = prompt['id'];
    if (id == null) return;
    if (prompt['method'] == 'item/approval/request') {
      final approved = await AppDialog.confirm(
        context,
        title: t('native.approval'),
        message: '${params['reason'] ?? ''}\n${jsonEncode(params['kind'])}',
        confirmLabel: t('native.approve'),
      );
      _client.respond(id, <String, Object?>{
        'decision': approved ? 'approved' : 'denied',
      });
    } else if (prompt['method'] == 'item/question/request') {
      final answers = <String, Object?>{};
      for (final question
          in (params['questions'] as List? ?? <Object?>[]).whereType<Map>()) {
        if (!mounted) return;
        final options = (question['options'] as List? ?? <Object?>[])
            .whereType<Map>()
            .map((option) => option['label'])
            .join(' / ');
        final answer = await AppDialog.prompt(
          context,
          title: '${question['question']}\n$options',
        );
        if (answer == null) return;
        answers['${question['id']}'] = <String, Object?>{
          'answers': <String>[answer],
        };
      }
      _client.respond(id, <String, Object?>{'answers': answers});
    }
    if (mounted) {
      setState(() => _prompts.removeWhere((entry) => entry['id'] == id));
    }
  }

  Future<void> _file() async {
    final thread = _thread;
    final generation = _generation;
    final path = await AppDialog.prompt(context, title: t('native.filePath'));
    if (!mounted ||
        generation != _generation ||
        _thread != thread ||
        path == null ||
        path.isEmpty ||
        thread == null) {
      return;
    }
    await _showFile(thread, path, download: false);
  }

  Future<void> _showFile(
    NativeThread thread,
    String path, {
    required bool download,
  }) async {
    final generation = _generation;
    final serverId = _server?.id;
    bool current() =>
        mounted &&
        generation == _generation &&
        identical(_thread, thread) &&
        _server?.id == serverId &&
        _client.ready;
    if (!current()) return;
    final transfer = FileTransfer(
      conversationId: thread.threadId,
      serverId: serverId ?? widget.serverId,
      readMethod: 'workspace/readFile',
      threadField: 'threadId',
      call: (method, payload, timeoutMs) async {
        if (!current()) throw const FileTransferError('cancelled');
        final result = await _client.call(
          method,
          (payload as Map).cast<String, Object?>(),
          timeout: Duration(milliseconds: timeoutMs ?? 30000),
        );
        if (!current()) throw const FileTransferError('cancelled');
        return result;
      },
    );
    final name = fileBaseName(path);
    final kind = outputFileKind(name);
    await showOutputFile(
      context,
      file: OutputFile(
        path: path,
        name: name,
        kind: kind == OutputFileKind.office ? OutputFileKind.other : kind,
        created: false,
      ),
      transfer: transfer,
      downloadOnOpen: download,
      opener: (saved) async => current() && await defaultFileOpener(saved),
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final thread = _thread;
    return AppScreen(
      title: _server?.alias ?? t('native.title'),
      subtitle: thread == null
          ? t('native.chats')
          : (_running ? t('native.running') : t('native.ready')),
      actions: <Widget>[
        AppAction(
          icon: AppIcons.refresh,
          tooltip: t('native.reconnect'),
          onPressed: () => unawaited(_connect()),
        ),
        if (thread == null)
          AppAction(
            icon: AppIcons.plus,
            tooltip: t('native.newChat'),
            onPressed: () => unawaited(_perform(_create)),
          ),
        if (thread != null)
          AppAction(
            icon: AppIcons.folder,
            tooltip: t('native.download'),
            onPressed: () => unawaited(_perform(_file)),
          ),
      ],
      bottomBar: thread == null
          ? null
          : Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  TextField(
                    controller: _draft,
                    minLines: 1,
                    maxLines: 5,
                    style: TextStyle(color: palette.text),
                    decoration: InputDecoration(hintText: t('native.message')),
                  ),
                  const SizedBox(height: 8),
                  PrimaryButton(
                    label: t(_running ? 'native.stop' : 'native.send'),
                    enabled: _client.ready && !_busy,
                    onPressed: () => unawaited(
                      _perform(
                        _running
                            ? () async {
                                await thread.interrupt();
                              }
                            : _send,
                      ),
                    ),
                  ),
                ],
              ),
            ),
      body: _busy
          ? const Center(child: BrandLoading())
          : ListView(
              padding: AppInsets.pad(context, const EdgeInsets.all(16)),
              children: <Widget>[
                if (_error != null) ...<Widget>[
                  Text(_error!, style: TextStyle(color: palette.danger)),
                  const SizedBox(height: 12),
                ],
                if (thread == null) ...<Widget>[
                  for (final row in _threads)
                    ListTile(
                      title: Text(
                        '${row['title'] == '' ? t('conn.untitled') : row['title']}',
                        style: TextStyle(color: palette.text),
                      ),
                      onTap: () =>
                          unawaited(_perform(() => _open(row['id'] as String))),
                    ),
                  if (_threads.isEmpty)
                    Text(
                      t('native.noChats'),
                      style: TextStyle(color: palette.muted),
                    ),
                ] else ...<Widget>[
                  SecondaryButton(
                    label: t('native.chats'),
                    onPressed: () => setState(() {
                      _thread = null;
                      unawaited(_events?.cancel());
                    }),
                  ),
                  for (final prompt in _prompts.where(
                    (entry) =>
                        (entry['params'] as Map?)?['threadId'] ==
                        thread.threadId,
                  ))
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: PrimaryButton(
                        label: t('native.waiting'),
                        onPressed: () =>
                            unawaited(_perform(() => _answer(prompt))),
                      ),
                    ),
                  for (final item in _items.values)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: NativeTranscriptItem(
                        item: item,
                        enabled: _client.ready && !_busy,
                        onFile: (path, {required download}) => unawaited(
                          _perform(
                            () => _showFile(thread, path, download: download),
                          ),
                        ),
                      ),
                    ),
                ],
              ],
            ),
    );
  }
}
