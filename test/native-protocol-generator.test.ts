import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = process.cwd();
const generator = `${root}/scripts/generate-native-protocol.mjs`;
const generated = `${root}/apps/mobile_flutter/lib/protocol/native_schema.dart`;

test("generated Flutter native protocol metadata is fresh", () => {
  execFileSync(process.execPath, [generator, "--check"], { cwd: root, stdio: "inherit" });
  const text = readFileSync(generated, "utf8");
  assert.match(text, /nativeProtocolNotifications/);
  assert.match(text, /request\/cancel/);
  assert.match(text, /NativeProtocolMethods/);
  assert.match(text, /nativeProtocolMethodSchemasJson/);
  assert.match(text, /workspace\/writeFile/);
  assert.match(text, /validateParams/);
  assert.match(text, /validateResponse/);
});
