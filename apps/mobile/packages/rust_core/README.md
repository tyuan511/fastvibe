# fastvibe_rust_core

This local Flutter FFI plugin only packages `apps/mobile/core`. It contains no
second transport, JNI wrapper or platform state reducer. Dart owns a runtime
handle and calls the Rust C ABI directly.

- **Android:** `DynamicLibrary.open('libfastvibe_mobile_core.so')`. Run
  `bash scripts/build-mobile-android-core.sh` from the repository root. The
  library is staged at
  `android/src/main/jniLibs/arm64-v8a/libfastvibe_mobile_core.so`; the plugin fails
  its Gradle build if that file is absent.
- **iOS:** `DynamicLibrary.process()`. Run `bash scripts/build-mobile-ios.sh`.
  CocoaPods links `ios/Frameworks/FastVibeMobileCore.xcframework`. Explicit linker
  roots retain all `fv_mobile_core_*` entry points in Release as well as Debug.

The canonical ABI header remains `../../core/include/fastvibe_mobile_core.h`.
Generated libraries and frameworks are not checked in. Android currently ships
arm64-v8a, matching the existing release asset and signing contract.
