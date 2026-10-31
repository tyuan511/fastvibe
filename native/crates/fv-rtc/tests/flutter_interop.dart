// Copy this file into a temporary Flutter runner's integration_test directory.
// Dependencies: integration_test SDK and flutter_webrtc 1.6.2+hotfix.4.
// macOS runner entitlements must include com.apple.security.network.client=true.
// Start `cargo run -p fv-rtc --example flutter_peer -- 17779`, then run
// flutter test integration_test/flutter_interop.dart -d macos
// This uses real native libwebrtc, forced local TURN, no account or private credentials.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('native Rust RTC forced TURN and fv-protocol initialize', (tester) async {
    const base = 'http://127.0.0.1:17779';
    final client = HttpClient();
    final iceResponse = await (await client.getUrl(Uri.parse('$base/ice'))).close();
    final config = jsonDecode(await utf8.decodeStream(iceResponse)) as Map<String, dynamic>;
    final pc = await createPeerConnection(config);
    final socket = await WebSocket.connect('ws://127.0.0.1:17779/signal');
    final done = Completer<void>();
    var remote = false;
    final early = <RTCIceCandidate>[];
    final relays = <String>[];
    pc.onIceCandidate = (candidate) {
      final text = candidate.candidate;
      if (text == null || text.isEmpty) return;
      expect(text, contains(' typ relay'));
      relays.add(text);
      socket.add(jsonEncode({'type':'candidate','candidate':text,'mid':candidate.sdpMid ?? '0'}));
    };
    final subscription = socket.listen((raw) async {
      final data = jsonDecode(raw as String) as Map<String, dynamic>;
      if (data['type'] == 'answer') {
        expect(data['protocol'], 'fv-protocol-v1');
        await pc.setRemoteDescription(RTCSessionDescription(data['sdp'] as String, 'answer'));
        remote = true;
        for (final c in early) { await pc.addCandidate(c); }
        early.clear();
      } else if (data['type'] == 'candidate') {
        final c = RTCIceCandidate(data['candidate'] as String, data['mid'] as String, 0);
        if (remote) { await pc.addCandidate(c); } else { early.add(c); }
      }
    });
    final channel = await pc.createDataChannel('fastvibe-native', RTCDataChannelInit()..ordered=true..protocol='fv-protocol-v1'..binaryType='binary');
    final bytes = <int>[];
    channel.onMessage = (message) {
      expect(message.isBinary, isTrue);
      final data = message.binary;
      expect(data.length, lessThanOrEqualTo(16384));
      if (data[0] == 1) {
        unawaited(channel.send(RTCDataChannelMessage.fromBinary(Uint8List.fromList([2]))));
      } else if (data[0] == 0) {
        bytes.addAll(data.sublist(1));
        if (bytes.isNotEmpty && bytes.last == 10) {
          final response = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
          expect(response['id'], 1);
          expect(response['result']['protocolVersion'], 1);
          expect((response['result']['large'] as String).length, 128*1024);
          if (!done.isCompleted) done.complete();
        }
      }
    };
    channel.onDataChannelState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        final request = utf8.encode('${jsonEncode({'id':1,'method':'initialize','params':{'protocolVersion':1,'clientInfo':{'name':'flutter-interop','version':'1'}}})}\n');
        unawaited(channel.send(RTCDataChannelMessage.fromBinary(Uint8List.fromList([0,...request]))));
      }
    };
    final offer = await pc.createOffer({'mandatory':{'OfferToReceiveAudio':false,'OfferToReceiveVideo':false},'optional':<Object>[]});
    socket.add(jsonEncode({'type':'offer','sdp':offer.sdp,'protocol':'fv-protocol-v1'}));
    await pc.setLocalDescription(offer);
    try {
      await tester.runAsync(() => done.future.timeout(const Duration(seconds:35)));
      expect(relays, isNotEmpty);
      final stats = await pc.getStats();
      expect(stats.any((s) => s.type == 'local-candidate' && s.values['candidateType'] == 'relay'), isTrue);
    } finally {
      await subscription.cancel(); await socket.close(); await channel.close(); await pc.close(); client.close();
    }
  });
}
