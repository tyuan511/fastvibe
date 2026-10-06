/**
 * app.json holds the config; this only derives what must not be hand-maintained.
 *
 * `android.versionCode` follows `expo.version` (1.2.3 → 10203). The in-app updater
 * installs over the running build, and Android orders builds by versionCode, not by
 * the version name: left at the default of 1, every release would be the same build
 * as far as the installer is concerned, and nothing would stop an old APK replacing
 * a newer one.
 *
 * `ios.buildNumber` is what TestFlight orders uploads by, and it must rise on every
 * upload of one version — a retried build of the same tag included — so CI passes its
 * run number. Without it the number follows the version like versionCode does, which
 * is enough for a local build and never for a second upload.
 */
module.exports = ({ config }) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(config.version ?? "");
  if (!match) throw new Error(`expo.version must be MAJOR.MINOR.PATCH, got ${config.version}`);
  const [, major, minor, patch] = match.map(Number);
  if (minor > 99 || patch > 99) throw new Error(`expo.version ${config.version} does not fit the versionCode scheme`);
  const versionCode = major * 10000 + minor * 100 + patch;
  const buildNumber = process.env.FASTVIBE_IOS_BUILD_NUMBER || String(versionCode);
  if (!/^\d+$/.test(buildNumber)) throw new Error(`FASTVIBE_IOS_BUILD_NUMBER must be an integer, got ${buildNumber}`);
  return {
    ...config,
    ios: { ...config.ios, buildNumber },
    android: { ...config.android, versionCode },
  };
};
