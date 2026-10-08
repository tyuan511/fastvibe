import 'dart:convert';

/// One row of the transcript as the phone draws it.
///
/// A reply is one row: consecutive assistant messages (one per model round trip) are
/// merged, so a run that called five tools then answered is a single row with one footer
/// rather than six. The merged row keeps the **first** message's id, which is what stops
/// a streaming run from remounting and closing a card the reader had opened.
class ChatMessage {
  ChatMessage({
    required this.id,
    required this.role,
    this.text = '',
    this.thinking,
    List<ToolBlock>? tools,
    this.error,
    this.stop,
    this.kind,
    this.dag,
    this.createdAt,
    this.completedAt,
    this.compact,
    this.parts,
    this.attachments,
    this.lastId,
  }) : tools = tools ?? <ToolBlock>[];

  factory ChatMessage.fromJson(Object? value) {
    if (value is! Map) return ChatMessage(id: 'message', role: 'assistant');
    final map = value.cast<String, Object?>();
    final tools = <ToolBlock>[];
    if (map['tools'] is List) {
      for (final item in map['tools'] as List) {
        final block = ToolBlock.fromJson(item);
        if (block != null) tools.add(block);
      }
    }
    final parts = parseParts(map['parts']);
    final attachments = parseAttachments(map['attachments']);
    return ChatMessage(
      id: map['id'] is String ? map['id'] as String : 'message-${DateTime.now().microsecondsSinceEpoch}',
      role: map['role'] is String ? map['role'] as String : 'assistant',
      text: map['text'] is String ? map['text'] as String : '',
      thinking: map['thinking'] is String ? map['thinking'] as String : null,
      tools: tools,
      error: map['error'] is String ? map['error'] as String : null,
      stop: map['stop'] is String ? map['stop'] as String : null,
      kind: map['kind'] is String ? map['kind'] as String : null,
      dag: map['dag'] is Map ? DagSummary.fromJson(map['dag'] as Map) : null,
      createdAt: map['createdAt'] is num ? (map['createdAt'] as num).toInt() : null,
      completedAt: map['completedAt'] is num ? (map['completedAt'] as num).toInt() : null,
      compact: map['compact'] is Map ? CompactInfo.fromJson(map['compact'] as Map) : null,
      parts: parts.isEmpty ? null : parts,
      attachments: attachments.isEmpty ? null : attachments,
    );
  }

  final String id;
  final String role;
  String text;
  String? thinking;
  List<ToolBlock> tools;
  String? error;
  String? stop;
  String? kind;
  DagSummary? dag;
  int? createdAt;
  int? completedAt;
  CompactInfo? compact;
  List<MessagePart>? parts;
  List<ChatAttachment>? attachments;

  /// On a merged row: the id of the last message folded into it, which is where the
  /// turn footer is looked up.
  String? lastId;

  bool get isAssistant => role == 'assistant';

  bool get joinable => role == 'assistant' && kind != 'compact';

  bool get hasContent => text.trim().isNotEmpty || (thinking?.trim().isNotEmpty ?? false) || tools.isNotEmpty;

  ChatMessage copy() => ChatMessage(
        id: id,
        role: role,
        text: text,
        thinking: thinking,
        tools: List<ToolBlock>.from(tools),
        error: error,
        stop: stop,
        kind: kind,
        dag: dag,
        createdAt: createdAt,
        completedAt: completedAt,
        compact: compact,
        parts: parts == null ? null : List<MessagePart>.from(parts!),
        attachments: attachments,
        lastId: lastId,
      );
}

class DagSummary {
  const DagSummary({this.settled, this.completed, this.failed, this.blocked});

  factory DagSummary.fromJson(Map<dynamic, dynamic> map) => DagSummary(
        settled: map['settled'] is bool ? map['settled'] as bool : null,
        completed: map['completed'] is num ? (map['completed'] as num).toInt() : null,
        failed: map['failed'] is num ? (map['failed'] as num).toInt() : null,
        blocked: map['blocked'] is num ? (map['blocked'] as num).toInt() : null,
      );

  final bool? settled;
  final int? completed;
  final int? failed;
  final int? blocked;
}

class ToolBlock {
  ToolBlock({
    required this.id,
    required this.name,
    this.args,
    this.result,
    this.status,
    this.details,
  });

  static ToolBlock? fromJson(Object? value) {
    if (value is! Map) return null;
    final name = value['name'];
    if (name is! String) return null;
    return ToolBlock(
      id: value['id'] is String ? value['id'] as String : 'tool-${DateTime.now().microsecondsSinceEpoch}',
      name: name,
      args: value['args'],
      result: value['result'] is String ? value['result'] as String : null,
      status: value['status'] is String ? value['status'] as String : null,
      details: value['details'],
    );
  }

  final String id;
  String name;
  Object? args;
  String? result;

  /// running | done | error | aborted
  String? status;
  Object? details;

  ToolBlock copy() => ToolBlock(id: id, name: name, args: args, result: result, status: status, details: details);
}

class CompactInfo {
  const CompactInfo({this.status, this.reason, this.tokensBefore, this.tokensAfter, this.error});

  factory CompactInfo.fromJson(Map<dynamic, dynamic> map) => CompactInfo(
        status: map['status'] is String ? map['status'] as String : null,
        reason: map['reason'] is String ? map['reason'] as String : null,
        tokensBefore: map['tokensBefore'] is num ? (map['tokensBefore'] as num).toInt() : null,
        tokensAfter: map['tokensAfter'] is num ? (map['tokensAfter'] as num).toInt() : null,
        error: map['error'] is String ? map['error'] as String : null,
      );

  final String? status;
  final String? reason;
  final int? tokensBefore;
  final int? tokensAfter;
  final String? error;
}

class ChatAttachment {
  const ChatAttachment({required this.id, required this.kind, required this.name, this.mimeType, this.dataUrl});

  final String id;
  final String kind;
  final String name;
  final String? mimeType;
  final String? dataUrl;

  String? get base64 {
    final url = dataUrl;
    if (url == null) return null;
    final match = RegExp(r'^data:([^;,]+);base64,(.+)$', dotAll: true).firstMatch(url);
    return match?.group(2);
  }
}

/// One piece of a reply, in the order the model produced it.
sealed class MessagePart {
  const MessagePart();
}

class TextPart extends MessagePart {
  const TextPart(this.text);

  final String text;
}

class ThinkingPart extends MessagePart {
  const ThinkingPart(this.text);

  final String text;
}

class ToolPart extends MessagePart {
  const ToolPart(this.toolId);

  final String toolId;
}

class CompactPart extends MessagePart {
  const CompactPart(this.text, this.compact);

  final String text;
  final CompactInfo? compact;
}

class ModelPart extends MessagePart {
  const ModelPart(this.provider, this.model);

  final String? provider;
  final String? model;
}

class ErrorPart extends MessagePart {
  const ErrorPart(this.text);

  final String text;
}

List<MessagePart> parseParts(Object? value) {
  if (value is! List) return <MessagePart>[];
  final parts = <MessagePart>[];
  for (final item in value) {
    if (item is! Map) continue;
    final kind = item['kind'];
    switch (kind) {
      case 'text':
        if (item['text'] is String) parts.add(TextPart(item['text'] as String));
      case 'thinking':
        if (item['text'] is String) parts.add(ThinkingPart(item['text'] as String));
      case 'tool':
        if (item['toolId'] is String) parts.add(ToolPart(item['toolId'] as String));
      case 'compact':
        parts.add(CompactPart(
          item['text'] is String ? item['text'] as String : '',
          item['compact'] is Map ? CompactInfo.fromJson(item['compact'] as Map) : null,
        ));
      case 'model':
        final to = item['to'];
        parts.add(ModelPart(
          to is Map && to['provider'] is String ? to['provider'] as String : null,
          to is Map && to['id'] is String ? to['id'] as String : null,
        ));
      case 'error':
        if (item['text'] is String) parts.add(ErrorPart(item['text'] as String));
    }
  }
  return parts;
}

List<ChatAttachment> parseAttachments(Object? value) {
  if (value is! List) return <ChatAttachment>[];
  final attachments = <ChatAttachment>[];
  for (final item in value) {
    if (item is! Map) continue;
    final dataUrl = item['dataUrl'];
    if (item['kind'] != 'image' || dataUrl is! String) continue;
    attachments.add(ChatAttachment(
      id: item['id'] is String ? item['id'] as String : 'attachment',
      kind: 'image',
      name: item['name'] is String ? item['name'] as String : 'image',
      mimeType: item['mimeType'] is String ? item['mimeType'] as String : null,
      dataUrl: dataUrl,
    ));
  }
  return attachments;
}

/// The parts of a message, synthesised from the older fields when the engine did not
/// send a `parts` list (an imported chat, a transcript from an older build).
List<MessagePart> partsOf(ChatMessage message) {
  final parts = message.parts;
  if (parts != null && parts.isNotEmpty) return parts;
  final synthesised = <MessagePart>[];
  if (message.thinking != null && message.thinking!.isNotEmpty) synthesised.add(ThinkingPart(message.thinking!));
  if (message.text.isNotEmpty) synthesised.add(TextPart(message.text));
  for (final tool in message.tools) {
    synthesised.add(ToolPart(tool.id));
  }
  return synthesised;
}

/// Fold consecutive assistant messages into one row.
///
/// The cache is keyed by the incoming message object and only reused while the row it was
/// merged against is the same instance, so a completed reply keeps its identity across
/// streamed updates (and a card the reader opened stays open).
List<ChatMessage> mergeReplies(List<ChatMessage> messages, Map<ChatMessage, ({ChatMessage previous, ChatMessage merged})> cache) {
  final out = <ChatMessage>[];
  for (final message in messages) {
    final previous = out.isEmpty ? null : out.last;
    if (previous == null || !previous.joinable || !message.joinable) {
      out.add(message);
      continue;
    }
    var entry = cache[message];
    if (entry == null || !identical(entry.previous, previous)) {
      entry = (previous: previous, merged: combineReplies(previous, message));
      cache[message] = entry;
    }
    out[out.length - 1] = entry.merged;
  }
  return out;
}

ChatMessage combineReplies(ChatMessage previous, ChatMessage message) {
  final parts = <MessagePart>[
    ...partsOf(previous),
    if (previous.error != null && previous.error!.isNotEmpty) ErrorPart(previous.error!),
    ...partsOf(message),
  ];
  final text = <String>[
    if (previous.text.trim().isNotEmpty) previous.text,
    if (message.text.trim().isNotEmpty) message.text,
  ].join('\n\n');
  return ChatMessage(
    id: previous.id,
    role: message.role,
    text: text,
    tools: <ToolBlock>[...previous.tools, ...message.tools],
    error: message.error,
    stop: message.stop,
    kind: message.kind,
    dag: message.dag,
    createdAt: previous.createdAt ?? message.createdAt,
    completedAt: message.completedAt,
    compact: message.compact,
    parts: parts,
    attachments: message.attachments,
    lastId: message.lastId ?? message.id,
  );
}

/// One thing the transcript draws, after folding a reply's parts into blocks.
sealed class RenderBlock {
  const RenderBlock();
}

class TextBlock extends RenderBlock {
  const TextBlock(this.text);

  final String text;
}

class ErrorBlock extends RenderBlock {
  const ErrorBlock(this.text);

  final String text;
}

class CompactBlock extends RenderBlock {
  const CompactBlock(this.text, this.compact);

  final String text;
  final CompactInfo? compact;
}

class ModelBlock extends RenderBlock {
  const ModelBlock(this.model);

  final String? model;
}

class DagBlock extends RenderBlock {
  const DagBlock(this.dag);

  final DagSummary? dag;
}

/// A stretch of thinking and tool calls with no prose between them: one card.
class ProcessBlock extends RenderBlock {
  const ProcessBlock(this.steps);

  final List<ProcessStep> steps;

  ProcessBlock withStep(ProcessStep step) => ProcessBlock(<ProcessStep>[...steps, step]);
}

sealed class ProcessStep {
  const ProcessStep();
}

class ThinkingStep extends ProcessStep {
  const ThinkingStep(this.text);

  final String text;
}

class ToolStep extends ProcessStep {
  const ToolStep(this.tool);

  final ToolBlock tool;
}

/// Turns a merged reply into render blocks. Only what the reader must read — prose, a
/// compaction notice, a model divider, an error — interrupts a process card.
List<RenderBlock> buildBlocks(ChatMessage message) {
  final byId = <String, ToolBlock>{for (final tool in message.tools) tool.id: tool};
  final blocks = <RenderBlock>[];
  void pushProcess(ProcessStep step) {
    final last = blocks.isEmpty ? null : blocks.last;
    if (last is ProcessBlock) {
      blocks[blocks.length - 1] = last.withStep(step);
    } else {
      blocks.add(ProcessBlock(<ProcessStep>[step]));
    }
  }

  for (final part in partsOf(message)) {
    switch (part) {
      case TextPart(:final text):
        if (text.trim().isNotEmpty) blocks.add(TextBlock(text));
      case ThinkingPart(:final text):
        if (text.trim().isNotEmpty) pushProcess(ThinkingStep(text));
      case ToolPart(:final toolId):
        final tool = byId[toolId];
        if (tool != null) pushProcess(ToolStep(tool));
      case ErrorPart(:final text):
        if (text.trim().isNotEmpty) blocks.add(ErrorBlock(text));
      case CompactPart(:final text, :final compact):
        blocks.add(CompactBlock(text, compact));
      case ModelPart(:final model):
        blocks.add(ModelBlock(model));
    }
  }
  return blocks;
}

String encodeJson(Object? value) {
  try {
    return const JsonEncoder.withIndent('  ').convert(value);
  } catch (_) {
    return '$value';
  }
}
