import 'dart:convert';

/// Payloads carry both identities: conversation ids are only unique on one machine.
class NotificationTarget {
  const NotificationTarget(this.serverId, this.conversationId);
  final String serverId;
  final String conversationId;

  String encode() =>
      jsonEncode({'serverId': serverId, 'conversationId': conversationId});

  static NotificationTarget? parse(String? payload) {
    if (payload == null || payload.isEmpty) return null;
    try {
      final value = jsonDecode(payload);
      if (value is! Map ||
          value['serverId'] is! String ||
          value['conversationId'] is! String) {
        return null;
      }
      final target = NotificationTarget(
        value['serverId'] as String,
        value['conversationId'] as String,
      );
      return target.serverId.isEmpty || target.conversationId.isEmpty
          ? null
          : target;
    } catch (_) {
      // Notifications from the first Flutter build remain tappable after an upgrade.
      final parts = payload.split('|');
      if (parts.length == 2 && parts.every((part) => part.isNotEmpty)) {
        return NotificationTarget(parts[0], parts[1]);
      }
      return null;
    }
  }
}
