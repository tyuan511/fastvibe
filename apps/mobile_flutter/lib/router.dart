import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import 'screens/add_device.dart';
import 'screens/chat.dart';
import 'screens/devices.dart';
import 'screens/scan.dart';
import 'screens/server.dart';
import 'screens/settings.dart';
import 'session/connection.dart';

/// The Expo client's file routes, one to one: `/`, `/add`, `/scan`, `/settings`,
/// `/server/:id`, `/chat/:conversationId`.
final GoRouter appRouter = GoRouter(
  initialLocation: '/',
  routes: <RouteBase>[
    GoRoute(path: '/', builder: (context, state) => const DevicesScreen()),
    GoRoute(path: '/add', builder: (context, state) => const AddDeviceScreen()),
    GoRoute(path: '/scan', builder: (context, state) => const ScanScreen()),
    GoRoute(path: '/settings', builder: (context, state) => const SettingsScreen()),
    GoRoute(
      path: '/server/:id',
      builder: (context, state) => ServerScreen(serverId: state.pathParameters['id']!),
    ),
    GoRoute(
      path: '/chat/:conversationId',
      builder: (context, state) => ChatScreen(conversationId: state.pathParameters['conversationId']!),
    ),
  ],
);

/// Bridges the app's lifecycle observer onto the connection.
abstract final class ConnectionLifecycle {
  static void handle(AppLifecycleState state) {
    Connection.instance.handleAppState(state);
  }
}
