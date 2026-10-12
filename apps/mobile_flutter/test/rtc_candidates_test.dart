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
    // A unique-local IPv6 address leads nowhere off its own network; a public one does.
    expect(wantsCandidate('candidate:8 1 udp 2122262783 fd07:b51a:cc66::5 50001 typ host'), isFalse);
    expect(wantsCandidate('candidate:9 1 udp 2122262783 2409:8a00:1::5 50001 typ host'), isTrue);
    expect(wantsCandidate('garbage'), isFalse);
  });

  test('host addresses cannot use up the budget before the public address and the relay arrive', () {
    final budget = CandidateBudget();
    final hosts = <bool>[
      for (var index = 0; index < 12; index++)
        budget.admit('candidate:$index 1 udp 2122260223 10.0.0.$index 5000 typ host'),
    ];
    // Three of a kind, not four: the last place is kept for the other address family.
    expect(hosts.where((sent) => sent).length, 3);
    expect(budget.admit('candidate:30 1 udp 2122262783 2409:8a00:1::5 5000 typ host'), isTrue,
        reason: 'a public IPv6 address still has a place after any number of IPv4 ones');
    expect(budget.admit('candidate:31 1 udp 2122262783 2409:8a00:1::6 5000 typ host'), isFalse,
        reason: 'four hosts are the most one call offers');
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

  test('IPv6 hosts cannot crowd out the IPv4 one either', () {
    final budget = CandidateBudget();
    final hosts = <bool>[
      for (var index = 0; index < 6; index++)
        budget.admit('candidate:$index 1 udp 2122262783 2409:8a00:1::$index 5000 typ host'),
    ];
    expect(hosts.where((sent) => sent).length, 3);
    expect(budget.admit('candidate:9 1 udp 2122260223 192.168.1.5 5000 typ host'), isTrue);
  });

  test('where UDP is blocked the relay is reached over TLS on 443, else over TCP', () {
    expect(
      relayOverTcp(<String>[
        'turn:turn.example:3478?transport=udp',
        'turn:turn.example:3478?transport=tcp',
        'turns:turn.example:5349?transport=tcp',
        'turn:turn.example:443?transport=udp',
        'turn:turn.example:80?transport=tcp',
        'turns:turn.example:443?transport=tcp',
      ]),
      <String>['turns:turn.example:443?transport=tcp'],
    );
    expect(
      relayOverTcp(<String>['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349?transport=tcp']),
      <String>['turns:turn.example:5349?transport=tcp'],
    );
    expect(
      relayOverTcp(<String>['turn:turn.example:3478?transport=udp', 'turn:turn.example:3478?transport=tcp']),
      <String>['turn:turn.example:3478?transport=tcp'],
    );
    // Nothing to fall back to: STUN alone, or a relay that only speaks UDP.
    expect(relayOverTcp(<String>['stun:stun.example:3478']), isNull);
    expect(relayOverTcp(<String>['turn:turn.example:3478?transport=udp', 'turn:turn.example:443']), isNull);
  });

  group('the path in use', () {
    const host = StatsEntry('L1', 'local-candidate', <String, Object?>{'candidateType': 'host'});
    const relayed = StatsEntry('L2', 'local-candidate', <String, Object?>{'candidateType': 'relay'});
    const guessed = StatsEntry('R1', 'remote-candidate', <String, Object?>{'candidateType': 'srflx', 'address': '183.156.1.2'});
    const overV6 = StatsEntry('R2', 'remote-candidate', <String, Object?>{'candidateType': 'host', 'ip': '2408:8207::9'});
    const viaRelay = StatsEntry('P1', 'candidate-pair', <String, Object?>{
      'localCandidateId': 'L2', 'remoteCandidateId': 'R1', 'state': 'succeeded', 'nominated': false,
    });
    const direct = StatsEntry('P2', 'candidate-pair', <String, Object?>{
      'localCandidateId': 'L1', 'remoteCandidateId': 'R1', 'state': 'succeeded', 'nominated': true,
    });

    test('is the pair the transport selected, not the first one that succeeded', () {
      final pair = selectedPairFrom(const <StatsEntry>[
        host, relayed, guessed, viaRelay, direct,
        StatsEntry('T1', 'transport', <String, Object?>{'selectedCandidatePairId': 'P2'}),
      ]);
      expect(pair?.path, 'direct');
      expect(pair?.describe(), 'direct host/srflx v4');
    });

    test('falls back to the nominated pair when no transport is reported', () {
      expect(selectedPairFrom(const <StatsEntry>[host, relayed, guessed, viaRelay, direct])?.describe(), 'direct host/srflx v4');
      expect(selectedPairFrom(const <StatsEntry>[host, relayed, guessed, viaRelay])?.describe(), 'relay relay/srflx v4');
    });

    test('names the address family, and is nothing before a pair exists', () {
      const pair = StatsEntry('P3', 'candidate-pair', <String, Object?>{
        'localCandidateId': 'L1', 'remoteCandidateId': 'R2', 'state': 'succeeded', 'nominated': true,
      });
      expect(selectedPairFrom(const <StatsEntry>[host, overV6, pair])?.describe(), 'direct host/host v6');
      expect(selectedPairFrom(const <StatsEntry>[host, guessed]), isNull);
      expect(selectedPairFrom(const <StatsEntry>[]), isNull);
    });
  });
}
