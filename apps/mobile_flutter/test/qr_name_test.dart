import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/option_sheet.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/main.dart' show buildTheme;
import 'package:fastvibe_mobile/screens/add_device.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/feedback.dart';
import 'package:fastvibe_mobile/ui/kit.dart';

void main() {
  setUpAll(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await LiquidGlassWidgets.initialize(warmUpMode: GlassWarmUpMode.never);
    await i18n.setPreference(LanguagePreference.zh);
  });

  for (final palette in [light, dark]) {
    testWidgets(
      'QR names fill the form and preserve manual edits (dark=${palette.dark})',
      (tester) async {
        final router = GoRouter(
          routes: [
            GoRoute(path: '/', builder: (_, _) => const AddDeviceScreen()),
            // Return the decoded camera payload without needing camera hardware.
            GoRoute(
              path: '/scan',
              builder: (_, _) => const Scaffold(body: Text('scanner fixture')),
            ),
          ],
        );
        await tester.pumpWidget(
          LiquidGlassWidgets.wrap(
            brightnessResolver: Theme.maybeBrightnessOf,
            theme: GlassThemeData.simple(quality: GlassQuality.minimal),
            child: MaterialApp.router(
              routerConfig: router,
              theme: buildTheme(palette),
              builder: (_, child) => PaletteScope(
                palette: palette,
                child: ToastHost(child: child!),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 400));

        Future<void> scan(String raw) async {
          FocusManager.instance.primaryFocus?.unfocus();
          await tester.pump();
          final scanButton = find.text(t('add.scanTitle'));
          final action = tester.widget<InkWell>(
            find.ancestor(of: scanButton, matching: find.byType(InkWell)).first,
          );
          action.onTap!();
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
          expect(find.text('scanner fixture'), findsOneWidget);
          setScannedAddress(raw);
          router.pop();
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 500));
        }

        String field(int index) => tester
            .widget<TextField>(find.byType(TextField).at(index))
            .controller!
            .text;

        await scan('http://192.168.22.139:7777?name=tangge+mbp');
        expect(field(0), 'http://192.168.22.139:7777');
        expect(field(1), 'tangge mbp');

        await scan(
          'http://192.168.22.140:7777?name=%E5%B7%A5%E4%BD%9C%E7%94%B5%E8%84%91',
        );
        expect(field(1), '工作电脑');
        await scan('http://192.168.22.141:7777');
        expect(field(1), '');

        await tester.enterText(find.byType(TextField).at(1), '我的连接名');
        await scan('https://desk.example.com?name=New');
        expect(field(0), 'https://desk.example.com');
        expect(field(1), '我的连接名');
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump(const Duration(seconds: 1));
        router.dispose();
      },
    );
  }
}
