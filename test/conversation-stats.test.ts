import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { conversationStats } from "../src/main/engine/conversation-stats.ts";

const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
const rows = [
  { type: "message", message: { role: "user", content: "first" } },
  { type: "message", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall" }], usage } },
  { type: "message", message: { role: "toolResult", usage } },
  { type: "message", message: { role: "user", content: "follow-up" } },
  { type: "message", message: { role: "assistant", provider: "p", model: "m", content: [], usage } },
  { type: "compaction", usage },
  { type: "branch_summary", usage },
  { type: "usage", usage },
] as unknown as SessionEntry[];

test("whole-conversation summaries agree with SDK totals, including tool and compaction usage", () => {
  const sdk = AgentSession.prototype.getSessionStats.call({
    sessionManager: { getEntries: () => rows }, getContextUsage: () => undefined,
  } as unknown as AgentSession);
  const result = conversationStats(rows, () => undefined);
  assert.deepEqual(result.tokens, sdk.tokens);
  assert.equal(result.rounds, sdk.userMessages);
  assert.equal(result.steps, sdk.assistantMessages);
  assert.equal(result.toolCalls, sdk.toolCalls);
  assert.equal(result.cost, sdk.cost);
  assert.equal(result.tokens?.total, 600);
});

test("summary costs use each assistant's price tier and retain recorded costs for other usage", () => {
  const result = conversationStats(rows, () => ({
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    costTiers: [{ over: 50, cost: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 } }],
  }));
  assert.equal(result.cost, 2.0004);
});

test("empty conversations report zero counts and token buckets", () => {
  assert.deepEqual(conversationStats([], () => undefined), {
    rounds: 0, steps: 0, toolCalls: 0, cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});
