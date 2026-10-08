import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../i18n/core.dart';
import '../session/connection.dart';
import '../ui/preferences.dart';
import 'policy.dart';

const String _channelId = 'fastvibe-activity';

final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
final Set<String> _seenKeys = <String>{};

/// What a tap on a banner should open.
typedef OpenNotificationTarget = void Function(String serverId, String conversationId);

/// Install the phone's local-notification bridge once from the app root.
///
/// This listens to the already-authenticated engine stream rather than creating a second
/// connection. It is therefore useful while the app is backgrounded but cannot wake a
/// process the OS has suspended or killed; remote push is a later phase of the feature.
class LocalNotifications {
  LocalNotifications._();

  static final LocalNotifications instance = LocalNotifications._();

  OpenNotificationTarget? _onOpen;

  Future<void> install(OpenNotificationTarget onOpen) async {
    _onOpen = onOpen;
    const settings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(
        requestAlertPermission: false,
        requestBadgePermission: false,
        requestSoundPermission: false,
      ),
    );
    try {
      await _plugin.initialize(
        settings: settings,
        onDidReceiveNotificationResponse: (response) {
          final payload = response.payload;
          if (payload == null) return;
          final parts = payload.split('|');
          if (parts.length != 2) return;
          _onOpen?.call(parts[0], parts[1]);
        },
      );
    } catch (_) {
      // A platform without notification support still runs the app.
    }
    await _prepare();
    Connection.instance.onEngineEvent(_handleEvent);
  }

  void _handleEvent(Map<String, Object?> event, Object? meta) {
    final connection = Connection.instance;
    final notice = mobileNoticeForEvent(event, NoticeContext(
      background: WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed,
      enabled: Preferences.instance.notifications,
      serverId: connection.server?.id ?? '',
      conversations: connection.conversations
          .map((item) => (id: item.id, kind: item.kind))
          .toList(),
      archivedIds: connection.archivedIds,
    ));
    if (notice == null) return;
    final key = notice.key;
    if (key != null) {
      if (_seenKeys.contains(key)) return;
      _seenKeys.add(key);
      if (_seenKeys.length > 1000) _seenKeys.remove(_seenKeys.first);
    }
    unawaited(_present(notice, connection.server?.id ?? ''));
  }

  Future<void> _present(MobileNotice notice, String serverId) async {
    if (serverId.isEmpty) return;
    final connection = Connection.instance;
    String? conversationTitle;
    for (final item in connection.conversations) {
      if (item.id == notice.conversationId) {
        conversationTitle = item.title;
        break;
      }
    }
    final title = notice.kind == 'waiting'
        ? t('notifications.waitingTitle')
        : (notice.title ?? conversationTitle ?? t('common.conversation'));
    try {
      await _plugin.show(
        id: notice.key?.hashCode ?? DateTime.now().millisecondsSinceEpoch.remainder(1 << 31),
        title: title,
        body: noticeBody(notice),
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            _channelId,
            t('notifications.channel'),
            importance: Importance.defaultImportance,
            priority: Priority.defaultPriority,
          ),
          iOS: const DarwinNotificationDetails(),
        ),
        payload: '$serverId|${notice.conversationId}',
      );
    } catch (_) {
      // Notification presentation is best effort; the live event remains in-app.
    }
  }

  /// Ask for notification permission when the feature is enabled.
  Future<bool> enable() async {
    await Preferences.instance.setNotifications(true);
    final granted = await _requestPermission();
    if (!granted) await Preferences.instance.setNotifications(false);
    return granted;
  }

  Future<void> _prepare() async {
    if (!Preferences.instance.notifications) return;
    final granted = await _requestPermission();
    if (!granted) await Preferences.instance.setNotifications(false);
  }

  Future<bool> _requestPermission() async {
    if (!Platform.isIOS && !Platform.isAndroid) return false;
    try {
      if (Platform.isAndroid) {
        final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
        await android?.createNotificationChannel(AndroidNotificationChannel(
          _channelId,
          t('notifications.channel'),
          importance: Importance.defaultImportance,
        ));
        return await android?.requestNotificationsPermission() ?? false;
      }
      final ios = _plugin.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>();
      return await ios?.requestPermissions(alert: true, badge: false, sound: true) ?? false;
    } catch (_) {
      return false;
    }
  }
}

Future<bool> enableLocalNotifications() => LocalNotifications.instance.enable();
