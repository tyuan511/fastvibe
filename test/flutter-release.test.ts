import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../apps/mobile_flutter/tool/check_release.sh", import.meta.url));
const posix = process.platform !== "win32";

test("published APK names retain their ABI for the mobile updater", { skip: !posix }, () => {
  const workflow = readFileSync(new URL("../.github/workflows/mobile-android.yml", import.meta.url), "utf8");
  const assignment = workflow.match(/^\s+apk="[^"\n]+"/m)?.[0];
  assert.ok(assignment, "APK naming step must be present");
  for (const [tag, expected] of [
    ["app-v0.5.0", "FastVibe-app-v0.5.0-arm64-v8a.apk"],
    ["", "FastVibe-main-1234567-arm64-v8a.apk"],
  ]) {
    const result = spawnSync("bash", ["-c", `${assignment}\nprintf '%s' "$apk"`], {
      encoding: "utf8", env: { ...process.env, RELEASE_TAG: tag, GITHUB_SHA: "1234567890abcdef" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

function check(version: string, tag = "") {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-flutter-release-"));
  try {
    const pubspec = join(dir, "pubspec.yaml");
    writeFileSync(pubspec, `version: ${version}\n`);
    return spawnSync("bash", [checker, pubspec], {
      encoding: "utf8", env: { ...process.env, RELEASE_TAG: tag },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Flutter Android builds retain the shipping client's versionCode floor", { skip: !posix }, () => {
  assert.equal(check("0.4.2+402", "app-v0.4.2").status, 0);
  assert.equal(check("0.4.3+403").status, 0);
  assert.equal(check("0.4.3+500").status, 0);
  assert.notEqual(check("0.4.2+42").status, 0);
  assert.notEqual(check("0.4.3+402").status, 0);
  assert.notEqual(check("0.4.3+2100000001").status, 0);
});

test("mobile tags must match the Flutter version, including manual workflow inputs", { skip: !posix }, () => {
  for (const tag of ["app-v0.4.1", "v0.4.2", "main", "app-v0.4.2-rc1"]) {
    assert.notEqual(check("0.4.2+402", tag).status, 0, tag);
  }
  for (const version of ["0.4.2", "0.4.2+oops", "0.4.2-rc1+402", "0.100.0+10000"]) {
    assert.notEqual(check(version).status, 0, version);
  }
});
