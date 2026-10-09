import { test } from "node:test";
import assert from "node:assert/strict";
import { discoveryNameProblem, discoveryNameSetting, discoveryNameWithSuffix } from "../src/shared/discovery-name.ts";

test("discovery names accept Unicode and empty means restore the default", () => {
  assert.equal(discoveryNameSetting("  工作电脑 🖥  "), "工作电脑 🖥");
  assert.equal(discoveryNameSetting("  "), "");
  assert.equal(discoveryNameProblem(""), null);
  for (const value of [null, undefined, {}, 123, "bad.name", "bad\\name", "bad\nname"]) {
    assert.equal(discoveryNameSetting(value), "");
  }
});

test("DNS label limits count UTF-8 bytes rather than characters", () => {
  assert.equal(discoveryNameProblem("a".repeat(63)), null);
  assert.equal(discoveryNameProblem("a".repeat(64)), "tooLong");
  assert.equal(discoveryNameProblem("机".repeat(21)), null);
  assert.equal(discoveryNameProblem("机".repeat(22)), "tooLong");
  assert.equal(discoveryNameProblem("🖥".repeat(16)), "tooLong");
  assert.equal(discoveryNameWithSuffix("机".repeat(21), " (2)"), `${"机".repeat(19)} (2)`);
  assert.equal(discoveryNameWithSuffix("🖥".repeat(16)), "🖥".repeat(15));
});
