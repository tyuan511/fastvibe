import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  OFFICECLI_PLATFORMS,
  assetsFromChecksumSums,
  officeCliAgentKeys,
  officeCliDesktopKeys,
  officeCliPlatform,
  officeCliPlatformKey,
  parseOfficeCliManifest,
  serializeOfficeCliManifest,
} from "../src/shared/office.ts";

const manifest = parseOfficeCliManifest(JSON.parse(readFileSync(new URL("../scripts/officecli.json", import.meta.url), "utf8")));

test("the pinned manifest names every platform the table ships, with that platform's asset", () => {
  for (const platform of OFFICECLI_PLATFORMS) {
    const asset = manifest.assets[platform.key];
    assert.ok(asset, `missing ${platform.key}`);
    assert.equal(asset.asset, platform.asset);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(Object.keys(manifest.assets).length, OFFICECLI_PLATFORMS.length);
});

test("desktop and agent keys are a partition of the table, and alpine is agent-only", () => {
  const desktop = new Set(officeCliDesktopKeys());
  const agent = new Set(officeCliAgentKeys());
  for (const platform of OFFICECLI_PLATFORMS) {
    const inDesktop = desktop.has(platform.key);
    const inAgent = agent.has(platform.key);
    assert.equal(inDesktop, platform.usedBy.includes("desktop"), platform.key);
    assert.equal(inAgent, platform.usedBy.includes("agent"), platform.key);
  }
  assert.equal(desktop.has("linux-alpine-x64"), false);
  assert.equal(agent.has("linux-alpine-arm64"), true);
  assert.equal(agent.has("linux-x64"), true);
});

test("a running process resolves to the directory the fetcher writes and the package copies", () => {
  assert.equal(officeCliPlatformKey("darwin", "arm64"), "mac-arm64");
  assert.equal(officeCliPlatformKey("darwin", "x64"), "mac-x64");
  assert.equal(officeCliPlatformKey("win32", "x64"), "win-x64");
  assert.equal(officeCliPlatformKey("linux", "arm64"), "linux-arm64");
  assert.equal(officeCliPlatformKey("linux", "aarch64", { musl: true }), "linux-alpine-arm64");
  assert.equal(officeCliPlatformKey("freebsd", "x64"), null);
  // The packaged path is resources/officecli/<key>/<binary>, which is what extraResources
  // copies from. The two cannot be named differently.
  const mac = officeCliPlatform("mac-arm64");
  assert.equal(mac?.binary, "officecli");
  assert.equal(officeCliPlatform("win-x64")?.binary, "officecli.exe");
});

test("a release checksum file maps onto the table, and a missing asset is an error", () => {
  const lines = OFFICECLI_PLATFORMS.map((item, index) => `${"ab".repeat(32).slice(0, 64 - String(index).length)}${index}  ${item.asset}`);
  const parsed = assetsFromChecksumSums(`${lines.join("\n")}\n`);
  assert.equal(parsed["mac-arm64"]?.asset, "officecli-mac-arm64");
  assert.throws(() => assetsFromChecksumSums("abcd  something-else\n"), /缺少/);
});

test("serializing the committed manifest is a no-op", () => {
  const raw = readFileSync(new URL("../scripts/officecli.json", import.meta.url), "utf8");
  assert.equal(serializeOfficeCliManifest(manifest), raw.endsWith("\n") ? raw : `${raw}\n`);
});
