import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_BASE_UNUSED_MS, MEMORY_MAX_SOURCES, MEMORY_RETENTION_POLICY, memoryExpired, memoryRetentionClock, memoryRetentionScore, reinforceMemory, type MemoryRetention } from "../src/main/engine/memory-retention.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

test("unweighted decay expires at 30/60/120/240/360 unused days regardless of ranking weight", () => {
  assert.equal(MEMORY_BASE_UNUSED_MS, 30 * DAY);
  assert.equal(MEMORY_MAX_SOURCES, 256);
  for (const [count, days] of [[0, 30], [1, 60], [2, 120], [3, 240], [4, 360], [31, 360]]) {
    const record = { generatedAt: START, reinforcementCount: count };
    assert.equal(memoryExpired(record, START + days * DAY), false);
    assert.equal(memoryExpired(record, START + days * DAY + 1), true);
    if (count > 0) assert.ok(memoryRetentionScore(record, START + days * DAY + 1) > 1 / 16, "ranking weight must not extend expiry");
  }
});

test("effective use reinforces at most once every 24 hours and cannot revive an expired source", () => {
  const initial = { generatedAt: START };
  assert.equal(reinforceMemory(initial, START + DAY - 1), initial);
  const first = reinforceMemory(initial, START + DAY);
  assert.deepEqual(first, { generatedAt: START, lastUsage: START + DAY, lastReinforcedAt: START + DAY, reinforcementCount: 1 });
  assert.equal(reinforceMemory(first, START + 2 * DAY - 1), first);
  assert.equal(reinforceMemory(first, START + 2 * DAY).reinforcementCount, 2);
  assert.equal(reinforceMemory(first, START + 61 * DAY + 1), first);
  const saturated = { generatedAt: START, reinforcementCount: 31 };
  assert.equal(reinforceMemory(saturated, START + DAY).reinforcementCount, 31);
});

test("legacy invalid numbers use finite fallbacks and old usage counts do not increase retention", () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const record: MemoryRetention = { generatedAt: START, lastUsage: invalid, reinforcementCount: invalid, lastReinforcedAt: invalid };
    assert.equal(memoryRetentionClock(record), START);
    assert.equal(memoryRetentionScore(record, START), 1);
    assert.equal(memoryExpired(record, START + 30 * DAY + 1), true);
    assert.equal(reinforceMemory(record, START + DAY).reinforcementCount, 1);
    assert.ok(Number.isFinite(memoryRetentionScore({ generatedAt: invalid }, START)));
  }
  const legacy = { generatedAt: START, usageCount: 1_000_000, pinned: true };
  assert.equal(memoryExpired(legacy, START + 30 * DAY + 1), true);
  assert.equal(memoryRetentionScore(legacy, START), 1);
  assert.equal("pinned" in reinforceMemory(legacy, START + DAY), false);
});

test("both prompts use explicit-save parity and surviving-source support rules", () => {
  assert.match(MEMORY_RETENTION_POLICY, /including explicitly saved/);
  assert.match(MEMORY_RETENTION_POLICY, /No source has a permanent exemption/);
  assert.match(MEMORY_RETENTION_POLICY, /supported exclusively by that source/);
  assert.match(MEMORY_RETENTION_POLICY, /support from surviving sources/);
  assert.match(MEMORY_RETENTION_POLICY, /Never recreate a removed source/);
});
