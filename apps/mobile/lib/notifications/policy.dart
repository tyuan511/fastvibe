import '../i18n/core.dart';

/// One phone notification's worth of decision.
class MobileNotice {
  const MobileNotice({required this.kind, required this.conversationId, this.title, this.key});

  /// done | error | waiting
  final String kind;
  final String conversationId;
  final String? title;

  /// Deduplication key: the same event replayed must not raise a second banner.
  final String? key;
}

class NoticeContext {
  const NoticeContext({
    required this.background,
    required this.enabled,
    required this.serverId,
    required this.conversations,
    required this.archivedIds,
  });

  final bool background;
  final bool enabled;
  final String serverId;
  final List<({String id, String? kind})> conversations;
  final List<String> archivedIds;
}

const Set<String> _blockingMethods = <String>{'confirm', 'select', 'input', 'editor', 'questions'};

String? _eligibleConversation(Map<String, Object?> event, NoticeContext context) {
  final id = event['conversationId'];
  if (id is! String || id.isEmpty) return null;
  ({String id, String? kind})? conversation;
  for (final item in context.conversations) {
    if (item.id == id) {
      conversation = item;
      break;
    }
  }
  if (conversation == null || conversation.kind == 'side-chat') return null;
  if (context.archivedIds.contains(id)) return null;
  return id;
}

/// Decide whether a server event should produce one phone notification.
///
/// Only three things are worth a banner: a run finishing, a run failing, and a prompt
/// that has parked a tool call until somebody answers. The first two are "you can come
/// back now"; the third is the only one that is actually blocking.
MobileNotice? mobileNoticeForEvent(Map<String, Object?> event, NoticeContext context) {
  if (!context.background || !context.enabled) return null;

  final conversationId = _eligibleConversation(event, context);
  if (conversationId == null) return null;

  if (event['type'] == 'conversation_activity') {
    final status = event['status'];
    if (status != 'completed' && status != 'failed') return null;
    final seq = event['seq'];
    return MobileNotice(
      kind: status == 'completed' ? 'done' : 'error',
      conversationId: conversationId,
      title: event['title'] is String ? event['title'] as String : null,
      key: seq is num
          ? '${context.serverId}|$conversationId|$seq'
          : null,
    );
  }

  if (event['type'] != 'extension_ui_request') return null;
  final method = event['method'];
  if (method is! String || !_blockingMethods.contains(method)) return null;
  final id = event['id'];
  if (id is! String || id.isEmpty) return null;

  return MobileNotice(
    kind: 'waiting',
    conversationId: conversationId,
    key: '${context.serverId}|$id',
  );
}

/// The title a banner shows for a notice.
String noticeTitle(MobileNotice notice) => switch (notice.kind) {
      'done' => t('notifications.doneTitle'),
      'error' => t('notifications.errorTitle'),
      _ => t('notifications.waitingTitle'),
    };

String noticeBody(MobileNotice notice) => switch (notice.kind) {
      'done' => t('notifications.doneBody'),
      'error' => t('notifications.errorBody'),
      _ => t('notifications.waitingBody'),
    };
