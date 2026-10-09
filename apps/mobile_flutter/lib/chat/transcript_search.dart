import 'package:flutter/material.dart';

import '../i18n/core.dart';
import '../screens/transcript.dart';
import '../ui/kit.dart';
import '../ui/sheet.dart';
import 'message.dart';

/// Search drains older history first, so a no-match result means the whole chat.
class TranscriptSearch extends StatefulWidget {
  const TranscriptSearch({super.key, required this.load});
  final Future<List<ChatMessage>> Function() load;
  @override
  State<TranscriptSearch> createState() => _TranscriptSearchState();
}

class _TranscriptSearchState extends State<TranscriptSearch> {
  final _query = TextEditingController();
  List<ChatMessage>? _messages;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _failed = false);
    try {
      final messages = await widget.load();
      if (mounted) setState(() => _messages = messages);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = paletteOf(context);
    final needle = _query.text.trim().toLowerCase();
    final results = needle.isEmpty
        ? <ChatMessage>[]
        : (_messages ?? <ChatMessage>[])
              .where((m) => m.text.toLowerCase().contains(needle))
              .toList()
              .reversed
              .toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AppSheetHeader(title: t('chat.search')),
          SearchField(
            controller: _query,
            placeholder: t('common.search'),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),
          if (_failed)
            TextButton(onPressed: _load, child: Text(t('chat.loadFailed')))
          else if (_messages == null)
            Text(t('chat.searchLoading'), style: TextStyle(color: p.muted))
          else if (needle.isEmpty)
            Text(t('chat.searchHint'), style: TextStyle(color: p.muted))
          else if (results.isEmpty)
            Text(t('common.noMatch'), style: TextStyle(color: p.muted)),
          Expanded(
            child: ListView.builder(
              padding: EdgeInsets.zero,
              itemCount: results.length,
              itemBuilder: (context, i) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: MessageRow(
                  meta: null,
                  message: results[i],
                  palette: p,
                  live: false,
                  turnStart: true,
                  onLongPress: (_) {},
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
