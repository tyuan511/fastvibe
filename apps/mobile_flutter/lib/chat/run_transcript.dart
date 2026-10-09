import 'dart:async';

import 'package:flutter/cupertino.dart'
    show CupertinoActivityIndicator, CupertinoButton;
import 'package:flutter/material.dart';

import '../i18n/core.dart';
import '../protocol/client.dart';
import '../screens/transcript.dart';
import '../session/connection.dart';
import '../ui/kit.dart';
import '../ui/sheet.dart';
import 'message.dart';

/// Subagent checkpoints are read at step boundaries, never for every streamed token.
class RunTranscript extends StatefulWidget {
  const RunTranscript({
    super.key,
    required this.conversationId,
    required this.runId,
  });
  final String conversationId;
  final String runId;
  @override
  State<RunTranscript> createState() => _RunTranscriptState();
}

class _RunTranscriptState extends State<RunTranscript> {
  List<ChatMessage> _messages = [];
  bool _loading = true;
  bool _failed = false;
  bool _pending = false;
  bool _again = false;
  int _limit = 40;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    Connection.instance.onEngineEvent(_event);
    Connection.instance.addListener(_connectionChanged);
    _read();
  }

  @override
  void dispose() {
    _timer?.cancel();
    Connection.instance.offEngineEvent(_event);
    Connection.instance.removeListener(_connectionChanged);
    super.dispose();
  }

  RemoteClient? _lastRemote;
  void _connectionChanged() {
    if (_lastRemote != Connection.instance.client) _read();
  }

  void _event(Map<String, Object?> event, EventMeta? meta) {
    if (event['conversationId'] != widget.conversationId ||
        event['subagentId'] != widget.runId) {
      return;
    }
    final inner = event['event'];
    if (event['type'] == 'subagent_lifecycle' ||
        (event['type'] == 'subagent_event' &&
            inner is Map &&
            ['turn_end', 'agent_settled'].contains(inner['type']))) {
      _timer?.cancel();
      _timer = Timer(const Duration(milliseconds: 150), _read);
    }
  }

  Future<void> _read() async {
    if (_pending) {
      _again = true;
      return;
    }
    final remote = Connection.instance.client;
    _lastRemote = remote;
    if (remote == null) {
      if (mounted) {
        setState(() {
          _loading = false;
          _failed = true;
        });
      }
      return;
    }
    _pending = true;
    try {
      final value = await remote.call('engine:get-subagent-messages', {
        'conversationId': widget.conversationId,
        'subagentId': widget.runId,
      });
      if (!mounted || remote != Connection.instance.client) return;
      if (value is! List) throw StateError(t('dag.loadFailed'));
      setState(() {
        _messages = value.map(ChatMessage.fromJson).toList();
        _failed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      _pending = false;
      if (mounted) {
        setState(() => _loading = false);
        if (_again) {
          _again = false;
          unawaited(_read());
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = paletteOf(context);
    final messages = _messages
        .skip((_messages.length - _limit).clamp(0, _messages.length))
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppSheetHeader(title: t('dag.execution')),
        if (_failed)
          CupertinoButton(onPressed: _read, child: Text(t('dag.refresh'))),
        if (_loading)
          const Padding(
            padding: EdgeInsets.all(12),
            child: CupertinoActivityIndicator(),
          ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
            children: [
              if (_messages.length > _limit)
                CupertinoButton(
                  onPressed: () => setState(() => _limit += 40),
                  child: Text(t('dag.earlier')),
                ),
              if (!_loading && messages.isEmpty)
                Text(
                  t(_failed ? 'dag.loadFailed' : 'dag.noExecution'),
                  style: TextStyle(color: p.muted),
                ),
              for (final message in messages)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: MessageRow(
                    message: message,
                    meta: null,
                    palette: p,
                    turnStart: false,
                    live: false,
                    onLongPress: (_) {},
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
