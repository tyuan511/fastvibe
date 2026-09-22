import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentThinkingLevel } from "../resources/extensions/subagent/agents.ts";

for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
  test(`subagent templates accept ${level} reasoning`, () => {
    assert.equal(parseAgentThinkingLevel(level), level);
  });
}

test("legacy or invalid subagent reasoning migrates to medium", () => {
  assert.equal(parseAgentThinkingLevel(undefined), "medium");
  assert.equal(parseAgentThinkingLevel("off"), "medium");
  assert.equal(parseAgentThinkingLevel("extreme"), "medium");
  assert.equal(parseAgentThinkingLevel(1), "medium");
});
