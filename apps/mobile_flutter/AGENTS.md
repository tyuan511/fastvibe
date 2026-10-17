# FastVibe mobile (Flutter)

The shipping iOS / Android phone client, in `apps/mobile_flutter` (`fastvibe_mobile`).
It connects to saved FastVibe machines using App Protocol v1. Flutter owns the native
client; the browser's `mobile.html` remains a separate web entry.

## Flutter is newer than your training data

Before writing code that touches a Flutter or Dart API:

1. Read the version in `pubspec.yaml` / `flutter --version`.
2. Read the package's own source in `~/.pub-cache/hosted/pub.dev/<package>-<version>/`,
   starting with `lib/<package>.dart` for the public surface. The doc comments there are
   the specification, and a signature you remember is a guess.

## Commands

```bash
export PATH="$HOME/development/flutter/bin:$PATH"   # the SDK is not on PATH by default

flutter analyze                     # zero issues is the bar; there is no warning budget
flutter test                        # pure logic + every screen, both themes
flutter build ios --release --no-codesign
bash tool/build_release.sh          # arm64-v8a APK only
```

`flutter build apk --release` **must** pass `--split-per-abi` (or go through
`tool/build_release.sh`). A fat APK is ~88 MB against ~32 MB per architecture, and the
in-app updater downloads exactly one file.

## Layout

```
lib/
  main.dart          app root: theme, palette scope, toast host, update prompt, router
  router.dart        go_router; devices, conversations and phone settings
  theme/theme.dart   the design tokens — Palette, Radii, elevation, nameTint, DesktopSpinner
  i18n/              zh.dart + en.dart are GENERATED; core.dart is the reader
  protocol/          address, client (the socket), diagnostics, model cache, rtc_* (the official connection)
  session/           connection (the one live link), catalog, conversation actions
  storage/servers.dart
  chat/              message model, queue, snapshot sync, tool cards, composer, DAG
  screens/           one file per route
  ui/                kit (buttons, avatars, chips), glass_screen, feedback (toast/dialog)
  update/            GitHub release lookup and the Android self-update
  notifications/     local-notification policy and bridge
tool/
  i18n/             zh.json + en.json, the translation source
  gen_i18n.mjs       regenerates lib/i18n/{zh,en}.dart from tool/i18n
  check_release.sh   validates app-v* tags and Android build numbers
  create-release-keystore.sh  initial signing setup; never replace the shipping key
  build_release.sh
```

## The rules that matter

### Liquid glass is the chrome, never the content

`liquid_glass_widgets` (iOS 26/27 material, shader-based) is used for the navigation and
control layer only: `GlassScaffold` per screen, `GlassIconButton` / `GlassButton` in the
bars, `GlassModalSheet` for every picker and sheet. A conversation's rows, a settings
card and a transcript stay **opaque** — a reader has to read them, and glass over text is
noise. `lib/ui/glass_screen.dart` is the one place that composes the shell.

**`GlassScaffold` is not a `Scaffold` and provides no `Material` ancestor.** Every
`TextField`, `InkWell` and `Switch` in a body throws `No Material widget found` without
one, at render time, taking the whole tree down. `GlassScreen` wraps the body in
`Material(type: MaterialType.transparency)` for exactly this reason — do not remove it,
and do not add a screen that bypasses the shell.

Never nest refractive glass in refractive glass (`GlassButton` inside a `GlassCard`):
it double-refracts, clips the jelly animation, and wastes fill rate. Inside a glass
container use plain text and icons.

### Every string goes through `t()`

`lib/i18n/zh.dart` and `lib/i18n/en.dart` are **generated** by `tool/gen_i18n.mjs` from
`tool/i18n/{zh,en}.json`. Chinese defines the keys; English can add `_one` singulars.
To add or change a string, edit the JSON sources and run `pnpm flutter:i18n` at the
repo root. `node tool/gen_i18n.mjs --check` rejects missing translations and stale output.

Do not hand-edit the generated files. `t('key')` with `{'count': n}` picks the English
`_one` form for `count == 1`.

### Only semantic colours

`paletteOf(context)` (from `ui/kit.dart`) is the one reading of the active palette.
`palette.text / muted / subtle / border / separator / card / field / accent / accentSoft
/ danger / dangerSoft / warning / success` — never a literal colour, and never
`Colors.white` outside a surface that is meant to be white (the primary button's label).
The app ships light **and** dark; `test/screens_test.dart` renders every screen in both.

### `AppIcons`, not `Icons`

`lib/ui/icons.dart` maps the shared Hugeicons set under the product
names. `Icons` collides with `package:flutter/material.dart`'s, so the import is a
compile error the moment both are in scope — use `AppIcons.`.

### The transcript is the hard part

Read `lib/chat/message.dart`, `live_events.dart`, `snapshot_sync.dart` and
`lib/screens/chat.dart` before changing anything about how a reply is drawn. The rules:

- **A reply is one row.** `mergeReplies` folds consecutive assistant messages (one per
  model round trip) into one, keeping the *first* message's id — a key that moved to each
  round trip would remount the row mid-run and close a card the reader had opened.
  Its cache retains only the current projection's keys; live deltas replace message
  objects, so retaining old keys leaks every previous version of the growing reply.
- **Consecutive thinking and tool calls fold into one `ProcessGroup` card.** Only prose, a
  compaction notice, a model divider or an error ends the stretch. Each thinking line expands
  on its own tap, and a `todo` tool row expands into its full checklist (one line per item,
  the in-progress one spinning only while the reply streams) — the row's `1/5 · …` summary is
  not the plan. Every other tool row is one line by design: arguments, output and diffs belong
  to the desktop transcript.
- **A `codemode` script's own tool calls are not rows.** They arrive with a
  `parentToolCallId` and are dropped by `applyLiveEngineEvent`; the script's card lists
  them from `details.calls`.
- **Subscribe, then snapshot, then drop by `seq`.** `SnapshotSync` holds every event that
  arrives while the snapshot is in flight and merges them by *server sequence*, not by
  arrival time — the wildcard subscription can deliver a live frame before the named
  replay is requested. More than 2048 held events abandons the cursor rather than
  certifying a gap.
- **The wire cursor and the engine seq are different counters.** A gateway's upstream
  engine can restart without resetting this socket's protocol sequence, so neither can
  stand in for the other.
- **A task graph is not in the chat snapshot.** `DagWatcher` re-reads it on every new
  ready connection, retaining the visible graph while loading. A read overtaken by a
  push or replacement connection cannot overwrite newer state.
- **Streaming is reduced in place, painted once per frame-sized interval.** A fast model
  otherwise repaints the list once per token.
- **A block of prose is laid out bounded, and its Markdown theme is built once.**
  `TranscriptView` cuts a reply longer than `kMarkdownChunkChars` into one list row per
  Markdown block (`lib/chat/markdown_chunks.dart`, an incremental chunker fed the whole
  text every frame but only reading the new lines), so `ListView.builder` builds and lays
  out only the rows on screen and a settled chunk is never parsed again. Without it a
  model looping on its own output (376 KB in one assistant message) was parsed whole on
  every streamed frame and laid out inside one row — unbounded work per frame, and a row
  that took seconds to open. The chunker's own rules: cut only where a Markdown block can
  begin, so a fence, a `$$` formula, a loose list or a table is never split; past 2× the
  chunk size cut anyway, closing an open fence and re-opening it in the next chunk. The
  rows come out in the *list's* order — the newest block first, since the list is inverted
  — and the message's first row carries its name while the last carries the footer and the
  live tail. A long *thinking* block is the same problem one level down and scrolls inside
  its card above `_inlineChars`.
  The Markdown theme data and style sheet are cached per palette/size/language and handed
  back *by identity*: `GptMarkdownTheme` is an `InheritedWidget` whose data has no value
  equality, and a fresh instance makes every descendant re-read its dependencies, which
  the package answers by throwing its parse caches away — a full re-parse of the reply on
  every frame.
  (A library is not the answer here: the whole Flutter ecosystem renders Markdown into a
  Column, and `gpt_markdown`'s lazy path — `SliverGptMarkdown` — needs a sliver host, which
  a one-row-per-message list is not. Row-level chunking sidesteps both.)
- **Older history has its own flight** (`HistoryPager`), so scrolling back never blocks
  the live path. `loadAll` drains it before a copy-all, which must never silently copy
  just the visible window.
- **Open a small authoritative window.** Start with three complete turns and a 128 KiB
  soft budget; tool/result boundaries can exceed that budget. `transcriptPreview` is
  negotiated before asking for abbreviated settled bodies and inline images. A built
  row fetches its `deferredIds` through `engine:get-message`; merged replies preserve
  all of those ids. Copy, reuse and Copy All must resolve every required body first.
  Live tails retain their full prefix for the stream reducer.
- **A cached transcript is only a display hint.** `transcript_cache.dart` keeps the
  recent window under the app cache directory, keyed by saved host and conversation,
  with 256 KiB per entry, twenty entries and a seven-day expiry. It never persists a
  queue, engine seq or replay checkpoint. An authoritative snapshot replaces it before
  actions are enabled; a late cache read cannot overwrite fresh/live content. Defer
  the composer's session read until the history's first frame, otherwise metadata can
  initialize the whole agent ahead of the read-only transcript path.

### Files a reply produced: listed, previewed, downloaded

`lib/chat/output_files.dart` lists them under a settled reply (`OutputFilesRow`, on the
message's last row, never while it streams): the file of every finished `write` / `edit`
and every `present` item that worked. Nothing is guessed from a command's printed output —
the phone asks for tool results in summary form, which leaves a long result out, so a
guess would come and go with its length. Tapping a row opens `FileViewer`
(`lib/chat/file_sheet.dart`): an image, Markdown or text is drawn in the sheet, anything else
is a download; every file has 下载.

- **Bytes cross the call channel, in slices.** The official connection is one WebRTC data
  channel with no HTTP beside it, so `/api/media` (what the desktop's `fastvibe-media://`
  streams from) is unreachable. `workspace:read-file` (`src/main/engine/file-chunk.ts`)
  answers `{ size, mtimeMs, offset, data(base64), eof }` for `{ path, conversationId,
  offset, length }`; `FileTransfer` asks for the next slice until `eof`. A slice is at most
  512 KiB, so a transcript update queued behind it on the ordered channel waits briefly,
  and the phone gets progress and a place to stop.
- **The machine resolves the path, not the phone.** A tool wrote `out/report.md` relative to
  its conversation's directory, which the phone never learns. It sends the path as the tool
  named it plus the `conversationId`; Main resolves a relative path against that
  conversation's `cwd`. The `conversationId` is also what routes the call to an SSH host
  (the gateway scopes by `conversationId` / `path`), so no path is ever scoped on the phone.
- **A download is one completed file or a resumable checkpoint.** Bytes stay in a hidden `.part` until completion. The checkpoint key hashes the host id, conversation id and path; metadata stores size and modification time. A transient disconnect retains it and the viewer offers Resume. A reconnect uses the current client of the same saved host, never the retired socket or a different device. Resume checks size and `mtimeMs` before appending; a changed remote file restarts from zero. A mid-transfer change, malformed slice, stalled transfer or explicit cancellation removes the checkpoint. Closing the sheet pauses and preserves a verifiable checkpoint, including after a disconnect. Startup and new downloads remove invalid/orphaned checkpoints and checkpoints older than seven days, and evict oldest inactive checkpoints above a 512 MiB budget. Completed downloads and active writers are excluded. Older hosts that omit offset/mtime may still download normally, but cannot create a resumable checkpoint; incorrect supplied fields are still rejected. Final names remain safe and never replace earlier downloads (`name (2).ext`).
- **After a download the system opens it** (`open_filex`): iOS's document sheet offers
  共享 / 存储到「文件」, Android picks an app. Downloads live in `<documents>/Downloads`, and
  `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` make that folder show under
  「FastVibe」 in the Files app. Nothing is written to a public folder: Android needs no
  storage permission this way, and a file the person wants elsewhere goes through the
  system's share sheet.
- **Limits**: 12 MB of picture and 256 KB of text are previewed; the machine refuses a file
  over 256 MiB. A text read that contains a NUL byte is shown as 「不是文本」, not as garbage.

### The queue is Main's, the phone holds a projection

`lib/chat/queue.dart`. Every reply and push passes through `mergeQueue`'s **revision
gate**, including the cancel and resume replies, so a late RPC cannot revive a delivered
item or an old pause. A paused *empty* queue does not catch a fresh prompt. The send
decision is captured **before the first await**: a Stop during `record-prompt` must keep
that send queued.

A lost acknowledgement (`TransportError` with code `timeout` / `dropped` / `closed`) is
**not** a refusal — it becomes `SubmissionUncertainError`, the optimistic row stays, and
the transcript is re-read. Never branch on an error's *message*; it is translated, and an
English phone would miss a Chinese pattern.

`engine:continue` resolves after the whole resumed run, so `RemoteClient.call` gives it
no default request deadline. Socket closure and foreground health probes still reject
pending calls; ordinary RPCs keep their 30-second budget.

### Never move the engine's active conversation

The phone reads a chat with `engine:get-snapshot` and asks for its live stream by
subscribing to `conversation:<id>` **by name**. It does not call `conversations.open`,
which sets the active conversation every desktop window follows. `conversations:create`
is called with `activate: false` for the same reason. `DagWatcher` follows the same rule.

### Settings that belong to this phone

`lib/ui/preferences.dart`: theme, haptics, notifications. Which model the agent runs and
what it may do are the *machine's* settings and live in the composer. The language is
`lib/i18n/core.dart`, and an install from before the setting keeps 中文 (a saved device
list is the marker) — the desktop's rule for 界面语言.

## Testing

`flutter test` runs two layers, and both are load-bearing:

- **`test/chat_test.dart` / `address_test.dart`** — the runtime invariants, ported from
  the retired native client's regressions. `address_test.dart` is the same table, so a
  change there is a change to which machine a QR code connects to.
- **`test/screens_test.dart`** — every screen and the chat's own widgets, rendered in
  **both themes**. This is the layer `flutter analyze` cannot see: a render-time throw
  (a missing ancestor, a component used outside the group it needs) unmounts the whole
  tree and produces a white window, and it is exactly how the missing `Material` ancestor
  in `GlassScreen` was found.

Add a screen or a chat widget → render it here. `SharedPreferences.setMockInitialValues`
is required in `setUpAll`, or every storage read throws `MissingPluginException` as a
late error on whichever test happens to be running.

## Android and iOS

- Package `dev.fastvibe.mobile` on both — the same identifier the Expo client ships under,
  which is what lets the self-updater's APK install over it (Android refuses a package
  signed with a different key).
- `minSdk 24`; **core library desugaring is required** by `flutter_local_notifications`
  (`isCoreLibraryDesugaringEnabled` + `desugar_jdk_libs`). Without it the build fails in
  `checkDebugAarMetadata`, not at runtime.
- `android:usesCleartextTraffic="true"` and iOS `NSAllowsLocalNetworking`: 设置 → 远程访问
  copies a plain `http://` LAN address, and both platforms refuse it by default.
- Android self-update only (`lib/update/`). iOS has no sideloading, so every entry point
  there is a no-op behind `updatesSupported`.

## CI and releases

`.github/workflows/mobile-checks.yml` runs analysis and tests on mobile pull requests
and pushes to main without signing secrets. Both release workflows run those checks too.
The Flutter SDK is pinned by `environment.flutter` in `pubspec.yaml`.

- Android: bump `pubspec.yaml` to `MAJOR.MINOR.PATCH+BUILD`, commit the release note
  `docs/release/app-v<version>.md` with it, and push `app-v<version>`. The workflow refuses
  a tag without that note and publishes it as the release body, which is what the update
  prompt and 设置 → 关于 → 更新日志 render (`lib/update/release_notes_sheet.dart`).
  The build must be at least `MAJOR * 10000 + MINOR * 100 + PATCH` to remain compatible
  with existing installations. `check_release.sh` enforces that floor and the tag.
  The tag dispatches the existing `mobile-android.yml` onto main for reusable caches;
  it builds the tag's commit, signs with the existing `FASTVIBE_ANDROID_*` secrets,
  verifies the signature, and publishes one arm64 APK plus SHA-256 checksum. No AAB.
- iOS: `mobile-ios.yml` archives Flutter's `Runner` unsigned and signs at export with
  the existing App Store Connect key. `github.run_number.github.run_attempt` is passed
  as `--build-number` so reruns rise too. `TESTFLIGHT_AUTO=true` enables tag uploads;
  manual runs can export an IPA without uploading. `APPLE_TEAM_ID` overrides the team.

## Connection diagnostics

Settings opens a readable summary of the latest connection attempt, with separate authentication, offline-device, transport and catalog-restoration guidance plus recent timings. A later success supersedes an earlier failure. Successful signaling/channel-open timings never imply an authentication rejection; only explicit unauthorized errors or close code 4001 do. An incomplete post-open protocol handshake has its own guidance, and a later disconnect is not blamed on initial restoration. Full diagnostic JSON remains copyable; both views exclude credentials and RPC payloads. Summaries are snapshots when the sheet opens, not a second connection state machine.
