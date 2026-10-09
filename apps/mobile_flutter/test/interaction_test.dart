import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/composer.dart';
import 'package:fastvibe_mobile/chat/draft_storage.dart';
import 'package:fastvibe_mobile/chat/option_sheet.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/main.dart';
import 'package:fastvibe_mobile/protocol/address.dart';
import 'package:fastvibe_mobile/screens/add_device.dart';
import 'package:fastvibe_mobile/screens/chat.dart';
import 'package:fastvibe_mobile/screens/devices.dart';
import 'package:fastvibe_mobile/screens/settings.dart';
import 'package:fastvibe_mobile/session/connection.dart';
import 'package:fastvibe_mobile/storage/servers.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/feedback.dart';
import 'package:fastvibe_mobile/ui/kit.dart';

void main() {
  setUpAll(() async {
    await LiquidGlassWidgets.initialize(warmUpMode: GlassWarmUpMode.never);
  });
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    await i18n.setPreference(LanguagePreference.zh);
    Connection.instance.disconnect();
  });

  Future<void> pump(
    WidgetTester tester,
    Widget child, {
    Palette palette = light,
    double scale = 1,
  }) async {
    await tester.pumpWidget(
      LiquidGlassWidgets.wrap(
        brightnessResolver: Theme.maybeBrightnessOf,
        theme: GlassThemeData.simple(quality: GlassQuality.minimal),
        child: MaterialApp(
          theme: buildTheme(palette),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
              disableAnimations: true,
            ),
            child: PaletteScope(
              palette: palette,
              child: ToastHost(child: child!),
            ),
          ),
          home: child,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 400));
  }

  testWidgets(
    'saved devices refresh after a mutation and search respects the name',
    (tester) async {
      await pump(tester, const DevicesScreen());
      await ServerStore.instance.upsert(
        const SavedServer(
          id: 's1',
          alias: 'Studio',
          origin: 'https://studio.test',
          host: 'studio.test',
          kind: AddressKind.public,
          createdAt: 0,
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Studio'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'missing');
      await tester.pump();
      expect(find.text('Studio'), findsNothing);
      await tester.enterText(find.byType(TextField), 'STUDIO');
      await tester.pump();
      expect(find.text('Studio'), findsOneWidget);
      await ServerStore.instance.patch('s1', favorite: true);
      await tester.pump();
      expect(find.text(t('devices.favorites')), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a searchable glass sheet supplies Material and returns selection',
    (tester) async {
      String? picked;
      await pump(
        tester,
        Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showOptionSheet(
                context,
                title: 'Pick',
                options: [
                  for (var i = 0; i < 12; i++)
                    SheetOption(value: '$i', label: 'Option $i'),
                ],
                onSelect: (v) => picked = v,
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.enterText(find.byType(TextField), 'Option 11');
      await tester.pump();
      await tester.pumpAndSettle();
      await tester.tap(find.text('Option 11').last);
      await tester.pump(const Duration(milliseconds: 500));
      expect(picked, '11');
      expect(tester.takeException(), isNull);
      toastSuccess('After sheet');
      await tester.pump();
      expect(find.text('After sheet'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
    },
  );

  testWidgets(
    'glass prompt saves edited text without disposing its field mid-dismissal',
    (tester) async {
      String? result;
      await pump(
        tester,
        Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                result = await AppDialog.prompt(
                  context,
                  title: 'Rename',
                  initial: 'Old',
                );
              },
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pump(const Duration(milliseconds: 500));
      await tester.enterText(find.byType(TextField), 'New');
      await tester.tap(find.text(t('common.save')));
      await tester.pump(const Duration(milliseconds: 500));
      expect(result, 'New');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'changing conversations preserves both drafts and never reuses attachments',
    (tester) async {
      Connection.instance.server = const SavedServer(
        id: 'draft-server',
        alias: 'Draft',
        origin: 'https://draft.test',
        host: 'draft.test',
        kind: AddressKind.public,
        createdAt: 0,
      );
      await writeDraft('draft-server', 'a', 'draft A');
      await writeDraft('draft-server', 'b', 'draft B');
      await pump(tester, const ChatScreen(conversationId: 'a'));
      expect(
        tester.widget<Composer>(find.byType(Composer)).draft.text,
        'draft A',
      );
      tester.widget<Composer>(find.byType(Composer)).draft.text = 'edited A';
      await pump(tester, const ChatScreen(conversationId: 'b'));
      expect(
        tester.widget<Composer>(find.byType(Composer)).draft.text,
        'draft B',
      );
      expect((await readDraft('draft-server', 'a'))?.text, 'edited A');
      expect(tester.widget<Composer>(find.byType(Composer)).images, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect((await readDraft('draft-server', 'b'))?.text, 'draft B');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a long question form stays scrollable above a small-screen keyboard',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 568));
      tester.view.viewInsets = const FakeViewPadding(bottom: 240);
      addTearDown(() {
        tester.view.resetViewInsets();
        tester.binding.setSurfaceSize(null);
      });
      Connection.instance.pending = [
        BlockingPrompt(
          id: 'questions',
          conversationId: 'small',
          method: 'questions',
          title: 'Review',
          questions: [
            for (var i = 0; i < 6; i++)
              PromptQuestion(question: 'Question $i', header: 'Question $i'),
          ],
        ),
      ];
      await pump(tester, const ChatScreen(conversationId: 'small'), scale: 1.6);
      expect(tester.takeException(), isNull);
      expect(find.text('Review'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      Connection.instance.disconnect();
    },
  );

  for (final locale in [LanguagePreference.zh, LanguagePreference.en]) {
    for (final palette in [light, dark]) {
      for (final size in [
        const Size(320, 568),
        const Size(390, 844),
        const Size(768, 1024),
      ]) {
        testWidgets(
          'accessible layouts ${locale.name}/${palette.dark}/${size.width}',
          (tester) async {
            await tester.binding.setSurfaceSize(size);
            addTearDown(() => tester.binding.setSurfaceSize(null));
            await i18n.setPreference(locale);
            for (final screen in [
              const DevicesScreen(),
              const AddDeviceScreen(),
              const SettingsScreen(),
            ]) {
              await pump(tester, screen, palette: palette, scale: 1.6);
              expect(
                tester.takeException(),
                isNull,
                reason: '${screen.runtimeType}',
              );
            }
          },
        );
      }
    }
  }
}
