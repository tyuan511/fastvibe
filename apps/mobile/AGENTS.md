# FastVibe mobile

Expo SDK 57 client in `apps/mobile` (`@fastvibe/mobile`). It connects to FastVibe machines the user has saved: a device list, then the remote session. It lives in the repo's pnpm workspace. Do not add a nested lockfile or `pnpm-workspace.yaml`.

## Expo has changed — do not trust training data

Expo ships breaking changes every SDK release. Before writing code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt and follow its links. Do not answer from memory.

## Commands

From the repo root:

```bash
pnpm mobile:start
pnpm mobile:ios
pnpm mobile:android
pnpm mobile:typecheck
```

Install SDK-compatible packages from this directory, never by guessing a version:

```bash
pnpm expo install <package>
```

This package uses pnpm, not bun or npm. The root workspace must stay on pnpm's isolated linker — the desktop app's packager depends on it. Do not set `nodeLinker: hoisted`.

## Routing

Expo Router. Routes live in `src/app/`. Keep non-route code outside that directory.

## UI

- **Tokens live in `ui/theme.ts`**: `background` is the grouped page, `card` a raised surface, `field` a recessed one (inputs, code); each status colour has a `…Soft` fill. `brand` is the icon's blue → indigo gradient, used only for the one primary action on a screen. `nameTint` gives a provider or project the same colour everywhere. Cards on the page are flat (fill colour, no shadow); `elevation()` is for what floats — the FAB, dialogs, toasts, and a barely-there `0` for the composer and the 正在工作 pill.
- **Gradients and rings are drawn with `react-native-svg`** (`ui/gradient.tsx`, the composer's context ring) — it is already linked for the icons, so no gradient module is added. `Gradient` sizes its `Svg` from `onLayout`; a percentage-sized `Svg` kept its first measurement and stopped short of the card.
- **`HugeiconsIcon` ignores `style`**: rotate a chevron by wrapping it in a `View`.
- **Every picker and menu is `ui/sheet.tsx`** (backdrop fades, panel slides, drag the header down to close) via `OptionSheet`, which grows a search field past nine options.
- **The model picker is its own sheet** (`chat/model-picker.tsx`): search across providers, a provider rail, 最近 (per server, on the phone — `model-recents.ts`), and each provider collapsed to one row except the current model's. A flat list of every provider's models was several screens long.
- **Dialogs and feedback have one look each.** Never `Alert.alert`: a confirmation, a notice or a text prompt is `dialog` (`ui/dialog.tsx`, drawn by the root's `DialogHost`), and the outcome of an action — 已复制, 已归档, 重命名失败 — is `toast` (`ui/toast.tsx`). A dialog waits until no sheet is on screen (`ui/overlay.ts`): iOS drops a modal presented while another is still dismissing, which is how 删除 from a sheet used to open nothing. `ToastHost` is mounted in the root *and* inside each modal, because a modal is its own window and would cover a toast drawn only by the root.
- **A reply is one row, and its working is one card.** Consecutive assistant messages (one per model round trip) render as a single row (`mergeReplies`, keyed by the first message's id so a streaming run does not remount it), and every stretch of thinking and tool calls with no prose between them is one `ProcessGroup` card.
- **Chat actions** (rename, archive/restore, delete) are in `session/conversation-actions.ts`, shared by the list and the chat header. Archive lists are read before they are written, because every client shares them.

## Language and settings

- **Every string goes through `t()`** (`src/i18n/`): `zh.ts` is the source, `en.ts` is typed against it so a missing key fails the typecheck, and `<key>_one` is an English singular picked for `count: 1`. Components call `useT()` so a switch in 设置 redraws screens already open — including list rows and `memo` components, which a parent re-render does not reach.
- **`i18n/core.ts` imports nothing from React Native**, because `node --test` loads modules that translate (`chat/queue.ts`, `chat/turn-meta.ts`); those imports carry the `.ts` suffix (`allowImportingTsExtensions`). Tests pin the language with `setLanguage`.
- **Never branch on a message.** The queue used to decide "maybe sent" by matching `请求超时|连接已断开|连接已关闭`, which an English phone would have missed and then rolled back a prompt Main may have taken. Transport failures are `TransportError` with a `code`; GitHub's are `GitHubStatusError` with a `status`.
- **The language follows the phone, except on an install from before the setting**, which keeps 中文 (a saved device list is the marker) — the desktop's rule for 界面语言.
- **设置** (top-right of the device list) holds only this phone's preferences: theme (applied with `Appearance.setColorScheme`, so native alerts and the keyboard follow), language, haptics, and 关于. What the agent may do and which model it runs are the machine's, and stay in the composer. The root layout holds the splash screen until the stored language and theme are applied.

## Message queue

The native chat uses Main's durable queue, not `engine:prompt`'s implicit steering.
`chat/queue.ts` captures the send decision before the first await: a busy conversation
or a nonempty queue calls `engine:queue-add`; a paused *empty* queue does not catch a
fresh prompt. It respects the host's `queueBehavior` (default `followUp`). Only direct
prompts get an optimistic transcript row; queue entries stay in `QueuePanel` until Main
delivers them. Cancel/resume, pushes and snapshots all pass through the same
conversation/revision gate so a late RPC cannot restore a delivered item or an old pause.
The screen re-subscribes and snapshots when the ready client changes after reconnect.
A missing send acknowledgement is an unknown outcome, never an automatic retry.
`test/mobile-queue.test.ts` tests the actual send dispatch and queue merge without React.

## Connection recovery

`RemoteClient` uses the existing App Protocol ping/pong after 15 seconds without incoming
frames, with a 15-second reply deadline (up to 45 seconds while other frames are still
arriving ahead of the pong). A timed-out RPC probes without replaying the RPC.
Backgrounding cancels health timers; foregrounding and network changes probe immediately.
`expo-network` wakes pending reconnects when connectivity returns, without treating a failed
Internet reachability check as proof that a LAN host is unreachable. Connection attempts
include catalog restoration and cannot overlap; stale callbacks cannot affect a replacement.
Close codes and reasons are retained in a bounded, current-run diagnostic history, copied
from 设置 → 关于 → 复制连接诊断. Never include credentials or RPC content in that history.
The host still owns running work; reconnect re-subscribes and restores snapshots.


## Dynamic sub-agent tasks

The native chat wraps its transcript in `MobileDagProvider` (`chat/dag-panel.tsx`). A compact progress row opens the existing `Sheet` with an ownership tree, then node detail or execution history. `dag_*` tool rows navigate there; `kind: "dag"` messages render as quiet system notices.

- `watchMobileDag` subscribes before `dag:list`, retains deletion tombstones during a pending list, and rejects older graph revisions. It is scoped to the chat and client; reconnect replaces the subscription, while cached task state remains visible with a reconnect label. It never calls `conversations.open`.
- `shared/dag-view.ts` orders siblings by attention while preserving ownership. Dependencies remain links in detail; prior coordinator attempts are labelled. A child whose coordinator has ended does not offer a retry the host would refuse.
- Stop/retry/resume use the same `dag:*` calls as the desktop, with explicit `conversationId`. Never optimistically mark the work stopped or completed. Controls are disabled while disconnected or awaiting acknowledgement.
- Results use `dag:output` pages after completion. Execution history uses `engine:get-subagent-messages`, scoped to `runId`, refreshed at turn boundaries and lifecycle changes, not for every token. A new attempt or client cannot receive the old request's response. Only a bounded window of messages is rendered at once.
- Keep the native wire-message shape local; pulling in the renderer's full type graph introduces unrelated browser/Node types. DAG contracts themselves are pure shared modules.
- The phone web page uses `useDagSync` and the responsive `DagDialog`: task list and detail replace one another on narrow screens. `mock.html?mobile=1` previews it; `lang=en` and `theme=dark` cover language and appearance. Neither the preview bridge nor its mutations reach an engine.

## Native projects

`ios/` and `android/` are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins. Metro detects this monorepo automatically; do not add manual `watchFolders` or `nodeModulesPaths`.

A key that prebuild does not read fails silently, and only in a release build. Two have bitten: the top-level `splash` (SDK 57 reads only the `expo-splash-screen` plugin) and `android.usesCleartextTraffic` (only `expo-build-properties` writes it). The second matters most: Android 9+ blocks `http://` in release builds, every LAN address is plain HTTP, and the debug manifest allows it — so the app works in development and cannot reach any LAN machine once released, while the phone's browser opens the same address fine. After changing native config, run `expo prebuild` and read the generated `android/app/src/main/AndroidManifest.xml`, then delete `android/`.

## Updates (Android)

The app updates itself from GitHub Releases (`src/update/`): it lists the `app-v*` tags, takes the newest one whose release has a `.apk` asset, and offers it in a banner on the 设备 screen; the APK is downloaded to the cache and handed to the system installer (`REQUEST_INSTALL_PACKAGES`). Releases are shared with the desktop app, so never look them up by `releases/latest` or the first page of `releases`.

It checks on mount **and every time the app returns to the foreground**, reusing an answer for 10 minutes. Not once per launch: backing out of the app on Android keeps the JS runtime alive, and the 设备 screen is the root and never unmounts, so a "no update" cached per process outlived the release it predated. The automatic check is silent on failure, which made a phone that cannot reach `api.github.com` look up to date — so 设置 → 关于 shows the version and a manual 检查更新 that always answers (up to date / found / why it failed, with a 15s per-request timeout). A manual check clears an earlier 忽略 and hands its result to the banner (`announceRelease`), which owns download and install.

To ship a phone release, bump `expo.version` in `app.json` and push `app-v<version>`. `android.versionCode` is derived from the version in `app.config.js` — do not set it by hand. The tag push does not build: it dispatches `mobile-android.yml` onto main with the tag as input, because Actions caches are per ref and only main's can be shared — a build on the tag started cold every time. That run builds the tag's commit and publishes the release; a manual run with no tag just builds main (and warms the cache). The installer only accepts an APK signed with the same key, which is why the release key must never change.

## APK size

The 0.2.1 APK was 61 MB for an arm64-only build. What it was made of, and what now holds each part down:

- **Icons come from `src/ui/icons.ts`, never from `@hugeicons/core-free-icons` itself.** Metro does not tree-shake, so importing even one name from the package index bundles every icon — 7.7 MB of source, over half the JS bundle (Hermes bytecode 10 MB → 4.4 MB once fixed). Add an icon by adding a line there; `hugeicons.d.ts` types the per-icon paths, which ship without declarations.
- **Native libraries are compressed** (`useLegacyPackaging`). By default AGP stores `.so` files uncompressed so they can be mapped in place — 27 MB of the APK. For an APK downloaded over a phone connection the download matters more than the install-time extraction.
- **R8 and resource shrinking are on** (`enableMinifyInReleaseBuilds`, `enableShrinkResourcesInReleaseBuilds`). Five dex files were 18 MB compressed. If a release build crashes where a debug one does not, suspect R8 stripping something reached by reflection and add a keep rule through a config plugin.
- **The ML Kit barcode scanner stays** (~6 MB with its models). Dropping it means `launchScanner`, which is Google Play Services' code scanner — absent on most phones sold in mainland China.

## iOS (TestFlight)

`.github/workflows/mobile-ios.yml` builds on a macOS runner and uploads to TestFlight. It is **manual until `TESTFLIGHT_AUTO` is `true`** (a repository variable): Actions → Mobile iOS TestFlight → Run workflow, with `upload` off to stop after exporting an `.ipa`, which is how to check signing before an App Store Connect record exists. Once the variable is set, pushing `app-v*` builds and uploads too, from the same tag as the Android APK.

- **Signing is automatic and keyed by the App Store Connect API key** (`APPLE_API_KEY_P8` / `_ID` / `APPLE_API_ISSUER`, the same secrets the desktop notarization uses). `-allowProvisioningUpdates` with the key creates or reuses the distribution certificate and the App Store profile in the account, so nothing else is stored. It needs a key whose role can manage certificates (Admin); an App Manager key fails at export with a provisioning error. `APPLE_TEAM_ID` (repository variable) overrides the team, which defaults to the personal one.
- **`ios.buildNumber` comes from CI's run number** (`FASTVIBE_IOS_BUILD_NUMBER`, read in `app.config.js`). TestFlight rejects an upload whose build number is not higher than every earlier one of that version, a retry included, so it cannot follow the version the way `versionCode` does.
- **The App Store Connect record is not created by CI.** Apps cannot be created through the API: make it once in the web UI with bundle ID `dev.fastvibe.mobile`. The bundle ID itself is registered by automatic signing.
- **`plugins/without-push-entitlement.js` removes `aps-environment`**, which expo-notifications adds to every build. The app posts local notifications only and never asks for a push token; the entitlement would make the App ID need Push Notifications for nothing. It must be listed *before* expo-notifications in `app.json` — mods run in reverse registration order.
- **`ITSAppUsesNonExemptEncryption: false`** is set, or every upload stops on the export-compliance question. `expo-secure-store`'s `faceIDPermission` is `false`: its default writes an English `NSFaceIDUsageDescription` for a permission the app never asks for.
- **Permission prompts are localized** (`locales/en.json`, `locales/zh-Hans.json`, wired through `expo.locales` and `CFBundleAllowMixedLocalizations`). The system shows the camera / photo / local-network purpose string in the *phone's* language, not the in-app language setting, and a reviewer's phone is usually English. The values in `app.json` (`cameraPermission`, `photosPermission`, `NSLocalNetworkUsageDescription`) are English on purpose: they are the fallback for every language that has no `.lproj`. A new permission needs a string in both files and an English base value, never Chinese only.
- **The App Store icon must have no alpha channel**; Expo flattens `assets/icon.png` when it generates the iOS icon, so the source can keep its transparency. Check the generated `AppIcon.appiconset` if the icon pipeline changes.
- **An iPad build must allow all four orientations** (or set `UIRequiresFullScreen`), even though the app is portrait-only on the phone. Expo emits them for `supportsTablet: true`; the upload fails with `ITMS-90474` if a change removes them.
- **Plain HTTP works only on the local network** (`NSAllowsLocalNetworking`: private IPs and `.local`). A machine reached by a public hostname over `http://` is blocked by ATS, unlike on Android; `https` tunnels are unaffected. Do not add `NSAllowsArbitraryLoads` — it is a review question for a benefit few users have.
- **Self-update is Android-only** (`updatesSupported`), so nothing in the iOS app offers to download an APK.
