import { test } from "node:test";
import assert from "node:assert/strict";
import { lastRequestUsage, turnTokens } from "../src/main/engine/turn-usage.ts";

/**
 * The composer's 本轮 Token and 输出速度 rows use different scopes: the turn's token total
 * and the latest completed request's speed. Both come from the transcript, so they mean the same
 * thing after a restart as it did while the run was going — which is only true if the rule
 * lives in one pure function enumerated here rather than in whatever Main happened to be
 * holding in memory.
 */

const user = () => ({ type: "message", message: { role: "user" } });
const toolResult = (usage?: Record<string, number>) => ({ type: "message", message: { role: "toolResult", usage } });
const usageEntry = (usage: Record<string, number>) => ({ type: "usage", usage });
const compaction = (usage?: Record<string, number>) => ({ type: "compaction", usage });

/** An assistant round trip: `startedAt` is its request, `endedAt` when it was persisted. */
function assistant(
  usage: Record<string, number>,
  span?: { startedAt?: number; endedAt?: string | number; durationMs?: number },
): { type: string; timestamp?: string | number; message: { role: string; timestamp?: number; durationMs?: number; usage: Record<string, number> } } {
  return {
    type: "message",
    timestamp: span?.endedAt,
    message: { role: "assistant", timestamp: span?.startedAt, durationMs: span?.durationMs, usage },
  };
}

const u = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const iso = (ms: number) => new Date(ms).toISOString();

test("request speed pairs only the latest assistant's output and duration", () => {
  const branch = [
    user(),
    assistant(u(1_000, 9_000), { durationMs: 60_000 }),
    toolResult(),
    assistant(u(100, 300), { durationMs: 2_000 }),
    toolResult(),
    compaction(u(500, 4_000)),
    usageEntry(u(100, 2_000)),
    { type: "branch_summary", usage: u(100, 1_000) },
  ];
  const request = lastRequestUsage(branch);
  assert.deepEqual(request, { outputTokens: 300, durationMs: 2_000 });
  assert.equal(request!.outputTokens / (request!.durationMs / 1_000), 150);
  assert.equal(turnTokens(branch).tokens.output, 16_300, "turn usage still counts all billed output");
});

test("request speed survives a new prompt while the next request has not been persisted", () => {
  const branch = [user(), assistant(u(100, 200), { durationMs: 4_000 }), user()];
  assert.deepEqual(lastRequestUsage(branch), { outputTokens: 200, durationMs: 4_000 });
  assert.deepEqual(lastRequestUsage([...branch, assistant(u(100, 90), { durationMs: 1_000 })]), {
    outputTokens: 90, durationMs: 1_000,
  });
});

test("an untimed latest request does not borrow earlier timing or speed", () => {
  const branch = [user(), assistant(u(100, 200), { durationMs: 4_000 }), assistant(u(100, 300))];
  assert.deepEqual(lastRequestUsage(branch), { outputTokens: 300, durationMs: 0 });
});

test("latest request uses its own measured duration or its transcript bounds", () => {
  assert.deepEqual(lastRequestUsage([assistant(u(10, 50), { startedAt: 1_000, endedAt: 20_000, durationMs: 2_000 })]), {
    outputTokens: 50, durationMs: 2_000,
  });
  assert.deepEqual(lastRequestUsage([assistant(u(10, 50), { startedAt: 1_000, endedAt: iso(3_000) })]), {
    outputTokens: 50, durationMs: 2_000,
  });
});

test("request speed has no sample before an assistant reply, and invalid output stays zero", () => {
  assert.equal(lastRequestUsage([]), undefined);
  assert.equal(lastRequestUsage([user(), compaction(u(100, 20)), usageEntry(u(100, 20))]), undefined);
  assert.deepEqual(lastRequestUsage([assistant(u(10, Number.NaN), { durationMs: 2_000 })]), {
    outputTokens: 0, durationMs: 2_000,
  });
});

test("only what came after the last user message counts", () => {
  const branch = [
    user(),
    assistant(u(1_000, 100)),
    assistant(u(200, 50, 1_000)),
    user(),
    assistant(u(500, 80, 1_200)),
  ];
  assert.deepEqual(turnTokens(branch).tokens, { ...u(500, 80, 1_200, 0), total: 1_780 });
});

test("a steer re-baselines the turn", () => {
  // A follow-up injected mid-run is a user message, and the row then answers "since the
  // newest input" — which is the question the reader is asking when they steer.
  const before = [user(), assistant(u(9_000, 400), { startedAt: 0, endedAt: 5_000 })];
  const after = [assistant(u(1_000, 60), { startedAt: 6_000, endedAt: 8_000 })];
  const turn = turnTokens([...before, user(), ...after]);
  assert.deepEqual(turn.tokens, { ...u(1_000, 60), total: 1_060 });
  assert.equal(turn.modelMs, 2_000, "the previous turn's round trip is not in it either");
});

test("a branch with no user message is the whole branch", () => {
  // A transcript that opens on a compaction summary has nothing to cut on.
  const branch = [compaction(u(300, 900)), assistant(u(1_000, 100))];
  assert.deepEqual(turnTokens(branch).tokens, { ...u(1_300, 1_000), total: 2_300 });
});

test("cache warming and compaction calls inside the turn are billed to it", () => {
  const branch = [
    user(),
    usageEntry(u(2_000, 0)),
    assistant(u(100, 20, 2_000)),
    compaction(u(400, 150)),
    assistant(u(80, 10)),
  ];
  assert.deepEqual(turnTokens(branch).tokens, { ...u(2_580, 180, 2_000), total: 4_760 });
});

test("the same entries before the turn are left out", () => {
  const branch = [user(), usageEntry(u(5_000)), compaction(u(5_000)), user(), assistant(u(10, 1))];
  assert.deepEqual(turnTokens(branch).tokens, { ...u(10, 1), total: 11 });
});

test("messages that are not the model's are not counted twice", () => {
  // The engine records usage on a tool result only for the round trip that produced it;
  // the assistant above it already carries that request's numbers.
  const branch = [user(), assistant(u(500, 50)), toolResult(), assistant(u(100, 20))];
  assert.deepEqual(turnTokens(branch).tokens, { ...u(600, 70), total: 670 });
});

test("an empty turn is zero, not the previous turn's number", () => {
  const branch = [user(), assistant(u(900, 90)), user()];
  assert.deepEqual(turnTokens(branch), { tokens: { ...u(0, 0), total: 0 }, modelMs: 0 });
  assert.deepEqual(turnTokens([]), { tokens: { ...u(0, 0), total: 0 }, modelMs: 0 });
});

test("junk usage does not poison the total", () => {
  const branch = [
    user(),
    assistant({ input: 1_000, output: Number.NaN, cacheRead: -5, cacheWrite: 20 }),
    assistant(u(0)),
  ];
  assert.deepEqual(turnTokens(branch).tokens, { ...u(1_000, 0, 0, 20), total: 1_020 });
});

test("entries the cut does not understand are skipped", () => {
  const branch = [
    { type: "model_change", provider: "p", modelId: "m" },
    user(),
    { type: "label", label: "x" },
    assistant(u(40, 4)),
    { type: "context_edit" },
  ];
  assert.deepEqual(turnTokens(branch).tokens, { ...u(40, 4), total: 44 });
});

test("the engine's own durationMs wins over the disk span", () => {
  // A slow flush (fsync under load, a checkpoint write ahead of it) inflates the span
  // between the request and the entry landing; the engine's number is the request's.
  const branch = [user(), assistant(u(10, 5), { startedAt: 1_000, endedAt: iso(20_000), durationMs: 4_000 })];
  assert.equal(turnTokens(branch).modelMs, 4_000);
});

test("a junk durationMs falls back to the span instead of poisoning it", () => {
  const junk = [user(), assistant(u(10, 5), { startedAt: 1_000, endedAt: iso(2_500), durationMs: -9 })];
  assert.equal(turnTokens(junk).modelMs, 1_500);
  const nan = [user(), assistant(u(10, 5), { startedAt: 1_000, endedAt: iso(2_500), durationMs: Number.NaN })];
  assert.equal(turnTokens(nan).modelMs, 1_500);
});

test("turn model time is the round trips, not the wall clock around them", () => {
  // 2s of generation, then 5s waiting on a tool, then 1.5s more. The 5s is the tool's, and
  // the turn model time excludes that wait even though speed now uses a single request.
  const branch = [
    user(),
    assistant(u(1_000, 200), { startedAt: 1_000, endedAt: iso(3_000) }),
    { type: "message", timestamp: iso(3_100), message: { role: "toolResult" } },
    assistant(u(1_200, 150), { startedAt: 8_000, endedAt: iso(9_500) }),
  ];
  assert.equal(turnTokens(branch).modelMs, 3_500);
});

test("an entry timestamp given as a number is read as well as an ISO string", () => {
  const branch = [user(), assistant(u(10, 5), { startedAt: 1_000, endedAt: 2_500 })];
  assert.equal(turnTokens(branch).modelMs, 1_500);
});

test("a round trip with no bounds contributes no time", () => {
  // An imported transcript, or a message written before Main timed anything.
  const branch = [user(), assistant(u(10, 5)), assistant(u(10, 5), { startedAt: 1_000 }), assistant(u(10, 5), { endedAt: iso(1_000) })];
  assert.equal(turnTokens(branch).modelMs, 0);
});

test("a clock that went backwards contributes no negative time", () => {
  const branch = [user(), assistant(u(10, 5), { startedAt: 9_000, endedAt: iso(8_000) })];
  assert.equal(turnTokens(branch).modelMs, 0);
});

test("only this turn's round trips are timed", () => {
  const branch = [
    user(),
    assistant(u(10, 5), { startedAt: 0, endedAt: iso(60_000) }),
    user(),
    assistant(u(10, 5), { startedAt: 61_000, endedAt: iso(64_000) }),
  ];
  assert.equal(turnTokens(branch).modelMs, 3_000);
});
