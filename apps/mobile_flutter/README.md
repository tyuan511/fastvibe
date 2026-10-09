# FastVibe for Flutter

A native iOS / Android client for FastVibe machines, using the same App Protocol v1
as the desktop and web clients. Flutter owns its visual design: soft light
and dark backgrounds, pinned liquid-glass navigation, floating composer, glass
sheets and dialogs. Transcripts and dense content stay readable and opaque.

The device page keeps connection actions in a bottom dock. On a machine, the bottom
glass pill combines All / Active / Waiting with the new-chat button. Search and
project selection stay by the conversation list. Short menus open at their content
height; model, task, archive and search sheets share a close control and can expand.
Markdown uses a reading scale, restrained headings, highlighted code panels, inline
code, quotations, typeset math and horizontally scrollable tables. Settings includes
a live appearance preview and glass switches.

## Run locally

Requires Flutter 3.47.6 / Dart 3.13.5 (the SDK constraint is in `pubspec.yaml`).

```sh
export PATH="$HOME/development/flutter/bin:$PATH"
flutter pub get
flutter run
```

## Functionality

| Area | Flutter behavior |
| --- | --- |
| Devices | QR or address/password login, secure token storage, rename, delete, copy address, automatic list refresh |
| Conversations | Recent, running and waiting groups, project filtering, server-side message search, archive/restore/delete, draft-aware creation |
| Chat | Markdown/math, thinking and tool groups, model/reasoning selection, photos, stop/continue, durable queue, prompt answers |
| Recovery | Lifecycle/network probes, named subscriptions, snapshot/replay sequencing, paged history, unknown acknowledgement handling |
| Tasks | Task hierarchy, reports, paged output, retry/stop/resume, subagent execution checkpoints |
| Phone settings | System/light/dark themes, Chinese/English, haptics, local notifications, connection diagnostics, Android updates |

Additional phone features: favorite and search saved devices, filter conversations
by activity, search an entire conversation including older history, paste images,
and reduce glass effects. The last option caps rendering quality and reduces
transparency; system accessibility settings remain respected.

The notification payload identifies both the machine and conversation. A cold-start
or cross-device tap connects to the correct saved machine before opening the chat.
A missing token lands on that machine's login screen. Notifications remain local:
they use the connected event stream and cannot wake a killed/suspended process.

## Local verification

```sh
flutter analyze
flutter test
# Full native workflow against an in-process loopback server, no model or remote account:
flutter drive --driver=test_driver/integration_test.dart \
  --target=integration_test/app_flow_test.dart -d <simulator-or-emulator-id>

flutter build ios --release --no-codesign
bash tool/build_release.sh   # arm64-v8a APK only
```

Unit/widget coverage includes real HTTP/WebSocket handshakes, concurrent responses,
unknown acknowledgements, timeouts, snapshot/replay ordering, history pagination,
queue revisions, drafts, device persistence, release selection, translations,
interactive sheets/dialogs, and layouts in both languages/themes at 320, 390 and
768 logical pixels with 1.6x text. Long question forms are checked with a keyboard.

The native scenario exercises devices → chat → send → enqueue → dropped socket →
restored queue, model and task sheets, full-chat search, draft restoration, theme and
accessibility changes, cross-device notification navigation, image compression and
the native clipboard bridge. Test fixtures use only the `integration` and
`integration-second` device ids and are removed on completion. Automatic update
checks are disabled for this scenario. Screenshots go to `build/qa/ios-*.png` or
`build/qa/android-*.png`; inspect them after a successful run.

Camera capture, third-party photo-provider permission prompts and delivery while a
physical phone is locked still require a real device. Simulator checks verify the
camera widget mounts and the permission recovery route exists; they do not pretend
to scan a physical QR code.

## Verified UI flows

The native integration scenario also checks the bottom activity dock and captures
short model sheets, light/dark Markdown headings, lists, quotes, highlighted code,
wide tables and math. The translation generator resolves its sources relative to
itself, so another checkout cannot silently supply this app's text.

## Distribution

Both platforms use `dev.fastvibe.mobile`. Local Android release builds use the debug
key for installation/testing. To upgrade the shipping app, supply its existing
signing key through `FASTVIBE_ANDROID_STORE_FILE`, `FASTVIBE_ANDROID_STORE_PASSWORD`,
`FASTVIBE_ANDROID_KEY_ALIAS` and `FASTVIBE_ANDROID_KEY_PASSWORD` (defaults to the store
password). An incomplete signing configuration fails immediately. Never publish a
locally debug-signed APK as an upgrade to the production app.

Android builds only `arm64-v8a`, using `--split-per-abi --target-platform android-arm64`.
The APK retains the build number in `pubspec.yaml`; Flutter's per-ABI offset is disabled.
The build number must be at least `MAJOR * 10000 + MINOR * 100 + PATCH`, matching the
previous client's versionCode scheme. For example, `0.4.2+402` can replace build 402.
Future releases must increase both the version and build number. `tool/check_release.sh`
rejects a lower build number or an `app-v*` tag that does not match the version.

Strings live in `tool/i18n/{zh,en}.json`. Edit those files, then run
`node tool/gen_i18n.mjs` (or `pnpm flutter:i18n` from the repo root).
`node tool/gen_i18n.mjs --check` verifies translations and generated output.

### GitHub Actions

- **Mobile Flutter checks** runs `flutter analyze`, `flutter test`, release metadata and
  translation checks on pull requests and pushes to main that change the mobile client.
- **Mobile Android APK** keeps the `app-v*` tag and manual-run entry points. Tag pushes
  dispatch a build on main, checking out the tagged commit so caches can be reused.
  It publishes `FastVibe-app-v<version>-arm64-v8a.apk` and its `.sha256` checksum, with
  `docs/release/app-v<version>.md` as the release body; a tag without that note fails
  before building. The app renders the same body as its changelog.
  The ABI stays in the name so the updater can reject incompatible devices.
  A manual run without a tag only uploads build artifacts. It reuses the existing
  `FASTVIBE_ANDROID_KEYSTORE_BASE64`, `FASTVIBE_ANDROID_STORE_PASSWORD`,
  `FASTVIBE_ANDROID_KEY_ALIAS` and `FASTVIBE_ANDROID_KEY_PASSWORD` secrets.
- **Mobile iOS TestFlight** archives the Flutter `Runner` app, then automatically signs
  and exports it with `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
  `APPLE_TEAM_ID` overrides the team. `TESTFLIGHT_AUTO=true` enables uploads on `app-v*`
  tags; a manual run with `upload` off exports an IPA artifact. The build number is
  `github.run_number.github.run_attempt`, including reruns. The App Store Connect app
  record must already exist for `dev.fastvibe.mobile`.

Both release workflows analyze and test the app before building. All three workflows
read the Flutter SDK version from `environment.flutter` in `pubspec.yaml`.

## CI migration verification on 2026-10-09

- `flutter analyze`: zero issues; `flutter test`: 106 passed.
- Android arm64 release build passed. APK inspection confirms only `arm64-v8a` native
  libraries, package `dev.fastvibe.mobile`, version `0.4.2`, build 402, about 18.6 MB.
  The local APK uses the debug key; production CI supplies the existing release key.
- `flutter build ipa --release --no-codesign --build-number 402.1` passed and produced
  `build/ios/archive/Runner.xcarchive`. Its bundle ID is `dev.fastvibe.mobile`, version
  `0.4.2`, build `402.1`.
- All three mobile workflows passed `actionlint`; translation checks, shell syntax,
  TypeScript checking and frozen-lockfile installation passed.
- Repository tests: 1211 passed with `node --test --test-concurrency=1 'test/**/*.test.ts'`.
  Concurrent runs hit existing timing-sensitive assertions; they passed in the serial run.

GitHub release signing and TestFlight export/upload require a workflow run with the
repository's existing signing secrets; they were not executed locally. No desktop GUI
or Computer Use verification was performed for this migration.
