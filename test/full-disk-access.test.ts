import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appBundlePath,
  fullDiskAccessSettingsUrl,
  hasFullDiskAccess,
  probePath,
} from "../src/main/engine/full-disk-access.ts";

test("a non-mac has nothing to grant", () => {
  assert.equal(hasFullDiskAccess({ platform: "win32", probe: () => "denied" }), true);
});

test("one readable protected database counts as granted", () => {
  assert.equal(hasFullDiskAccess({ platform: "darwin", probe: () => "ok" }), true);
});

test("a refusal is not granted, even when the other database is missing", () => {
  let n = 0;
  assert.equal(
    hasFullDiskAccess({
      platform: "darwin",
      paths: ["user", "system"],
      probe: () => (n++ === 0 ? "denied" : "missing"),
    }),
    false,
  );
});

test("the first readable database is enough", () => {
  let n = 0;
  assert.equal(
    hasFullDiskAccess({
      platform: "darwin",
      paths: ["user", "system"],
      probe: () => (n++ === 0 ? "missing" : "ok"),
    }),
    true,
  );
});

test("two missing databases are not reported as granted", () => {
  assert.equal(hasFullDiskAccess({ platform: "darwin", probe: () => "missing" }), false);
});

test("settings url follows the System Settings rename", () => {
  assert.match(fullDiskAccessSettingsUrl(21), /preference\.security\?Privacy_AllFiles$/);
  assert.match(fullDiskAccessSettingsUrl(22), /PrivacySecurity\.extension\?Privacy_AllFiles$/);
  assert.match(fullDiskAccessSettingsUrl(25), /PrivacySecurity\.extension\?Privacy_AllFiles$/);
});

test("the bundle path is the .app, not the binary inside it", () => {
  assert.equal(appBundlePath("/Applications/FastVibe.app/Contents/MacOS/FastVibe"), "/Applications/FastVibe.app");
  assert.equal(appBundlePath("/tmp/Electron.app/Contents/MacOS/Electron"), "/tmp/Electron.app");
  assert.equal(appBundlePath("/usr/bin/fastvibe"), "/usr/bin/fastvibe");
});

test("probePath tells a readable file, a missing one, and a refused one apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "fda-"));
  const readable = join(dir, "readable");
  writeFileSync(readable, "");
  assert.equal(probePath(readable), "ok");
  assert.equal(probePath(join(dir, "no-such-file")), "missing");
  const refused = join(dir, "refused");
  writeFileSync(refused, "");
  chmodSync(refused, 0);
  try {
    assert.equal(probePath(refused), "denied");
  } finally {
    chmodSync(refused, 0o644);
  }
});
