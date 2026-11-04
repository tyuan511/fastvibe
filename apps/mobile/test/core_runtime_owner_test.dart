import 'dart:async';

import 'package:fastvibe_mobile/core/runtime.dart';
import 'package:flutter_test/flutter_test.dart';

class TestNativeRuntime extends NativeCoreRuntime {
  bool fatal = false;
  bool disposed = false;
  Completer<void>? disposal;

  @override
  bool get failed => fatal;

  @override
  Future<void> dispose() async {
    await disposal?.future;
    disposed = true;
  }
}

void main() {
  test(
    'healthy runtime is reused after ordinary transport retirement',
    () async {
      final runtime = TestNativeRuntime();
      var creations = 0;
      final owner = NativeCoreRuntimeOwner(
        factory: () {
          creations++;
          return runtime;
        },
      );
      await owner.prepare(Future<void>.value());
      await owner.prepare(Future<void>.value());
      expect(owner.current, same(runtime));
      expect(creations, 1);
      expect(runtime.disposed, isFalse);
    },
  );

  test('fatal replacement waits for retirement and disposal exactly once', () async {
    final old = TestNativeRuntime()..fatal = true;
    old.disposal = Completer<void>();
    final next = TestNativeRuntime();
    final retirement = Completer<void>();
    var creations = 0;
    final owner = NativeCoreRuntimeOwner(
      factory: () => ++creations == 1 ? old : next,
    );
    // Model queued old-account cleanup as part of the same retirement barrier.
    final retired = retirement.future.then((_) {
      expect(owner.current, same(old));
      expect(old.disposed, isFalse);
    });
    final first = owner.prepare(retired);
    final second = owner.prepare(retired);
    await Future<void>.delayed(Duration.zero);
    expect(creations, 1);
    retirement.complete();
    await Future<void>.delayed(Duration.zero);
    expect(owner.current, same(old));
    expect(creations, 1);
    old.disposal!.complete();
    await Future.wait([first, second]);
    expect(old.disposed, isTrue);
    expect(owner.current, same(next));
    expect(next.disposed, isFalse);
    expect(creations, 2);
  });
}
