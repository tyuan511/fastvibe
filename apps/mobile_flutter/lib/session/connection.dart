import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/widgets.dart';

import '../account/account.dart';
import '../account/device_id.dart';
import '../account/official_devices.dart';
import '../app_info.dart';
import '../i18n/core.dart';
import '../protocol/address.dart';
import '../protocol/client.dart';
import '../protocol/diagnostics.dart';
import '../protocol/model_cache.dart';
import '../protocol/rtc_connection.dart';
import '../protocol/rtc_signaling.dart';
import '../storage/servers.dart';
import 'catalog.dart';

const int _reconnectBaseMs = 300;
const int _reconnectMaxMs = 10000;

enum ConnectionStatus { idle, connecting, ready, error }

/// A prompt from the agent or a plugin that has parked a tool call until somebody
/// answers. Answered through `engine:permission-respond`.
class BlockingPrompt {
  const BlockingPrompt({
    required this.id,
    this.conversationId,
    required this.method,
    this.title,
    this.message,
    this.placeholder,
    this.options,
    this.questions,
  });

  final String id;
  final String? conversationId;

  /// confirm | select | input | editor | questions
  final String method;
  final String? title;
  final String? message;
  final String? placeholder;
  final List<String>? options;
  final List<PromptQuestion>? questions;
}

class PromptQuestion {
  const PromptQuestion({required this.question, this.header, this.options});

  final String question;
  final String? header;
  final List<String>? options;
}

class ConnectionTarget {
  const ConnectionTarget(this.server, this.token);

  final SavedServer server;
  final String token;
}

/// The one connection to the machine this phone is looking at.
///
/// Everything the screens read lives here: the catalog, which chats are running, which
/// are waiting on an answer, and the socket itself. A dropped socket keeps the last
/// catalog on screen and reconnects with backoff, because a phone loses its socket every
/// time the screen locks and a visible error page would make a Wi-Fi blip feel like a
/// logout.
class Connection extends ChangeNotifier {
  Connection._();

  static final Connection instance = Connection._();

  ConnectionStatus status = ConnectionStatus.idle;
  String? error;
  bool needsPassword = false;

  /// The computer is on the account and the account is not signed in (or its sign-in was
  /// refused): the way forward is signing in, not a password.
  bool needsAccount = false;
  SavedServer? server;
  List<CatalogProject> projects = <CatalogProject>[];
  List<CatalogConversation> conversations = <CatalogConversation>[];
  List<String> archivedIds = <String>[];

  /// The socket dropped and a replacement is being negotiated; the last snapshot stays.
  bool reconnecting = false;

  final Map<String, bool> running = <String, bool>{};

  /// Wall-clock start of each current run; shared across chat screen mounts.
  final Map<String, int> runningSince = <String, int>{};
  final Map<String, bool> waiting = <String, bool>{};
  List<BlockingPrompt> pending = <BlockingPrompt>[];

  RemoteClient? _client;

  /// A handshaken transport can restore the open chat while the catalog is loading.
  RemoteClient? _transportReady;
  final Map<String, int> _conversationFloors = <String, int>{};
  final Map<String, EventMeta> _statusCursors = <String, EventMeta>{};

  /// Invalidate credential/login work as soon as the user chooses another target.
  int _selectionGeneration = 0;
  ConnectionTarget? _target;
  int _connectionGeneration = 0;
  Timer? _reconnectTimer;
  int _reconnectAttempt = 0;

  /// Includes catalog restore, so foreground/network events cannot open overlapping
  /// sockets.
  RemoteClient? _opening;
  List<ConnectivityResult>? _network;
  _CatalogFlight? _catalogFlight;

  final List<void Function(Map<String, Object?>, EventMeta?)> _engineListeners =
      <void Function(Map<String, Object?>, EventMeta?)>[];
  bool _batching = false;
  bool _changedInBatch = false;

  void _batchState(void Function() update) {
    _batching = true;
    try {
      update();
    } finally {
      _batching = false;
      if (_changedInBatch) {
        _changedInBatch = false;
        notifyListeners();
      }
    }
  }

  void _setState(void Function() update) {
    update();
    if (_batching) {
      _changedInBatch = true;
      return;
    }
    notifyListeners();
  }

  /// The handshaken client, or null while the socket is down or still opening.
  RemoteClient? get client => identical(_client, _transportReady) ? _client : null;

  RemoteClient? get transportReady => _transportReady;

  void onEngineEvent(void Function(Map<String, Object?> event, EventMeta? meta) listener) {
    _engineListeners.add(listener);
  }

  void offEngineEvent(void Function(Map<String, Object?> event, EventMeta? meta) listener) {
    _engineListeners.remove(listener);
  }

  /// The open chat's authoritative state participates in the catalog's live overlay.
  void applyChatSnapshot(RemoteClient remote, String conversationId, {required int seq, bool? running, List<Object?>? pendingUi}) {
    if (client != remote) return;
    _handlePushInternal(r'$chat-snapshot', <String, Object?>{
      'conversationId': conversationId,
      'seq': seq,
      'running': ?running,
      'pendingUi': ?pendingUi,
    });
  }

  /// Reconcile status events held alongside a chat snapshot, without delivering them twice.
  void applyChatEvent(RemoteClient remote, Map<String, Object?> event) {
    if (client != remote) return;
    _handlePushInternal('engine:event', event, restoring: true, fromChat: true);
  }

  /// Keep the phone list in step with a settings write made by this very socket.
  void setArchivedIds(List<String> ids) {
    _captureCatalogPush('settings:changed', <String, Object?>{'archivedConversations': ids});
    _setState(() => archivedIds = ids);
  }

  Future<void> connectSaved(SavedServer server) async {
    final selection = ++_selectionGeneration;
    _abandonConnection();
    _reset(server: server, status: ConnectionStatus.connecting);
    String? token;
    try {
      token = server.isOfficial ? AccountService.instance.token : await readToken(server.id);
    } catch (exception) {
      if (selection != _selectionGeneration) return;
      _abandonConnection();
      _reset(server: server, status: ConnectionStatus.error, error: '$exception');
      return;
    }
    if (selection != _selectionGeneration) return;
    if (token == null || token.isEmpty) {
      _abandonConnection();
      if (server.isOfficial) {
        _reset(server: server, status: ConnectionStatus.error, needsAccount: true, error: t('conn.accountRequired'));
      } else {
        _reset(server: server, status: ConnectionStatus.error, needsPassword: true, error: t('conn.needPassword'));
      }
      return;
    }
    final next = _beginTarget(server, token);
    await _connectWithToken(next, ++_connectionGeneration, silent: false);
  }

  Future<void> loginSaved(SavedServer server, String password) async {
    final selection = ++_selectionGeneration;
    _abandonConnection();
    _reset(server: server, status: ConnectionStatus.connecting);
    final remote = RemoteClient(version: appVersion);
    try {
      final token = await remote.login(server.origin, password, 'FastVibe ${server.alias}');
      if (selection != _selectionGeneration) return;
      await writeToken(server.id, token);
      if (selection != _selectionGeneration) return;
      final next = _beginTarget(server, token);
      await _connectWithToken(next, ++_connectionGeneration, silent: false);
    } catch (exception) {
      if (selection != _selectionGeneration) return;
      _reset(
        server: server,
        status: ConnectionStatus.error,
        needsPassword: true,
        error: exception is StateError ? exception.message : t('conn.loginFailed'),
      );
    }
  }

  /// The account signed out (or its sign-in was refused): a connection made through it is
  /// no longer one the phone has the right to hold.
  void handleAccountChange() {
    final current = server;
    if (current != null && current.isOfficial && !AccountService.instance.signedIn) {
      disconnect();
    }
  }

  void disconnect() {
    _selectionGeneration += 1;
    _abandonConnection();
    _reset();
  }

  /// Ask the current saved target to reconnect immediately instead of waiting for backoff.
  void reconnectNow() {
    final target = _target;
    if (target == null || !reconnecting) return;
    _clearReconnectTimer();
    _scheduleReconnect(target, _connectionGeneration, immediate: true);
  }

  /// Re-read the catalog, run and prompt state — the list's pull-to-refresh.
  Future<void> refreshConnection() async {
    final remote = client;
    if (remote == null) {
      final target = _target;
      if (target != null) _scheduleReconnect(target, _connectionGeneration, immediate: true);
      return;
    }
    await _refreshCatalog(remote);
  }

  void resolvePendingPrompt(String id) {
    final pending = this.pending.where((item) => item.id != id).toList();
    _setState(() {
      this.pending = pending;
      waiting
        ..clear()
        ..addEntries(pending.where((item) => item.conversationId != null).map((item) => MapEntry(item.conversationId!, true)));
    });
  }

  /// Subscribe to one conversation by name. The desktop forwards a background chat's
  /// stream only to a named subscriber, so this is what makes the phone's chat live.
  void subscribeScope(String scope) => _client?.subscribe(<String>[scope]);

  void unsubscribeScope(String scope) => _client?.unsubscribe(<String>[scope]);

  Future<void> _connectWithToken(ConnectionTarget next, int generation, {required bool silent}) async {
    final server = next.server;
    if (!_isCurrentTarget(next, generation) || _opening != null) return;
    _clearReconnectTimer();
    reconnecting = silent;
    final address = server.isOfficial ? null : parseServerAddress(server.origin);
    if (!server.isOfficial && address == null) {
      _abandonConnection();
      _reset(server: server, status: ConnectionStatus.error, error: t('conn.badAddress'));
      return;
    }
    _retireClient();
    final remote = RemoteClient(version: appVersion);
    _opening = remote;
    _client = remote;
    remote.setActive(_appIsActive());
    final started = DateTime.now().millisecondsSinceEpoch;
    recordConnectionDiagnostic(Diagnostic(event: 'connecting', serverId: server.id, attempt: _reconnectAttempt));
    if (!silent) {
      _reset(server: server, status: ConnectionStatus.connecting);
    }
    remote.onPush((channel, payload, meta) => _handlePushInternal(channel, payload, meta: meta));
    remote.onDisconnect((detail) => _onRemoteDisconnect(remote, next, generation, started, detail));
    try {
      if (server.isOfficial) {
        final account = AccountService.instance;
        final deviceId = server.officialDeviceId!;
        final name = await account.deviceLabel();
        final clientId = await stableDeviceId();
        await remote.connectOpened(
          () => RtcDialer(
            origin: account.origin,
            token: next.token,
            deviceId: deviceId,
            clientName: name,
            platform: account.platform,
            clientId: clientId,
          ).dial(),
        );
      } else {
        await remote.connect(address!, next.token);
      }
      if (!_isCurrentTarget(next, generation) || _client != remote) return;
      remote.subscribe(<String>['*']);
      final catalog = _refreshCatalog(remote);
      _conversationFloors.clear();
      _statusCursors.clear();
      _transportReady = remote;
      reconnecting = false;
      _armRollover();
      // Notify the mounted chat immediately. It gates its controls on its own
      // snapshot/replay, independently of the still-loading global catalog.
      _setState(() => reconnecting = false);
      await catalog;
      if (!_isCurrentTarget(next, generation) || _client != remote) return;
      // Local persistence need not hold the ready socket or the chat's restoration.
      unawaited(ServerStore.instance.patch(server.id, lastConnectedAt: DateTime.now().millisecondsSinceEpoch));
      _reconnectAttempt = 0;
      reconnecting = false;
      recordConnectionDiagnostic(Diagnostic(
        event: 'connected',
        serverId: server.id,
        elapsedMs: DateTime.now().millisecondsSinceEpoch - started,
      ));
      _setState(() {
        status = ConnectionStatus.ready;
        reconnecting = false;
        this.server = server;
        error = null;
        needsPassword = false;
        needsAccount = false;
      });
    } catch (exception) {
      if (!_isCurrentTarget(next, generation) || _client != remote) return;
      final connectionError = exception is ConnectionError ? exception : null;
      recordConnectionDiagnostic(Diagnostic(
        event: 'connect-failed',
        serverId: server.id,
        elapsedMs: DateTime.now().millisecondsSinceEpoch - started,
        failure: connectionError?.code ?? 'restore-failed',
        detailKind: connectionError?.detail?.kind,
        detailCode: connectionError?.detail?.code,
      ));
      final unauthorized = connectionError != null &&
          (connectionError.code == 'unauthorized' || connectionError.detail?.code == 4001);
      // A computer that is no longer on the account will not come back by retrying.
      final gone = server.isOfficial && connectionError?.code == 'gone';
      if (server.isOfficial && unauthorized) unawaited(AccountService.instance.tokenRejected(next.token));
      if (gone) unawaited(OfficialDevices.instance.refresh());
      if (identical(_client, remote)) {
        _client = null;
        _retireClient(remote);
      }
      if (unauthorized || gone || !silent) reconnecting = false;
      if (unauthorized || gone) {
        _target = null;
        _connectionGeneration += 1;
        _clearReconnectTimer();
      }
      if (unauthorized || gone || !silent) {
        _reset(
          server: server,
          status: ConnectionStatus.error,
          needsPassword: unauthorized && !server.isOfficial,
          needsAccount: unauthorized && server.isOfficial,
          error: server.isOfficial && connectionError != null && !unauthorized
              ? connectionError.message
              : unauthorized
                  ? (server.isOfficial ? t('conn.accountRequired') : t('conn.expired'))
                  : (exception is StateError ? exception.message : '$exception'),
        );
      } else {
        reconnecting = true;
        // Auto-reconnect failures stay invisible; retain the last usable snapshot and
        // keep trying with backoff instead of flashing the connection error screen.
        _setState(() {
          status = ConnectionStatus.ready;
          reconnecting = true;
          this.server = server;
          error = null;
          needsPassword = false;
          needsAccount = false;
        });
      }
      if (!unauthorized && !gone) _scheduleReconnect(next, generation);
    } finally {
      if (identical(_opening, remote)) _opening = null;
    }
  }

  void _onRemoteDisconnect(
    RemoteClient remote,
    ConnectionTarget next,
    int generation,
    int started,
    DisconnectDetail detail,
  ) {
    final server = next.server;
    if (_client != remote || !_isCurrentTarget(next, generation)) return;
    recordConnectionDiagnostic(Diagnostic(
      event: 'disconnected',
      serverId: server.id,
      detailKind: detail.kind,
      detailCode: detail.code,
      elapsedMs: DateTime.now().millisecondsSinceEpoch - started,
    ));
    final restoring = identical(_opening, remote) && !identical(_transportReady, remote);
    if (identical(_transportReady, remote)) _transportReady = null;
    _client = null;
    if (identical(_opening, remote)) _opening = null;
    _rolloverTimer?.cancel();
    _rolloverTimer = null;
    remote.onPush(null);
    remote.onDisconnect(null);
    if (detail.code == 4001) {
      _abandonConnection();
      _reset(server: server, status: ConnectionStatus.error, error: t('conn.expired'), needsPassword: true);
      return;
    }
    reconnecting = true;
    // Keep the current catalog and conversation on screen while the replacement
    // socket is negotiated. A dropped mobile socket is expected during backgrounding
    // and a visible error page makes a short Wi-Fi blip feel like a logout.
    _setState(() {
      status = ConnectionStatus.ready;
      reconnecting = true;
      error = null;
      needsPassword = false;
      needsAccount = false;
    });
    _scheduleReconnect(next, generation, immediate: !restoring);
  }

  /// How long before a relay credential expires its connection is replaced. Long enough
  /// for a whole handshake over a slow path (the dial gives up after twenty seconds) and
  /// for the old one to finish what it is answering; short enough that the replacement is
  /// not spent on credential life the old connection still has.
  static const Duration _rolloverLead = Duration(seconds: 75);
  Timer? _rolloverTimer;
  RemoteClient? _renewing;

  /// A connection through the relay lasts exactly as long as the credential it was made
  /// with. So before that runs out, a second connection is made with a new one and the
  /// session moves onto it: the screens re-attach to the new client the way they do after
  /// any reconnect (from the checkpoint they hold), but nothing is dropped and no banner
  /// shows, because the old connection is still up while it happens.
  void _armRollover() {
    _rolloverTimer?.cancel();
    _rolloverTimer = null;
    final remote = _client;
    final target = _target;
    if (remote == null || target == null || !identical(remote, _transportReady) || !_appIsActive()) return;
    final expires = remote.credentialExpiresAt;
    if (expires == null) return;
    final generation = _connectionGeneration;
    var wait = expires.difference(DateTime.now()) - _rolloverLead;
    if (wait < Duration.zero) wait = Duration.zero;
    _rolloverTimer = Timer(wait, () {
      _rolloverTimer = null;
      unawaited(_rollover(remote, target, generation));
    });
  }

  Future<void> _rollover(RemoteClient old, ConnectionTarget next, int generation, {int attempt = 0}) async {
    bool current() =>
        _isCurrentTarget(next, generation) && identical(_client, old) && identical(_transportReady, old);
    final server = next.server;
    if (!current() || !server.isOfficial || _renewing != null || !_appIsActive()) return;
    // A direct connection never depended on the credential, and a relayed one on a
    // different path is not the credential's to end.
    if (!await old.usesRelay() || !current()) return;
    final started = DateTime.now().millisecondsSinceEpoch;
    final fresh = RemoteClient(version: appVersion);
    _renewing = fresh;
    fresh.setActive(true);
    try {
      final account = AccountService.instance;
      final name = await account.deviceLabel();
      final clientId = await stableDeviceId();
      await fresh.connectOpened(
        () => RtcDialer(
          origin: account.origin,
          token: next.token,
          deviceId: server.officialDeviceId!,
          clientName: name,
          platform: account.platform,
          clientId: clientId,
        ).dial(renewal: true),
      );
    } catch (exception) {
      fresh.close();
      if (identical(_renewing, fresh)) _renewing = null;
      recordConnectionDiagnostic(Diagnostic(
        event: 'rollover-failed',
        serverId: server.id,
        elapsedMs: DateTime.now().millisecondsSinceEpoch - started,
        failure: exception is ConnectionError ? exception.code : 'rollover-failed',
      ));
      // The old connection is still good for a little while: try again, a few times.
      final left = old.credentialExpiresAt?.difference(DateTime.now()) ?? Duration.zero;
      if (current() && attempt < 3 && left > const Duration(seconds: 15)) {
        _rolloverTimer?.cancel();
        _rolloverTimer = Timer(const Duration(seconds: 4), () {
          _rolloverTimer = null;
          unawaited(_rollover(old, next, generation, attempt: attempt + 1));
        });
      }
      return;
    }
    if (identical(_renewing, fresh)) _renewing = null;
    if (!current()) {
      // The old one went away, or the user chose another target, while this was being made.
      fresh.close();
      return;
    }
    recordConnectionDiagnostic(Diagnostic(
      event: 'rolled-over',
      serverId: server.id,
      elapsedMs: DateTime.now().millisecondsSinceEpoch - started,
    ));
    old.onPush(null);
    old.onDisconnect(null);
    fresh.onPush((channel, payload, meta) => _handlePushInternal(channel, payload, meta: meta));
    fresh.onDisconnect((detail) => _onRemoteDisconnect(fresh, next, generation, started, detail));
    fresh.setActive(_appIsActive());
    _client = fresh;
    _transportReady = fresh;
    fresh.subscribe(<String>['*']);
    final catalog = _refreshCatalog(fresh);
    _conversationFloors.clear();
    _statusCursors.clear();
    // The open chat sees a new client and restores onto it from its own checkpoint.
    _setState(() {});
    _armRollover();
    unawaited(_retireAfterDrain(old));
    try {
      await catalog;
    } catch (_) {
      // The catalog on screen is still right; a failed refresh retries with the next event.
    }
  }

  /// Let a replaced connection finish the requests it is answering, then close it. What is
  /// still unanswered when its credential runs out is lost with it, the same as on any
  /// dropped connection, and its callers already treat that as "maybe sent".
  Future<void> _retireAfterDrain(RemoteClient old) async {
    final until = DateTime.now().add(const Duration(seconds: 45));
    final limit = old.credentialExpiresAt?.subtract(const Duration(seconds: 5));
    while (old.pendingCalls > 0 &&
        DateTime.now().isBefore(until) &&
        (limit == null || DateTime.now().isBefore(limit))) {
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    old.close();
  }

  ConnectionTarget _beginTarget(SavedServer server, String token) {
    _retireClient();
    _clearReconnectTimer();
    _reconnectAttempt = 0;
    final next = ConnectionTarget(server, token);
    _target = next;
    return next;
  }

  bool _isCurrentTarget(ConnectionTarget next, int generation) =>
      identical(_target, next) && _connectionGeneration == generation;

  void _abandonConnection() {
    reconnecting = false;
    _target = null;
    _connectionGeneration += 1;
    _reconnectAttempt = 0;
    _clearReconnectTimer();
    _retireClient();
  }

  void _retireClient([RemoteClient? value]) {
    final remote = value ?? _client;
    if (remote == null) return;
    if (identical(remote, _client)) {
      _rolloverTimer?.cancel();
      _rolloverTimer = null;
    }
    remote.onDisconnect(null);
    remote.onPush(null);
    remote.close();
    if (identical(_transportReady, remote)) _transportReady = null;
    if (identical(_opening, remote)) _opening = null;
    if (identical(_client, remote)) _client = null;
  }

  void _clearReconnectTimer() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  void _scheduleReconnect(ConnectionTarget next, int generation, {bool immediate = false}) {
    if (!_isCurrentTarget(next, generation) || !_appIsActive()) return;
    // Only a definite absence of a network pauses retries. Internet reachability says
    // nothing about a saved LAN server, and an unknown state must never lock it out.
    final network = _network;
    if (network != null && network.isNotEmpty && network.every((result) => result == ConnectivityResult.none)) return;
    if (immediate) _clearReconnectTimer();
    if (_reconnectTimer != null) return;
    final exponent = _reconnectAttempt > 10 ? 10 : _reconnectAttempt;
    final base = (_reconnectBaseMs * (1 << exponent)).clamp(_reconnectBaseMs, _reconnectMaxMs);
    final jitter = 0.8 + DateTime.now().microsecondsSinceEpoch % 1000 / 5000;
    final delay = immediate ? 0 : (base * jitter).round();
    _reconnectAttempt += 1;
    _reconnectTimer = Timer(Duration(milliseconds: delay), () {
      _reconnectTimer = null;
      if (!_appIsActive() || !_isCurrentTarget(next, generation)) return;
      unawaited(_connectWithToken(next, generation, silent: true));
    });
  }

  /// Called from the app's lifecycle observer.
  void handleAppState(AppLifecycleState state) {
    recordConnectionDiagnostic(Diagnostic(event: 'app-state', appState: state.name));
    _client?.setActive(state == AppLifecycleState.resumed);
    if (state != AppLifecycleState.resumed) {
      _clearReconnectTimer();
      // Its timers stop with the app, and the socket will not be there on the way back.
      dropKeptSignaling();
      return;
    }
    _wakeConnection(fast: true);
    _refreshNetworkState();
    // Timers were frozen while the app was away; the credential's clock was not.
    _armRollover();
  }

  void _wakeConnection({bool fast = false, bool replaceOpening = false}) {
    final target = _target;
    if (target == null || !_appIsActive()) return;
    final opening = _opening;
    if (opening != null && replaceOpening) _retireClient(opening);
    if (client != null) {
      _client?.checkHealth(fast: fast);
    } else if (_opening == null) {
      _scheduleReconnect(target, _connectionGeneration, immediate: true);
    }
  }

  void handleNetworkChange(List<ConnectivityResult> next) {
    final previous = _network;
    _network = next;
    if (previous != null && _sameNetwork(previous, next)) return;
    recordConnectionDiagnostic(Diagnostic(
      event: 'network',
      networkType: next.map((result) => result.name).join(','),
      connected: !next.every((result) => result == ConnectivityResult.none),
    ));
    // A signaling socket kept from the last call was opened on the network that just went.
    dropKeptSignaling();
    if (next.isNotEmpty && next.every((result) => result == ConnectivityResult.none)) {
      _clearReconnectTimer();
      return;
    }
    _reconnectAttempt = 0;
    final changedPath = previous != null &&
        (previous.isEmpty ||
            previous.every((result) => result == ConnectivityResult.none) ||
            !_sameNetwork(previous, next));
    _wakeConnection(fast: changedPath, replaceOpening: changedPath);
  }

  bool _sameNetwork(List<ConnectivityResult> a, List<ConnectivityResult> b) {
    if (a.length != b.length) return false;
    for (var index = 0; index < a.length; index++) {
      if (a[index] != b[index]) return false;
    }
    return true;
  }

  Future<void> _refreshNetworkState() async {
    try {
      handleNetworkChange(await Connectivity().checkConnectivity());
    } catch (_) {
      // Probing the actual server remains available if OS state is unknown.
    }
  }

  Future<void> _refreshCatalog(RemoteClient remote) {
    final existing = _catalogFlight;
    if (existing != null && identical(existing.remote, remote)) return existing.promise;
    final flight = _CatalogFlight(remote, <String, _CatalogPush>{});
    _catalogFlight = flight;
    flight.promise = _readCatalog(remote, flight.pushes).whenComplete(() {
      if (identical(_catalogFlight, flight)) _catalogFlight = null;
    });
    return flight.promise;
  }

  Future<void> _readCatalog(RemoteClient remote, Map<String, _CatalogPush> pushes) async {
    final started = DateTime.now().millisecondsSinceEpoch;
    final results = await Future.wait(<Future<Object?>>[
      remote.call('conversations:list'),
      remote.call('engine:get-running'),
      remote.call('engine:get-pending-ui'),
      remote.call('settings:get'),
    ]);
    if (_client != remote) return;
    recordConnectionDiagnostic(
      Diagnostic.metric('catalog', elapsedMs: DateTime.now().millisecondsSinceEpoch - started),
    );
    final catalog = results[0];
    final runningIds = results[1];
    final pendingEvents = results[2];
    final settings = results[3];

    final runningNext = <String, bool>{};
    final runningSinceNext = <String, int>{};
    if (runningIds is List) {
      for (final id in runningIds) {
        if (id is! String) continue;
        runningNext[id] = true;
        runningSinceNext[id] = runningSince[id] ?? DateTime.now().millisecondsSinceEpoch;
      }
    }
    final pendingNext = <BlockingPrompt>[];
    if (pendingEvents is List) {
      for (final event in pendingEvents) {
        final prompt = parseBlockingPrompt(event);
        if (prompt != null) pendingNext.add(prompt);
      }
    }
    final waitingNext = <String, bool>{};
    for (final item in pendingNext) {
      if (item.conversationId != null) waitingNext[item.conversationId!] = true;
    }
    _batchState(() {
      _applyCatalog(catalog);
      archivedIds = archivedIdsFrom(settings);
      running
        ..clear()
        ..addAll(runningNext);
      runningSince
        ..clear()
        ..addAll(runningSinceNext);
      waiting
        ..clear()
        ..addAll(waitingNext);
      pending = pendingNext;
      // Pushes can outrun one of the four reads. Reapply the latest value per key,
      // without delivering engine events twice or painting a stale intermediate state.
      for (final push in pushes.values) {
        _handlePushInternal(push.channel, push.payload, restoring: true);
      }
    });
  }

  void _captureCatalogPush(String channel, Object? payload) {
    final flight = _catalogFlight;
    if (flight == null || !identical(flight.remote, _client)) return;
    String? key;
    if (channel == 'settings:changed' || channel == 'workspace:changed') key = channel;
    if (channel == r'$chat-snapshot' && payload is Map && payload['conversationId'] is String) {
      key = 'chat:${payload['conversationId']}';
    }
    if (channel == 'engine:event' && payload is Map) {
      if (payload['type'] == 'conversation_running' && payload['conversationId'] is String) {
        key = 'run:${payload['conversationId']}';
      }
      if ((parseBlockingPrompt(payload) != null || payload['type'] == 'extension_ui_dismiss') && payload['id'] is String) {
        key = 'prompt:${payload['id']}';
      }
    }
    if (key != null) {
      flight.pushes.remove(key);
      flight.pushes[key] = _CatalogPush(channel, payload);
    }
  }

  void _handlePushInternal(
    String channel,
    Object? payload, {
    EventMeta? meta,
    bool restoring = false,
    bool fromChat = false,
  }) {
    if (!restoring && channel != 'engine:event') _captureCatalogPush(channel, payload);
    if (_client != null && (channel == 'models-dev:changed' || channel == 'settings:changed')) {
      invalidateModelCatalog(_client);
    }
    if (channel == 'settings:changed') {
      _setState(() => archivedIds = archivedIdsFrom(payload));
      return;
    }
    if (channel == 'workspace:changed') {
      _applyCatalog(payload);
      return;
    }
    if (channel == r'$chat-snapshot' && payload is Map && payload['conversationId'] is String) {
      final id = payload['conversationId'] as String;
      final seq = payload['seq'];
      if (seq is int) _conversationFloors[id] = seq;
      _batchState(() {
        if (payload['running'] is bool) {
          _handlePushInternal(
            'engine:event',
            <String, Object?>{'type': 'conversation_running', 'conversationId': id, 'running': payload['running']},
            restoring: true,
          );
        }
        if (payload['pendingUi'] is List) {
          final next = pending.where((item) => item.conversationId != id).toList();
          for (final value in payload['pendingUi'] as List) {
            final prompt = parseBlockingPrompt(value);
            if (prompt != null) next.add(prompt);
          }
          pending = next;
          waiting
            ..clear()
            ..addEntries(next.where((item) => item.conversationId != null).map((item) => MapEntry(item.conversationId!, true)));
        }
      });
      return;
    }
    if (channel != 'engine:event' || payload is! Map) return;
    final event = payload.cast<String, Object?>();
    final statusEvent = event['type'] == 'conversation_running' ||
        event['type'] == 'extension_ui_request' ||
        event['type'] == 'extension_ui_dismiss';
    final id = event['conversationId'] is String ? event['conversationId'] as String : null;
    final floor = id != null ? _conversationFloors[id] : null;
    final wire = id != null ? _statusCursors[id] : null;
    // Catalog overlay values have already passed the live sequence gate. They must
    // be applied again after its older baseline, even when their seq equals the floor.
    final staleStatus = (!restoring || fromChat) &&
        statusEvent &&
        (meta != null
            ? wire?.epoch == meta.epoch && meta.seq <= wire!.seq
            : event['seq'] is int && floor != null && (event['seq'] as int) <= floor);
    if ((!restoring || fromChat) && !staleStatus) _captureCatalogPush(channel, payload);
    if (statusEvent && !staleStatus && id != null && meta != null) _statusCursors[id] = meta;
    if (statusEvent && !staleStatus && id != null && floor != null && event['seq'] is int) {
      _conversationFloors[id] = event['seq'] as int;
    }
    if (!staleStatus && event['type'] == 'conversation_running' && event['conversationId'] is String) {
      final id = event['conversationId'] as String;
      _setState(() {
        running[id] = event['running'] == true;
        if (event['running'] == true) {
          runningSince.putIfAbsent(id, () => DateTime.now().millisecondsSinceEpoch);
        } else {
          runningSince.remove(id);
        }
      });
    }
    if (!staleStatus && event['type'] == 'extension_ui_request') {
      final prompt = parseBlockingPrompt(event);
      if (prompt != null) {
        _setState(() {
          pending = pending.where((item) => item.id != prompt.id).toList()..add(prompt);
          if (prompt.conversationId != null) waiting[prompt.conversationId!] = true;
        });
      }
    }
    if (!staleStatus && event['type'] == 'extension_ui_dismiss' && event['id'] is String) {
      final id = event['id'] as String;
      _setState(() {
        pending = pending.where((item) => item.id != id).toList();
        waiting
          ..clear()
          ..addEntries(pending.where((item) => item.conversationId != null).map((item) => MapEntry(item.conversationId!, true)));
      });
    }
    if (restoring) return;
    for (final listener in _engineListeners) {
      try {
        listener(event, meta);
      } catch (_) {
        // One screen's reducer must not prevent other subscribers from receiving a push.
      }
    }
  }

  void _applyCatalog(Object? payload) {
    if (payload is! Map) return;
    final map = payload.cast<String, Object?>();
    final nextProjects = map['projects'] is List
        ? (map['projects'] as List).map(parseProject).whereType<CatalogProject>().toList()
        : projects;
    final nextConversations = map['conversations'] is List
        ? (map['conversations'] as List)
            .map((value) => parseConversation(value, untitled: t('conn.untitled')))
            .whereType<CatalogConversation>()
            .toList()
        : conversations;
    _setState(() {
      projects = nextProjects;
      conversations = nextConversations;
    });
  }

  void _reset({
    SavedServer? server,
    ConnectionStatus status = ConnectionStatus.idle,
    String? error,
    bool needsPassword = false,
    bool needsAccount = false,
  }) {
    _setState(() {
      this.status = status;
      this.error = error;
      this.needsPassword = needsPassword;
      this.needsAccount = needsAccount;
      this.server = server;
      projects = <CatalogProject>[];
      conversations = <CatalogConversation>[];
      archivedIds = <String>[];
      reconnecting = false;
      running.clear();
      runningSince.clear();
      waiting.clear();
      pending = <BlockingPrompt>[];
    });
  }
}

class _CatalogFlight {
  _CatalogFlight(this.remote, this.pushes);

  final RemoteClient remote;
  final Map<String, _CatalogPush> pushes;
  Future<void> promise = Future<void>.value();
}

class _CatalogPush {
  const _CatalogPush(this.channel, this.payload);

  final String channel;
  final Object? payload;
}

List<String> archivedIdsFrom(Object? value) {
  if (value is! Map || value['archivedConversations'] is! List) return <String>[];
  return (value['archivedConversations'] as List).whereType<String>().toList();
}

BlockingPrompt? parseBlockingPrompt(Object? value) {
  if (value is! Map || value['type'] != 'extension_ui_request' || value['id'] is! String) return null;
  final method = value['method'];
  if (method != 'confirm' && method != 'select' && method != 'input' && method != 'editor' && method != 'questions') {
    return null;
  }
  return BlockingPrompt(
    id: value['id'] as String,
    conversationId: value['conversationId'] is String ? value['conversationId'] as String : null,
    method: method as String,
    title: value['title'] is String ? value['title'] as String : null,
    message: value['message'] is String ? value['message'] as String : null,
    placeholder: value['placeholder'] is String ? value['placeholder'] as String : null,
    options: _stringList(value['options']),
    questions: value['questions'] is List
        ? (value['questions'] as List).map(_parseQuestion).whereType<PromptQuestion>().toList()
        : null,
  );
}

PromptQuestion? _parseQuestion(Object? value) {
  if (value is! Map || value['question'] is! String) return null;
  return PromptQuestion(
    question: value['question'] as String,
    header: value['header'] is String ? value['header'] as String : null,
    options: _stringList(value['options']),
  );
}

List<String>? _stringList(Object? value) {
  if (value is! List) return null;
  final items = value.whereType<String>().toList();
  return items.isEmpty ? null : items;
}

bool _appIsActive() {
  final state = WidgetsBinding.instance.lifecycleState;
  return state == null || state == AppLifecycleState.resumed;
}
