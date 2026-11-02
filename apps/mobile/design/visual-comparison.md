# Native mobile prototype comparison

Baseline: `apps/mobile/design/prototype-standalone.html`. Screenshots come from actual platform simulators; host SwiftUI image renders are not accepted as simulator evidence.

## Android

Review APK uses `-PfastvibeVisualReview=true` (`dev.fastvibe.mobile.visual`), separate from the user's installed application and credentials. Fixture preferences stay in memory and no account/network runtime is started.

All ten pages are covered: login, computers, connecting/failed, conversations, thread, new conversation, streaming, history, pending operation, settings. The instrumentation exports 26 reference states in both appearances (52 PNGs), including offline/project/filter/model sheets, tool details and diffs, confirm/select/input, and an edited input. Four additional `chats-scrolled` / `thread-scrolled` light/dark captures verify real swipe gestures and that the scrolling body starts below the measured header.

Artifacts: `apps/mobile/.visual-review/android/after/prototype-*.png` (ignored generated output). `*-390.png` are review-size derivatives; original simulator PNGs are retained.

Implementation corrections include background layer ordering, shared color and typography tokens, logo shadow, safe areas, floating transcript chrome, composer position, computer connection badges, continuous catalog glass, prompt sheet geometry, thinking/turn times, compaction metadata, tool outputs and diffs. A measured follow-up retains full 19.375sp diff line boxes (`LineHeightStyle.Trim.None`), increases transcript end padding to the reference reading gap, uses the user-bubble-specific sheen/shadow, and hides the underlying composer/model control only while a pending sheet is actually presented. Queue send-now and move-up remain available from the queue row's action menu. The ordinary debug application ID remains unchanged unless the explicit review property is passed.

A second Android pass separates the backdrop from foreground content before applying saturation (1.8 for panels/sheets, 1.9 for controls), preserving text and icon colors. Sheen ends at 30% for sheets, 55% for controls and 46% for panels. Top headers now occupy their own measured layout region above a clipped scrolling body, following the user's actual scroll feedback. Catalog rows and transcript content cannot render under the header; the background wash remains continuous. The transparent top chrome overlay was removed. The bottom composer chrome remains blur-only. Android versions before API 31 retain the tint fallback.

The theme now preserves full line boxes across the catalog and sheets. Fresh captures put the login logo at y=254, select/input buttons at y=762–813 with 22px lower padding, and catalog separators approximately 95px apart (device-pixel rounding of the reference's 94px), removing the prior 4.4px-per-row compression. The extra trailing pending-sheet spacer was removed; Reply TextView paragraphs also retain their outer half-leading. Queue label/body line heights are explicitly 17.64sp/20.58sp, keeping the queue panel at the reference height instead of inheriting the 17sp body strut.

Validation: app unit tests 36 passed; native unit tests 3 passed. The complete 52-image instrumentation was rerun successfully after the measured line-height, prompt-presentation, bubble and page-spacing fixes (`OK (1 test)`); all originals were re-exported. The streaming interaction also verifies opening the queue action menu and dismissing it using the actual Android back key. The temporary emulator display override was reset.

Color comparisons must convert the browser screenshot's embedded ICC profile to sRGB first. For example, one reference bubble sample reads `(78,111,254)` in its source profile and `(12,132,254)` after conversion; treating the raw values as sRGB would falsely suggest a violet accent. No palette correction is justified by that unconverted difference.

### Reference differences that carry actual product behavior

- Android retains its own system status/navigation bars, fonts, actual phone name, application version, and account-derived avatar. The HTML uses iPhone chrome and static sample values.
- Global settings does not show a particular computer's path, relay usage, or diagnostics. This preserves the user's earlier instruction that connection state belongs to that computer. Internal core-version details are not added to the product UI.
- A stopped historical reply cannot offer a continuation action after a newer turn has completed. Continuation is available only for the eligible latest stopped reply.
- Pending request messages have no tool-call identifier or separate command field. Fenced commands in actual request messages render correctly; the UI does not guess which running tool a request belongs to.
- The model/provider picker has no corresponding artwork in the unique HTML prototype; it retains the user's requested collapsed provider groups and the same glass components.
- An excerpted diff's actual line count is displayed, even if the static prototype's badge states a larger count than its excerpt contains.

These differences do not establish pixel-identical visual acceptance. Remaining typography, material, shadow, and layout differences must be assessed from the per-page screenshots.

## Reproduce Android captures

```sh
JAVA_HOME=/path/to/jdk17 ANDROID_HOME=/path/to/android/sdk \
  apps/mobile/android/gradlew -p apps/mobile/android \
  -PfastvibeVisualReview=true :app:assembleDebug :app:assembleDebugAndroidTest
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r apps/mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -r \
  -e class dev.fastvibe.mobile.PrototypeVisualTest \
  dev.fastvibe.mobile.visual.test/androidx.test.runner.AndroidJUnitRunner
```

Read the instrumentation summary: Android's `am instrument` can return exit code zero when a test fails. Optional `-e prototypeState streaming` limits the run. Images are in the isolated target application's cache and are exported with `adb exec-out run-as`.

## iOS

All ten pages and 13 prototype variants are available through a DEBUG-only launch entry, generating 46 light/dark images. A separate `filter-many` regression scene adds two images with 40 projects, and `thread-multiline` adds two six-line-composer captures; these are scaling checks rather than extra prototype pages. The review application uses `dev.fastvibe.mobile.visual` on an isolated iPhone 13 simulator with iOS 27.2. It branches into the in-memory fixture before constructing the production session controller.

Artifacts: `apps/mobile/.visual-review/ios/after/<state>-<theme>.png`. These are real `simctl io screenshot` images; `*-390.png` are normalized derivatives. Initial launch captures that showed a white transition frame were discarded. The final full recapture uses sequential launches with a five-second settle interval.

Corrections include the computer/catalog/settings geometry, floating transcript navigation and composer, inset offline/project/filter/pending sheets, actual device metadata, exact Lucide paths extracted from the prototype, pending message code fences, history-loading placement, and tool failure badge placement. The transcript's bottom scroll target now contains the reading inset, so scrolling to the latest reply cannot stop with its final paragraph behind the composer; pending sheets hide the underlying composer and model control. Filter choices now scroll within the available height while the title and Done button remain fixed; both the normal and 40-project scenes were rebuilt and recaptured. The app also now links Network, SystemConfiguration and libresolv, required by the existing Rust static library.

Validation: simulator Debug application builds successfully; `swift test` reports 10 tests, 9 passed and 1 intentionally skipped (opt-in macOS screen export), including backward-compatible device metadata decoding. Checks were rerun after the font cascade, full line boxes, live blur and bubble-width changes. All 50 simulator images (46 reference variants plus two long-filter and two multiline-composer regressions) were refreshed; login and the transcript family were recaptured again after their final width/spacing changes. The separate DEBUG blur proof is retained under `ios/live/blur-proof-light.png`. The background regression passes both appearances with maximum RGB difference 2. The screenshot comparison is separate from these checks.

The native font's line wrapping, material sampling and some system controls still differ from the HTML. The Rust simulator archive also emits deployment-target warnings (built for simulator 27.2 while the app floor is 18.0); only the installed iOS 27.2 simulator was exercised. Settings intentionally follows the same product constraints as Android (actual local/account/version data; computer-specific connection information is not global). iOS has no production model picker equivalent to Android's; no screenshot was falsely labelled as one. The three unsupported Android-only screenshot variants are omitted.

### Reproduce iOS captures

```sh
xcodebuild -project apps/mobile/ios/FastVibeApp.xcodeproj -scheme FastVibe \
  -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,id=<device>' \
  -derivedDataPath apps/mobile/ios/DerivedData CODE_SIGNING_ALLOWED=NO \
  PRODUCT_BUNDLE_IDENTIFIER=dev.fastvibe.mobile.visual SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG ARCHS=arm64 build
xcrun simctl install <device> apps/mobile/ios/DerivedData/Build/Products/Debug-iphonesimulator/FastVibe.app
xcrun simctl launch --terminate-running-process <device> dev.fastvibe.mobile.visual \
  --prototype-screen thread --prototype-theme light
# Capture after the launch transition completes.
xcrun simctl io <device> screenshot thread-light.png
```

Supported state names are enumerated in `SimulatorPrototypeLaunch.screens`. Neither platform's build/test success establishes pixel-identical acceptance.

## Page review ledger

Every row has actual Android and iOS simulator captures in both appearances. “Captured” is coverage, not pixel-identical acceptance.

| Page | Corrections verified | Remaining comparison limits |
| --- | --- | --- |
| Login | 96-point logo, reference safe areas, primary button and help copy | Platform font metrics and logo shadow rendering |
| Computers | Home navigation, account/device cards, actual direct/relay metadata, offline sheet | Real avatar/device values; glass saturation and shadow differences |
| Connecting / failure | Step states, recovery explanation, cancel/retry layout | Platform spinner and text metrics |
| Conversations | Continuous lazy list, project/status labels, search, floating create, filters/project sheet | Calendar-relative labels use real dates; native glyph metrics |
| Thread | Ordered thinking/tools, compaction, model divider, actual timing, tool details and diff | Historical Continue intentionally restricted; iOS text wrapping differs |
| New conversation | Centered empty state, paperclip/input controls, icon and title spacing | Native text metrics; real computer context in Android header |
| Streaming | Expanded thinking, live tool states, fixed clock evidence, queue and stop | Cross-platform paragraph wrapping; Android queue actions are a row menu |
| History | Pinned loading capsule, no duplicate load row, actual tool diff | Actual excerpt count is 8 additions; static reference says 48 |
| Pending | Inset sheet, real message code, paired actions, underlying composer/model control hidden | Protocol has no tool-call association, so waiting badge is not guessed |
| Settings | Account/appearance/local version/update/logout | Global computer connection/diagnostic and internal core fields intentionally omitted |

The iOS 40-project filter scene confirms a capped choices viewport and an accessible Done button; the source uses a ScrollView for the remaining choices. No claim is made here that an automated screenshot proves every project was interactively selected.

The iOS production surfaces now sample actual underlying views through public `UIVisualEffectView`; the macOS host-test path retains the sampled background. UIKit's fixed blur recipes do not expose independent CSS radius/saturation controls, so their intensity and reduced wash still require visual calibration. A DEBUG-only `blur-proof` scene places one continuous high-contrast checker/text source under a right-half effect with no extra tint; actual simulator capture confirms the checker edges and small text are blurred.

Transcript prose uses a system SF primary font with explicit public PingFang SC fallback. Actual simulator measurement of the 23-character final sentence changes from 357.79pt to 367.36pt at 16pt, while Latin width stays identical. Its screenshot now wraps into two lines. User, thinking, Markdown, code/diff and elapsed text retain the full CSS line box, including outer half-leading. User bubbles measure the natural width with the same font cascade, add the 28pt horizontal padding, and cap at 84% of the transcript; this avoids SwiftUI shrinking a long wrapped bubble below the reference width. The composer rests 30pt above the lower edge when the keyboard is closed; its scroll target includes the measured composer height and reading gap. The six-line draft scene confirms that growing the composer keeps the final paragraph and elapsed label above it. Markdown resolves normal, bold, italic and combined runs to explicit font descriptors before attaching the PingFang cascade, so SwiftUI does not re-derive a font and lose that cascade. Links and other inline attributes survive; inline code uses the reference's 13.5pt at a 16pt body size. Body typography and material still receive per-page simulator verification; successful checks alone do not constitute pixel-identical acceptance.
