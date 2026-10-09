# FastVibe for Flutter

A native iOS / Android client for FastVibe machines, using the same App Protocol v1
as the React Native app in `../mobile`. Flutter owns its visual design: soft light
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
tool/build_release.sh   # split APKs and Android App Bundle
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

All split APKs and the AAB retain the build number from `pubspec.yaml`; Flutter's
per-ABI version offset is disabled. The updater selects the device's supported ABI
before falling back to a universal APK. iOS builds above intentionally omit signing
and uploading. Existing React Native release workflows remain the shipping pipeline.

Strings are shared with React Native: edit `../mobile/src/i18n/{zh,en}.ts`, then run
`node tool/gen_i18n.mjs`. The tests reject untranslated literal keys.

## Verification on 2026-10-09

- `flutter analyze`: zero issues; `flutter test`: 98 passed.
- React Native TypeScript check passed; 113 existing mobile regression tests passed.
- iOS 27 simulator and Android 16 emulator: complete native workflow and screenshot checks passed.
- iOS release build passed without codesigning.
- Android release builds passed for all three split APKs and the AAB. The arm64 APK
  reports `dev.fastvibe.mobile`, build 42, and was installed and launched on the emulator.

These are local validation results, not an App Store or Google Play release.
