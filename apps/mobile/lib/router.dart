import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import 'screens/chat.dart';
import 'screens/devices.dart';
import 'screens/server.dart';
import 'screens/settings.dart';
import 'session/connection.dart';
import 'storage/servers.dart';
import 'i18n/core.dart';
import 'ui/feedback.dart';

/// Account computers, their conversations, and this phone's settings.
final GoRouter appRouter = GoRouter(
  initialLocation: '/',
  routes: <RouteBase>[
    GoRoute(
      path: '/',
      builder: (context, state) => const DevicesScreen(),
      routes: [
        GoRoute(
          path: 'settings',
          builder: (context, state) => const SettingsScreen(),
        ),
        GoRoute(
          path: 'server/:id',
          builder: (context, state) =>
              ServerScreen(serverId: state.pathParameters['id']!),
        ),
        GoRoute(
          path: 'chat/:conversationId',
          builder: (context, state) => ChatScreen(
            conversationId: state.pathParameters['conversationId']!,
          ),
        ),
      ],
    ),
  ],
);

/// Bridges the app's lifecycle observer onto the connection.
abstract final class ConnectionLifecycle {
  static void handle(AppLifecycleState state) {
    Connection.instance.handleAppState(state);
  }
}

int _notificationNavigation = 0;

Future<void> openNotificationTarget(
  String serverId,
  String conversationId,
) async {
  final generation = ++_notificationNavigation;
  final servers = await ServerStore.instance.load();
  if (generation != _notificationNavigation) return;
  final server = servers.where((item) => item.id == serverId).firstOrNull;
  if (server == null) {
    toastError(t('notifications.deviceMissing'));
    return;
  }
  final path = '/server/${Uri.encodeComponent(server.id)}';
  appRouter.go(path);
  final connection = Connection.instance;
  if (connection.server?.id != server.id || connection.client == null) {
    await connection.connectSaved(server);
  }
  if (generation != _notificationNavigation ||
      connection.server?.id != server.id ||
      connection.client == null ||
      appRouter.routeInformationProvider.value.uri.path != path) {
    return;
  }
  // Keep the machine underneath the chat, so Back always has a useful destination.
  appRouter.push('/chat/${Uri.encodeComponent(conversationId)}');
}
