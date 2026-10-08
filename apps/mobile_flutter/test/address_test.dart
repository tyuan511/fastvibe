import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/protocol/address.dart';

/// The same cases `test/mobile-address.test.ts` pins for the Expo client. A change here
/// is a change to which machine a QR code connects to, so both clients are held to the
/// identical table.
void main() {
  test('a tunnel QR is an https origin', () {
    final parsed = parseServerAddress('https://foo.trycloudflare.com/')!;
    expect(parsed.origin, 'https://foo.trycloudflare.com');
    expect(parsed.wsUrl, 'wss://foo.trycloudflare.com/ws');
    expect(parsed.kind, AddressKind.public);
  });

  test('the LAN address copied from settings needs no scheme', () {
    final parsed = parseServerAddress('192.168.31.45:7777')!;
    expect(parsed.origin, 'http://192.168.31.45:7777');
    expect(parsed.wsUrl, 'ws://192.168.31.45:7777/ws');
    expect(parsed.kind, AddressKind.lan);
  });

  test('a typed LAN host without a port uses FastVibe\'s default', () {
    final parsed = parseServerAddress('10.0.0.8')!;
    expect(parsed.origin, 'http://10.0.0.8:7777');
    expect(parsed.kind, AddressKind.lan);
  });

  test('an explicit http LAN URL is kept', () {
    final parsed = parseServerAddress('http://172.16.4.2:7777/mobile.html')!;
    expect(parsed.origin, 'http://172.16.4.2:7777');
    expect(parsed.kind, AddressKind.lan);
  });

  test('an IPv6 LAN QR keeps brackets for HTTP and WebSocket', () {
    final parsed = parseServerAddress('http://[fd00::45]:7777')!;
    expect(parsed.origin, 'http://[fd00::45]:7777');
    expect(parsed.wsUrl, 'ws://[fd00::45]:7777/ws');
    expect(parsed.kind, AddressKind.lan);
  });

  test('an IPv6 link-local QR preserves its encoded interface zone', () {
    final parsed = parseServerAddress('http://[fe80::20%25en0]:7777')!;
    expect(parsed.origin, 'http://[fe80::20%25en0]:7777');
    expect(parsed.wsUrl, 'ws://[fe80::20%25en0]:7777/ws');
    expect(parsed.kind, AddressKind.lan);
  });

  test('a bare public hostname is https', () {
    final parsed = parseServerAddress('foo.ngrok-free.app')!;
    expect(parsed.origin, 'https://foo.ngrok-free.app');
    expect(parsed.kind, AddressKind.public);
  });

  test('mDNS names are LAN http', () {
    final parsed = parseServerAddress('mac-mini.local:7777')!;
    expect(parsed.origin, 'http://mac-mini.local:7777');
    expect(parsed.kind, AddressKind.lan);
  });

  test('loopback is recognised so a phone is not sent to itself', () {
    expect(parseServerAddress('127.0.0.1:7777')!.kind, AddressKind.loopback);
    expect(parseServerAddress('localhost')!.kind, AddressKind.loopback);
  });

  test('rejects a non-http scheme and an empty string', () {
    expect(parseServerAddress(''), isNull);
    expect(parseServerAddress('ftp://192.168.1.2'), isNull);
  });

  test('a bare IPv6 address is the plain LAN listener, not a TLS endpoint', () {
    // What 设置 → 远程访问 copies for the LAN row when the machine is set to IPv6: no
    // scheme, and a global address, which classifies as public. TLS against the plain
    // listener failed every connection.
    final parsed = parseServerAddress('[240e:370:a51b:a280:49f:eaac:3882:fb66]:7777')!;
    expect(parsed.origin, 'http://[240e:370:a51b:a280:49f:eaac:3882:fb66]:7777');
    expect(parsed.wsUrl, 'ws://[240e:370:a51b:a280:49f:eaac:3882:fb66]:7777/ws');
    expect(parseServerAddress('[240e:370::1]')!.origin, 'http://[240e:370::1]:7777');
  });

  test('an explicit https IPv6 address keeps https', () {
    expect(parseServerAddress('https://[240e:370::1]')!.origin, 'https://[240e:370::1]');
  });

  test('wss and ws are rewritten to https and http', () {
    expect(parseServerAddress('wss://foo.example.com')!.origin, 'https://foo.example.com');
    expect(parseServerAddress('ws://10.0.0.5:7777')!.origin, 'http://10.0.0.5:7777');
  });

  test('an out-of-range port is refused rather than defaulted', () {
    expect(parseServerAddress('10.0.0.8:0'), isNull);
    expect(parseServerAddress('10.0.0.8:99999'), isNull);
  });

  test('credentials in the address are refused', () {
    expect(parseServerAddress('http://user:pass@10.0.0.8:7777'), isNull);
  });
}
