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
