/**
 * app.json holds the config; this only derives what must not be hand-maintained.
 *
 * `android.versionCode` follows `expo.version` (1.2.3 → 10203). The in-app updater
 * installs over the running build, and Android orders builds by versionCode, not by
 * the version name: left at the default of 1, every release would be the same build
 * as far as the installer is concerned, and nothing would stop an old APK replacing
 * a newer one.
 */
module.exports = ({ config }) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(config.version ?? "");
  if (!match) throw new Error(`expo.version must be MAJOR.MINOR.PATCH, got ${config.version}`);
  const [, major, minor, patch] = match.map(Number);
  if (minor > 99 || patch > 99) throw new Error(`expo.version ${config.version} does not fit the versionCode scheme`);
  return {
    ...config,
    android: { ...config.android, versionCode: major * 10000 + minor * 100 + patch },
  };
};
