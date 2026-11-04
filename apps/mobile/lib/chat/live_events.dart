/// Reading a live engine event onto the transcript.
///
/// Pure and separate from the screen so the rules can be tested without a widget tree,
/// and so a streaming reducer cannot accidentally depend on render state.
///
/// The one rule worth stating: a call a `codemode` script made itself arrives as a
/// `tool_execution_*` event with a `parentToolCallId`. It is not a row of its own — the
/// script's own card lists its calls — so it is dropped here, which also stops each of
/// those events from costing a transcript reload.
library;

import 'message.dart';

/// The id of the call that made this one, when a tool ran it itself.
String? nestedParent(Map<String, Object?> event) {
  final parent = event['parentToolCallId'];
  return parent is String && parent.isNotEmpty ? parent : null;
}

/// A tool event's structured payload: on the event itself, or inside its partial result.
Object? toolEventDetails(Map<String, Object?> event) {
  final details = event['details'];
  if (details != null) return details;
  final partial = event['partialResult'];
  if (partial is Map && partial['details'] != null) return partial['details'];
  final result = event['result'];
  if (result is Map && result['details'] != null) return result['details'];
  return null;
}

/// A tool result as text. The engine's result is `{content: [{type: 'text', text}]}`;
/// the text parts are what a reader wants, not that object's JSON.
String? toolResultText(Object? value) {
  if (value is String) return value;
  if (value == null) return null;
  if (value is Map && value['content'] is List) {
    final parts = <String>[];
    for (final part in value['content'] as List) {
      if (part is String) {
        parts.add(part);
      } else if (part is Map && part['type'] == 'text' && part['text'] is String) {
        parts.add(part['text'] as String);
      }
    }
    final text = parts.where((part) => part.isNotEmpty).join('\n');
    // An update that only reports progress in `details` has no text yet.
    return text.isEmpty ? null : text;
  }
  return encodeJson(value);
}

String? _stringValue(Object? value) => value is String && value.isNotEmpty ? value : null;

class _LiveToolPatch {
  const _LiveToolPatch({
    required this.id,
    required this.status,
    this.name,
    this.args,
    this.result,
    this.details,
  });

  final String id;
  final String status;
  final String? name;
  final Object? args;
  final String? result;
  final Object? details;
}

/// Reduces one streamed event onto the transcript.
///
/// Returns the same list instance when nothing changed, so the caller's paint throttle
/// can skip a frame.
List<ChatMessage> applyLiveEngineEvent(List<ChatMessage> messages, Map<String, Object?> event) {
  final rawInner = event['type'] == 'message_update' ? event['assistantMessageEvent'] : null;
  final inner = rawInner is Map ? rawInner.cast<String, Object?>() : null;
  final type = inner?['type'] is String ? inner!['type'] as String : event['type'];

  if (type == 'text_delta' || type == 'thinking_delta') {
    final delta = inner?['delta'] is String
        ? inner!['delta'] as String
        : (inner?['text'] is String ? inner!['text'] as String : '');
    if (delta.isEmpty) return messages;
    final live = _ensureLiveAssistant(messages);
    final list = live.list;
    final index = live.index;
    final current = list[index];
    final parts = <MessagePart>[...?current.parts];
    final isText = type == 'text_delta';
    final previous = parts.isEmpty ? null : parts.last;
    if (isText && previous is TextPart) {
      parts[parts.length - 1] = TextPart(previous.text + delta);
    } else if (!isText && previous is ThinkingPart) {
      parts[parts.length - 1] = ThinkingPart(previous.text + delta);
    } else {
      parts.add(isText ? TextPart(delta) : ThinkingPart(delta));
    }
    final next = current.copy();
    if (isText) {
      next.text = current.text + delta;
    } else {
      next.thinking = '${current.thinking ?? ''}$delta';
    }
    next.parts = parts;
    list[index] = next;
    return list;
  }

  const toolCallTypes = <String>{
    'toolcall_start',
    'tool_call_start',
    'toolcall_delta',
    'tool_call_delta',
    'toolcall_end',
    'tool_call_end',
  };
  if (toolCallTypes.contains(type)) {
    final block = _partialToolBlock(inner);
    final live = _ensureLiveAssistant(messages);
    final list = live.list;
    final index = live.index;
    final current = list[index];
    final candidate = _stringValue(block?['id']) ?? _stringValue(inner?['id']);
    final isStart = type == 'toolcall_start' || type == 'tool_call_start';
    if (!isStart && candidate == null && !current.tools.any((tool) => tool.status == 'running' && tool.name.isEmpty)) {
      return list;
    }
    final id = _resolveLiveToolId(current, candidate);
    final isEnd = type == 'toolcall_end' || type == 'tool_call_end';
    return _upsertLiveTool(list, index, _LiveToolPatch(
      id: id,
      status: 'running',
      name: _stringValue(block?['name']) ?? _stringValue(inner?['name']),
      args: block?['arguments'] ??
          block?['input'] ??
          inner?['arguments'] ??
          inner?['args'] ??
          inner?['input'],
      result: isEnd ? _stringifyToolValue(inner?['result'] ?? inner?['output']) : null,
    ));
  }

  if (type == 'tool_execution_start' || type == 'tool_execution_update' || type == 'tool_execution_end') {
    if (nestedParent(event) != null) return messages;
    final isStart = type == 'tool_execution_start';
    if (!isStart && !messages.any((message) => message.isAssistant)) return messages;
    final live = _ensureLiveAssistant(messages);
    final list = live.list;
    final index = live.index;
    final current = list[index];
    final candidate = _stringValue(event['toolCallId']) ?? _stringValue(event['id']);
    if (!isStart && candidate == null && !current.tools.any((tool) => tool.status == 'running' && tool.name.isEmpty)) {
      return list;
    }
    final id = _resolveLiveToolId(current, candidate);
    return _upsertLiveTool(list, index, _LiveToolPatch(
      id: id,
      status: type == 'tool_execution_end' ? (event['isError'] == true ? 'error' : 'done') : 'running',
      name: _stringValue(event['toolName']) ?? _stringValue(event['name']),
      args: event['args'] ?? event['arguments'],
      // A streaming update carries its structured payload (codemode's call list)
      // inside the partial result.
      details: toolEventDetails(event),
      result: toolResultText(event['partialResult'] ?? event['result'] ?? event['output']),
    ));
  }

  return messages;
}

({List<ChatMessage> list, int index}) _ensureLiveAssistant(List<ChatMessage> messages) {
  final list = List<ChatMessage>.from(messages);
  final index = list.length - 1;
  final last = index >= 0 ? list[index] : null;
  if (last != null && last.isAssistant) {
    list[index] = last.copy();
    return (list: list, index: index);
  }
  list.add(ChatMessage(
    id: 'live-${DateTime.now().microsecondsSinceEpoch}',
    role: 'assistant',
    parts: <MessagePart>[],
    createdAt: DateTime.now().millisecondsSinceEpoch,
  ));
  return (list: list, index: list.length - 1);
}

List<ChatMessage> _upsertLiveTool(List<ChatMessage> list, int index, _LiveToolPatch patch) {
  final message = list[index];
  final tools = List<ToolBlock>.from(message.tools);
  final existingIndex = tools.indexWhere((tool) => tool.id == patch.id);
  if (existingIndex == -1) {
    tools.add(ToolBlock(
      id: patch.id,
      name: patch.name?.isNotEmpty == true ? patch.name! : 'tool',
      args: patch.args,
      result: patch.result,
      status: patch.status,
      details: patch.details,
    ));
    final next = message.copy();
    next.tools = tools;
    next.parts = <MessagePart>[...?message.parts, ToolPart(patch.id)];
    list[index] = next;
    return list;
  }
  final existing = tools[existingIndex];
  final updated = existing.copy();
  if (patch.name != null) updated.name = patch.name!;
  if (patch.args != null) updated.args = patch.args;
  if (patch.result != null) updated.result = patch.result;
  if (patch.details != null) updated.details = patch.details;
  updated.status = patch.status.isNotEmpty ? patch.status : existing.status;
  tools[existingIndex] = updated;
  final next = message.copy();
  next.tools = tools;
  list[index] = next;
  return list;
}

Map<String, Object?>? _partialToolBlock(Map<String, Object?>? inner) {
  final partial = inner?['partial'];
  if (inner == null || partial is! Map || partial['content'] is! List) return null;
  final content = partial['content'] as List;
  if (content.isEmpty) return null;
  final index = inner['contentIndex'] is int ? inner['contentIndex'] as int : content.length - 1;
  if (index < 0 || index >= content.length) return null;
  final block = content[index];
  return block is Map ? block.cast<String, Object?>() : null;
}

String _resolveLiveToolId(ChatMessage message, String? candidate) {
  if (candidate != null) return candidate;
  for (final tool in message.tools.reversed) {
    if (tool.status == 'running' && tool.name.isEmpty) return tool.id;
  }
  return 'tool-${DateTime.now().microsecondsSinceEpoch}';
}

String? _stringifyToolValue(Object? value) {
  if (value is String) return value;
  if (value == null) return null;
  return encodeJson(value);
}

/// A `message_start` for an assistant turn opens a new row only when the previous one
/// already wrote something: an empty row would be a blank bubble.
List<ChatMessage> applyMessageStart(List<ChatMessage> messages, Map<String, Object?> event) {
  final message = event['message'];
  if (message is! Map || message['role'] != 'assistant') return messages;
  final last = messages.isEmpty ? null : messages.last;
  if (last == null || !last.isAssistant || !last.hasContent) return messages;
  final createdAt = message['createdAt'] is num
      ? (message['createdAt'] as num).toInt()
      : (event['createdAt'] is num ? (event['createdAt'] as num).toInt() : DateTime.now().millisecondsSinceEpoch);
  return <ChatMessage>[
    ...messages,
    ChatMessage(
      id: 'live-${DateTime.now().microsecondsSinceEpoch}',
      role: 'assistant',
      parts: <MessagePart>[],
      createdAt: createdAt,
    ),
  ];
}

/// Merge a `tail` snapshot onto the rows already on screen, anchored at the entry the
/// snapshot begins from. Returns null when the anchor is gone, which forces a full read.
List<ChatMessage>? mergeMessageTail(List<ChatMessage> current, List<ChatMessage> tail, String anchorId) {
  final anchorIndex = current.indexWhere((message) => message.id == anchorId);
  if (anchorIndex < 0 || tail.isEmpty || tail.first.id != anchorId) return null;
  return <ChatMessage>[...current.sublist(0, anchorIndex), ...tail];
}

/// The instant the run in flight started: the first assistant message after the newest
/// user message. The footer and the working capsule must agree on where a run begins.
int? currentRunStartedAt(List<ChatMessage> messages) {
  var lastUser = -1;
  for (var index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role == 'user') {
      lastUser = index;
      break;
    }
  }
  for (var index = lastUser + 1; index < messages.length; index++) {
    final message = messages[index];
    if (message.isAssistant && message.createdAt != null) return message.createdAt;
  }
  return null;
}
