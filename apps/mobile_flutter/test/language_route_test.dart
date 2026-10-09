import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/main.dart';
import 'package:fastvibe_mobile/router.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/feedback.dart';
import 'package:fastvibe_mobile/ui/kit.dart';

/// The layer 切换语言 → 回到其他界面 used to break on.
///
/// A page hosted directly under the language scope redraws trivially, and that alone
/// would pass with the bug in place. go_router keeps each page by its key, so the
/// rebuild has to cross the Navigator: the root repaints, the route does not, and the
/// screen you go back to keeps drawing the language it was opened in. This is the
/// router-shaped host `lib/main.dart` actually builds.
void main() {
  setUpAll(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await LiquidGlassWidgets.initialize(warmUpMode: GlassWarmUpMode.never);
    await i18n.setPreference(LanguagePreference.zh);
  });

  Future<void> pumpApp(WidgetTester tester) async {
    await tester.pumpWidget(
      ListenableBuilder(
        listenable: i18n,
        builder: (context, _) => LiquidGlassWidgets.wrap(
          brightnessResolver: Theme.maybeBrightnessOf,
          child: MaterialApp.router(
            theme: buildTheme(light),
            routerConfig: appRouter,
            builder: (context, child) => LanguageScope(
              language: i18n.language,
              child: PaletteScope(
                palette: light,
                child: ToastHost(child: child ?? const SizedBox.shrink()),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
  }

  testWidgets('a route on the stack redraws when the language changes', (
    tester,
  ) async {
    await i18n.setPreference(LanguagePreference.zh);
    await pumpApp(tester);

    final before = t('devices.workspaces');
    expect(find.text(before), findsWidgets);

    await i18n.setPreference(LanguagePreference.en);
    await tester.pump();

    expect(find.text(t('devices.workspaces')), findsWidgets);
    expect(find.text(before), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a screen opened before the switch redraws on the way back', (
    tester,
  ) async {
    await i18n.setPreference(LanguagePreference.zh);
    await pumpApp(tester);
    final deviceTitle = t('devices.workspaces');

    appRouter.push('/settings');
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text(t('nav.settings')), findsWidgets);

    await i18n.setPreference(LanguagePreference.en);
    await tester.pump();

    appRouter.pop();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text(deviceTitle), findsNothing);
    expect(find.text(t('devices.workspaces')), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
