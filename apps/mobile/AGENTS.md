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

## Native projects

`ios/` and `android/` are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins. Metro detects this monorepo automatically; do not add manual `watchFolders` or `nodeModulesPaths`.

A key that prebuild does not read fails silently, and only in a release build. Two have bitten: the top-level `splash` (SDK 57 reads only the `expo-splash-screen` plugin) and `android.usesCleartextTraffic` (only `expo-build-properties` writes it). The second matters most: Android 9+ blocks `http://` in release builds, every LAN address is plain HTTP, and the debug manifest allows it — so the app works in development and cannot reach any LAN machine once released, while the phone's browser opens the same address fine. After changing native config, run `expo prebuild` and read the generated `android/app/src/main/AndroidManifest.xml`, then delete `android/`.

## Updates (Android)

The app updates itself from GitHub Releases (`src/update/`): on launch it lists the `app-v*` tags, takes the newest one whose release has a `.apk` asset, and offers it in a banner on the 设备 screen; the APK is downloaded to the cache and handed to the system installer (`REQUEST_INSTALL_PACKAGES`). Releases are shared with the desktop app, so never look them up by `releases/latest` or the first page of `releases`.

To ship a phone release, bump `expo.version` in `app.json` and push `app-v<version>`. `android.versionCode` is derived from the version in `app.config.js` — do not set it by hand. The installer only accepts an APK signed with the same key, which is why the release key must never change.
