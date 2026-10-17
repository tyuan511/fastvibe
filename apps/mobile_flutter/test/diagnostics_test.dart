import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/protocol/diagnostics.dart';

void main() {
  test('a recovered connection does not keep reporting an old authentication failure', () {
    final summary = summarizeConnectionDiagnostics(<Diagnostic>[
      Diagnostic(event: 'connect-failed', failure: 'unauthorized'),
      Diagnostic(event: 'connecting'),
      Diagnostic(event: 'connected'),
    ], <String, List<Diagnostic>>{});
    expect(summary.state, 'ready');
  });
  test('authentication, unavailable computers, and data restoration have distinct actions', () {
    for (final pair in <String, String>{'unauthorized': 'auth', 'offline': 'offline', 'gone': 'gone', 'restore-failed': 'catalog'}.entries) {
      final summary = summarizeConnectionDiagnostics(<Diagnostic>[Diagnostic(event: 'connect-failed', failure: pair.key)], <String, List<Diagnostic>>{});
      expect(summary.state, pair.value);
    }
  });
  test('unknown failures do not invent a precise network diagnosis', () {
    expect(summarizeConnectionDiagnostics(<Diagnostic>[Diagnostic(event: 'connect-failed', failure: 'unreachable')], <String, List<Diagnostic>>{}).state, 'network');
    expect(summarizeConnectionDiagnostics(<Diagnostic>[], <String, List<Diagnostic>>{}).state, 'empty');
  });
  test('successful signaling is not itself a failed transport or authentication', () {
    final start = Diagnostic(event: 'connecting');
    final metrics = <String, List<Diagnostic>>{'rtc.signal': <Diagnostic>[Diagnostic.metric('rtc.signal', elapsedMs: 12)]};
    expect(summarizeConnectionDiagnostics(<Diagnostic>[start], metrics).state, 'connecting');
    expect(summarizeConnectionDiagnostics(<Diagnostic>[start, Diagnostic(event: 'connect-failed', failure: 'unreachable')], metrics).state, 'network');
  });
  test('failure after RTC opens is a handshake problem unless auth was explicitly rejected', () {
    final start = Diagnostic(event: 'connecting');
    final metrics = <String, List<Diagnostic>>{'rtc.open': <Diagnostic>[Diagnostic.metric('rtc.open', elapsedMs: 20)]};
    expect(summarizeConnectionDiagnostics(<Diagnostic>[start, Diagnostic(event: 'connect-failed', failure: 'timeout')], metrics).state, 'handshake');
    expect(summarizeConnectionDiagnostics(<Diagnostic>[start, Diagnostic(event: 'connect-failed', failure: 'unauthorized')], metrics).state, 'auth');
  });
  test('a later disconnect is not blamed on already completed initial restoration', () {
    final start = Diagnostic(event: 'connecting');
    final metrics = <String, List<Diagnostic>>{'welcome': <Diagnostic>[Diagnostic.metric('welcome')], 'catalog-start': <Diagnostic>[Diagnostic.metric('catalog-start')]};
    expect(summarizeConnectionDiagnostics(<Diagnostic>[start, Diagnostic(event: 'connected'), Diagnostic(event: 'disconnected')], metrics).state, 'network');
  });

}
