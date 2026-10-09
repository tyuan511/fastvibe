import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import 'app_info.dart';
import 'chat/model_picker.dart';
import 'i18n/core.dart';
import 'notifications/local.dart';
import 'protocol/model_cache.dart';
import 'router.dart';
import 'session/connection.dart';
import 'theme/theme.dart';
import 'ui/feedback.dart';
import 'ui/kit.dart';
import 'ui/preferences.dart';
import 'update/update_prompt.dart';

Future<void> main() => startApp();

Future<void> startApp({bool checkUpdates = true}) async {
  WidgetsFlutterBinding.ensureInitialized();
  // Pre-warms the fragment shaders so the first glass frame is not a white flash.
  await LiquidGlassWidgets.initialize();
  await loadAppVersion();
  await i18n.load();
  await Preferences.instance.load();
  // The model picker needs the catalog but must not import the connection layer, which
  // would make it and the composer import each other.
  bindModelCatalogReader(() {
    final remote = Connection.instance.client;
    if (remote == null) return Future<List<Object?>>.value(const <Object?>[]);
    return readModelCatalog(remote);
  });
  await LocalNotifications.instance.install((serverId, conversationId) {
    unawaited(openNotificationTarget(serverId, conversationId));
  });
  runApp(FastVibeApp(checkUpdates: checkUpdates));
}

class FastVibeApp extends StatefulWidget {
  const FastVibeApp({super.key, this.checkUpdates = true});
  final bool checkUpdates;

  @override
  State<FastVibeApp> createState() => _FastVibeAppState();
}

class _FastVibeAppState extends State<FastVibeApp> with WidgetsBindingObserver {
  StreamSubscription<List<ConnectivityResult>>? _network;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _network = Connectivity().onConnectivityChanged.listen(
      Connection.instance.handleNetworkChange,
      onError: (Object _) {}, // Missing connectivity is unknown, not offline.
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _network?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The connection freezes its timers in the background and probes on return; a phone
    // loses its socket every time the screen locks, and nothing on this side hears the
    // server give up on it.
    ConnectionLifecycle.handle(state);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge(<Listenable>[i18n, Preferences.instance]),
      builder: (context, _) => LiquidGlassWidgets.wrap(
        brightnessResolver: Theme.maybeBrightnessOf,
        adaptiveQuality: true,
        respectSystemAccessibility: true,
        adaptiveConfig: GlassAdaptiveScopeConfig(
          maxQuality: Preferences.instance.reduceGlass
              ? GlassQuality.minimal
              : GlassQuality.premium,
        ),
        theme: GlassThemeData.simple(blur: 12, thickness: 25),
        child: MaterialApp.router(
          title: 'FastVibe',
          debugShowCheckedModeBanner: false,
          routerConfig: appRouter,
          theme: buildTheme(light),
          darkTheme: buildTheme(dark),
          themeMode: Preferences.instance.themeMode,
          builder: (context, child) {
            // Every route gets the palette, the toast host and the overlay scope: a
            // toast raised from a modal must be drawn by that modal, which is its own
            // route and would otherwise cover a host mounted only at the root.
            return PaletteScope(
              palette: Theme.of(context).brightness == Brightness.dark
                  ? dark
                  : light,
              child: ToastHost(
                child: UpdatePrompt(
                  enabled: widget.checkUpdates,
                  child: AnnotatedRegion<SystemUiOverlayStyle>(
                    value: Theme.of(context).brightness == Brightness.dark
                        ? SystemUiOverlayStyle.light
                        : SystemUiOverlayStyle.dark,
                    child: GlassAccessibilityScope(
                      reduceTransparency: Preferences.instance.reduceGlass
                          ? true
                          : null,
                      child: GlassNavigationShell(
                        child: child ?? const SizedBox.shrink(),
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

/// A Material theme built from the same tokens the screens draw with, so a platform
/// widget (a text selection handle, a native switch) does not arrive in a second palette.
ThemeData buildTheme(Palette palette) {
  final scheme = ColorScheme(
    brightness: palette.dark ? Brightness.dark : Brightness.light,
    primary: palette.accent,
    onPrimary: palette.accentText,
    secondary: palette.accent,
    onSecondary: palette.accentText,
    error: palette.danger,
    onError: palette.accentText,
    surface: palette.card,
    onSurface: palette.text,
    surfaceContainerHighest: palette.field,
    outline: palette.border,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: palette.dark ? Brightness.dark : Brightness.light,
    colorScheme: scheme,
    scaffoldBackgroundColor: palette.background,
    canvasColor: palette.background,
    dividerColor: palette.separator,
    splashFactory: InkSparkle.splashFactory,
    textTheme:
        (palette.dark
                ? Typography.material2021().white
                : Typography.material2021().black)
            .apply(bodyColor: palette.text, displayColor: palette.text),
  );
}
