# FastVibe mobile — Flutter + Rust

Android and iOS share one Flutter interface. The grouped lists, flat surfaces, typography and blue accent come from the original Flutter flat design (`67a79709`, restored from the complete `142aa23e` implementation). Native Compose/SwiftUI screens and the JNI/SwiftPM application bridges have been removed.

## Layout

- `lib/`: Flutter pages, conversation UI, drafts, attachments and device/account presentation.
- `lib/core/`: Dart FFI access to the Rust C ABI. A dedicated isolate owns the runtime so synchronous account commands cannot block Flutter's UI isolate.
- `core/`: Rust account client, iroh transport, App Protocol v1, RPC correlation, transcript projection and bounded event/history state.
- `packages/rust_core/`: local FFI plugin. Android packages `libfastvibe_mobile_core.so`; iOS links `FastVibeMobileCore.xcframework` and preserves its exported C ABI symbols.
- `android/`, `ios/`: Flutter hosts, signing, OAuth callback, permissions and system integration. They contain no parallel native product UI.

The UI uses the current account-authenticated iroh connection, not the old Flutter WebRTC or LAN-password stack. The shared C ABI is declared in `core/include/fastvibe_mobile_core.h` and implemented by `core/src/ffi.rs`. JSON commands and polled events pass through the same runtime used by the protocol integration tests.

Relay leases carry all configured nodes in `relays`, with a separate credential and QUIC discovery port for each. Rust configures every entry in its `RelayMap` and supplies every relay URL as a peer address candidate. The top-level single-node fields remain for compatibility with older Control/client versions; an explicitly empty or invalid list is an error. `test/mobile-protocol.integration.test.ts` exercises both the legacy single-node response and a real two-node configuration whose first relay is unavailable.

The App Protocol hello includes `settings`: catalog initialization reads `conversations:list`, `engine:get-running`, `engine:get-pending-ui` and `settings:get`, and the connection health probe also reads settings. A transport connection or welcome alone does not prove these calls are authorized.

## Local discovery and connection reuse

The desktop advertises its iroh QUIC endpoint through Bonjour `_fastvibe-iroh._udp`. TXT records contain `v=1`, `device_id`, `endpoint_id` and comma-separated socket `addrs`; they carry no credentials. The service port is the actual QUIC UDP port, not the HTTP listener's port. Advertisements follow endpoint address changes, account state, the computer name and remote-access lifecycle.

Flutter uses native NSD/Bonjour (`nsd 5`) on Android and iOS. A **LAN / 局域网** label appears only when both advertised IDs match an official device already in the current account. Selecting it refreshes the account device's endpoint and rechecks the discovery record before forwarding up to eight fresh addresses. Records expire after 60 seconds and are cleared on account, foreground or network changes; lost services are removed immediately. iOS requires the Bonjour service declaration and local-network permission.

A matching LAN selection sets `preferDirect` instead of waiting for a relay-token request. Rust tries the known IP routes for 1.5 seconds; if they fail, it asynchronously obtains a fresh, complete relay lease and retries with all relay candidates. The total dial remains bounded by 15 seconds. An acquired fallback lease publishes its expiry before welcome so the normal credential rollover is armed. Direct-only dialing is explicit; it does not reinterpret an empty or malformed relay lease as valid. EndpointId verification and account authorization apply to both routes.

`Connection` retains one native runtime across client facades. Disconnect retires the old facade and clears its protocol events and projection while preserving the endpoint's sockets and path knowledge. Generation checks isolate late replies and commands; a cancelled relay-map update is reconciled before the next dial, including removal of partially applied nodes. Account or identity changes close the old endpoint. A terminal runtime failure is disposed before its owner creates a replacement. Network changes notify the retained endpoint and restart discovery.

Successful device and endpoint registrations are cached for five minutes only while their account token, install ID, name, platform and identity still match. Account changes and 401/403/404 responses invalidate the cache. Each new connection still reads the current account device list; relay leases are fetched when needed. Connection diagnostics record fixed phase names, elapsed time and outcomes without credentials.

## Toolchains

Use the Flutter SDK version specified by `pubspec.yaml`, Rust stable, Java 17, Android SDK 36 and NDK `28.2.13676358`. Android ships ARM64 (`arm64-v8a`). iOS requires Xcode, CocoaPods, and the Rust device/simulator targets.

```sh
cd apps/mobile
flutter pub get
flutter analyze
flutter test
```

From the repository root:

```sh
pnpm mobile:analyze
pnpm mobile:test
pnpm mobile:core:test
pnpm mobile:android
pnpm mobile:ios
```

## Account sign-in

Account authorization opens the phone’s full default browser through `url_launcher` in external-application mode. `app_links` receives `fastvibe://oauth/callback` on Android and iOS; Flutter routing does not consume that URL. The pending attempt checks its state and PKCE verifier, expires after five minutes, and can be cancelled from the account row. Closing or cancelling an old attempt cannot publish a late login.

## Android

Set `ANDROID_SDK_ROOT` / `ANDROID_HOME`, or `sdk.dir` in `android/local.properties`. On macOS, the Rust build script also recognizes Homebrew's Android command-line tools. `ANDROID_NDK_HOME` can explicitly select the NDK.

```sh
bash scripts/build-mobile-android-core.sh
cd apps/mobile/android
bash tool/build.sh
```

The Rust script builds the production transport/account features and stages the library under `packages/rust_core/android/src/main/jniLibs/arm64-v8a`. The app ID remains `dev.fastvibe.mobile`.

Signed releases require `FASTVIBE_ANDROID_STORE_FILE`, `FASTVIBE_ANDROID_STORE_PASSWORD`, `FASTVIBE_ANDROID_KEY_ALIAS` and `FASTVIBE_ANDROID_KEY_PASSWORD`. The release script refuses incomplete signing configuration; `tool/verify-release.sh` checks the APK certificate against the trusted keystore. Do not substitute a debug signature for an update to an installed production APK.

```sh
cd apps/mobile/android
bash tool/build.sh --release
```

Flutter outputs APKs in `apps/mobile/build/app/outputs/flutter-apk/`. The release asset remains `FastVibe-app-vX.Y.Z-arm64-v8a.apk` plus its SHA256 file. `pubspec.yaml` and `android/version.properties` must agree on version/build number; the Rust crate version tracks the mobile release. This migration retains version `0.5.13+513`.

## iOS

```sh
bash scripts/build-mobile-ios.sh
bash scripts/check-mobile-ios.sh
cd apps/mobile
flutter pub get
flutter build ios --simulator --debug --no-codesign
flutter build ios --release --no-codesign
```

The Rust build produces device arm64 and universal simulator arm64/x86_64 slices. The XCFramework lives in `packages/rust_core/ios/Frameworks/`; it is generated, not committed. `FASTVIBE_IOS_FRAMEWORK` and `FASTVIBE_IOS_BUILD_DIR` can override output locations. The checker verifies architectures and the exported create/destroy/command/poll/free-string symbols.

CocoaPods links the FFI plugin into the Flutter Runner. Dart loads iOS symbols from the current process; the plugin must retain them through release dead stripping. Open `ios/Runner.xcworkspace` when using Xcode.

The existing distribution certificate, team, App Store Connect credentials and build-number series remain in the iOS workflow. TestFlight upload is still an explicit workflow input.

## Tests and connection diagnosis

```sh
cargo test --locked --manifest-path apps/mobile/core/Cargo.toml
node --test test/mobile-release.test.ts
cargo build --locked --manifest-path rust/Cargo.toml --bin fastvibe-iroh
FASTVIBE_IROH_BIN="$PWD/rust/target/debug/fastvibe-iroh" node --test test/mobile-protocol.integration.test.ts
```

The protocol test uses a temporary local account API, relay and real desktop AppServer. It exercises direct-preferred LAN dialing without a relay-token request, stale-address relay fallback with expiry propagation, registration reuse, welcome, the four catalog initialization calls, a settings health probe, RPC results, independent conversation navigation, snapshots, subscriptions, prompts, pending questions, history, queue and stop over the C ABI. It does not touch installed accounts or conversations. The harness checks that its desktop sidecar supports the current multi-relay commands before testing the network; an older staged binary must be rebuilt rather than treated as a transport failure.

A page rendering successfully is not proof of remote connectivity. Verify account registration, lease issuance, relay TLS/authorization, iroh connection, protocol welcome and catalog initialization separately. UI migration does not bypass a failed relay path.

Bonjour discovery requires mDNS traffic to reach the phone. A Wi-Fi network that filters multicast may still permit QUIC unicast connections but show no LAN label. Treat a widget fixture or an injected DNS-SD record as a separate validation from automatic discovery across the actual network; neither establishes that multicast delivery works.
