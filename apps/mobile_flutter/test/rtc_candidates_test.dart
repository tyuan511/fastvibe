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

  test('host addresses cannot use up the budget before the public address and the relay arrive', () {
    final budget = CandidateBudget();
    final hosts = <bool>[
      for (var index = 0; index < 12; index++)
        budget.admit('candidate:$index 1 udp 2122260223 10.0.0.$index 5000 typ host'),
    ];
    expect(hosts.where((sent) => sent).length, 4);
    expect(budget.admit('candidate:20 1 udp 1686052607 203.0.113.7 6000 typ srflx raddr 10.0.0.1 rport 5000'), isTrue);
    expect(budget.admit('candidate:21 1 udp 41885439 198.51.100.2 50000 typ relay raddr 0.0.0.0 rport 0'), isTrue);
    expect(budget.admit('candidate:22 1 udp 41885439 198.51.100.2 50001 typ relay raddr 0.0.0.0 rport 0'), isTrue);
    expect(budget.admit('candidate:23 1 udp 41885439 198.51.100.2 50002 typ relay raddr 0.0.0.0 rport 0'), isFalse,
        reason: 'two relays are the most one call offers');
  });

  test('a repeat is not sent twice, and the whole call stays within what the desktop keeps', () {
    final budget = CandidateBudget();
    const line = 'candidate:1 1 udp 1686052607 203.0.113.7 6000 typ srflx raddr 10.0.0.1 rport 5000';
    expect(budget.admit(line), isTrue);
    expect(budget.admit(line), isFalse);
    var sent = 1;
    for (var index = 0; index < 20; index++) {
      if (budget.admit('candidate:${index + 2} 1 udp 1686052607 203.0.113.$index 6000 typ srflx raddr 10.0.0.1 rport 5000')) sent += 1;
    }
    expect(sent, 8);
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
