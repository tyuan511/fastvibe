import '../i18n/core.dart';
import 'message.dart';

/// The desktop reply footer, reduced to the two facts a finished turn can state:
/// when it finished, and how long the whole turn took.
///
/// A turn is one user prompt plus every assistant round-trip that followed it. The footer
/// sits on the last row of that group, and a turn still in flight gets none — the working
/// capsule is already saying that, and a finish time read mid-run would be the previous
/// round-trip's.
class TurnMeta {
  const TurnMeta({required this.endedAt, this.elapsedMs});

  /// Completion instant, falling back to the request start when the end was not timed.
  final int endedAt;

  /// Whole turn: first request start to the last entry's completion. Absent when untimed.
  final int? elapsedMs;
}

Map<String, TurnMeta> completedTurnFooters(
  List<ChatMessage> messages,
  bool running, [
  Map<String, TurnMeta>? previous,
]) {
  final footers = <String, TurnMeta>{};
  var unchanged = previous != null;
  var index = 0;
  while (index < messages.length) {
    ChatMessage? first;
    ChatMessage? last;
    do {
      final message = messages[index++];
      if (message.isAssistant) {
        first ??= message;
        last = message;
      }
    } while (index < messages.length && messages[index].role != 'user');
    final isTail = index >= messages.length;
    if (running && isTail) continue;
    if (first == null || last == null) continue;
    final endedAt = last.completedAt ?? last.createdAt ?? first.createdAt;
    if (endedAt == null) continue;
    final elapsedMs = last.completedAt != null && first.createdAt != null
        ? (last.completedAt! - first.createdAt!).clamp(0, 1 << 62)
        : null;
    final id = messages[index - 1].id;
    final value = TurnMeta(
      endedAt: endedAt,
      elapsedMs: elapsedMs != null && elapsedMs > 0 ? elapsedMs : null,
    );
    final cached = previous?[id];
    final entry = cached != null && cached.endedAt == value.endedAt && cached.elapsedMs == value.elapsedMs
        ? cached
        : value;
    if (!identical(entry, cached)) unchanged = false;
    footers[id] = entry;
  }
  if (unchanged && previous != null && previous.length == footers.length) return previous;
  return footers;
}

/// `14:32` today, `9月3日 14:32` otherwise — the same rule as the desktop footer.
String formatTurnClock(int timestamp, [int? now]) {
  final date = DateTime.fromMillisecondsSinceEpoch(timestamp);
  final reference = DateTime.fromMillisecondsSinceEpoch(now ?? DateTime.now().millisecondsSinceEpoch);
  final sameDay = date.year == reference.year && date.month == reference.month && date.day == reference.day;
  final hour = date.hour.toString().padLeft(2, '0');
  final minute = date.minute.toString().padLeft(2, '0');
  final time = '$hour:$minute';
  if (sameDay) return time;
  final day = formatMonthDay(date, withYear: date.year != reference.year);
  return '$day $time';
}

/// Spoken duration, matching the desktop footer: `41秒`, `3分钟 41秒`, `1小时 2分钟 3秒`.
String formatTurnSpent(int milliseconds) {
  if (milliseconds < 0) return '';
  final total = (milliseconds / 1000).round();
  final hours = total ~/ 3600;
  final minutes = (total % 3600) ~/ 60;
  final seconds = total % 60;
  final parts = <String>[];
  if (hours > 0) parts.add(t('time.hours', vars: <String, Object?>{'n': hours}));
  if (minutes > 0) parts.add(t('time.minutes', vars: <String, Object?>{'n': minutes}));
  if (seconds > 0 || parts.isEmpty) parts.add(t('time.seconds', vars: <String, Object?>{'n': seconds}));
  return parts.join(' ');
}

String formatTurnMeta(TurnMeta meta, [int? now]) {
  final clock = formatTurnClock(meta.endedAt, now);
  if (clock.isEmpty) return '';
  final spent = meta.elapsedMs != null ? formatTurnSpent(meta.elapsedMs!) : '';
  return spent.isNotEmpty ? t('time.turnSpent', vars: <String, Object?>{'clock': clock, 'spent': spent}) : clock;
}

/// `刚刚` / `5分钟前` / `3小时前` / `昨天` / `9月3日` — a list row's timestamp.
String relativeTime(int timestamp, [int? now]) {
  final reference = now ?? DateTime.now().millisecondsSinceEpoch;
  final diff = reference - timestamp;
  if (diff < 60000) return t('time.justNow');
  if (diff < 3600000) return t('time.minutesAgo', vars: <String, Object?>{'n': diff ~/ 60000});
  if (diff < 86400000) return t('time.hoursAgo', vars: <String, Object?>{'n': diff ~/ 3600000});
  if (diff < 172800000) return t('time.yesterday');
  final date = DateTime.fromMillisecondsSinceEpoch(timestamp);
  return formatMonthDay(date, withYear: date.year != DateTime.fromMillisecondsSinceEpoch(reference).year);
}

/// `mm:ss`, or `h:mm:ss` past an hour — the working capsule's counter.
String formatElapsed(int milliseconds) {
  final total = (milliseconds / 1000).floor().clamp(0, 1 << 40);
  final hours = total ~/ 3600;
  final minutes = (total % 3600) ~/ 60;
  final seconds = total % 60;
  final mm = minutes.toString().padLeft(2, '0');
  final ss = seconds.toString().padLeft(2, '0');
  return hours > 0 ? '$hours:$mm:$ss' : '$mm:$ss';
}
