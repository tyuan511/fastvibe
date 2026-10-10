import 'package:fastvibe_mobile/protocol/rtc_connection.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('only UDP candidates another machine can reach are sent', () {
    expect(wantsCandidate('candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host'), isTrue);
    expect(wantsCandidate('candidate:2 1 udp 41885439 198.51.100.2 50000 typ relay raddr 0.0.0.0 rport 0'), isTrue);
    expect(wantsCandidate('candidate:3 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active'), isFalse);
    expect(wantsCandidate('candidate:4 1 udp 2122194687 fe80::1 54322 typ host'), isFalse);
    expect(wantsCandidate('candidate:6 1 udp 2130706431 127.0.0.1 44323 typ host'), isFalse);
    expect(wantsCandidate('candidate:7 1 udp 2130706431 ::1 40791 typ host'), isFalse);
    expect(wantsCandidate('garbage'), isFalse);
  });

  test('one TURN address is kept, UDP preferred', () {
    expect(
      oneRelayPerServer(<String>[
        'stun:turn.example:3478',
        'turn:turn.example:3478?transport=tcp',
        'turn:turn.example:3478?transport=udp',
        'turns:turn.example:5349?transport=tcp',
      ]),
      <String>['stun:turn.example:3478', 'turn:turn.example:3478?transport=udp'],
    );
    expect(
      oneRelayPerServer(<String>['turns:turn.example:5349?transport=tcp', 'turn:turn.example:3478?transport=tcp']),
      <String>['turns:turn.example:5349?transport=tcp'],
    );
    expect(oneRelayPerServer(<String>['stun:a:1']), <String>['stun:a:1']);
  });
}
