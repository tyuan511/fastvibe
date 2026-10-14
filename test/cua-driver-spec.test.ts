import assert from "node:assert/strict";
import test from "node:test";
import {
  CUA_DRIVER_VERSION,
  cuaMirrorUrl,
  cuaPlatformSpec,
} from "../src/main/engine/cua-driver-spec.ts";

test("computer control is not offered on linux or an unknown architecture", () => {
  assert.equal(cuaPlatformSpec("linux", "x64"), null);
  assert.equal(cuaPlatformSpec("darwin", "ia32"), null);
  assert.equal(cuaPlatformSpec("freebsd", "arm64"), null);
});

test("each supported platform fetches a worker and a native library, checksummed", () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
    ["win32", "arm64"],
  ] as const) {
    const spec = cuaPlatformSpec(platform, arch);
    assert.ok(spec, `${platform}/${arch}`);
    assert.equal(spec.version, CUA_DRIVER_VERSION);
    assert.deepEqual(spec.artifacts.map((item) => item.kind), ["worker", "native"]);
    for (const artifact of spec.artifacts) {
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
      assert.match(artifact.url, new RegExp(`cua-driver-rs-v${CUA_DRIVER_VERSION}/`));
      assert.equal(cuaMirrorUrl(artifact.url), `https://gh-proxy.com/${artifact.url}`);
    }
  }
});

test("the mac worker is the pinned universal archive, thinned per architecture", () => {
  const arm = cuaPlatformSpec("darwin", "arm64");
  const intel = cuaPlatformSpec("darwin", "x64");
  assert.equal(arm?.lipo, "arm64");
  assert.equal(intel?.lipo, "x86_64");
  assert.equal(arm?.artifacts[0]?.filename, intel?.artifacts[0]?.filename);
  assert.equal(
    arm?.artifacts[0]?.sha256,
    "386db225a3080714a0f9f935525e61efaf46709587ef8b94dd2df81aeb2f6daa",
  );
  assert.equal(arm?.packageName, "@trycua/cua-driver-darwin-arm64");
  assert.equal(intel?.packageName, "@trycua/cua-driver-darwin-x64");
  assert.notEqual(arm?.artifacts[1]?.sha256, intel?.artifacts[1]?.sha256);
});

test("windows fetches an exe, not the mac universal binary", () => {
  const spec = cuaPlatformSpec("win32", "x64");
  assert.equal(spec?.workerName, "cua-driver.exe");
  assert.equal(spec?.lipo, undefined);
  assert.match(spec?.artifacts[0]?.filename ?? "", /windows-x86_64-binary\.zip$/);
  assert.equal(spec?.packageName, "@trycua/cua-driver-win32-x64-msvc");
});
