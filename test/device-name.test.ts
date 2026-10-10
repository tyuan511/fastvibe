import assert from "node:assert/strict";
import test from "node:test";
import { defaultDeviceName, deviceNameProblem, deviceNameSetting } from "../src/shared/device-name.ts";

test("a chosen name is trimmed, and an empty or invalid one means follow the computer", () => {
  assert.equal(deviceNameSetting("  工作电脑 🖥  "), "工作电脑 🖥");
  assert.equal(deviceNameSetting("  "), "");
  assert.equal(deviceNameSetting(undefined), "");
  assert.equal(deviceNameSetting("bad\nname"), "");
});

test("names may contain dots, but not control characters, and are capped at 64 characters", () => {
  assert.equal(deviceNameProblem(""), null);
  assert.equal(deviceNameProblem("build-box.office"), null);
  assert.equal(deviceNameProblem("a\u0000b"), "invalidCharacters");
  assert.equal(deviceNameProblem("a".repeat(64)), null);
  assert.equal(deviceNameProblem("a".repeat(65)), "tooLong");
  // Counted in characters, as the cloud counts them, not bytes.
  assert.equal(deviceNameProblem("机".repeat(64)), null);
  assert.equal(deviceNameProblem("机".repeat(65)), "tooLong");
});

test("the default is the computer's own name without .local", () => {
  assert.equal(defaultDeviceName("Yuans-MacBook-Pro.local"), "Yuans-MacBook-Pro");
  assert.equal(defaultDeviceName("build-box.LOCAL."), "build-box");
  assert.equal(defaultDeviceName("my.server.example"), "my.server.example");
  assert.equal(defaultDeviceName(""), "FastVibe");
  assert.equal(defaultDeviceName(".local"), "FastVibe");
});
