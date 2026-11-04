import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:url_launcher/url_launcher.dart';

class BrowserAuthCancelled implements Exception {
  const BrowserAuthCancelled();
}

/// Uses the phone's full default browser, with no WebView or authentication tab.
/// Listen before launching so even an immediate callback cannot overtake setup.
class ExternalBrowserAuthenticator {
  ExternalBrowserAuthenticator({
    Stream<Uri> Function()? links,
    Future<bool> Function(Uri)? launch,
    this.timeout = const Duration(minutes: 5),
  }) : _links = links ?? (() => AppLinks().uriLinkStream),
       _launch =
           launch ??
           ((uri) => launchUrl(uri, mode: LaunchMode.externalApplication));

  final Stream<Uri> Function() _links;
  final Future<bool> Function(Uri) _launch;
  final Duration timeout;
  Completer<String>? _pending;

  Future<String> authenticate(String url) async {
    if (_pending != null) {
      throw StateError('Browser authentication is already active');
    }
    final request = Uri.parse(url);
    final expectedState = request.queryParameters['state'];
    if (expectedState == null ||
        expectedState.isEmpty ||
        (request.scheme != 'https' && request.scheme != 'http')) {
      throw ArgumentError('Invalid browser authorization request');
    }
    final pending = Completer<String>();
    _pending = pending;
    StreamSubscription<Uri>? subscription;
    Timer? timer;
    void fail(Object error, [StackTrace? stack]) {
      if (!pending.isCompleted) pending.completeError(error, stack);
    }

    try {
      subscription = _links().listen(
        (uri) {
          if (pending.isCompleted ||
              uri.scheme != 'fastvibe' ||
              uri.host != 'oauth' ||
              uri.path != '/callback' ||
              uri.hasPort ||
              uri.userInfo.isNotEmpty ||
              uri.fragment.isNotEmpty) {
            return;
          }
          final states = uri.queryParametersAll['state'];
          if (states == null ||
              states.length != 1 ||
              states.single != expectedState) {
            return;
          }
          if (!uri.queryParameters.containsKey('code') &&
              !uri.queryParameters.containsKey('error')) {
            return;
          }
          pending.complete(uri.toString());
        },
        onError: fail,
        onDone: () => fail(StateError('Browser callback channel closed')),
      );
      timer = Timer(
        timeout,
        () => fail(TimeoutException('Browser authorization expired', timeout)),
      );
      unawaited(
        Future<bool>.sync(() => _launch(request)).then<void>((opened) {
          if (!opened) {
            fail(StateError('The default browser could not be opened'));
          }
        }, onError: (Object error, StackTrace stack) => fail(error, stack)),
      );
      return await pending.future;
    } finally {
      timer?.cancel();
      await subscription?.cancel();
      if (identical(_pending, pending)) _pending = null;
    }
  }

  void cancel() {
    final pending = _pending;
    if (pending != null && !pending.isCompleted) {
      _pending = null;
      pending.completeError(const BrowserAuthCancelled());
    }
  }
}
