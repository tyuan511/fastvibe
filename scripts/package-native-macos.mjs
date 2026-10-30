#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { signingOptions, signNativeApp, notarizeNativeApp } from "./lib/native-mac-signing.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function nativeVersion() {
  const version = readFileSync(join(root, "native/Cargo.toml"), "utf8")
    .match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("invalid native workspace version");
  return version;
}

export function checkNativeTag(tag, version = nativeVersion()) {
  if (tag !== `native-v${version}`) throw new Error(`native tag must match Cargo version: native-v${version}`);
}

export function assembleMacApp(staged, app, version = nativeVersion()) {
  const manifest = JSON.parse(readFileSync(join(staged, "native-manifest.json"), "utf8"));
  if (manifest.schema !== 1 || manifest.layout !== "bundle" || manifest.platform !== "mac" || manifest.arch !== "arm64" || manifest.version !== version) {
    throw new Error("expected a mac-arm64 native bundle with the current native version");
  }
  const contents = join(app, "Contents");
  mkdirSync(contents, { recursive: true });
  cpSync(join(staged, "bin"), join(contents, "MacOS"), { recursive: true });
  cpSync(join(staged, "Resources"), join(contents, "Resources"), { recursive: true });
  cpSync(join(root, "resources/icon.icns"), join(contents, "Resources/icon.icns"));
  manifest.binaries = manifest.binaries.map((entry) => ({ ...entry, path: entry.path.replace(/^bin\//, "MacOS/") }));
  writeFileSync(join(contents, "Resources/native-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.fastvibe.native</string>
<key>CFBundleName</key><string>FastVibe Native</string>
<key>CFBundleDisplayName</key><string>FastVibe Native</string>
<key>CFBundleExecutable</key><string>fastvibe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version.split("-")[0]}</string>
<key>CFBundleVersion</key><string>${version.split("-")[0]}</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>FastVibe uses the microphone when you request audio input.</string>
</dict></plist>\n`);
  return app;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check-tag")) { checkNativeTag(args[args.indexOf("--check-tag") + 1]); return; }
  if (args.includes("--help")) {
    console.log("Usage: node scripts/package-native-macos.mjs [--no-build] [--sign] [--notarize] [--profile debug|release] [--output DIR] [--check-tag native-vX.Y.Z]");
    return;
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("native preview packaging currently requires macOS arm64");
  const signing = signingOptions(args);
  const option = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
  const output = resolve(option("output", join(root, "release/native/mac-arm64")));
  const staged = join(output, "staged");
  const version = nativeVersion();
  const app = join(output, "FastVibe Native.app");
  const archive = join(output, `FastVibe-Native-${version}-mac-arm64.zip`);
  const run = (command, argv) => execFileSync(command, argv, { cwd: root, stdio: "inherit" });
  rmSync(staged, { recursive: true, force: true });
  rmSync(app, { recursive: true, force: true });
  for (const path of [archive, `${archive}.sha256`, join(output, "native-notarization.json"), join(output, "native-notarization-log.json")]) {
    rmSync(path, { force: true });
  }
  run(process.execPath, ["scripts/stage-native-app.mjs", "--platform", "mac", "--arch", "arm64", "--profile", option("profile", "release"), "--bundle", "--output", staged, ...(args.includes("--no-build") ? ["--no-build"] : [])]);
  // Only generated subdirectories are removed, never the chosen output directory.
  assembleMacApp(staged, app, version);
  run(process.execPath, ["scripts/check-native-bundle.mjs", "--bundle", app]);
  for (const name of ["fastvibe-server", "fastvibe"]) {
    const binary = join(app, "Contents/MacOS", name);
    const arch = execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" }).trim();
    if (arch !== "arm64") throw new Error(`expected arm64 executable, got ${arch}: ${binary}`);
    const expected = name === "fastvibe" ? `FastVibe Native ${version}` : `fastvibe-server ${version}`;
    const actual = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    if (actual !== expected) throw new Error(`stale native executable: expected ${expected}, got ${actual}`);
  }
  signNativeApp(app, signing);
  run(process.execPath, ["scripts/check-native-bundle.mjs", "--bundle", app, "--allow-resigned"]);
  if (signing.notarize) {
    const result = notarizeNativeApp(app, archive, signing);
    console.log(`Apple notarization accepted: ${result.id}`);
  }
  // A ZIP cannot be stapled. Archive the stapled app anew and only then hash it.
  rmSync(archive, { force: true });
  run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", app, archive]);
  run("cargo", ["run", "--quiet", "--locked", "--manifest-path", "native/Cargo.toml", "-p", "fv-update", "--bin", "verify-native-update", "--", archive, version]);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${sha256}  ${archive.split("/").at(-1)}\n`);
  console.log(`Native preview: ${archive}\nSHA256: ${sha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
