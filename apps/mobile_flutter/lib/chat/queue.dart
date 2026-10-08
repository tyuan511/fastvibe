import '../i18n/core.dart';
import '../protocol/client.dart';

/// The native client's validated projection of the shared `ConversationQueueState`.
///
/// The queue's only authority is Main. The phone holds this projection, and every reply
/// and push passes through [mergeQueue]'s revision gate — including the cancel and resume
/// replies — so a late RPC cannot revive a delivered item or an old pause.
class QueueItem {
  const QueueItem({
    required this.id,
    required this.text,
    required this.behavior,
    this.sending = false,
    this.claimed = false,
  });

  final String id;
  final String text;

  /// steer | followUp
  final String behavior;
  final bool sending;
  final bool claimed;
}

class QueueState {
  const QueueState({
    required this.conversationId,
    required this.revision,
    required this.items,
    this.pause,
  });

  final String conversationId;
  final int revision;
  final List<QueueItem> items;

  /// stopped | error | null
  final String? pause;
}

QueueState emptyQueue(String conversationId) =>
    QueueState(conversationId: conversationId, revision: -1, items: const <QueueItem>[]);

/// A lost acknowledgement is not proof of refusal; never encourage a duplicate send.
class SubmissionUncertainError extends Error {
  SubmissionUncertainError() : message = t('queue.uncertain');

  final String message;

  @override
  String toString() => message;
}

/// All replies and pushes pass through this gate, including cancel/resume replies.
QueueState mergeQueue(QueueState current, Object? value) {
  if (value is! Map) return current;
  final conversationId = value['conversationId'];
  final revision = value['revision'];
  final items = value['items'];
  final pause = value['pause'];
  if (conversationId != current.conversationId) return current;
  if (revision is! int || revision < current.revision) return current;
  if (items is! List) return current;
  if (pause != null && pause != 'stopped' && pause != 'error') return current;
  final parsed = <QueueItem>[];
  for (final item in items) {
    // Do not silently empty part of an invalid queue: it could make Send bypass it.
    if (item is! Map) return current;
    final id = item['id'];
    final text = item['text'];
    final behavior = item['behavior'];
    if (id is! String || text is! String) return current;
    if (item['conversationId'] != current.conversationId) return current;
    if (behavior != 'steer' && behavior != 'followUp') return current;
    parsed.add(QueueItem(
      id: id,
      text: text,
      behavior: behavior as String,
      sending: item['sending'] == true,
      claimed: item['claimed'] == true,
    ));
  }
  return QueueState(
    conversationId: current.conversationId,
    revision: revision,
    items: parsed,
    pause: pause as String?,
  );
}

/// Capture before any await: a Stop during record-prompt must keep this send queued.
bool shouldQueueMessage(bool running, QueueState queue) => running || queue.items.isNotEmpty;

bool shouldHoldSend({required bool sending, required bool queueLoading}) => sending || queueLoading;

class PromptImage {
  const PromptImage({required this.data, this.mimeType = 'image/jpeg'});

  final String data;
  final String mimeType;

  Map<String, Object?> toJson() => <String, Object?>{'type': 'image', 'data': data, 'mimeType': mimeType};
}

/// A queued prompt's optimistic title/preview, so a failed send can be rolled back.
class QueuedPromptPreview {
  const QueuedPromptPreview({
    required this.previousTitle,
    this.previousPreview,
    required this.nextTitle,
    this.nextPreview,
  });

  final String previousTitle;
  final String? previousPreview;
  final String nextTitle;
  final String? nextPreview;
}

/// Uses the host's durable queue, never `engine:prompt`'s implicit mid-run steering.
Future<Object?> submitMessage(
  RemoteClient remote, {
  required String conversationId,
  required String text,
  List<PromptImage>? images,
  required bool enqueue,
  ({String title, String? preview})? previous,
  required void Function() onPrompt,
}) async {
  // A desktop gateway may route to an older SSH Agent whose methods weren't advertised
  // by this welcome. Keep that route on the compatible call sequence.
  if (remote.supportsPromptSubmit && !conversationId.startsWith('remote:')) {
    if (!enqueue) onPrompt();
    try {
      return await remote.call(
        'engine:submit-prompt',
        <String, Object?>{
          'conversationId': conversationId,
          'text': text,
          'enqueue': enqueue,
          if (images != null && images.isNotEmpty) 'images': images.map((image) => image.toJson()).toList(),
        },
        60000,
      );
    } catch (error) {
      if (isLostAcknowledgement(error)) throw SubmissionUncertainError();
      rethrow;
    }
  }
  final catalog = await remote.call('conversations:record-prompt', <String, Object?>{
    'id': conversationId,
    'text': text,
  });
  QueuedPromptPreview? preview;
  if (previous != null && catalog is Map && catalog['conversations'] is List) {
    for (final item in catalog['conversations'] as List) {
      if (item is! Map || item['id'] != conversationId) continue;
      final title = item['title'];
      if (title is String) {
        preview = QueuedPromptPreview(
          previousTitle: previous.title,
          previousPreview: previous.preview,
          nextTitle: title,
          nextPreview: item['preview'] is String ? item['preview'] as String : null,
        );
      }
      break;
    }
  }
  var dispatched = false;
  try {
    if (enqueue) {
      final settings = await remote.call('settings:get');
      // /compact is a command; steering it would inject the literal text into a run.
      final compact = RegExp(r'^/compact(?:\s|$)').hasMatch(text);
      final behavior = !compact && settings is Map && settings['queueBehavior'] == 'steer' ? 'steer' : 'followUp';
      dispatched = true;
      return await remote.call('engine:queue-add', <String, Object?>{
        'conversationId': conversationId,
        'text': text,
        'message': text,
        'behavior': behavior,
        if (images != null && images.isNotEmpty) 'images': images.map((image) => image.toJson()).toList(),
        if (preview != null)
          'preview': <String, Object?>{
            'previousTitle': preview.previousTitle,
            'previousPreview': ?preview.previousPreview,
            'nextTitle': preview.nextTitle,
            'nextPreview': ?preview.nextPreview,
          },
      });
    }
    // Only a direct submission gets an optimistic transcript row. Queued prompts
    // appear there when Main actually delivers them, not when they enter the tray.
    onPrompt();
    dispatched = true;
    await remote.call(
      'engine:prompt',
      <String, Object?>{
        'message': text,
        if (images != null && images.isNotEmpty) 'images': images.map((image) => image.toJson()).toList(),
        'conversationId': conversationId,
      },
      60000,
    );
    return null;
  } catch (error) {
    // `TransportError` is what the client uses when it cannot know whether Main committed.
    if (dispatched && isLostAcknowledgement(error)) throw SubmissionUncertainError();
    if (preview != null) {
      try {
        await remote.call('conversations:restore-prompt', <String, Object?>{
          'id': conversationId,
          'expectedTitle': preview.nextTitle,
          'expectedPreview': ?preview.nextPreview,
          'title': preview.previousTitle,
          'preview': ?preview.previousPreview,
        });
      } catch (_) {
        // The rollback is best-effort; the original failure is what the caller reports.
      }
    }
    rethrow;
  }
}

/// The client's `TransportError`: the request left, the answer never came.
///
/// Matched by its code, never by its (translated) message — an English phone would miss a
/// Chinese pattern and then roll back a prompt Main may have taken.
bool isLostAcknowledgement(Object error) =>
    error is TransportError && (error.code == 'timeout' || error.code == 'dropped' || error.code == 'closed');
