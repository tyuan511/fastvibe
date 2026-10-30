import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assembleMacApp, checkNativeTag, nativeVersion } from "../scripts/package-native-macos.mjs";
import { checkReleaseNote } from "../scripts/check-release-note.mjs";

const root = new URL("..", import.meta.url).pathname;
test("native tags cannot trigger an Electron release or disagree with Cargo", () => {
  const version = nativeVersion();
  checkNativeTag(`native-v${version}`);
  for (const tag of [`v${version}`, `app-v${version}`, "native-v9.9.9"]) assert.throws(() => checkNativeTag(tag));
  const workflow = readFileSync(join(root, ".github/workflows/native-bundles.yml"), "utf8");
  assert.match(workflow, /tags: \["native-v\*"\]/);
  assert.match(workflow, /prerelease: true/);
  assert.match(workflow, /make_latest: false/);
  assert.match(workflow, /-F draft=false -F prerelease=true -f make_latest=false/);
  assert.match(workflow, /RELEASE_ID: \$\{\{ steps\.draft_release\.outputs\.id \}\}/);
  assert.match(workflow, /needs: \[check, bundle\]/);
  assert.doesNotMatch(workflow, /windows-|ubuntu-24|arch: x64/);
  assert.match(readFileSync(join(root, "src/main/updater.ts"), "utf8"), /autoUpdater.allowPrerelease = false/);
});

test("native notes use the same bilingual contract as other release channels", () => {
  const temp = mkdtempSync(join(tmpdir(), "fv-native-note-"));
  try {
    const notes = join(temp, "docs/release"); mkdirSync(notes, { recursive: true });
    const tag = "native-v0.1.0";
    const url = `https://github.com/tyuan511/fastvibe/blob/${tag}/docs/release/${tag}`;
    writeFileSync(join(notes, `${tag}.md`), `**English** | [简体中文](${url}_zh-CN.md)\n\nNative preview.\n`);
    writeFileSync(join(notes, `${tag}_zh-CN.md`), `[English](${url}.md) | **简体中文**\n\n原生测试版。\n`);
    assert.equal(checkReleaseNote(tag, temp).tag, tag);
    assert.throws(() => checkReleaseNote("native-v0.1.0/../../other", temp), /not a release tag/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("publication refuses missing GitHub digests and a stable or already public release", () => {
  const temp = mkdtempSync(join(tmpdir(), "fv-native-publish-"));
  try {
    const name = `FastVibe-Native-${nativeVersion()}-mac-arm64.zip`;
    const bytes = Buffer.from("archive fixture");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(temp, name), bytes);
    writeFileSync(join(temp, `${name}.sha256`), `${sha256}  ${name}\n`);
    const release = { tag_name: `native-v${nativeVersion()}`, draft: true, prerelease: true,
      assets: [{ name, digest: `sha256:${sha256}`, size: bytes.length }] };
    const path = join(temp, "release.json");
    const check = (value: unknown) => {
      writeFileSync(path, JSON.stringify(value));
      execFileSync(process.execPath, [join(root, "scripts/check-native-release.mjs"), path, temp], { stdio: "pipe" });
    };
    check(release);
    assert.throws(() => check({ ...release, prerelease: false }), /draft prerelease/);
    assert.throws(() => check({ ...release, draft: false }), /draft prerelease/);
    assert.throws(() => check({ ...release, assets: [{ ...release.assets[0], digest: null }] }), /digest\/size does not match/);
    assert.throws(() => check({ ...release, assets: [{ ...release.assets[0], size: 1 }] }), /digest\/size does not match/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("mac app layout preserves executables, pinned resources and independent identity", () => {
  const temp = mkdtempSync(join(tmpdir(), "fv-native-bundle-"));
  try {
    const stage = join(temp, "stage"); mkdirSync(join(stage, "bin"), { recursive: true });
    mkdirSync(join(stage, "Resources/officecli/mac-arm64"), { recursive: true });
    const entry = (path: string, text: string) => {
      writeFileSync(join(stage, path), text);
      return { path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
    };
    const binaries = ["fastvibe", "fastvibe-server"].map((name) => {
      const result = { name, ...entry(`bin/${name}`, "#!/bin/sh\nexit 0\n") };
      chmodSync(join(stage, result.path), 0o755); return result;
    });
    const resources = [entry("Resources/officecli/mac-arm64/officecli", "pinned office bytes")];
    writeFileSync(join(stage, "native-manifest.json"), JSON.stringify({ schema: 1, layout: "bundle", version: nativeVersion(), platform: "mac", arch: "arm64", binaries, resources }));
    const app = assembleMacApp(stage, join(temp, "FastVibe Native.app"));
    const plist = readFileSync(join(app, "Contents/Info.plist"), "utf8");
    assert.match(plist, /<key>CFBundleIdentifier<\/key><string>dev.fastvibe.native<\/string>/);
    assert.match(plist, /<key>CFBundleExecutable<\/key><string>fastvibe<\/string>/);
    execFileSync(process.execPath, [join(root, "scripts/check-native-bundle.mjs"), "--bundle", app]);
    writeFileSync(join(app, "Contents/Resources/officecli/mac-arm64/officecli"), "tampered");
    assert.throws(() => execFileSync(process.execPath, [join(root, "scripts/check-native-bundle.mjs"), "--bundle", app, "--allow-resigned"], { stdio: "pipe" }), /resource hash mismatch/);
    assert.throws(() => assembleMacApp(stage, join(temp, "wrong.app"), "99.0.0"), /current native version/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
