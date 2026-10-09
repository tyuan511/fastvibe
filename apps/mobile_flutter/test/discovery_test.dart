import 'dart:async';
import 'dart:io';

import 'package:fastvibe_mobile/protocol/discovery.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

InternetAddress ip(String text) => InternetAddress(text);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('Android NSD single IPv4 result reaches the nearby list through the plugin codec', () async {
    const channel = MethodChannel('com.haberey/nsd');
    final binding = TestDefaultBinaryMessengerBinding.instance;
    String? discoveryHandle;
    Future<void> nativeEvent(String method, Map<String, Object?> arguments) {
      final done = Completer<void>();
      binding.channelBuffers.push(
        channel.name,
        channel.codec.encodeMethodCall(MethodCall(method, arguments)),
        (_) => done.complete(),
      );
      return done.future;
    }

    binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      final arguments = Map<String, Object?>.from(call.arguments as Map);
      switch (call.method) {
        case 'startDiscovery':
          discoveryHandle = arguments['handle'] as String;
          expect(arguments['service.type'], fastvibeServiceType);
          await nativeEvent('onDiscoveryStartSuccessful', arguments);
        case 'resolve':
          // Match nsd_android's real wire format: addresses is one string, not a list.
          await nativeEvent('onResolveSuccessful', <String, Object?>{
            ...arguments,
            'service.host': '192.168.22.139',
            'service.addresses': '192.168.22.139',
            'service.port': 7777,
          });
        case 'stopDiscovery':
          await nativeEvent('onDiscoveryStopSuccessful', arguments);
        default:
          fail('Unexpected NSD method: ${call.method}');
      }
      return null;
    });
    final nearby = NearbyDiscovery();
    try {
      await nearby.start();
      await nativeEvent('onServiceDiscovered', <String, Object?>{
        'handle': discoveryHandle,
        'service.name': 'tangge mbp',
        'service.type': fastvibeServiceType,
      });
      await Future<void>.delayed(Duration.zero);
      expect(nearby.machines, const <NearbyMachine>[
        NearbyMachine(
          name: 'tangge mbp',
          port: 7777,
          origins: <String>['http://192.168.22.139:7777'],
        ),
      ]);
      await nativeEvent('onServiceLost', <String, Object?>{
        'handle': discoveryHandle,
        'service.name': 'tangge mbp',
        'service.type': fastvibeServiceType,
      });
      expect(nearby.machines, isEmpty);
    } finally {
      await nearby.stop();
      nearby.dispose();
      binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    }
  });

  group('originsFor', () {
    test('puts the Wi-Fi address before the other interfaces', () {
      final origins = originsFor(<InternetAddress>[
        ip('100.64.0.9'),
        ip('192.168.22.139'),
        ip('10.0.0.4'),
      ], 7777);
      expect(origins, <String>[
        'http://192.168.22.139:7777',
        'http://10.0.0.4:7777',
        'http://100.64.0.9:7777',
      ]);
    });

    test('drops link-local and loopback, which a phone cannot use', () {
      final origins = originsFor(<InternetAddress>[
        ip('fe80::1'),
        ip('169.254.7.7'),
        ip('127.0.0.1'),
        ip('192.168.1.5'),
      ], 8080);
      expect(origins, <String>['http://192.168.1.5:8080']);
    });

    test('keeps a routable IPv6 last, bracketed', () {
      final origins = originsFor(<InternetAddress>[
        ip('fd07:b51a:cc66::1'),
        ip('192.168.1.5'),
      ], 7777);
      expect(origins, <String>[
        'http://192.168.1.5:7777',
        'http://[fd07:b51a:cc66::1]:7777',
      ]);
    });

    test('no usable address gives no origins', () {
      expect(originsFor(<InternetAddress>[ip('fe80::1')], 7777), isEmpty);
    });
  });

  group('firstReachable', () {
    test(
      'returns the best-ranked origin that answers, not the fastest',
      () async {
        final answered = await firstReachable(
          <String>['http://a', 'http://b', 'http://c'],
          probe: (origin, _) async {
            if (origin == 'http://a') {
              await Future<void>.delayed(const Duration(milliseconds: 40));
              return true;
            }
            return true;
          },
        );
        expect(answered, 'http://a');
      },
    );

    test('skips the ones that fail or throw', () async {
      final answered = await firstReachable(
        <String>['http://dead', 'http://broken', 'http://ok'],
        probe: (origin, _) async {
          if (origin == 'http://broken') throw const SocketException('nope');
          return origin == 'http://ok';
        },
      );
      expect(answered, 'http://ok');
    });

    test('null when nothing answers or there is nothing to try', () async {
      expect(
        await firstReachable(<String>[
          'http://x',
        ], probe: (_, _) async => false),
        isNull,
      );
      expect(await firstReachable(<String>[]), isNull);
    });
  });
}
