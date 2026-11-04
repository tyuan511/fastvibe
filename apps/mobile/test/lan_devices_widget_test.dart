import 'dart:io';
import 'dart:ui' as ui;

import 'package:fastvibe_mobile/account/lan_discovery.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/main.dart' show buildTheme;
import 'package:fastvibe_mobile/screens/devices.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/app_screen.dart';
import 'package:fastvibe_mobile/ui/kit.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nsd/nsd.dart' as nsd;
import 'package:shared_preferences/shared_preferences.dart';

import 'lan_discovery_test.dart' as fixture;
import 'protocol_core_client_test.dart' show FakeCore, connect;

void main() {
  setUpAll(() async {
    final path = Platform.environment['FASTVIBE_UI_FONT'];
    if (path != null) {
      final font = ByteData.sublistView(File(path).readAsBytesSync());
      for (final family in ['Roboto', '.SF UI Text', '.SF UI Display']) {
        await (FontLoader(family)..addFont(Future.value(font))).load();
      }
    }
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await i18n.setPreference(LanguagePreference.zh);
  });

  for (final palette in [light, dark]) {
    testWidgets(
      'device list LAN badge and tap pass fresh direct addresses (${palette.dark})',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final native = nsd.Discovery('widget');
        final discovery = LanDiscovery(
          start: () async => native,
          stop: (_) async {},
        );
        discovery.setAccount('fixture');
        await tester.pump();
        native.add(fixture.service());
        final server = fixture.saved();
        final core = FakeCore()..remoteEndpoint = fixture.endpointId;
        final key = GlobalKey();
        Future<void>? selected;
        await tester.pumpWidget(
          MaterialApp(
            theme: buildTheme(palette).copyWith(
              textTheme: buildTheme(palette).textTheme
                  .apply(fontFamily: 'Roboto'),
            ),
            home: LanguageScope(
              language: i18n.language,
              child: PaletteScope(
                palette: palette,
                child: DefaultTextStyle(
                  style: TextStyle(
                    color: palette.text,
                    fontFamily: 'Roboto',
                    decoration: TextDecoration.none,
                  ),
                  child: RepaintBoundary(
                    key: key,
                    child: AppScreen(
                      title: t('official.section'),
                      showBack: false,
                      body: ListenableBuilder(
                        listenable: discovery,
                        builder: (context, _) => Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              SectionLabel(title: t('devices.allDevices')),
                              DeviceRow(
                                server: server,
                                connected: false,
                                online: true,
                                lan: discovery.endpointFor(server) != null,
                                onTap: () {
                                  final lan = discovery.endpointFor(server);
                                  selected = tester.runAsync(() async {
                                    final client = await connect(
                                      core,
                                      lanEndpointId: lan?.endpointId,
                                      directAddresses:
                                          lan?.directAddresses ?? [],
                                    );
                                    client.close();
                                    await client.shutdown;
                                  });
                                },
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('局域网'), findsOneWidget);
        expect(tester.takeException(), isNull);
        final capture = Platform.environment['FASTVIBE_UI_CAPTURE_DIR'];
        if (capture != null) {
          await tester.runAsync(() async {
            final image =
                await (key.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            Directory(capture).createSync(recursive: true);
            File('$capture/fv-lan-${palette.dark ? 'dark' : 'light'}.png')
                .writeAsBytesSync(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        await tester.tap(find.text(server.alias));
        await tester.pumpAndSettle();
        await selected;
        final command = core.commands.singleWhere(
          (c) => c['action'] == 'connect',
        );
        expect(command['directAddresses'], [
          '192.168.1.2:4444',
          '[fd00::2]:5555',
        ]);
        native.remove(fixture.service());
        await tester.pump();
        expect(find.text('局域网'), findsNothing);
        await tester.pumpWidget(const SizedBox());
        discovery.dispose();
        await tester.pump();
      },
    );
  }
}
