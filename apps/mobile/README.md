# Native FastVibe mobile clients

`apps/mobile` contains the rebuilt phone client:

- `core/`: Rust core shared by both platforms. It owns App Protocol v1, iroh framing, transcript projection, interleaved text/thinking/tool parts, event reduction, and bounded history windows. `src/lib.rs` only declares modules and reexports the stable public surface; `protocol.rs` contains wire and transcript types, `frames.rs` handles logical fragments, `iroh_transport.rs` handles stream boundaries, `transcript.rs` owns projection, `mobile_client.rs` owns account requests, `runtime/` separates state, command dispatch, account commands, connection lifecycle, RPC correlation and event hydration, and `ffi.rs` contains the C ABI.
- `android/`: Kotlin + Jetpack Compose application plus the `:native` AAR library. The native module builds the Rust core for Android ABIs, links a thin JNI shim, and exposes the same JSON state contract.
- `ios/`: Swift Package and SwiftUI application. Its C bridge links the Rust XCFramework directly on iOS and exposes the same JSON state contract; host SwiftPM tests can run without that artifact.

The native clients use the account authenticated iroh endpoint as their only remote transport. They do not expose the desktop LAN password/listener as a separate product mode. The iroh QUIC stream carries each App Protocol fragment with a four-byte big-endian length prefix, bounded at 65,537 bytes; both the desktop sidecar and mobile core must use this framing. The mobile sends its initial hello to make the bidirectional stream visible to the desktop, whose socket adapter buffers initial messages until peer authorization and protocol attachment finish.

## iOS packaging

The Rust ABI is declared manually in `core/include/fastvibe_mobile_core.h` and is
consumed by the SwiftPM C target under `ios/Sources/FastVibeMobileCoreFFI`.
Build the device and simulator static libraries and package them as an XCFramework:

```sh
pnpm mobile:ios:build
pnpm mobile:ios:check
xcodebuild -project apps/mobile/ios/FastVibeApp.xcodeproj -scheme FastVibe \
  -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build
```

The iOS build enables the real `iroh-transport,mobile-client` features by default. The vendored Apple compatibility sources keep iOS interface/address enumeration from `netdev`, while avoiding the BSD `AF_ROUTE` and unavailable `libc::in6_ifreq` paths used by older upstream releases. iroh can therefore gather host candidates and use STUN for a direct path, with relay fallback when NAT traversal cannot establish a direct path. Set `FASTVIBE_IOS_CARGO_FEATURES` only when producing a deliberately different feature variant.

The iOS SwiftUI screens follow the approved prototype: login → computers → conversation list → transcript, with settings reached from computers. The shared visual system owns the three-color background, glass surfaces and light/dark tokens. Transcript history, streaming, queue and pending-operation states share one conversation view. Production screens consume the Rust state and account data; reference conversations live only in previews and tests.

Export 390 × 844 native layout reference images on macOS, in both appearances:

```sh
FASTVIBE_IOS_PREVIEW_DIR="$PWD/apps/mobile/ios/.native-build/previews" \
  swift test --package-path apps/mobile/ios --filter PrototypeRenderTests
```

These host renders show edge-to-edge page content without a simulated status bar or home indicator. They support comparison with the HTML prototype. iPhone safe areas, keyboard behavior, scrolling and final material appearance are reviewed on the device. Without the export variable, the render test is skipped.

The backdrop has a separate full-image sRGB regression check against lossless browser PNG exports of the approved HTML; it runs without the export variable. The shared glass renderer applies the prototype's explicit blur, saturation, tint, sheen and shadow values without adding system Material. It currently samples only the known page backdrop: text and other views behind sheets are not part of the blur, and the offline sheet's separate presentation host still needs device review. Passing the backdrop check therefore does not establish whole-screen visual equivalence.

```sh
cargo test --manifest-path apps/mobile/core/Cargo.toml
swift test --package-path apps/mobile/ios
cd apps/mobile/android && ./gradlew assembleDebug
cd apps/mobile/android && ./gradlew :native:buildAar
```

The transcript model keeps message parts in source order, including thinking, tool calls, tool results, model changes, and compaction. UI lists must render lazily and consume the bounded visible window; older turns are fetched by cursor instead of loading the whole transcript into a single view.


### Android native prerequisites

The Android build uses the checked-in Gradle wrapper (Gradle 8.10.2), Java 17, Android SDK 35, CMake 3.22.1, and Android NDK 28.2.13676358. Put `sdk.dir=/absolute/path/to/Android/sdk` in `android/local.properties`, or set `ANDROID_SDK_ROOT`/`ANDROID_HOME`; `local.properties` is ignored and must not be committed.

The shipping Android build targets **arm64-v8a / ARMv8 only**, matching the Flutter release APK. `./gradlew :native:buildRustAndroid` and `apps/mobile/android/tool/build.sh` copy the ARM64 Rust library into the APK/AAR JNI directory; pass `-PfastvibeAbis=...` only for an intentional development ABI override. `./gradlew :native:buildAar` produces `native/build/outputs/aar/native-release.aar`. Install `aarch64-linux-android` with `rustup target add aarch64-linux-android`.

### Android product and verification

The approved visual baseline is in [`design/prototype-standalone.html`](design/prototype-standalone.html). The Android app uses the real account service and Rust/JNI runtime; production code contains no sample conversation catalog. Login uses browser PKCE, and saved credentials are bound to the configured issuer. The account migration reads the old Flutter secure-storage format without removing its data.

Conversation operations complete on the server's `rpcResult`, not when JNI queues the call. The core owns transcript projection, snapshot hydration, live event ordering and history paging. Android retains drafts on failed or uncertain sends and validates output downloads in chunks of at most 512 KiB, including stable size and modification time.

Run the Android code checks and create a development APK with:

```sh
cd apps/mobile/android
./gradlew :app:testDebugUnitTest :native:testDebugUnitTest :app:assembleDebug
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`. It uses the development signing certificate, so it cannot replace an installed production APK signed with the release key. Production builds use the existing `FASTVIBE_ANDROID_*` signing inputs through `tool/build.sh release`; release verification checks the APK certificate against that keystore. The application ID remains `dev.fastvibe.mobile`, and `version.properties` advances beyond Flutter build 510. Published update assets retain `FastVibe-app-vX.Y.Z-arm64-v8a.apk`.

The local desktop protocol harness and C ABI integration test are separate from UI acceptance:

```sh
node --experimental-strip-types --test test/native-android-release.test.ts
node --experimental-strip-types --test test/mobile-protocol.integration.test.ts
```

The protocol test starts a temporary relay, account test server and real desktop AppServer. It uses test credentials and does not read the installed app's account or conversation data. Interactive product acceptance is performed manually by the user.
