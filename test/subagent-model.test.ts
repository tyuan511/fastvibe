import test from "node:test";
import assert from "node:assert/strict";
import { resolveSubagentModel } from "../src/main/pi/subagent-model.ts";

test("resource accounting and execution resolve unavailable roles to the authenticated fallback", () => {
  const missing = { provider: "missing", id: "model" };
  const available = { provider: "gateway", id: "working" };
  const registry = {
    find: (provider: string) => provider === "missing" ? missing : available,
    getAvailable: () => [available],
    hasConfiguredAuth: (model: unknown) => model === available,
  };
  assert.equal(resolveSubagentModel(registry as any, "missing/model", "gateway/working"), available);
  assert.equal(resolveSubagentModel(registry as any, "working"), available);
  assert.equal(resolveSubagentModel(registry as any, "missing/model"), undefined);
});
