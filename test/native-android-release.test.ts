import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const android = join(root, "apps", "mobile", "android");
const tool = join(android, "tool");
const bash = (script: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync("bash", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

test("native Android release metadata and updater asset contract stay aligned", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "mobile-android.yml"), "utf8");
  const metadata = readFileSync(join(android, "version.properties"), "utf8");

  assert.match(metadata, /^versionName=0\.5\.12$/m);
  assert.match(metadata, /^versionCode=512$/m);
  assert.match(workflow, /tags:\s*\n\s+- "app-v\*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tool\/build\.sh --release --with-aar/);
  assert.doesNotMatch(workflow, /apps\/mobile_flutter|flutter-action|flutter build/);
  assert.match(workflow, /FastVibe-\$\{RELEASE_TAG\}-arm64-v8a\.apk/);
  assert.match(workflow, /draft: true/);
  assert.match(workflow, /gh release edit .*--draft=false/);
  for (const secret of [
    "FASTVIBE_ANDROID_KEYSTORE_BASE64",
    "FASTVIBE_ANDROID_STORE_PASSWORD",
    "FASTVIBE_ANDROID_KEY_ALIAS",
    "FASTVIBE_ANDROID_KEY_PASSWORD",
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`), `${secret} wiring changed`);
  }
});

test("Android metadata checker accepts the shipping version and matching tag", () => {
  const result = bash(join(tool, "check-release.sh"), [join(android, "version.properties"), "app-v0.5.12"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Android 0\.5\.12 \(versionCode 512\), ABI arm64-v8a/);
});

test("Android metadata checker rejects a mismatched release tag", () => {
  const result = bash(join(tool, "check-release.sh"), [join(android, "version.properties"), "app-v0.5.10"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match app-v0\.5\.12/);
});

test("signed native release build fails closed before Gradle without all signing inputs", () => {
  const env = { ...process.env };
  for (const key of [
    "FASTVIBE_ANDROID_STORE_FILE",
    "FASTVIBE_ANDROID_STORE_PASSWORD",
    "FASTVIBE_ANDROID_KEY_ALIAS",
    "FASTVIBE_ANDROID_KEY_PASSWORD",
  ]) delete env[key];
  const result = bash(join(tool, "build.sh"), ["--release"], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Signed release requires FASTVIBE_ANDROID_STORE_FILE/);
});

test("APK signer verification compares apksigner output with the trusted keystore certificate", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-native-android-release-"));
  try {
    const apk = join(dir, "release.apk");
    const apksigner = join(dir, "apksigner");
    const keytool = join(dir, "keytool");
    const keystore = join(dir, "release.keystore");
    const cert = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    writeFileSync(apk, "test apk");
    writeFileSync(keystore, "test keystore");
    writeFileSync(apksigner, `#!/usr/bin/env bash
printf '%s\\n' 'Verified using v2 scheme (APK Signature Scheme v2): true' 'Signer #1 certificate SHA-256 digest: ${cert}'\n`);
    writeFileSync(keytool, `#!/usr/bin/env bash
printf '%s\\n' 'SHA256: ${cert}'\n`);
    chmodSync(apksigner, 0o755);
    chmodSync(keytool, 0o755);

    const ok = bash(join(tool, "verify-release.sh"), [
      apk,
      "--apksigner", apksigner,
      "--keystore", keystore,
      "--alias", "fastvibe",
      "--store-password-env", "TEST_STORE_PASSWORD",
    ], { TEST_STORE_PASSWORD: "test-password", PATH: `${dir}:${process.env.PATH}` });
    assert.equal(ok.status, 0, ok.stderr);

    const mismatch = bash(join(tool, "verify-release.sh"), [
      apk,
      "--apksigner", apksigner,
      "--trusted-cert-sha256", "11".repeat(32),
    ]);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match the trusted production certificate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
